// Auto-crop for uploaded pictures, shared by Lensy and 种草本 (keep both copies the same).
// 1. Black bars around a picture (a screenshot of a video or of a landscape photo) are cut off.
// 2. A phone screenshot (小红书 note, photo app, chat…) is cut down to the photo in it: the app's top bar,
//    title, text, comments and buttons go. A normal photo is left alone.
// findBox(rgba, w, h) works on a small copy of the picture and returns {x, y, w, h} as fractions,
// or null when nothing should be cut. cropBox(image) does the drawing step in the browser.

const DIFF = 14; // a pixel this far (max channel difference) from the app background is not background

// Screenshot shape: phones are 19.5:9 or so (≥ 1.9 tall). Older 16:9 phones and long screenshots too.
const SCREEN_WIDTHS = [640, 720, 750, 828, 1080, 1125, 1170, 1179, 1206, 1242, 1260, 1284, 1290, 1320, 1440];
export function looksLikeScreenshot(w, h) {
  const r = h / w;
  return r >= 1.9 || (r >= 1.7 && SCREEN_WIDTHS.includes(w));
}

export function findBox(px, w, h, opts) {
  opts = opts || {};
  const shot = opts.screenshot != null ? opts.screenshot : looksLikeScreenshot(opts.realW || w, opts.realH || h);
  const at = (x, y) => (y * w + x) * 4;
  const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

  // A row / column is "flat" when it is one solid colour (a bar, a separator, an empty margin).
  const rowStats = (y, x0, x1) => {
    let s = 0;
    let s2 = 0;
    let dark = 0;
    for (let x = x0; x < x1; x++) { const l = lum(at(x, y)); s += l; s2 += l * l; if (l < 28) dark++; }
    const m = s / (x1 - x0);
    return { sd: Math.sqrt(Math.max(0, s2 / (x1 - x0) - m * m)), dark: dark / (x1 - x0) };
  };
  const colStats = (x, y0, y1) => {
    let s = 0;
    let s2 = 0;
    let dark = 0;
    for (let y = y0; y < y1; y++) { const l = lum(at(x, y)); s += l; s2 += l * l; if (l < 28) dark++; }
    const m = s / (y1 - y0);
    return { sd: Math.sqrt(Math.max(0, s2 / (y1 - y0) - m * m)), dark: dark / (y1 - y0) };
  };

  // ---- 1. black bars (any picture) ----
  const blackRow = (y) => { const r = rowStats(y, 0, w); return r.sd < 6 && r.dark > 0.97; };
  const blackCol = (x, y0, y1) => { const c = colStats(x, y0, y1); return c.sd < 6 && c.dark > 0.97; };
  let top = 0;
  let bottom = h;
  while (top < h - 1 && blackRow(top)) top++;
  while (bottom - 1 > top && blackRow(bottom - 1)) bottom--;
  let left = 0;
  let right = w;
  while (left < w - 1 && blackCol(left, top, bottom)) left++;
  while (right - 1 > left && blackCol(right - 1, top, bottom)) right--;

  // ---- 2. the photo inside a screenshot ----
  if (shot) {
    const band = photoBand(px, w, h, at);
    if (band) { top = band.y0; bottom = band.y1; left = band.x0; right = band.x1; }
  }

  const bw = right - left;
  const bh = bottom - top;
  if (bw <= 0 || bh <= 0) return null;
  if (bw * bh > w * h * 0.95) return null; // (almost) nothing to cut
  if (bw < w * 0.25 || bh < h * 0.12) return null; // too small to be "the picture": better keep everything
  return { x: left / w, y: top / h, w: bw / w, h: bh / h };
}

