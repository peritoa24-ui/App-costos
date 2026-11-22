import { db, uid, exportAll, importAll } from "./db.js";
import { readTicket, getApiKey, setApiKey } from "./ocr.js";
import { readTicketFree } from "./ocr-free.js";

// Método de lectura: "free" (gratis, en el teléfono) o "ai" (Claude, requiere API key)
function getOcrMode() {
  let m = "free";
  try { m = localStorage.getItem("ocr_mode") || "free"; } catch {}
  return m === "ai" && getApiKey() ? "ai" : "free";
}
function setOcrMode(m) { try { localStorage.setItem("ocr_mode", m); } catch {} }
import { startScanner, isValidEan } from "./scanner.js";
import {
  CATEGORIES, getOrCreateProduct, lookupBarcode, guessCategory, rankItems, addPrice, addAlias, latestPrice, normalize, UNNAMED,
} from "./products.js";
import {
  spendByMonth, spendByCategory, topProducts, priceChanges, projectSpend,
  consumptionRates, monthLabel, monthKey, ticketTotal,
} from "./stats.js";

// ---------- utilidades ----------
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const money = (n) =>
  n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString("es-AR");
const money2 = (n) =>
  n == null || isNaN(n) ? "—" : "$" + Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x) => (x == null || !isFinite(x) ? "—" : (x > 0 ? "+" : "") + (x * 100).toFixed(1).replace(".", ",") + "%");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => new Date(d + (d.length === 10 ? "T12:00:00" : "")).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric" });
const todayISO = () => new Date().toISOString().slice(0, 10);
const parseNum = (v) => {
  // acepta "1.234,50" y "1234.50"
  const s = String(v).trim();
  if (/,/.test(s)) return Number(s.replace(/\./g, "").replace(",", ".")) || 0;
  return Number(s) || 0;
};

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function openSheet(html) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").classList.remove("hidden");
  return $("#sheet-body");
}
function closeSheet() {
  $("#sheet").classList.add("hidden");
  $("#sheet-body").innerHTML = "";
}
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });

// ---------- estado ----------
const state = {
  tab: "dashboard",
  tickets: [],
  products: {},
  consumption: [],
  draft: null, // ticket en edición
  stopScanner: null,
  charts: [],
  projMonths: 3,
  manualInflation: null,
};

async function loadData() {
  const [tickets, products, consumption] = await Promise.all([
    db.getAll("tickets"), db.getAll("products"), db.getAll("consumption"),
  ]);
  state.tickets = tickets.sort((a, b) => b.date.localeCompare(a.date));
  state.products = Object.fromEntries(products.map((p) => [p.ean, p]));
  state.consumption = consumption.sort((a, b) => b.date.localeCompare(a.date));
}

function stopCamera() {
  if (state.stopScanner) { state.stopScanner(); state.stopScanner = null; }
}

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
}

const TITLES = { dashboard: "Resumen", ticket: "Ticket", consumo: "Consumo", productos: "Productos", ajustes: "Ajustes" };

function go(tab) {
  stopCamera();
  destroyCharts();
  state.tab = tab;
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#view-title").textContent = TITLES[tab];
  window.scrollTo(0, 0);
  render();
}
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));

function render() {
  ({ dashboard: renderDashboard, ticket: renderTicket, consumo: renderConsumo, productos: renderProductos, ajustes: renderAjustes })[state.tab]();
}

