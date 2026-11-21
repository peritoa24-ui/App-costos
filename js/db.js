// Almacenamiento local en IndexedDB (los datos quedan en el teléfono).
const DB_NAME = "app-costos";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // tickets: { id, date, store, total, items: [...], createdAt }
      if (!db.objectStoreNames.contains("tickets")) db.createObjectStore("tickets", { keyPath: "id" });
      // products: { ean, name, brand, category, aliases: [], prices: [{date, price, store, ticketId}] }
      if (!db.objectStoreNames.contains("products")) db.createObjectStore("products", { keyPath: "ean" });
      // consumption: { id, ean, date, price }
      if (!db.objectStoreNames.contains("consumption")) db.createObjectStore("consumption", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const result = fn(s);
        t.oncomplete = () => resolve(result && "result" in result ? result.result : result);
        t.onerror = () => reject(t.error);
      })
  );
}

export const db = {
  getAll: (store) => tx(store, "readonly", (s) => s.getAll()),
  get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
  put: (store, value) => tx(store, "readwrite", (s) => s.put(value)),
  delete: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
  clear: (store) => tx(store, "readwrite", (s) => s.clear()),
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function exportAll() {
  const [tickets, products, consumption] = await Promise.all([
    db.getAll("tickets"), db.getAll("products"), db.getAll("consumption"),
  ]);
  return { version: 1, exportedAt: new Date().toISOString(), tickets, products, consumption };
}

export async function importAll(data) {
  for (const store of ["tickets", "products", "consumption"]) {
    for (const row of data[store] || []) await db.put(store, row);
  }
}
