// Pictures and video frames: resizing, saving, object URLs, cropping.
import * as db from './db.js';
import { uid, frameTimes } from './logic.js';

const urls = new Map(); // `${id}:${kind}` -> object URL

export async function bitmap(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* fall back */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const im = new Image();
    im.decoding = 'async';
    im.src = url;
    await im.decode();
    return im;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const sizeOf = (src) => ({ w: src.videoWidth || src.naturalWidth || src.width, h: src.videoHeight || src.naturalHeight || src.height });

// Draws src (bitmap/image/video), optionally cropped to a fraction box, scaled so the long edge <= maxEdge.
export function draw(src, maxEdge, box) {
  const { w, h } = sizeOf(src);
  const sx = box ? box.x * w : 0;
  const sy = box ? box.y * h : 0;
  const sw = box ? box.w * w : w;
  const sh = box ? box.h * h : h;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

export const canvasBlob = (c, quality) => new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片转换失败'))), 'image/jpeg', quality || 0.9));

export async function resize(blobOrSrc, maxEdge, quality, box) {
  const src = blobOrSrc instanceof Blob ? await bitmap(blobOrSrc) : blobOrSrc;
  const c = draw(src, maxEdge, box);
  return { blob: await canvasBlob(c, quality), w: c.width, h: c.height };
}

// Saves a picture (full size up to 2400 px, plus a 480 px thumbnail) and returns its id.
export async function save(blobOrSrc, box) {
  const src = blobOrSrc instanceof Blob ? await bitmap(blobOrSrc) : blobOrSrc;
  const full = await resize(src, 2400, 0.9, box);
  const thumb = await resize(src, 480, 0.82, box);
  const id = uid();
  await db.put('images', { id, blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h, at: Date.now() });
  return id;
}

export async function url(id, kind) {
  if (!id) return '';
  const key = `${id}:${kind || 'full'}`;
  if (urls.has(key)) return urls.get(key);
  const rec = await db.get('images', id);
  if (!rec) return '';
  const u = URL.createObjectURL(kind === 'thumb' ? rec.thumb || rec.blob : rec.blob);
  urls.set(key, u);
  return u;
}

export function forget(id) {
  for (const k of ['full', 'thumb']) {
    const key = `${id}:${k}`;
    if (urls.has(key)) { URL.revokeObjectURL(urls.get(key)); urls.delete(key); }
  }
}

export const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// For the AI: JPEG, long edge <= 1568 px (larger gets scaled down by the API anyway).
export async function forAi(blobOrSrc, maxEdge) {
  const { blob } = await resize(blobOrSrc, maxEdge || 1568, 0.85);
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64(blob) } };
}

// ---------- video ----------

export async function openVideo(blob) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    v.onloadeddata = resolve;
    v.onerror = () => reject(new Error('这个视频打不开（格式不支持？）'));
    setTimeout(() => reject(new Error('视频加载超时')), 30000);
  });
  return v;
}

export function seek(v, t) {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(t, (v.duration || t) - 0.05));
    if (Math.abs(v.currentTime - target) < 0.01 && v.readyState >= 2) { resolve(); return; }
    const done = () => { v.removeEventListener('seeked', done); setTimeout(resolve, 30); };
    v.addEventListener('seeked', done);
    v.currentTime = target;
    setTimeout(done, 4000);
  });
}

// Samples frames for the AI: [{t, part}] where part is an image content block.
export async function sampleFrames(v, n, onStep) {
  const times = frameTimes(v.duration, n);
  const out = [];
  for (let i = 0; i < times.length; i++) {
    await seek(v, times[i]);
    const c = draw(v, 640);
    out.push({ t: times[i], part: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: (await canvasBlob(c, 0.8).then(toBase64)) } } });
    if (onStep) onStep(i + 1, times.length);
  }
  return out;
}

export async function saveFrame(v, t, box) {
  await seek(v, t);
  return save(draw(v, 2400), box);
}

export function closeVideo(v) {
  if (!v) return;
  const src = v.src;
  v.removeAttribute('src');
  v.load();
  URL.revokeObjectURL(src);
}
