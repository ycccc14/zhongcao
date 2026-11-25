// IndexedDB storage. Everything stays on this phone; backups are files the user exports.
// Stores: food, nails, edits, places, kv (settings) and images ({id, blob, thumb, w, h}).
const NAME = 'zhongcao';
const STORES = ['food', 'nails', 'edits', 'places', 'images', 'kv'];
let dbp = null;

// A failed open is not kept: iOS sometimes refuses once (low storage, a stuck upgrade), and the next try may work.
// The phone may also close the connection (storage cleanup); then the next call opens it again.
function openError(e) {
  const name = e && e.name;
  if (name === 'QuotaExceededError') return new Error('手机存储空间不够了，清理一些空间后再试');
  if (typeof indexedDB === 'undefined' || name === 'InvalidStateError' || name === 'SecurityError') return new Error('这个浏览器不让 App 存资料（无痕模式？），请用普通模式打开');
  return new Error(`打不开手机里的资料，请关掉 App 再打开（${(e && e.message) || name || '未知原因'}）`);
}

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(NAME, 1); } catch (e) { reject(openError(e)); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { dbp = null; };
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(openError(req.error));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const finished = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

export async function all(store) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).getAll());
}
export async function get(store, id) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(id));
}
export async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await finished(tx);
  return value;
}
export async function putMany(store, values) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  for (const v of values) tx.objectStore(store).put(v);
  await finished(tx);
}
export async function del(store, id) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  await finished(tx);
}
export async function clear(store) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await finished(tx);
}
export async function keys(store) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).getAllKeys());
}

export async function getKv(id, fallback) {
  const r = await get('kv', id);
  return r ? r.value : fallback;
}
export const setKv = (id, value) => put('kv', { id, value });

// Deletes pictures no record points to any more.
export async function sweepImages() {
  const used = new Set();
  for (const f of await all('food')) for (const i of f.images || []) used.add(i);
  for (const n of await all('nails')) { if (n.image) used.add(n.image); for (const i of n.images || []) used.add(i); }
  for (const e of await all('edits')) { if (e.before) used.add(e.before); if (e.after) used.add(e.after); for (const i of e.images || []) used.add(i); }
  const ids = await keys('images');
  let removed = 0;
  for (const id of ids) if (!used.has(id)) { await del('images', id); removed++; }
  return removed;
}