// The biggest horizontal band of "picture" rows in a screenshot, trimmed to its picture columns.
function photoBand(px, w, h, at) {
  // Background = the app's own colour, read from the status bar at the top and the bar at the bottom
  // (the most common colour there, averaged exactly so even a pale photo stands apart from it).
  const counts = new Map();
  const band = Math.max(2, Math.round(h * 0.04));
  let sampled = 0;
  for (let y = 0; y < h; y++) {
    if (y >= band && y < h - band) continue;
    for (let x = 0; x < w; x++) {
      const i = at(x, y);
      const k = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      const c = counts.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      c.n++; c.r += px[i]; c.g += px[i + 1]; c.b += px[i + 2];
      counts.set(k, c);
      sampled++;
    }
  }
  let top = null;
  for (const c of counts.values()) if (!top || c.n > top.n) top = c;
  if (!top || top.n < sampled * 0.4) return null; // no clear app colour: not an app screen
  const bg = [top.r / top.n, top.g / top.n, top.b / top.n];
  const off = (i) => Math.max(Math.abs(px[i] - bg[0]), Math.abs(px[i + 1] - bg[1]), Math.abs(px[i + 2] - bg[2])) > DIFF;

  // Per row: how much of it is not background, whether it reaches both screen edges, whether it is one flat colour.
  // Text always keeps a margin to the screen edges; a photo in a note / photo viewer goes edge to edge.
  const strip = Math.max(2, Math.round(w * 0.025));
  const frac = new Float32Array(h);
  const sides = new Uint8Array(h);
  const flat = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    let l = 0;
    let r = 0;
    let s = 0;
    let s2 = 0;
    let top = 0; // brightest channel, summed
    for (let x = 0; x < w; x++) {
      const i = at(x, y);
      if (off(i)) { c++; if (x < strip) l++; else if (x >= w - strip) r++; }
      const v = px[i] + px[i + 1] + px[i + 2];
      s += v; s2 += v * v;
      top += Math.max(px[i], px[i + 1], px[i + 2]);
    }
    frac[y] = c / w;
    sides[y] = l >= strip * 0.6 && r >= strip * 0.6 ? 1 : 0;
    const m = s / w;
    // A solid black stripe (a video's bar) is not picture; a plain dark, pale or coloured backdrop in a photo is.
    flat[y] = Math.sqrt(Math.max(0, s2 / w - m * m)) < 9 && top / w < 26 ? 1 : 0;
  }
  const isPic = (y) => frac[y] > 0.55 && sides[y] && !flat[y];
  const gap = Math.max(2, Math.round(h * 0.02)); // a white stripe inside the photo doesn't split it
  let run = null;
  let bestRun = null;
  let miss = 0;
  for (let y = 0; y <= h; y++) {
    if (y < h && isPic(y)) {
      if (!run) run = { y0: y, y1: y + 1 };
      else run.y1 = y + 1;
      miss = 0;
    } else if (run) {
      miss++;
      if (miss > gap || y === h) {
        if (!bestRun || run.y1 - run.y0 > bestRun.y1 - bestRun.y0) bestRun = run;
        run = null;
        miss = 0;
      }
    }
  }
  if (!bestRun) return null;
  const { y0, y1 } = bestRun;
  if (y1 - y0 < h * 0.15) return null;

  // What would be cut away must look like an app: some text / icons (the status bar at least), and not more photo.
  let drawn = 0;
  let pics = 0;
  let rows = 0;
  for (let y = 0; y < h; y++) {
    if (y >= y0 && y < y1) continue;
    rows++;
    if (isPic(y)) pics++;
    else if (frac[y] > 0.01) drawn++;
  }
  if (drawn < h * 0.02) return null;
  if (rows && pics / rows > 0.3) return null;

  // Columns: drop background margins at the sides of the band.
  const colPic = (x) => {
    let c = 0;
    for (let y = y0; y < y1; y++) if (off(at(x, y))) c++;
    return c / (y1 - y0) > 0.3;
  };
  let x0 = 0;
  let x1 = w;
  while (x0 < w - 1 && !colPic(x0)) x0++;
  while (x1 - 1 > x0 && !colPic(x1 - 1)) x1--;
  if (x1 - x0 < w * 0.3) return null;
  return { x0, x1, y0, y1 };
}

// Browser side: looks at a picture (image, bitmap, canvas) and returns its crop box or null.
export function cropBox(src) {
  try {
    const W = src.naturalWidth || src.videoWidth || src.width;
    const H = src.naturalHeight || src.videoHeight || src.height;
    if (!W || !H) return null;
    const k = Math.min(1, 220 / W);
    const w = Math.max(1, Math.round(W * k));
    const h = Math.max(1, Math.round(H * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    const box = findBox(ctx.getImageData(0, 0, w, h).data, w, h, { realW: W, realH: H });
    if (!box) return null;
    // On the sides that were cut, go in by one small pixel so no thin line of background is left by the rounding.
    const e = 1e-6;
    const l = box.x > e ? 1 / w : 0;
    const r = box.x + box.w < 1 - e ? 1 / w : 0;
    const t = box.y > e ? 1 / h : 0;
    const b = box.y + box.h < 1 - e ? 1 / h : 0;
    return { x: box.x + l, y: box.y + t, w: Math.max(0.01, box.w - l - r), h: Math.max(0.01, box.h - t - b) };
  } catch (e) {
    return null; // a picture we can't read: keep it whole
  }
}
