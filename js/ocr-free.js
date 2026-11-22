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

// Mejora la foto para el OCR: escala de grises, contraste y tamaño adecuado.
async function preprocess(file) {
  const bitmap = await createImageBitmap(file);
  const targetW = Math.min(1600, Math.max(1000, bitmap.width));
  const scale = targetW / bitmap.width;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  // gris + estiramiento de contraste usando percentiles
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = g;
    hist[g]++;
  }
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - lo) * 255) / range;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
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

const MONEY = String.raw`-?\$?\s?\d{1,3}(?:[.\s]?\d{3})*[.,]\d{2}-?`;
const MONEY_END = new RegExp(`(${MONEY})\\s*[A-Z*]?\\s*$`);
const QTY_LINE = new RegExp(String.raw`^\s*(\d+(?:[.,]\d{1,3})?)\s*(?:un|u|kg|kgs|unid)?\.?\s*[xX\*]\s*\$?\s*(${MONEY})`, "i");

const SKIP = /\b(sub\s*total|i\.?v\.?a|cuit|c\.?u\.?i\.?t|ing\.?\s*br|inicio\s*act|iibb|efectivo|tarjeta|debito|d[eé]bito|cr[eé]dito|vuelto|cambio|pago|cuotas|recibimos|su\s*vuelto|cajer|caja\b|ticket|factura|comprobante|consumidor\s*final|resp\.?\s*inscr|monotributo|domicilio|tel[eé]fono|gracias|cant\.?\s*de\s*(art|items)|art[ií]culos|items?\b|redondeo|percep|impuesto|neto|gravado|exento|nro\.|n[º°]|p\.?v\.?|cod\.?\s*aut|mercado\s*pago|qr\b|transf)/i;
const TOTAL = /\b(total(?!\s*(art|item|desc|ahorro))|importe\s*total|a\s*pagar)\b/i;
const DISCOUNT = /\b(dto|desc|descuento|bonif|promo|ahorro|oferta|2x1|3x2|2do|segunda|llevando|cupon|cup[oó]n|beneficio)\b/i;

const STORES = ["coto", "carrefour", "dia", "jumbo", "disco", "vea", "changomas", "chango más", "walmart", "la anonima", "la anónima", "cooperativa obrera", "toledo", "libertad", "makro", "vital", "maxiconsumo", "diarco", "yaguar", "nini", "easy", "farmacity", "kiosco"];

function cleanDescription(s) {
  return s
    .replace(/^\s*\d{8,14}\s+/, "") // código al principio
    .replace(/^\s*\d{1,6}\s+(?=[A-Za-zÁÉÍÓÚÑáéíóúñ])/, "") // código interno corto
    .replace(/\(\s*\d{1,2}[.,]\d{2}\s*%?\s*\)/g, "") // (21,00) alícuota IVA
    .replace(/\s{2,}/g, " ")
    .replace(/[|_~=]+/g, " ")
    .trim();
}

