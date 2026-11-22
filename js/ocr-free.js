// Lectura GRATIS del ticket, dentro del teléfono (Tesseract), sin internet ni API key.
// Es menos precisa que la IA: el texto se interpreta con reglas pensadas para tickets argentinos.

const base = new URL("../vendor/tesseract/", import.meta.url).href;
let workerPromise = null;
let progressCb = null;

function getWorker() {
  if (!workerPromise) {
    // se carga recién cuando hace falta, para que la app abra rápido
    workerPromise = import("../vendor/tesseract/tesseract.esm.min.js").then(({ default: Tesseract }) => Tesseract.createWorker("spa", 1, {
      workerPath: base + "worker.min.js",
      corePath: base + "core/",
      langPath: base + "lang/",
      logger: (m) => progressCb && progressCb(m),
    })).then(async (w) => {
      // 6 = un bloque uniforme de texto (como un ticket)
      await w.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
      return w;
    });
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

// Prepara la foto para el OCR:
// 1) encuentra dónde está el papel del ticket (claro y parejo) y recorta el fondo (mesa, granito, etc.)
// 2) lo lleva a un tamaño en el que las letras se leen bien
// 3) lo pasa a blanco y negro con un umbral adaptativo (tolera sombras y reflejos)
export async function preprocess(file) {
  const bitmap = await createImageBitmap(file);
  const box = findPaper(bitmap);

  // Recorte a tamaño de trabajo: ~1500 px de ancho de papel
  const targetW = Math.max(900, Math.min(1800, box.w));
  const scale = targetW / box.w;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(box.w * scale);
  canvas.height = Math.round(box.h * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, canvas.width, canvas.height);
  binarize(ctx, canvas.width, canvas.height);
  return canvas;
}

// Busca la zona de papel: bloques con mucha proporción de píxeles claros y poco color.
function findPaper(bitmap) {
  const W = 240;
  const s = W / bitmap.width;
  const H = Math.max(1, Math.round(bitmap.height * s));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(bitmap, 0, 0, W, H);
  const d = cx.getImageData(0, 0, W, H).data;
  const full = { x: 0, y: 0, w: bitmap.width, h: bitmap.height };

  // luminancia y umbral de "claro" relativo a la imagen (percentil 90)
  const lum = new Float32Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    lum[p] = sat > 60 ? 0 : l; // los colores fuertes no son papel
    hist[l | 0]++;
  }
  let acc = 0, p90 = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > W * H * 0.1) { p90 = v; break; } }
  const bright = Math.max(110, p90 - 45);

  // grilla de bloques de 4x4: proporción de píxeles claros
  const B = 4, gw = Math.floor(W / B), gh = Math.floor(H / B);
  const paper = new Uint8Array(gw * gh);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++) {
      let n = 0;
      for (let y = 0; y < B; y++)
        for (let x = 0; x < B; x++) if (lum[(by * B + y) * W + bx * B + x] >= bright) n++;
      paper[by * gw + bx] = n >= 12 ? 1 : 0; // >= 75% claro
    }
  // suavizado: un bloque es papel si la mayoría de sus vecinos lo son (quita motas del fondo)
  const smooth = new Uint8Array(gw * gh);
  for (let y = 1; y < gh - 1; y++)
    for (let x = 1; x < gw - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += paper[(y + dy) * gw + x + dx];
      smooth[y * gw + x] = n >= 6 ? 1 : 0;
    }
  // la mancha conectada más grande
  const label = new Int32Array(gw * gh).fill(-1);
  let best = null;
  for (let i = 0; i < gw * gh; i++) {
    if (!smooth[i] || label[i] >= 0) continue;
    const stack = [i];
    label[i] = i;
    let n = 0, x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    while (stack.length) {
      const k = stack.pop();
      const x = k % gw, y = (k / gw) | 0;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const nb of [k - 1, k + 1, k - gw, k + gw]) {
        if (nb < 0 || nb >= gw * gh || label[nb] >= 0 || !smooth[nb]) continue;
        if ((nb === k - 1 && x === 0) || (nb === k + 1 && x === gw - 1)) continue;
        label[nb] = i;
        stack.push(nb);
      }
    }
    if (!best || n > best.n) best = { n, x0, y0, x1, y1 };
  }
  if (!best) return full;
  const area = (best.x1 - best.x0 + 1) * (best.y1 - best.y0 + 1);
  // si el "papel" es casi toda la foto o es muy chico, no recortamos
  if (area > gw * gh * 0.85 || area < gw * gh * 0.04) return full;
  const k = B / s;
  const pad = 2 * k;
  const x = Math.max(0, best.x0 * k - pad);
  const y = Math.max(0, best.y0 * k - pad);
  const x2 = Math.min(bitmap.width, (best.x1 + 1) * k + pad);
  const y2 = Math.min(bitmap.height, (best.y1 + 1) * k + pad);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) };
}

