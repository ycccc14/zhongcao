// Talking to the outside: the link helper (Apps Script), picture/video downloads, geocoding and routes.
import { CFG } from './config.js';
import { firstUrl } from './logic.js';

// On a weak network a request can hang with no answer and no error, and the spinner turns for ever.
// Every request gets a time limit; `use(res, idle)` reads the answer inside it (call idle() whenever data arrives
// to restart the clock, so a slow but moving download is not cut off).
export const TIMEOUT_MSG = '网络太慢，等了很久没有回应，请换个网络再试';
export const LIMITS = { json: 15000, image: 30000, video: 30000 };

export async function fetchWithin(url, opts, ms, use) {
  const ctl = new AbortController();
  let timer = null;
  const idle = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), ms); };
  idle();
  try {
    const res = await fetch(url, { ...(opts || {}), signal: ctl.signal });
    return use ? await use(res, idle) : res;
  } catch (e) {
    if (ctl.signal.aborted) { const t = new Error(TIMEOUT_MSG); t.timeout = true; throw t; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function getJson(url, opts, ms) {
  return fetchWithin(url, opts, ms || LIMITS.json, (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

// ---------- links ----------

export async function readLink(text) {
  const url = firstUrl(text);
  if (!url) throw new Error('没有找到链接，请粘贴 Instagram / Google Maps 链接');
  if (!CFG.helper) throw new Error('链接读取服务还没设置好，暂时请用截图');
  let r;
  try {
    r = await getJson(`${CFG.helper}?fn=link&url=${encodeURIComponent(url)}`);
  } catch (e) {
    throw new Error(e.timeout ? '读取链接超时（网络太慢），请换个网络再试，或改用截图' : '读取链接失败，请检查网络，或改用截图');
  }
  if (!r.ok) throw new Error(r.error || '读取链接失败');
  r.input = url;
  return r;
}

// Downloads a picture. Most CDNs allow it directly; otherwise go through the helper.
export async function downloadImage(url) {
  try {
    const b = await fetchWithin(url, { mode: 'cors', referrerPolicy: 'no-referrer' }, LIMITS.image, (res) => (res.ok ? res.blob() : null));
    if (b && b.size > 0 && /^image\//.test(b.type || 'image/')) return b;
  } catch (e) { /* try the helper */ }
  if (!CFG.helper) throw new Error('图片下载失败');
  const r = await getJson(`${CFG.helper}?fn=img&url=${encodeURIComponent(url)}`, null, LIMITS.image);
  if (!r.ok) throw new Error('图片下载失败');
  const bin = atob(r.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: r.type || 'image/jpeg' });
}

// The time limit counts from the last piece received, so a big video on a slow but working line still finishes.
export function downloadVideo(url, onProgress, maxBytes) {
  return fetchWithin(url, { mode: 'cors', referrerPolicy: 'no-referrer' }, LIMITS.video, async (res, idle) => {
    if (!res.ok) throw new Error(`视频下载失败（${res.status}）`);
    const total = +res.headers.get('content-length') || 0;
    if (maxBytes && total > maxBytes) throw new Error('视频太大了，只用封面和文字识别');
    if (!res.body || !res.body.getReader) return res.blob();
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      idle();
      chunks.push(value);
      got += value.length;
      if (maxBytes && got > maxBytes) { reader.cancel(); throw new Error('视频太大了，只用封面和文字识别'); }
      if (onProgress) onProgress(got, total);
    }
    return new Blob(chunks, { type: res.headers.get('content-type') || 'video/mp4' });
  });
}

// ---------- places ----------

// Search places by text. near = {lat,lng} to prefer nearby results. Returns [{name, address, lat, lng}].
export async function geocode(q, near) {
  q = String(q || '').trim();
  if (!q) return [];
  const out = [];
  try {
    const bias = near && near.lat != null ? `&lat=${near.lat}&lon=${near.lng}` : '';
    const r = await getJson(`${CFG.photon}?q=${encodeURIComponent(q)}&limit=6${bias}`);
    for (const f of r.features || []) {
      const p = f.properties || {};
      const [lng, lat] = f.geometry.coordinates;
      const addr = [p.housenumber, p.street, p.district || p.locality, p.city, p.state, p.country].filter(Boolean).join(', ');
      out.push({ name: p.name || p.street || addr, address: addr, lat, lng });
    }
  } catch (e) { /* fall through to Nominatim */ }
  if (!out.length) {
    try {
      const r = await getJson(`${CFG.nominatim}?format=jsonv2&limit=6&accept-language=zh,en&q=${encodeURIComponent(q)}`);
      for (const p of r) out.push({ name: p.name || p.display_name.split(',')[0], address: p.display_name, lat: +p.lat, lng: +p.lon });
    } catch (e) { /* nothing found */ }
  }
  return out;
}

export async function reverse(lat, lng) {
  try {
    const r = await getJson(`${CFG.reverse}?format=jsonv2&accept-language=zh,en&lat=${lat}&lon=${lng}`);
    return r.display_name || '';
  } catch (e) { return ''; }
}

// Road distance & time. Returns {walk:{km,min}, drive:{km,min}} (either may be missing).
export async function route(from, to) {
  const pair = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const one = async (base) => {
    try {
      const r = await getJson(`${base}${pair}?overview=false`);
      const x = r.routes && r.routes[0];
      return x ? { km: x.distance / 1000, min: x.duration / 60 } : null;
    } catch (e) { return null; }
  };
  const [drive, walk] = await Promise.all([one(CFG.osrmDrive), one(CFG.osrmFoot)]);
  const out = {};
  if (drive) out.drive = drive;
  if (walk) out.walk = walk;
  return Object.keys(out).length ? out : null;
}

export function myLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('这个浏览器不能定位')); return; }
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('没能取得位置（请允许定位权限）')), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}