// =====================================================================
// RESUMEN / DASHBOARD
// =====================================================================
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderDashboard() {
  const { tickets, products, consumption } = state;
  if (!tickets.length) {
    view.innerHTML = `
      <div class="card empty">
        <div class="big">🧾</div>
        <p><strong>Todavía no cargaste tickets.</strong></p>
        <p>Sacale una foto a tu primer ticket del súper y validalo escaneando los productos.</p>
        <button class="btn-primary btn-block" id="go-ticket">Cargar mi primer ticket</button>
      </div>`;
    $("#go-ticket").onclick = () => go("ticket");
    return;
  }
  const productList = Object.values(products);
  const months = spendByMonth(tickets);
  const cur = todayISO().slice(0, 7);
  const thisMonth = months.find((m) => m.month === cur)?.total || 0;
  const prev = months.filter((m) => m.month < cur).at(-1);
  const proj = projectSpend(tickets, productList, state.projMonths, state.manualInflation);
  const changes = priceChanges(productList);
  const cats = spendByCategory(tickets, products, months.length > 1 ? months.at(-Math.min(3, months.length)).month : null);
  const tops = topProducts(tickets, products);
  const rates = consumptionRates(consumption, products).filter((r) => r.monthlyCost);
  const validated = tickets.reduce((acc, t) => {
    acc.total += t.items.length;
    acc.ok += t.items.filter((i) => i.ean).length;
    return acc;
  }, { total: 0, ok: 0 });

  view.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="label">Gastado este mes</div><div class="value">${money(thisMonth)}</div>
        <div class="sub">${((n) => n + (n === 1 ? " ticket" : " tickets"))(tickets.filter((t) => monthKey(t.date) === cur).length)}</div></div>
      <div class="tile"><div class="label">Mes anterior</div><div class="value">${money(prev?.total)}</div>
        <div class="sub">${prev ? monthLabel(prev.month) : "sin datos"}</div></div>
      <div class="tile"><div class="label">Tu inflación mensual</div><div class="value">${proj?.autoInflation != null ? pct(proj.autoInflation) : "—"}</div>
        <div class="sub">${proj?.autoInflation != null ? "según tus productos" : "necesita precios repetidos"}</div></div>
      <div class="tile"><div class="label">Productos validados</div><div class="value">${validated.total ? Math.round((validated.ok / validated.total) * 100) : 0}%</div>
        <div class="sub">${validated.ok} de ${validated.total} líneas</div></div>
    </div>

    <div class="card">
      <h2>Proyección de gasto</h2>
      <div class="segmented" id="proj-seg">
        ${[1, 3, 6, 12].map((m) => `<button data-m="${m}" class="${m === state.projMonths ? "active" : ""}">${m} ${m === 1 ? "mes" : "meses"}</button>`).join("")}
      </div>
      ${proj ? `
        <div class="tiles" style="margin:12px 0 4px">
          <div class="tile"><div class="label">Total proyectado</div><div class="value">${money(proj.total)}</div>
            <div class="sub">próximos ${state.projMonths} ${state.projMonths === 1 ? "mes" : "meses"}</div></div>
          <div class="tile"><div class="label">Base mensual</div><div class="value">${money(proj.monthlyAvg)}</div>
            <div class="sub">${proj.partialNote ? "estimado con el mes en curso" : `promedio de ${proj.basedOn} ${proj.basedOn === 1 ? "mes" : "meses"}`}</div></div>
        </div>
        <label class="field small" style="margin-top:8px"><span>Inflación mensual usada: ${pct(proj.inflation)} ${state.manualInflation == null ? "(automática)" : "(manual)"}</span>
          <div class="row"><input id="infl" inputmode="decimal" placeholder="Ej: 3 para 3%" value="${state.manualInflation != null ? (state.manualInflation * 100).toString().replace(".", ",") : ""}" />
          <button class="btn-sm" id="infl-apply">Usar</button>${state.manualInflation != null ? `<button class="btn-sm" id="infl-auto">Auto</button>` : ""}</div>
        </label>
        <div class="chart-box tall"><canvas id="chart-months" aria-label="Gasto por mes y proyección"></canvas></div>
        <details><summary>Ver como tabla</summary>
          <table class="data">${months.map((m) => `<tr><td>${monthLabel(m.month)}</td><td class="num">${money(m.total)}</td></tr>`).join("")}
          ${proj.series.map((m) => `<tr><td>${monthLabel(m.month)} <span class="badge">proyectado</span></td><td class="num">${money(m.total)}</td></tr>`).join("")}</table>
        </details>` : `<p class="muted">Cargá al menos un ticket para proyectar.</p>`}
    </div>

    <div class="card">
      <h2>Gasto por categoría</h2>
      <p class="muted small" style="margin-top:-6px">${months.length > 1 ? "Últimos " + Math.min(3, months.length) + " meses" : "Este período"}. "Sin validar" son líneas del ticket que todavía no escaneaste.</p>
      <div class="chart-box" style="height:${Math.max(120, cats.length * 34 + 30)}px"><canvas id="chart-cats" aria-label="Gasto por categoría"></canvas></div>
    </div>

    <div class="card">
      <h2>En qué gastás más</h2>
      <ul class="list">${tops.map((t) => `<li><div class="grow"><div class="name">${esc(t.name)}</div><div class="muted small">${Number(t.qty.toFixed(2)).toLocaleString("es-AR")} u.</div></div><div class="num">${money(t.total)}</div></li>`).join("")}</ul>
    </div>

    <div class="card">
      <h2>Lo que más aumentó</h2>
      ${changes.length ? `<ul class="list">${changes.slice(0, 8).map((c) => `
        <li><div class="grow"><div class="name">${esc(c.product.name || c.product.ean)}</div>
          <div class="muted small">${money2(c.first.price)} → ${money2(c.last.price)} · ${Math.round(c.days)} días</div></div>
          <div class="num ${c.change > 0 ? "up" : "down"}">${pct(c.change)}</div></li>`).join("")}</ul>`
        : `<p class="muted">Cuando compres el mismo producto en dos tickets distintos (con al menos una semana de diferencia) vas a ver acá cuánto subió.</p>`}
    </div>

    ${rates.length ? `<div class="card">
      <h2>Costo de lo que consumís</h2>
      <ul class="list">${rates.slice(0, 8).map((r) => `<li><div class="grow"><div class="name">${esc(r.name)}</div>
        <div class="muted small">uno cada ${r.everyDays.toFixed(1).replace(".", ",")} días</div></div><div class="num">${money(r.monthlyCost)}/mes</div></li>`).join("")}</ul>
    </div>` : ""}
  `;

  view.querySelectorAll("#proj-seg button").forEach((b) => (b.onclick = () => { state.projMonths = Number(b.dataset.m); go("dashboard"); }));
  const inflApply = $("#infl-apply");
  if (inflApply) inflApply.onclick = () => {
    const v = $("#infl").value.trim();
    state.manualInflation = v === "" ? null : parseNum(v) / 100;
    go("dashboard");
  };
  const inflAuto = $("#infl-auto");
  if (inflAuto) inflAuto.onclick = () => { state.manualInflation = null; go("dashboard"); };

  drawCharts(months, proj, cats);
}

function drawCharts(months, proj, cats) {
  if (!window.Chart) { setTimeout(() => state.tab === "dashboard" && drawCharts(months, proj, cats), 200); return; }
  const Chart = window.Chart;
  const ink = cssVar("--text-2");
  const grid = cssVar("--grid");
  const series = cssVar("--series-1");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = ink;
  const tooltip = { callbacks: { label: (ctx) => " " + money(ctx.parsed.y ?? ctx.parsed.x) } };

  const mCanvas = $("#chart-months");
  if (mCanvas && proj) {
    const labels = [...months.map((m) => monthLabel(m.month)), ...proj.series.map((m) => monthLabel(m.month))];
    const real = [...months.map((m) => m.total), ...proj.series.map(() => null)];
    const projected = [...months.map(() => null), ...proj.series.map((m) => m.total)];
    state.charts.push(new Chart(mCanvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Gastado", data: real, backgroundColor: series, borderRadius: 4, maxBarThickness: 28, skipNull: true },
          { label: "Proyectado", data: projected, backgroundColor: series + "55", borderColor: series, borderWidth: 1.5, borderDash: [4, 3], borderRadius: 4, maxBarThickness: 28, skipNull: true },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: "top", align: "start", labels: { boxWidth: 12, boxHeight: 12 } }, tooltip },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, grid: { color: grid }, border: { display: false }, ticks: { callback: (v) => compact(v) } },
        },
      },
    }));
  }

  const cCanvas = $("#chart-cats");
  if (cCanvas && cats.length) {
    state.charts.push(new Chart(cCanvas, {
      type: "bar",
      data: { labels: cats.map((c) => c.category), datasets: [{ label: "Gasto", data: cats.map((c) => c.total), backgroundColor: series, borderRadius: 4, maxBarThickness: 18 }] },
      options: {
        indexAxis: "y",
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => " " + money(ctx.parsed.x) } } },
        scales: {
          x: { grid: { color: grid }, border: { display: false }, ticks: { callback: (v) => compact(v) } },
          y: { grid: { display: false } },
        },
      },
    }));
  }
}
function compact(v) {
  if (v >= 1e6) return "$" + (v / 1e6).toLocaleString("es-AR", { maximumFractionDigits: 1 }) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toLocaleString("es-AR", { maximumFractionDigits: 0 }) + "k";
  return "$" + v;
}

// =====================================================================
// TICKET: foto -> revisión -> validación con códigos -> guardar
// =====================================================================
function newDraft(data = {}) {
  return {
    id: uid(),
    date: data.date || todayISO(),
    store: data.store || "",
    total: data.total || 0,
    items: (data.items || []).map((i) => ({ ...i, id: uid(), ean: i.ean && isValidEan(i.ean) ? i.ean : null, auto: false })),
    rawText: data.rawText || "",
    extras: [], // productos escaneados que no figuran en el ticket
    step: "review",
  };
}

// Usa lo aprendido: si una línea coincide con un alias o EAN ya conocido, se valida sola.
function autoMatchDraft(draft) {
  const products = Object.values(state.products);
  for (const item of draft.items) {
    if (item.ean) {
      item.auto = true;
      const known = state.products[item.ean];
      if (item.description === UNNAMED && known?.name) item.description = known.name;
      continue;
    }
    if (item.description === UNNAMED) continue;
    const n = normalize(item.description);
    const p = products.find((p) => (p.aliases || []).some((a) => normalize(a) === n));
    if (p) { item.ean = p.ean; item.auto = true; }
  }
}

function renderTicket() {
  const d = state.draft;
  if (!d) return renderTicketHome();
  if (d.step === "review") return renderReview();
  if (d.step === "validate") return renderValidate();
}

function renderTicketHome() {
  const mode = getOcrMode();
  view.innerHTML = `
    <div class="card stack">
      <h2>Nuevo ticket</h2>
      <label class="btn btn-primary btn-block" for="photo">📷 Sacar foto del ticket</label>
      <input id="photo" type="file" accept="image/*" capture="environment" class="hidden" />
      <label class="btn btn-block" for="photo-gal">🖼️ Elegir foto de la galería</label>
      <input id="photo-gal" type="file" accept="image/*" class="hidden" />
      <button class="btn-block" id="manual">✍️ Cargar a mano</button>
      <p class="small muted">${mode === "ai" ? "Lectura con IA (Claude)." : "Lectura gratis en el teléfono."} Sacá la foto con buena luz, con el ticket estirado y derecho, que se vea entero. Después vas a poder corregir lo que haga falta. <a href="#" id="to-settings">Cambiar método</a></p>
      <div id="ocr-status"></div>
    </div>
    <div class="card">
      <h2>Tickets cargados</h2>
      ${state.tickets.length ? `<ul class="list">${state.tickets.map((t) => {
        const ok = t.items.filter((i) => i.ean).length;
        return `<li data-id="${t.id}"><div class="grow"><div class="name">${esc(t.store || "Sin comercio")}</div>
          <div class="muted small">${fmtDate(t.date)} · ${t.items.length} ítems · <span class="badge ${ok === t.items.length ? "ok" : "warn"}">${ok}/${t.items.length} validados</span></div></div>
          <div class="num">${money(ticketTotal(t))}</div></li>`;
      }).join("")}</ul>` : `<p class="muted">Todavía no hay tickets.</p>`}
    </div>`;

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const status = $("#ocr-status");
    const setStatus = (msg) => (status.innerHTML = `<p><span class="spinner"></span> ${esc(msg)}</p>`);
    setStatus("Leyendo el ticket… (puede tardar unos segundos)");
    view.querySelectorAll("button, label.btn").forEach((b) => (b.style.pointerEvents = "none"));
    try {
      const data = getOcrMode() === "ai" ? await readTicket(file) : await readTicketFree(file, setStatus);
      state.draft = newDraft(data);
      autoMatchDraft(state.draft);
      if (!state.draft.items.length) {
        state.draft.items.push({ id: uid(), description: "", quantity: 1, unitPrice: 0, lineTotal: 0, ean: null });
        toast("No pude reconocer productos en la foto. Cargalos a mano o probá otra foto.", 4500);
      }
      renderTicket();
    } catch (err) {
      status.innerHTML = `<p class="up">${esc(err.message || err)}</p>`;
      view.querySelectorAll("button, label.btn").forEach((b) => (b.style.pointerEvents = ""));
    }
  };
  $("#photo").onchange = onFile;
  $("#photo-gal").onchange = onFile;
  $("#manual").onclick = () => { state.draft = newDraft({ items: [{ description: "", quantity: 1, unitPrice: 0, lineTotal: 0 }] }); renderTicket(); };
  const ts = $("#to-settings");
  if (ts) ts.onclick = (e) => { e.preventDefault(); go("ajustes"); };
  view.querySelectorAll(".list li[data-id]").forEach((li) => (li.onclick = () => openTicketDetail(li.dataset.id)));
}

function openTicketDetail(id) {
  const t = state.tickets.find((x) => x.id === id);
  if (!t) return;
  const body = openSheet(`
    <h2 style="margin-top:0">${esc(t.store || "Ticket")}</h2>
    <p class="muted">${fmtDate(t.date)} · Total ${money2(ticketTotal(t))}</p>
    <ul class="list">${t.items.map((i) => `<li><div class="grow"><div class="name">${esc((i.ean && state.products[i.ean]?.name) || i.description)}</div>
      <div class="muted small">${esc(i.description)} · ${i.quantity} × ${money2(i.unitPrice)} ${i.ean ? `<span class="badge ok">✓ ${i.ean}</span>` : `<span class="badge warn">sin validar</span>`}</div></div>
      <div class="num">${money2(i.lineTotal)}</div></li>`).join("")}</ul>
    <div class="row" style="margin-top:12px">
      <button class="grow" id="t-edit">Editar / validar</button>
      <button class="btn-danger" id="t-del">Borrar</button>
      <button id="t-close">Cerrar</button>
    </div>`);
  $("#t-close", body).onclick = closeSheet;
  $("#t-edit", body).onclick = () => {
    closeSheet();
    state.draft = { ...structuredClone(t), items: t.items.map((i) => ({ ...i, id: i.id || uid() })), extras: [], step: "review", editing: true };
    go("ticket");
  };
  $("#t-del", body).onclick = async () => {
    if (!confirm("¿Borrar este ticket? Los precios que aportó también se quitan.")) return;
    await deleteTicket(t);
    closeSheet();
    toast("Ticket borrado");
    render();
  };
}

async function deleteTicket(t) {
  for (const p of Object.values(state.products)) {
    const before = (p.prices || []).length;
    p.prices = (p.prices || []).filter((x) => x.ticketId !== t.id);
    if (p.prices.length !== before) await db.put("products", p);
  }
  await db.delete("tickets", t.id);
  await loadData();
}

function itemsSum(d) {
  return d.items.reduce((s, i) => s + (Number(i.lineTotal) || 0), 0);
}

function renderReview() {
  const d = state.draft;
  const sum = itemsSum(d);
  const diff = d.total ? d.total - sum : 0;
  view.innerHTML = `
    <div class="card">
      <h2>1. Revisá lo que se leyó</h2>
      <div class="row">
        <label class="field grow"><span>Comercio</span><input id="d-store" value="${esc(d.store)}" placeholder="Ej: Coto" /></label>
        <label class="field" style="width:150px"><span>Fecha</span><input id="d-date" type="date" value="${esc(d.date)}" /></label>
      </div>
      <label class="field"><span>Total del ticket</span><input id="d-total" inputmode="decimal" value="${d.total || ""}" /></label>
      <p class="small muted" style="margin:4px 0 0">Cada producto: descripción, cantidad e importe total de la línea.</p>
      <div id="items">${d.items.map((i) => `
        <div class="item-edit" data-id="${i.id}">
          <input data-f="description" value="${esc(i.description)}" placeholder="Producto" />
          <input data-f="quantity" inputmode="decimal" value="${i.quantity}" aria-label="Cantidad" />
          <input data-f="lineTotal" inputmode="decimal" value="${i.lineTotal || ""}" aria-label="Importe" placeholder="Importe" />
          <span class="small muted num">${i.quantity && i.lineTotal ? money2(i.lineTotal / i.quantity) + " c/u" : ""}</span>
          <button class="x" data-del aria-label="Quitar">✕</button>
          ${!i.lineTotal ? `<div class="status"><span class="badge warn">Falta el importe: miralo en el ticket</span></div>` : ""}
          ${i.ean ? `<div class="status"><span class="badge ok">✓ ${state.products[i.ean]?.name ? esc(state.products[i.ean].name) : "código " + i.ean}${i.auto ? " · reconocido" : ""}</span></div>` : ""}
        </div>`).join("")}</div>
      <button class="btn-sm" id="add-item" style="margin-top:8px">+ Agregar línea</button>
      ${d.rawText ? `<details style="margin-top:10px"><summary>Ver el texto que se leyó de la foto</summary><pre class="small" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(d.rawText)}</pre></details>` : ""}
      <p class="small ${Math.abs(diff) > 1 ? "up" : "muted"}" id="sum-line">Suma de líneas: ${money2(sum)}${Math.abs(diff) > 1 ? ` · diferencia con el total: ${money2(diff)}` : d.total ? " ✓ coincide con el total" : ""}</p>
    </div>
    <div class="stack">
      <button class="btn-primary btn-block" id="to-validate">2. Validar escaneando códigos →</button>
      <button class="btn-block" id="save-now">Guardar sin validar</button>
      <button class="btn-block btn-danger" id="cancel">Descartar</button>
    </div>`;

  $("#d-store").oninput = (e) => (d.store = e.target.value);
  $("#d-date").onchange = (e) => (d.date = e.target.value || todayISO());
  $("#d-total").onchange = (e) => { d.total = parseNum(e.target.value); renderReview(); };
  view.querySelectorAll(".item-edit[data-id]").forEach((row) => {
    const item = d.items.find((i) => i.id === row.dataset.id);
    row.querySelectorAll("input").forEach((inp) => {
      inp.onchange = () => {
        const f = inp.dataset.f;
        if (f === "description") item.description = inp.value;
        else item[f] = parseNum(inp.value);
        if (f === "quantity" || f === "lineTotal") item.unitPrice = item.quantity ? item.lineTotal / item.quantity : item.lineTotal;
        if (f !== "description") renderReview();
      };
    });
    row.querySelector("[data-del]").onclick = () => { d.items = d.items.filter((i) => i !== item); renderReview(); };
  });
  $("#add-item").onclick = () => { d.items.push({ id: uid(), description: "", quantity: 1, unitPrice: 0, lineTotal: 0, ean: null }); renderReview(); };
  $("#to-validate").onclick = () => {
    d.items = d.items.filter((i) => i.description.trim() || i.lineTotal);
    if (!d.items.length) return toast("Agregá al menos un producto");
    d.step = "validate";
    renderTicket();
  };
  $("#save-now").onclick = saveDraft;
  $("#cancel").onclick = () => { if (confirm("¿Descartar este ticket?")) { state.draft = null; renderTicket(); } };
}

function renderValidate() {
  const d = state.draft;
  const done = d.items.filter((i) => i.ean).length;
  const pending = d.items.filter((i) => !i.ean);
  view.innerHTML = `
    <div class="card">
      <h2>2. Escaneá los productos</h2>
      <p class="small muted" style="margin-top:-6px">Apuntá la cámara al código de barras de cada producto que compraste.</p>
      <div class="scanner" id="scanner"><div class="empty" style="color:#bbb">Tocá "Abrir cámara"</div></div>
      <div class="row" style="margin-top:8px">
        <button class="grow btn-primary" id="cam">${state.stopScanner ? "Pausar cámara" : "Abrir cámara"}</button>
        <button id="type-code">Tipear código</button>
      </div>
      <div class="progress" style="margin-top:12px"><div style="width:${(done / d.items.length) * 100}%"></div></div>
      <p class="small"><strong>${done} de ${d.items.length}</strong> productos validados</p>
    </div>
    <div class="card">
      <h3 style="margin-top:0">Pendientes (${pending.length})</h3>
      ${pending.length ? `<ul class="list">${pending.map((i) => `<li><div class="grow name">${esc(i.description)}</div><div class="num">${money2(i.lineTotal)}</div></li>`).join("")}</ul>` : `<p class="down">✓ Todo el ticket está validado</p>`}
      ${d.items.some((i) => i.ean) ? `<h3>Validados</h3><ul class="list">${d.items.filter((i) => i.ean).map((i) => `
        <li data-id="${i.id}"><div class="grow"><div class="name">${esc(state.products[i.ean]?.name || d._names?.[i.ean] || i.description)}</div>
        <div class="muted small">${esc(i.description)} · ${i.ean}</div></div><button class="btn-sm" data-undo>Deshacer</button></li>`).join("")}</ul>` : ""}
      ${d.extras.length ? `<h3>Escaneados que no están en el ticket</h3><ul class="list">${d.extras.map((x) => `<li><div class="grow"><div class="name">${esc(x.name || x.ean)}</div><div class="muted small">${x.ean}</div></div><span class="badge bad">no figura</span></li>`).join("")}</ul>` : ""}
    </div>
    <div class="stack">
      <button class="btn-primary btn-block" id="save">Guardar ticket</button>
      <button class="btn-block" id="back">← Volver a editar</button>
    </div>`;

  // reabrir cámara si estaba abierta
  if (state.stopScanner) { state.stopScanner(); state.stopScanner = null; openCam(); }
  $("#cam").onclick = () => { if (state.stopScanner) { stopCamera(); renderValidate(); } else openCam(); };
  $("#type-code").onclick = () => {
    const code = prompt("Código de barras (números):");
    if (code) onScanTicket(code.replace(/\D/g, ""));
  };
  view.querySelectorAll("li[data-id] [data-undo]").forEach((b) => (b.onclick = () => {
    const item = d.items.find((i) => i.id === b.closest("li").dataset.id);
    item.ean = null; item.auto = false;
    renderValidate();
  }));
  $("#save").onclick = () => {
    const pend = d.items.filter((i) => !i.ean).length;
    if (pend && !confirm(`Quedan ${pend} productos sin validar. ¿Guardar igual?`)) return;
    saveDraft();
  };
  $("#back").onclick = () => { stopCamera(); d.step = "review"; renderTicket(); };

  async function openCam() {
    try {
      $("#cam").textContent = "Pausar cámara";
      state.stopScanner = await startScanner($("#scanner"), onScanTicket);
    } catch (err) {
      $("#cam").textContent = "Abrir cámara";
      toast("No se pudo abrir la cámara: " + (err.message || err));
    }
  }
}

let scanBusy = false;
async function onScanTicket(code) {
  const d = state.draft;
  if (!d || scanBusy || $("#sheet").classList.contains("hidden") === false) return;
  if (!/^\d{6,14}$/.test(code)) return toast("Código no válido");
  scanBusy = true;
  try {
    const { product } = await getOrCreateProduct(code);
    d._products = d._products || {};
    d._products[code] = d._products[code] || product;
    const prod = d._products[code];
    const pending = d.items.filter((i) => !i.ean);
    const already = d.items.filter((i) => i.ean === code).length;
    const ranked = rankItems(pending, prod);

    // Coincidencia segura (alias aprendido o EAN impreso): se asigna sola.
    if (ranked[0] && ranked[0].score >= 10) {
      assign(ranked[0].item, prod);
      toast(`✓ ${prod.name || ranked[0].item.description}`);
      return renderValidate();
    }
    askMatch(prod, ranked, already);
  } finally {
    scanBusy = false;
  }
}

function assign(item, prod) {
  item.ean = prod.ean;
  if (item.description === UNNAMED && prod.name) item.description = prod.name;
  if (!prod.name && item.description !== UNNAMED) prod.name = item.description;
  state.draft._names = { ...(state.draft._names || {}), [prod.ean]: prod.name };
}

function askMatch(prod, ranked, already) {
  const d = state.draft;
  const body = openSheet(`
    <p class="muted small" style="margin:0">Código ${prod.ean}${already ? ` · ya validaste ${already} ${already === 1 ? "unidad" : "unidades"}` : ""}</p>
    <label class="field" style="margin-top:8px"><span>Producto</span><input id="p-name" value="${esc(prod.name)}" placeholder="Nombre del producto" /></label>
    <label class="field"><span>Categoría</span><select id="p-cat">${CATEGORIES.map((c) => `<option ${c === prod.category ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <h3>¿Cuál línea del ticket es?</h3>
    ${ranked.length ? ranked.slice(0, 8).map((r, idx) => `
      <button class="choice ${idx === 0 && r.score > 0.4 ? "btn-primary" : ""}" data-i="${r.index}">
        ${esc(r.item.description)} <span class="num">${money2(r.item.lineTotal)}</span></button>`).join("")
      : `<p class="muted">No quedan líneas pendientes.</p>`}
    <button class="choice btn-danger" id="not-in">No está en el ticket</button>
    <button class="choice" id="cancel-m">Cancelar</button>`);
  const pending = d.items.filter((i) => !i.ean);
  const readForm = () => {
    prod.name = $("#p-name", body).value.trim();
    prod.category = $("#p-cat", body).value;
  };
  body.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => {
    readForm();
    const item = pending[Number(b.dataset.i)];
    assign(item, prod);
    addAlias(prod, item.description);
    closeSheet();
    renderValidate();
  }));
  $("#not-in", body).onclick = () => {
    readForm();
    if (!d.extras.some((x) => x.ean === prod.ean)) d.extras.push({ ean: prod.ean, name: prod.name });
    closeSheet();
    renderValidate();
  };
  $("#cancel-m", body).onclick = closeSheet;
}

