// Local storage layer: IndexedDB (books cache, ebook files, covers, highlights,
// reactions, sync queue) + localStorage (pending reading progress).

const DB_NAME = 'marginal-offline';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('books', { keyPath: 'id' });
        db.createObjectStore('files', { keyPath: 'id' });   // ebook binaries
        db.createObjectStore('covers', { keyPath: 'id' });
        db.createObjectStore('highlights', { keyPath: 'id' }).createIndex('book_id', 'book_id');
        db.createObjectStore('reactions', { keyPath: 'highlight_id' }).createIndex('book_id', 'book_id');
        db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}

export const idb = {
  get: (s, k) => run(s, 'readonly', (o) => o.get(k)),
  getAll: (s) => run(s, 'readonly', (o) => o.getAll()),
  keys: (s) => run(s, 'readonly', (o) => o.getAllKeys()),
  getAllByIndex: (s, index, key) => run(s, 'readonly', (o) => o.index(index).getAll(key)),
  put: (s, v) => run(s, 'readwrite', (o) => o.put(v)),
  del: (s, k) => run(s, 'readwrite', (o) => o.delete(k)),
};

export function replaceAll(store, rows) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const o = t.objectStore(store);
    o.clear();
    rows.forEach((r) => o.put(r));
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  }));
}

export function replaceByIndex(store, index, key, rows) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const o = t.objectStore(store);
    const cur = o.index(index).openKeyCursor(IDBKeyRange.only(key));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { o.delete(c.primaryKey); c.continue(); }
      else rows.forEach((r) => o.put(r));
    };
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  }));
}

// ---- Sync queue -----------------------------------------------------------
export const enqueue = (op) => idb.put('queue', { ...op, t: Date.now() });
export const getQueue = () => idb.getAll('queue');          // ordered by seq
export const removeQueued = (seq) => idb.del('queue', seq);

// ---- Pending reading progress (localStorage = synchronous, safe in pagehide)
const PP_KEY = 'marginal:pendingProgress';
export function getPendingProgress() {
  try { return JSON.parse(localStorage.getItem(PP_KEY)) || {}; } catch { return {}; }
}
export function setPendingProgress(id, p) {
  const m = getPendingProgress();
  m[id] = p;
  try { localStorage.setItem(PP_KEY, JSON.stringify(m)); } catch {}
}
export function clearPendingProgress(id, onlyIfCfi) {
  const m = getPendingProgress();
  if (!m[id]) return;
  if (onlyIfCfi && m[id].locationCfi !== onlyIfCfi) return; // newer position arrived meanwhile
  delete m[id];
  try { localStorage.setItem(PP_KEY, JSON.stringify(m)); } catch {}
}

// ---- Locally saved ebooks ---------------------------------------------------
export async function localBookIds() { return new Set(await idb.keys('files')); }
export const getBookFile = (id) => idb.get('files', id);
export const saveBookFile = (id, buffer, type) => idb.put('files', { id, buffer, type });
export const saveCover = (id, buffer, type) => idb.put('covers', { id, buffer, type });

export async function getCoverBlobUrl(id) {
  const c = await idb.get('covers', id);
  return c ? URL.createObjectURL(new Blob([c.buffer], { type: c.type || 'image/jpeg' })) : null;
}

export async function removeLocalBook(id) {
  await idb.del('files', id);
  await idb.del('covers', id);
}

export function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}