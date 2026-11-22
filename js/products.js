// Catálogo de productos, búsqueda por código de barras y emparejamiento con líneas del ticket.
import { db } from "./db.js";

export const CATEGORIES = [
  "Almacén", "Bebidas", "Lácteos", "Carnes", "Frutas y verduras", "Panadería",
  "Congelados", "Limpieza", "Perfumería e higiene", "Mascotas", "Bebé", "Otros",
];

const CATEGORY_RULES = [
  ["Lácteos", /dairies|dairy|milk|leche|\blch\b|yogur|yog\b|queso|cheese|manteca|butter|dulce-de-leche|crema|postre|flan/],
  ["Bebidas", /beverage|bebida|drink|water|agua|soda|gaseosa|juice|jugo|wine|vino|beer|cerv|fernet|aperitivo|cafe|coffee|\bte\b|tea|yerba|mate|coca|sprite|fanta|pepsi|isot/],
  ["Carnes", /meat|carne|pollo|chicken|fish|pescado|jamon|ham|sausage|embutido|fiambre|salchich|hamburg|milanesa|asado|picada|nalga|cuadril|vacio/],
  ["Frutas y verduras", /fruit|fruta|vegetable|verdura|hortaliza|legumbre-fresca/],
  ["Panadería", /bread|\bpan\b|pan-|galletit|biscuit|cookie|bakery|bizcoch|tostada|budin|medialuna/],
  ["Congelados", /frozen|congelado|helado|ice-cream/],
  ["Limpieza", /cleaning|limpieza|detergent|deterg|lavandina|bleach|jabon-en-polvo|jabon polvo|suavizante|household|limpiador|desinfect|esponja|trapo|insecticida/],
  ["Perfumería e higiene", /hygiene|shampoo|sham\b|acondic|soap|jabon|toothpaste|dental|pasta-dent|cepillo|deodorant|desod|\bdeo\b|talco|cosmetic|papel-higienico|papel hig|toilet|afeit|toalla|algodon|crema-corporal/],
  ["Mascotas", /pet|dog|cat|mascota|perro|gato/],
  ["Bebé", /baby|bebe|pañal|diaper/],
  ["Almacén", /groceries|pasta|fideo|rice|arroz|oil|aceite|flour|harina|sugar|azucar|cereal|avena|snack|conserva|salsa|sauce|condiment|legume|lenteja|poroto|atun|tomate|mayonesa|ketchup|mostaza|sal\b|galleta|mermelada|dulce|chocolate|cacao|polenta|pure/],
];

export function guessCategory(text) {
  const t = (text || "").toLowerCase();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  return "Otros";
}

// Busca el producto en Open Food Facts (base pública de códigos de barra).
export async function lookupBarcode(ean) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(ean)}.json?fields=product_name,product_name_es,brands,categories_tags,quantity`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.status !== 1 || !json.product) return null;
    const p = json.product;
    const name = [p.product_name_es || p.product_name, p.quantity].filter(Boolean).join(" ");
    return {
      name: name || "",
      brand: (p.brands || "").split(",")[0].trim(),
      category: guessCategory((p.categories_tags || []).join(" ") + " " + name),
    };
  } catch {
    return null;
  }
}

export async function getOrCreateProduct(ean) {
  let product = await db.get("products", ean);
  if (product) return { product, isNew: false };
  const info = await lookupBarcode(ean);
  product = {
    ean,
    name: info?.name || "",
    brand: info?.brand || "",
    category: info?.category || "Otros",
    aliases: [],
    prices: [],
  };
  return { product, isNew: true };
}

// --- Emparejamiento de texto (ticket vs nombre de producto) ---

const STOP = new Set(["de", "la", "el", "x", "con", "sin", "en", "y", "por", "un", "una"]);
export function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s) {
  return normalize(s).split(" ").filter((t) => t && !STOP.has(t));
}

// Similitud tolerante a abreviaturas de ticket ("LCH ENT" ~ "Leche entera").
export function similarity(ticketDesc, productText) {
  const a = tokens(ticketDesc);
  const b = tokens(productText);
  if (!a.length || !b.length) return 0;
  let score = 0;
  for (const ta of a) {
    let best = 0;
    for (const tb of b) {
      if (ta === tb) best = Math.max(best, 1);
      else if (tb.startsWith(ta) || ta.startsWith(tb)) best = Math.max(best, 0.8);
      else if (/^\d/.test(ta) || /^\d/.test(tb)) continue;
      else if (isAbbrev(ta, tb)) best = Math.max(best, 0.6);
    }
    score += best;
  }
  return score / a.length;
}
// "lch" es abreviatura de "leche" si sus letras aparecen en orden y empiezan igual.
function isAbbrev(abbr, word) {
  if (abbr.length < 2 || abbr[0] !== word[0]) return false;
  let i = 0;
  for (const ch of word) if (ch === abbr[i]) i++;
  return i === abbr.length;
}

// Ordena las líneas del ticket pendientes según qué tan probable es que sean este producto.
// Prioridad: alias ya aprendido > EAN impreso en el ticket > similitud de texto.
export function rankItems(items, product) {
  const aliases = new Set((product.aliases || []).map(normalize));
  const lastPrice = product.prices?.at(-1)?.price;
  return items
    .map((item, index) => {
      let score = similarity(item.description, `${product.name} ${product.brand}`);
      if (aliases.has(normalize(item.description))) score += 10;
      if (item.ean && item.ean === product.ean) score += 20;
      if (lastPrice && item.unitPrice && Math.abs(item.unitPrice - lastPrice) / lastPrice < 0.25) score += 0.3;
      return { item, index, score };
    })
    .sort((x, y) => y.score - x.score);
}

export function addPrice(product, entry) {
  product.prices = (product.prices || []).filter((p) => p.ticketId !== entry.ticketId);
  product.prices.push(entry);
  product.prices.sort((a, b) => a.date.localeCompare(b.date));
}

export const UNNAMED = "Producto sin nombre";

export function addAlias(product, description) {
  const n = normalize(description);
  if (!n || description === UNNAMED) return;
  product.aliases = product.aliases || [];
  if (!product.aliases.map(normalize).includes(n)) product.aliases.push(description);
}

export function latestPrice(product) {
  return product.prices?.at(-1)?.price ?? null;
}