async function saveDraft() {
  const d = state.draft;
  stopCamera();
  d.items = d.items.filter((i) => i.description.trim() || i.lineTotal);
  for (const i of d.items) if (!i.unitPrice) i.unitPrice = i.quantity ? i.lineTotal / i.quantity : i.lineTotal;

  // si se está editando un ticket existente, quitamos sus precios anteriores
  if (d.editing) {
    for (const p of Object.values(state.products)) {
      if ((p.prices || []).some((x) => x.ticketId === d.id)) {
        p.prices = p.prices.filter((x) => x.ticketId !== d.id);
        await db.put("products", p);
      }
    }
  }

  const ticket = {
    id: d.id, date: d.date, store: d.store.trim(), total: d.total || itemsSum(d),
    items: d.items.map(({ id, description, quantity, unitPrice, lineTotal, ean }) => ({ id, description, quantity, unitPrice, lineTotal, ean: ean || null })),
    createdAt: d.createdAt || new Date().toISOString(),
  };
  // Productos nuevos (con código pero que no están en el catálogo): buscamos nombre y categoría por el código
  const newEans = [...new Set(ticket.items.filter((i) => i.ean && !state.products[i.ean] && !d._products?.[i.ean]).map((i) => i.ean))];
  const looked = Object.fromEntries(await Promise.all(newEans.map(async (e) => [e, await lookupBarcode(e)])));

  // Actualiza catálogo y precios
  const touched = new Map();
  for (const item of ticket.items) {
    if (!item.ean) continue;
    let prod = touched.get(item.ean) || state.products[item.ean] || d._products?.[item.ean];
    if (!prod) {
      const info = looked[item.ean];
      const fromTicket = item.description !== UNNAMED ? item.description : "";
      prod = {
        ean: item.ean,
        name: info?.name || fromTicket || UNNAMED,
        brand: info?.brand || "",
        category: info?.name ? info.category : guessCategory(fromTicket),
        aliases: [],
        prices: [],
      };
    }
    if (d._products?.[item.ean]) Object.assign(prod, { name: d._products[item.ean].name || prod.name, category: d._products[item.ean].category, aliases: d._products[item.ean].aliases });
    if (!prod.name) prod.name = item.description;
    if (item.description === UNNAMED) item.description = prod.name;
    addAlias(prod, item.description);
    addPrice(prod, { date: ticket.date, price: Math.round(item.unitPrice * 100) / 100, store: ticket.store, ticketId: ticket.id });
    touched.set(item.ean, prod);
  }
  await db.put("tickets", ticket);
  for (const p of touched.values()) await db.put("products", p);

  state.draft = null;
  await loadData();
  toast("Ticket guardado ✓");
  go("dashboard");
}

