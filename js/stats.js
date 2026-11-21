// Cálculos del dashboard: gasto por mes/categoría, inflación propia y proyección.

export const monthKey = (date) => date.slice(0, 7);

export function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("es-AR", { month: "short", year: "2-digit" });
}

function addMonths(key, n) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Gasto por mes, rellenando meses sin compras con 0.
export function spendByMonth(tickets) {
  const map = new Map();
  for (const t of tickets) map.set(monthKey(t.date), (map.get(monthKey(t.date)) || 0) + ticketTotal(t));
  if (!map.size) return [];
  const keys = [...map.keys()].sort();
  const out = [];
  for (let k = keys[0]; k <= keys.at(-1); k = addMonths(k, 1)) out.push({ month: k, total: map.get(k) || 0 });
  return out;
}

export function ticketTotal(t) {
  return t.total || t.items.reduce((s, i) => s + (i.lineTotal || 0), 0);
}

export function spendByCategory(tickets, productsByEan, fromMonth) {
  const map = new Map();
  for (const t of tickets) {
    if (fromMonth && monthKey(t.date) < fromMonth) continue;
    for (const item of t.items) {
      const cat = item.ean && productsByEan[item.ean] ? productsByEan[item.ean].category : "Sin validar";
      map.set(cat, (map.get(cat) || 0) + (item.lineTotal || 0));
    }
  }
  return [...map.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

export function topProducts(tickets, productsByEan, limit = 8) {
  const map = new Map();
  for (const t of tickets) {
    for (const item of t.items) {
      const key = item.ean || "txt:" + item.description;
      const name = (item.ean && productsByEan[item.ean]?.name) || item.description;
      const cur = map.get(key) || { name, total: 0, qty: 0 };
      cur.total += item.lineTotal || 0;
      cur.qty += item.quantity || 1;
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

// Variación de precio de cada producto con al menos 2 precios.
export function priceChanges(products) {
  const out = [];
  for (const p of products) {
    const prices = p.prices || [];
    if (prices.length < 2) continue;
    const first = prices[0];
    const last = prices.at(-1);
    const days = (new Date(last.date) - new Date(first.date)) / 86400000;
    if (days < 7 || !first.price) continue;
    const change = last.price / first.price - 1;
    const monthly = Math.pow(last.price / first.price, 30 / days) - 1;
    out.push({ product: p, first, last, change, monthly, days });
  }
  return out.sort((a, b) => b.change - a.change);
}

// Inflación mensual "personal": mediana de la suba mensualizada de tus productos.
export function personalInflation(products) {
  const values = priceChanges(products).map((c) => c.monthly).filter((v) => isFinite(v)).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return Math.max(-0.2, Math.min(0.5, median));
}

// Proyección: promedio de los últimos meses completos, ajustado por inflación.
export function projectSpend(tickets, products, months, manualInflation) {
  const byMonth = spendByMonth(tickets);
  if (!byMonth.length) return null;
  const current = new Date().toISOString().slice(0, 7);
  let base = byMonth.filter((m) => m.month < current).slice(-3);
  let partialNote = false;
  if (!base.length) {
    // Solo hay datos del mes actual: extrapolamos según los días transcurridos.
    const cur = byMonth.find((m) => m.month === current);
    if (!cur) return null;
    const day = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    base = [{ month: current, total: (cur.total / Math.max(day, 1)) * daysInMonth }];
    partialNote = true;
  }
  const monthlyAvg = base.reduce((s, m) => s + m.total, 0) / base.length;
  const auto = personalInflation(products);
  const inflation = manualInflation != null ? manualInflation : auto ?? 0;
  const series = [];
  let total = 0;
  for (let i = 1; i <= months; i++) {
    const value = monthlyAvg * Math.pow(1 + inflation, i);
    total += value;
    series.push({ month: addMonths(current, i), total: value });
  }
  return { monthlyAvg, inflation, autoInflation: auto, total, series, basedOn: base.length, partialNote };
}

// Consumo: cada cuántos días consumís cada producto y cuánto te cuesta por mes.
export function consumptionRates(consumption, productsByEan) {
  const byEan = new Map();
  for (const c of consumption) {
    if (!byEan.has(c.ean)) byEan.set(c.ean, []);
    byEan.get(c.ean).push(c);
  }
  const out = [];
  for (const [ean, events] of byEan) {
    const product = productsByEan[ean];
    events.sort((a, b) => a.date.localeCompare(b.date));
    const price = product?.prices?.at(-1)?.price ?? events.at(-1).price ?? 0;
    let everyDays = null;
    if (events.length >= 2) {
      const span = (new Date(events.at(-1).date) - new Date(events[0].date)) / 86400000;
      everyDays = span / (events.length - 1);
    }
    out.push({
      ean,
      name: product?.name || ean,
      count: events.length,
      everyDays,
      monthlyCost: everyDays ? (30 / Math.max(everyDays, 0.5)) * price : null,
      lastDate: events.at(-1).date,
      price,
    });
  }
  return out.sort((a, b) => (b.monthlyCost || 0) - (a.monthlyCost || 0));
}
