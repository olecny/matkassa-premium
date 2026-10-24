// Tiny IndexedDB key-value store (one object store, "kv").
// Own database: Matkassa (the original) lives on the same origin and uses 'matkassa'. This app never writes there.
const DB_NAME = 'matkassa-premium';
export const ORIGINAL_DB = 'matkassa';
const COPY_KEYS = ['list', 'categories', 'rules', 'receipts', 'settings', 'extraOffers', 'offers'];
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const get = (key) => tx('readonly', (s) => s.get(key));
export const set = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const del = (key) => tx('readwrite', (s) => s.delete(key));

/**
 * Read the original Matkassa's data on this origin, read-only. Returns null when it doesn't exist.
 * Never creates or upgrades that database: an open() without a version can't upgrade an existing one, and if it
 * turns out not to exist the upgrade is aborted, so the original app never finds an empty, store-less database.
 */
export async function readOriginal() {
  try {
    if (typeof indexedDB.databases !== 'function') return null;
    if (!(await indexedDB.databases()).some((d) => d.name === ORIGINAL_DB)) return null;
  } catch (e) { return null; }
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(ORIGINAL_DB); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => req.transaction.abort();
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const odb = req.result;
      if (!odb.objectStoreNames.contains('kv')) { odb.close(); resolve(null); return; }
      const out = {};
      const t = odb.transaction('kv', 'readonly');
      for (const k of COPY_KEYS) t.objectStore('kv').get(k).onsuccess = (e) => { if (e.target.result !== undefined) out[k] = e.target.result; };
      t.oncomplete = () => { odb.close(); resolve(out); };
      t.onerror = t.onabort = () => { odb.close(); resolve(null); };
    };
  });
}

export async function persist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) { /* not supported */ }
  return false;
}