// =====================================================================
// CONSUMO: escanear lo que abrís / terminás
// =====================================================================
function renderConsumo() {
  const rates = consumptionRates(state.consumption, state.products);
  view.innerHTML = `
    <div class="card">
      <h2>Registrar consumo</h2>
      <p class="small muted" style="margin-top:-6px">Escaneá un producto cuando lo abrís o lo terminás. Así la app aprende cada cuánto lo consumís y cuánto te cuesta por mes, con el último precio que pagaste.</p>
      <div class="scanner" id="scanner"><div class="empty" style="color:#bbb">Tocá "Abrir cámara"</div></div>
      <div class="row" style="margin-top:8px">
        <button class="grow btn-primary" id="cam">Abrir cámara</button>
        <button id="type-code">Tipear código</button>
      </div>
    </div>
    <div class="card">
      <h2>Ritmo de consumo</h2>
      ${rates.length ? `<ul class="list">${rates.map((r) => `<li><div class="grow"><div class="name">${esc(r.name)}</div>
        <div class="muted small">${r.count} registros${r.everyDays ? ` · uno cada ${r.everyDays.toFixed(1).replace(".", ",")} días` : " · necesita 2 registros"} · último ${fmtDate(r.lastDate.slice(0, 10))}</div></div>
        <div class="num right">${r.monthlyCost ? money(r.monthlyCost) + "/mes" : money2(r.price)}</div></li>`).join("")}</ul>` : `<p class="muted">Todavía no registraste consumos.</p>`}
    </div>
    ${state.consumption.length ? `<div class="card"><h2>Últimos registros</h2><ul class="list">${state.consumption.slice(0, 15).map((c) => `
      <li data-id="${c.id}"><div class="grow"><div class="name">${esc(state.products[c.ean]?.name || c.ean)}</div><div class="muted small">${new Date(c.date).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</div></div>
      <button class="btn-sm" data-del>Borrar</button></li>`).join("")}</ul></div>` : ""}`;

  const openCam = async () => {
    try {
      $("#cam").textContent = "Pausar cámara";
      state.stopScanner = await startScanner($("#scanner"), onScanConsumo);
    } catch (err) {
      $("#cam").textContent = "Abrir cámara";
      toast("No se pudo abrir la cámara: " + (err.message || err));
    }
  };
  $("#cam").onclick = () => { if (state.stopScanner) { stopCamera(); renderConsumo(); } else openCam(); };
  $("#type-code").onclick = () => { const c = prompt("Código de barras:"); if (c) onScanConsumo(c.replace(/\D/g, "")); };
  view.querySelectorAll("li[data-id] [data-del]").forEach((b) => (b.onclick = async () => {
    await db.delete("consumption", b.closest("li").dataset.id);
    await loadData();
    renderConsumo();
  }));
}