export function parseTicketText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/\s+$/, "")
        .replace(/(\d)\s*([.,])\s+(\d{2})(?!\d)/g, "$1$2$3") // "240, 00" -> "240,00"
        .replace(/(\d)\s+([.,]\d{2})(?!\d)/g, "$1$2") // "240 ,00" -> "240,00"
    )
    .filter((l) => l.trim());
  const result = { store: "", date: "", total: 0, items: [] };

  // Comercio: un nombre conocido en las primeras líneas, si no la primera línea con letras.
  const head = lines.slice(0, 8).join(" ").toLowerCase();
  const known = STORES.find((s) => new RegExp(`\\b${s}\\b`).test(head));
  if (known) result.store = known.replace(/\b\w/g, (c) => c.toUpperCase());
  else {
    const first = lines.find((l) => /[A-Za-z]{3,}/.test(l) && !SKIP.test(l));
    if (first) result.store = first.trim().slice(0, 40);
  }

  // Fecha dd/mm/aa o dd/mm/aaaa
  for (const l of lines) {
    const m = l.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
    if (m) {
      let [, d, mo, y] = m;
      if (y.length === 2) y = "20" + y;
      if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) {
        result.date = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
        break;
      }
    }
  }

  let pendingQty = null; // línea "2 x 1.500,00" que aplica al próximo producto
  let afterTotal = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (afterTotal) continue;

    if (TOTAL.test(line) && !/sub\s*total/i.test(line)) {
      const m = line.match(MONEY_END);
      if (m) {
        result.total = Math.abs(parseAmount(m[1]));
        afterTotal = true;
      }
      continue;
    }

    const qty = line.match(QTY_LINE);
    if (qty) {
      // cantidades: "2", "0,750" (kg), "1.000" (1 kg con 3 decimales)
      const quantity = parseFloat(qty[1].replace(",", "."));
      const unit = Math.abs(parseAmount(qty[2]));
      const rest = line.slice(qty[0].length);
      const restMoney = rest.match(MONEY_END);
      const restDesc = cleanDescription(rest.replace(MONEY_END, ""));
      if (restDesc.length >= 3 && /[A-Za-z]{2,}/.test(restDesc)) {
        // todo en una línea: "2 x 1.500,00 LECHE ENTERA 3.000,00"
        const lineTotal = restMoney ? Math.abs(parseAmount(restMoney[1])) : unit * quantity;
        result.items.push(makeItem(restDesc, quantity, lineTotal));
      } else {
        pendingQty = { quantity: quantity || 1, unit };
        // a veces el importe total viene en la misma línea de cantidad y la descripción en la siguiente
        if (restMoney) pendingQty.lineTotal = Math.abs(parseAmount(restMoney[1]));
        // si la descripción vino ANTES (algunos tickets), aplicarlo al último ítem sin cantidad
        const last = result.items.at(-1);
        if (last && last._needsQty && Math.abs(last.lineTotal - (pendingQty.lineTotal ?? unit * pendingQty.quantity)) < 1) {
          last.quantity = pendingQty.quantity;
          last.unitPrice = pendingQty.unit;
          last._needsQty = false;
          pendingQty = null;
        }
      }
      continue;
    }

    if (SKIP.test(line)) continue;

    const money = line.match(MONEY_END);
    if (!money) {
      // descripción sin precio: puede ser la primera parte de un ítem cuyo precio viene después
      continue;
    }
    const amount = parseAmount(money[1]);
    const desc = cleanDescription(line.slice(0, money.index));

    if (DISCOUNT.test(line) || amount < 0) {
      const last = result.items.at(-1);
      if (last) {
        last.lineTotal = Math.max(0, last.lineTotal - Math.abs(amount));
        last.unitPrice = last.quantity ? last.lineTotal / last.quantity : last.lineTotal;
      }
      continue;
    }
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(desc)) continue;

    const ean = (line.match(/\b(\d{8}|\d{12,13})\b/) || [])[1] || null;
    let item;
    if (pendingQty) {
      const lineTotal = isFinite(amount) ? Math.abs(amount) : pendingQty.lineTotal ?? pendingQty.unit * pendingQty.quantity;
      item = makeItem(desc, pendingQty.quantity, lineTotal);
      pendingQty = null;
    } else {
      item = makeItem(desc, 1, Math.abs(amount));
      item._needsQty = true;
    }
    item.ean = ean;
    result.items.push(item);
  }

  result.items = result.items.filter((i) => i.lineTotal > 0 && i.lineTotal < 10_000_000).map(({ _needsQty, ...i }) => i);
  return result;
}

function makeItem(description, quantity, lineTotal) {
  const q = quantity > 0 && quantity < 1000 ? quantity : 1;
  return {
    description: description.slice(0, 60),
    quantity: Math.round(q * 1000) / 1000,
    unitPrice: Math.round((lineTotal / q) * 100) / 100,
    lineTotal: Math.round(lineTotal * 100) / 100,
    ean: null,
  };
}