// Umbral adaptativo (Bradley): cada píxel se compara con el promedio de su zona.
function binarize(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += g[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row;
    }
  }
  const r = Math.max(8, Math.round(w / 24));
  const T = 0.15;
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
      const count = (xb - xa) * (yb - ya);
      const sum = integral[yb * (w + 1) + xb] - integral[ya * (w + 1) + xb] - integral[yb * (w + 1) + xa] + integral[ya * (w + 1) + xa];
      const p = y * w + x;
      const v = g[p] * count < sum * (1 - T) ? 0 : 255;
      d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export async function readTicketFree(file, onProgress) {
  progressCb = (m) => {
    if (!onProgress) return;
    if (m.status === "recognizing text") onProgress(`Leyendo el ticket… ${Math.round(m.progress * 100)}%`);
    else if (/load|initializ/i.test(m.status)) onProgress("Preparando el lector (la primera vez tarda un poco)…");
  };
  const [worker, canvas] = await Promise.all([getWorker(), preprocess(file)]);
  const { data } = await worker.recognize(canvas);
  progressCb = null;
  return { ...parseTicketText(data.text), rawText: data.text };
}

// ---------------------------------------------------------------------
// Interpretación del texto
// ---------------------------------------------------------------------

// Número en formato argentino ("1.234,50", "1234,50", "1,234.50", "-300,00") -> 1234.5
export function parseAmount(s) {
  if (!s) return NaN;
  let t = s.replace(/[$\s]/g, "").replace(/[Oo]/g, "0");
  const neg = /^-|-$/.test(t);
  t = t.replace(/-/g, "");
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma > lastDot) t = t.replace(/\./g, "").replace(",", ".");
  else if (lastDot > lastComma && t.length - lastDot === 3) t = t.replace(/,/g, "");
  else t = t.replace(/[.,]/g, "");
  const n = Number(t);
  return neg ? -n : n;
}

// Importe: "1.234,50", "1234,50", "29816.50", "-3783,50"
const MONEY_SRC = String.raw`-?\$?\s?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[.,]\d{2}-?`;
const MONEY_ALL = new RegExp(String.raw`(?<![\d.,])(${MONEY_SRC})(?![\d])`, "g");
// "2,00 X 5405,00", "0,750 kg x 3.200,00", "1,00 X - 6830,00" (la X a veces se lee como % o *)
const QTY_LINE = new RegExp(String.raw`^\s*(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:un|u|kg|kgs|unid)?\.?\s*[xX\*%×]\s*[-—–\s]*\$?\s*(${MONEY_SRC})`, "i");
const IVA_PAREN = /\(\s*\d{1,2}[.,]\d{2}\s*%?\s*\)/g; // "(21,00)" alícuota de IVA

const SKIP = /\b(sub\s*total|i\.?v\.?a|cuit|c\.?u\.?i\.?t|ing\.?\s*br|inicio\s*act|iibb|efectivo|tarjeta|debito|d[eé]bito|cr[eé]dito|vuelto|cambio|pago|cuotas|recibimos|su\s*vuelto|cajer|caja\b|ticket|factura|comprobante|consumidor\s*final|resp\.?\s*inscr|monotributo|domicilio|tel[eé]fono|gracias|cant\.?\s*de\s*(art|items)|art[ií]culos|items?\b|redondeo|percep|impuesto|neto|gravado|exento|nro\.|n[º°]|p\.?v\.?|cod\.?\s*aut|mercado\s*pago|qr\b|transf)/i;
const TOTAL = /\b(total(?!\s*(art|item|desc|ahorro))|importe\s*total|a\s*pagar)\b/i;
const DISCOUNT = /\b(dto|desc|descuento|bonif|promo|ahorro|oferta|2x1|3x2|2do|segunda|llevando|cupon|cup[oó]n|beneficio)\b/i;

const STORES = ["coto", "carrefour", "dia", "jumbo", "disco", "vea", "changomas", "chango más", "walmart", "la anonima", "la anónima", "cooperativa obrera", "toledo", "libertad", "makro", "vital", "maxiconsumo", "diarco", "yaguar", "nini", "easy", "farmacity", "kiosco"];