let lastConsumo = { code: "", at: 0 };
async function onScanConsumo(code) {
  if (!/^\d{6,14}$/.test(code)) return toast("Código no válido");
  if (code === lastConsumo.code && Date.now() - lastConsumo.at < 8000) return; // evita registros duplicados
  lastConsumo = { code, at: Date.now() };
  let { product, isNew } = await getOrCreateProduct(code);
  if (isNew) {
    const name = prompt(`Producto nuevo (${code}). ¿Cómo se llama?`, product.name || "");
    if (name === null) return;
    product.name = name.trim() || code;
    await db.put("products", product);
  }
  await db.put("consumption", { id: uid(), ean: code, date: new Date().toISOString(), price: latestPrice(product) });
  await loadData();
  toast(`Consumo registrado: ${product.name || code}`);
  const wasOpen = !!state.stopScanner;
  stopCamera();
  renderConsumo();
  if (wasOpen) $("#cam").click();
}

// =====================================================================
// PRODUCTOS
// =====================================================================
function renderProductos() {
  const list = Object.values(state.products).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  view.innerHTML = `
    <div class="card">
      <input id="search" placeholder="Buscar producto o código…" />
      <ul class="list" id="plist" style="margin-top:8px"></ul>
      ${list.length ? "" : `<p class="muted">Los productos aparecen acá cuando validás tickets escaneando códigos.</p>`}
    </div>`;
  const draw = (q = "") => {
    const nq = normalize(q);
    $("#plist").innerHTML = list
      .filter((p) => !nq || normalize(`${p.name} ${p.brand} ${p.ean}`).includes(nq))
      .map((p) => {
        const prices = p.prices || [];
        const last = prices.at(-1);
        const ch = prices.length >= 2 && prices[0].price ? last.price / prices[0].price - 1 : null;
        return `<li data-ean="${p.ean}"><div class="grow"><div class="name">${esc(p.name || p.ean)}</div>
          <div class="muted small">${esc(p.category)} · ${prices.length} ${prices.length === 1 ? "precio" : "precios"}</div></div>
          <div class="right"><div class="num">${money2(last?.price)}</div>${ch != null ? `<div class="small num ${ch > 0 ? "up" : "down"}">${pct(ch)}</div>` : ""}</div></li>`;
      }).join("");
    view.querySelectorAll("#plist li").forEach((li) => (li.onclick = () => openProduct(li.dataset.ean)));
  };
  $("#search").oninput = (e) => draw(e.target.value);
  draw();
}