// Limpia la "basura" que el OCR deja en los bordes (manchas, bordes del papel).
function tidyLine(line) {
  let l = line.replace(IVA_PAREN, "  ").replace(/\s+$/, "");
  for (let i = 0; i < 3; i++) {
    l = l
      .replace(/^\s*\S{1,3}\s{2,}/, "") // basura corta al principio
      .replace(/\s{2,}(?!-?\$?\d+[.,]\d{2}\b)\S{1,4}\s*$/, ""); // basura corta al final (que no sea un importe)
  }
  return l.trim();
}

function lastMoney(line) {
  let m, last = null;
  MONEY_ALL.lastIndex = 0;
  while ((m = MONEY_ALL.exec(line))) last = { text: m[1], index: m.index, value: parseAmount(m[1]) };
  return last;
}

function cleanDescription(s) {
  return s
    .replace(/\s+\S{0,2}\d+[.,]\d{0,2}\b.*$/, "") // importe mal leído al final ("395,0 Sig")
    .replace(/^(?:(?=\S*[a-z”“"'.,;:¡!])\S{1,2}\s+)+/, "") // basura corta al principio ("y” ")
    .replace(/^[A-Z]\s+(?=[A-ZÁÉÍÓÚÑ]{3,})/, "") // letra suelta al principio
    .replace(/^\s*\d{8,14}\s+/, "") // código al principio
    .replace(/^\s*\d{1,6}\s+(?=[A-Za-zÁÉÍÓÚÑáéíóúñ])/, "") // código interno corto
    .replace(IVA_PAREN, " ")
    .replace(/[|_~=—–•·*+"“”`´¡!¿?]+/g, " ")
    .replace(/\s[-.:,;']+(?=\s|$)/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-.:,;']+|[\s\-.:,;']+$/g, "")
    .trim();
}

function isValidEan(code) {
  if (!/^\d{8}$|^\d{12,13}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const LETTERS = /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/;

export function parseTicketText(text) {
  const rawLines = text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/(\d)\s*([.,])\s+(\d{2})(?!\d)/g, "$1$2$3") // "240, 00" -> "240,00"
        .replace(/(\d)\s+([.,]\d{2})(?!\d)/g, "$1$2") // "240 ,00" -> "240,00"
    )
    .filter((l) => l.trim());
  const entries = rawLines
    .map((raw) => ({ hasIva: /\(\s*\d{1,2}[.,]\d{1,2}\s*%?\s*\)/.test(raw), line: tidyLine(raw) }))
    .filter((e) => e.line);
  const lines = entries.map((e) => e.line);
  const result = { store: "", date: "", total: 0, items: [] };

  // Comercio: un nombre conocido en las primeras líneas, si no la primera línea con letras.
  const head = lines.slice(0, 10).join(" ").toLowerCase();
  const known = STORES.find((s) => new RegExp(`\\b${s}\\b`).test(head));
  if (known) result.store = known.replace(/\b\w/g, (c) => c.toUpperCase());
  else {
    const first = lines.find((l) => /[A-Za-z]{3,}/.test(l) && !SKIP.test(l));
    if (first) result.store = cleanDescription(first).slice(0, 40);
  }

  // Fecha dd/mm/aa, dd-mm-aaaa, dd.mm.aaaa
  for (const l of rawLines) {
    const m = l.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/);
    if (m) {
      let [, d, mo, y] = m;
      if (y.length === 2) y = "20" + y;
      if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 && +y >= 2000 && +y <= 2100) {
        result.date = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
        break;
      }
    }
  }

  let pendingQty = null; // "2 x 1.500,00": aplica al próximo producto
  let pendingUnit = null; // solo "2430,00" (se perdió el "2,00 X"): sirve para deducir la cantidad
  for (const { line, hasIva } of entries) {
    if (TOTAL.test(line) && !/sub\s*total/i.test(line)) {
      const m = lastMoney(line);
      if (m) {
        result.total = Math.abs(m.value);
        break; // lo que sigue al total son pagos, impuestos, etc.
      }
      continue;
    }

    // código de barras solo en una línea (Día lo imprime debajo de cada producto)
    const onlyCode = line.match(/^\D{0,3}(\d{8}|\d{12,13})\D{0,3}$/);
    if (onlyCode) {
      const last = result.items.at(-1);
      if (last && !last.ean && isValidEan(onlyCode[1])) last.ean = onlyCode[1];
      continue;
    }

    const qty = line.match(QTY_LINE);
    if (qty) {
      const quantity = parseFloat(qty[1].replace(",", ".")) || 1;
      const unit = Math.abs(parseAmount(qty[2]));
      const rest = line.slice(qty[0].length);
      const restMoney = lastMoney(rest);
      const restDesc = cleanDescription(restMoney ? rest.slice(0, restMoney.index) : rest);
      if (restDesc.length >= 3 && LETTERS.test(restDesc)) {
        // todo en una línea: "2 x 1.500,00 LECHE ENTERA 3.000,00"
        result.items.push(makeItem(restDesc, quantity, restMoney ? Math.abs(restMoney.value) : unit * quantity));
      } else {
        pendingQty = { quantity, unit, lineTotal: restMoney ? Math.abs(restMoney.value) : null };
        // si la descripción vino ANTES (algunos tickets), aplicarlo al último ítem sin cantidad
        const last = result.items.at(-1);
        const expected = pendingQty.lineTotal ?? unit * quantity;
        if (last && last._needsQty && Math.abs(last.lineTotal - expected) < 1) {
          Object.assign(last, makeItem(last.description, quantity, last.lineTotal), { ean: last.ean, _needsQty: false });
          pendingQty = null;
        }
      }
      continue;
    }

    if (SKIP.test(line) || /^\s*descuentos?\s*:/i.test(line)) continue;

    const money = lastMoney(line);
    const desc = cleanDescription(money ? line.slice(0, money.index) : line);

    if (money && money.value > 0 && !LETTERS.test(line.replace(/\$/g, ""))) {
      pendingUnit = money.value; // línea con solo un precio
      continue;
    }

    if (money && (DISCOUNT.test(line) || money.value < 0)) {
      const last = result.items.at(-1);
      if (last) {
        last.lineTotal = Math.max(0, Math.round((last.lineTotal - Math.abs(money.value)) * 100) / 100);
        last.unitPrice = Math.round((last.quantity ? last.lineTotal / last.quantity : last.lineTotal) * 100) / 100;
      }
      continue;
    }
    if (!LETTERS.test(desc) || desc.length < 3) continue;

    let item = null;
    if (pendingQty) {
      // el importe de la línea manda; si no se pudo leer, se usa cantidad x precio unitario
      const expected = pendingQty.lineTotal ?? pendingQty.unit * pendingQty.quantity;
      const lineTotal = money && Math.abs(money.value) > 0 ? Math.abs(money.value) : expected;
      // si el importe leído no cierra con cantidad x unitario, confiamos en la cuenta
      const total = Math.abs(lineTotal - expected) > 1 && expected > 0 && money && !isPlausible(lineTotal, expected) ? expected : lineTotal;
      item = makeItem(desc, pendingQty.quantity, total);
      pendingQty = null;
    } else if (money) {
      const total = Math.abs(money.value);
      const q = pendingUnit ? total / pendingUnit : 1;
      if (pendingUnit && q >= 1.5 && q <= 50 && Math.abs(q - Math.round(q)) < 0.01) {
        item = makeItem(desc, Math.round(q), total);
      } else {
        item = makeItem(desc, 1, total);
        item._needsQty = true;
      }
    } else if (hasIva) {
      // se leyó el producto (tiene la alícuota de IVA) pero no el precio: queda para completar a mano
      item = makeItem(desc, 1, 0);
      item.missingPrice = true;
    }
    pendingUnit = null;
    if (!item) continue;
    const ean = (line.match(/\b(\d{8}|\d{12,13})\b/) || [])[1];
    if (ean && isValidEan(ean)) item.ean = ean;
    result.items.push(item);
  }

  result.items = result.items
    .filter((i) => (i.lineTotal > 0 || i.missingPrice) && i.lineTotal < 10_000_000)
    .map(({ _needsQty, ...i }) => i);
  return result;
}

// Un importe leído "raro" (ej: 395,00 en vez de 3965,00) se descarta si está muy lejos de cantidad x precio
function isPlausible(read, expected) {
  return read / expected > 0.8 && read / expected < 1.25;
}

function makeItem(description, quantity, lineTotal) {
  const q = quantity > 0 && quantity < 1000 ? quantity : 1;
  return {
    ean: null,
    description: description.slice(0, 60),
    quantity: Math.round(q * 1000) / 1000,
    unitPrice: Math.round((lineTotal / q) * 100) / 100,
    lineTotal: Math.round(lineTotal * 100) / 100,
  };
}