function openProduct(ean) {
  const p = state.products[ean];
  const body = openSheet(`
    <p class="muted small" style="margin:0">Código ${p.ean}</p>
    <label class="field" style="margin-top:8px"><span>Nombre</span><input id="p-name" value="${esc(p.name)}" /></label>
    <label class="field"><span>Categoría</span><select id="p-cat">${CATEGORIES.map((c) => `<option ${c === p.category ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <h3>Historial de precios</h3>
    ${(p.prices || []).length ? `<table class="data"><tr><th>Fecha</th><th>Comercio</th><th class="num">Precio</th></tr>
      ${[...p.prices].reverse().map((x) => `<tr><td>${fmtDate(x.date)}</td><td>${esc(x.store || "—")}</td><td class="num">${money2(x.price)}</td></tr>`).join("")}</table>` : `<p class="muted">Sin precios todavía.</p>`}
    <h3>Cómo figura en los tickets</h3>
    <p class="small">${(p.aliases || []).map(esc).join(" · ") || "—"}</p>
    <div class="row" style="margin-top:12px"><button class="btn-primary grow" id="p-save">Guardar</button><button id="p-close">Cerrar</button></div>`);
  $("#p-close", body).onclick = closeSheet;
  $("#p-save", body).onclick = async () => {
    p.name = $("#p-name", body).value.trim();
    p.category = $("#p-cat", body).value;
    await db.put("products", p);
    closeSheet();
    toast("Producto actualizado");
    renderProductos();
  };
}

// =====================================================================
// AJUSTES
// =====================================================================
function renderAjustes() {
  const key = getApiKey();
  view.innerHTML = `
    <div class="card">
      <h2>Cómo leer los tickets</h2>
      <label class="row" style="margin-bottom:10px;align-items:flex-start"><input type="radio" name="mode" value="free" style="width:auto;margin-top:4px" ${getOcrMode() === "free" ? "checked" : ""} />
        <span><strong>Gratis, en el teléfono</strong><br><span class="small muted">Funciona sin internet y sin costo. Es menos preciso: revisá y corregí los productos después de leer.</span></span></label>
      <label class="row" style="align-items:flex-start"><input type="radio" name="mode" value="ai" style="width:auto;margin-top:4px" ${getOcrMode() === "ai" ? "checked" : ""} ${key ? "" : "disabled"} />
        <span><strong>Con IA (Claude)</strong><br><span class="small muted">Mucho más precisa. Requiere una API key de Anthropic con crédito (unos centavos de dólar por ticket).${key ? "" : " Cargá la clave abajo para activarla."}</span></span></label>
    </div>
    <div class="card">
      <h2>API key (opcional)</h2>
      <p class="small muted">Solo para la lectura con IA. Se crea en console.anthropic.com y queda guardada <strong>solo en este teléfono</strong>.</p>
      <label class="field"><span>API key</span><input id="key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(key)}" /></label>
      <button class="btn-primary" id="save-key">Guardar clave</button>
      ${key ? `<span class="badge ok" style="margin-left:8px">configurada</span>` : ""}
    </div>
    <div class="card stack">
      <h2>Tus datos</h2>
      <p class="small muted">Todo se guarda en este dispositivo. Hacé una copia de seguridad de vez en cuando.</p>
      <p class="small">${state.tickets.length} tickets · ${Object.keys(state.products).length} productos · ${state.consumption.length} consumos</p>
      <button class="btn-block" id="export">⬇️ Exportar copia de seguridad</button>
      <label class="btn btn-block" for="import">⬆️ Importar copia</label>
      <input type="file" id="import" accept="application/json" class="hidden" />
      <button class="btn-block btn-danger" id="wipe">Borrar todos los datos</button>
    </div>
    <p class="small muted" style="text-align:center">Mis Costos v0.4 · Los nombres de productos vienen de Open Food Facts</p>`;

  $("#save-key").onclick = () => {
    setApiKey($("#key").value);
    if (getApiKey()) setOcrMode("ai");
    toast(getApiKey() ? "Clave guardada · lectura con IA activada" : "Clave borrada");
    renderAjustes();
  };
  view.querySelectorAll('input[name="mode"]').forEach((r) => (r.onchange = () => { setOcrMode(r.value); toast(r.value === "ai" ? "Lectura con IA" : "Lectura gratis"); }));
  $("#export").onclick = async () => {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `mis-costos-${todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $("#import").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importAll(JSON.parse(await file.text()));
      await loadData();
      toast("Datos importados");
      renderAjustes();
    } catch {
      toast("El archivo no es válido");
    }
  };
  $("#wipe").onclick = async () => {
    if (!confirm("¿Borrar TODOS los tickets, productos y consumos? No se puede deshacer.")) return;
    await Promise.all(["tickets", "products", "consumption"].map((s) => db.clear(s)));
    await loadData();
    toast("Datos borrados");
    renderAjustes();
  };
}

// ---------- inicio ----------
document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
await loadData();
render();

// para pruebas
window.__app = { state, loadData, render, go };
