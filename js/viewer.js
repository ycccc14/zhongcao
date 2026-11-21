// Full-screen photo viewer, shared by Lensy and 种草本 (keep both copies the same).
//   const v = openViewer(items, index, opts)
//   items: [{ src, from?: <img> on the page, caption? }]
//   opts:  { cls, buttons: extra top-bar HTML, onClose(), onIndex(i), tapClose (default true) }
//   returns { el, close(), index() }
// The picture grows out of the tapped thumbnail and shrinks back into it (cropped the way the thumbnail is).
// Pinch or double-tap to zoom, drag to look around, swipe sideways for the next picture,
// pull down / pinch small / tap to close. Only transform, opacity and clip-path move: no page re-layout.

const EASE = 'cubic-bezier(.22, .9, .24, 1)'; // quick start, long soft landing
const GLIDE = 'cubic-bezier(.17, .89, .32, 1)'; // fling deceleration
const OPEN_MS = 340;
const CLOSE_MS = 290;
const GAP = 20; // black gap between pictures while swiping
const MAX_ZOOM = 5;
const TAP_ZOOM = 2.5;

const CSS = `
.vw { position: fixed; inset: 0; z-index: 900; overflow: hidden; touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.vw * { touch-action: none; }
.vw-bg { position: absolute; inset: 0; background: #000; }
.vw-track { position: absolute; inset: 0; will-change: transform; }
.vw-slide { position: absolute; top: 0; height: 100%; overflow: hidden; }
.vw-img { position: absolute; left: 0; top: 0; max-width: none; max-height: none; transform-origin: 0 0; will-change: transform; display: block; -webkit-user-drag: none; }
.vw-ui { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; gap: 8px; padding: calc(env(safe-area-inset-top, 0px) + 8px) 12px 18px; color: #fff; background: linear-gradient(rgba(0,0,0,.42), transparent); opacity: 0; transition: opacity .25s ease; }
.vw-cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 30px 18px calc(env(safe-area-inset-bottom, 0px) + 18px); color: #fff; font-size: 14px; line-height: 1.5; background: linear-gradient(transparent, rgba(0,0,0,.55)); opacity: 0; transition: opacity .25s ease; pointer-events: none; }
.vw.ready .vw-ui, .vw.ready .vw-cap { opacity: 1; }
.vw.ready.hide-ui .vw-ui, .vw.ready.hide-ui .vw-cap, .vw.ready.pulling .vw-ui, .vw.ready.pulling .vw-cap, .vw.closing .vw-ui, .vw.closing .vw-cap { opacity: 0; }
.vw.hide-ui .vw-ui { pointer-events: none; }
.vw-count { font-size: 14px; font-variant-numeric: tabular-nums; letter-spacing: .5px; padding-left: 4px; }
.vw-grow { flex: 1; }
.vw-btn { width: 40px; height: 40px; border-radius: 50%; border: 0; padding: 0; background: rgba(255,255,255,.16); color: #fff; font: inherit; font-size: 18px; line-height: 40px; text-align: center; cursor: pointer; -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); transition: transform .15s ease, background .15s ease; }
.vw-btn:active { transform: scale(.9); background: rgba(255,255,255,.28); }
.vw.closing { pointer-events: none; }
`;

function injectCss() {
  if (document.getElementById('vw-css')) return;
  const s = document.createElement('style');
  s.id = 'vw-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Past the edge the picture still follows the finger, but less and less (like iOS).
const rubber = (v, min, max) => (v < min ? min - (min - v) * 0.35 : v > max ? max + (v - max) * 0.35 : v);
const T = (z) => `translate3d(${z.x}px, ${z.y}px, 0) scale(${z.s})`;
const FULL_CLIP = 'inset(0px 0px 0px 0px round 0px)';

export function openViewer(items, start, opts) {
  opts = opts || {};
  injectCss();
  const n = items.length;
  let idx = clamp(start | 0, 0, n - 1);
  let W = window.innerWidth;
  let H = window.innerHeight;
  const el = document.createElement('div');
  el.className = `vw ${opts.cls || ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '查看图片');
  el.innerHTML = `<div class="vw-bg"></div><div class="vw-track"></div>
    <div class="vw-ui"><span class="vw-count lb-count"></span><span class="vw-grow"></span>${opts.buttons || ''}<button class="vw-btn vw-x lb-x" aria-label="关闭">✕</button></div>
    <div class="vw-cap lb-cap"></div>`;
  const bg = el.querySelector('.vw-bg');
  const track = el.querySelector('.vw-track');
  const countEl = el.querySelector('.vw-count');
  const capEl = el.querySelector('.vw-cap');

  const slides = items.map((it) => {
    const s = document.createElement('div');
    s.className = 'vw-slide';
    const img = document.createElement('img');
    img.className = 'vw-img';
    img.alt = '';
    img.draggable = false;
    img.style.opacity = '0';
    s.appendChild(img);
    track.appendChild(s);
    return { el: s, img, it, fw: 0, fh: 0, z: null, asked: false };
  });

  const fromOf = (i) => { const f = items[i] && items[i].from; return f && f.isConnected && f.tagName === 'IMG' ? f : null; };
  const placeSlides = () => slides.forEach((s, i) => { s.el.style.left = `${i * (W + GAP)}px`; s.el.style.width = `${W}px`; });
  const setTrack = (dx, ms) => {
    track.style.transition = ms ? `transform ${ms}ms ${EASE}` : 'none';
    track.style.transform = `translate3d(${-idx * (W + GAP) + (dx || 0)}px, 0, 0)`;
  };
  // The picture at rest: as big as fits the screen, centred.
  const rest = (s) => ({ s: 1, x: (W - s.fw) / 2, y: (H - s.fh) / 2 });
  const size = (s, nw, nh) => {
    const k = Math.min(W / nw, H / nh);
    s.fw = nw * k;
    s.fh = nh * k;
    s.img.style.width = `${s.fw}px`;
    s.img.style.height = `${s.fh}px`;
    s.z = rest(s);
  };
  const setZ = (s, z, ms, ease) => {
    s.z = z;
    s.img.style.transition = ms ? `transform ${ms}ms ${ease || EASE}` : 'none';
    s.img.style.transform = T(z);
  };
  // Keep a zoomed picture covering the screen (or centred on the axis where it is smaller than the screen).
  const bounds = (s, sc) => {
    const w = s.fw * sc;
    const h = s.fh * sc;
    return { minX: w > W ? W - w : (W - w) / 2, maxX: w > W ? 0 : (W - w) / 2, minY: h > H ? H - h : (H - h) / 2, maxY: h > H ? 0 : (H - h) / 2 };
  };
  const settle = (s, z) => { const b = bounds(s, z.s); return { s: z.s, x: clamp(z.x, b.minX, b.maxX), y: clamp(z.y, b.minY, b.maxY) }; };
  const zoomAt = (z, sc, px, py) => ({ s: sc, x: px - (px - z.x) * (sc / z.s), y: py - (py - z.y) * (sc / z.s) });

  // Loads a picture: the thumbnail already on the page first (it is decoded, so it shows at once), then the full one.
  const load = (i) => {
    const s = slides[i];
    if (!s || s.asked) return s && s.ready;
    s.asked = true;
    const f = fromOf(i);
    const quick = f && f.complete && f.naturalWidth ? f.currentSrc || f.src : '';
    s.ready = new Promise((resolve) => {
      const shown = () => {
        if (!s.fw) { size(s, s.img.naturalWidth || W, s.img.naturalHeight || H); setZ(s, s.z); }
        s.img.style.opacity = '';
        resolve();
      };
      s.img.onload = shown;
      s.img.onerror = shown;
      if (quick) { s.img.src = quick; size(s, f.naturalWidth, f.naturalHeight); setZ(s, s.z); }
      else s.img.src = s.it.src;
      if (quick && quick !== s.it.src) {
        const hi = new Image();
        hi.src = s.it.src;
        const swap = () => { if (!closing) s.img.src = s.it.src; };
        (hi.decode ? hi.decode() : Promise.reject()).then(swap, () => { hi.onload = swap; });
      }
      if (s.img.complete && s.img.naturalWidth) shown();
    });
    return s.ready;
  };
  const loadAround = () => { load(idx); load(idx - 1); load(idx + 1); };

  // Where the thumbnail of picture i is on the page, as a transform + crop of the big picture.
  const thumbState = (i) => {
    const s = slides[i];
    const f = fromOf(i);
    if (!f || !s.fw) return null;
    const r = f.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) return null;
    const k = Math.max(r.width / s.fw, r.height / s.fh);
    const ix = (s.fw - r.width / k) / 2;
    const iy = (s.fh - r.height / k) / 2;
    const rad = (parseFloat(getComputedStyle(f).borderTopLeftRadius) || 0) / k;
    return { transform: T({ s: k, x: r.left - ix * k, y: r.top - iy * k }), clip: `inset(${iy}px ${ix}px ${iy}px ${ix}px round ${rad}px)` };
  };
  let hidden = null; // the page thumbnail hidden while its picture is out
  const hideFrom = () => {
    if (hidden) hidden.style.visibility = '';
    hidden = fromOf(idx);
    if (hidden) hidden.style.visibility = 'hidden';
  };

  const info = () => {
    countEl.textContent = n > 1 ? `${idx + 1} / ${n}` : '';
    const cap = items[idx].caption || '';
    capEl.textContent = cap;
    capEl.hidden = !cap;
  };
  const go = (i, ms) => {
    const old = idx;
    idx = clamp(i, 0, n - 1);
    if (old !== idx && slides[old].fw) setZ(slides[old], rest(slides[old]));
    setTrack(0, ms == null ? 360 : ms);
    info();
    loadAround();
    if (old !== idx) { hideFrom(); if (opts.onIndex) opts.onIndex(idx); }
  };

  // ---------- open ----------
  placeSlides();
  setTrack(0);
  info();
  document.body.appendChild(el);
  let closing = false;
  bg.style.opacity = '0';
  load(idx).then(() => {
    if (closing) return;
    const s = slides[idx];
    const from = thumbState(idx);
    hideFrom();
    bg.style.opacity = '1';
    bg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'ease-out' });
    setZ(s, s.z);
    s.img.style.clipPath = FULL_CLIP;
    s.img.style.webkitClipPath = FULL_CLIP;
    if (from) {
      s.img.animate([{ transform: from.transform, clipPath: from.clip, webkitClipPath: from.clip }, { transform: T(s.z), clipPath: FULL_CLIP, webkitClipPath: FULL_CLIP }], { duration: OPEN_MS, easing: EASE });
    } else {
      s.img.animate([{ transform: T(zoomAt(s.z, 0.9, W / 2, H / 2)), opacity: 0 }, { transform: T(s.z), opacity: 1 }], { duration: OPEN_MS, easing: EASE });
    }
    setTimeout(() => { if (!closing) el.classList.add('ready'); }, OPEN_MS * 0.5);
    loadAround();
  });

  // ---------- close ----------
  const close = () => {
    if (closing) return;
    closing = true;
    clearTimeout(tapTimer);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
    el.classList.add('closing');
    const s = slides[idx];
    const to = thumbState(idx);
    const done = () => {
      if (hidden) hidden.style.visibility = ''; // same frame the viewer goes: the thumbnail is back exactly where the picture landed
      el.remove();
    };
    const bgNow = parseFloat(getComputedStyle(bg).opacity);
    bg.animate([{ opacity: isNaN(bgNow) ? 1 : bgNow }, { opacity: 0 }], { duration: CLOSE_MS, easing: 'ease-in', fill: 'forwards' });
    let a;
    if (to && s.fw) {
      const now = s.img.style.transform || T(s.z);
      s.img.style.transition = 'none';
      a = s.img.animate([{ transform: now, clipPath: FULL_CLIP, webkitClipPath: FULL_CLIP }, { transform: to.transform, clipPath: to.clip, webkitClipPath: to.clip }], { duration: CLOSE_MS, easing: EASE, fill: 'forwards' });
    } else {
      a = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { duration: CLOSE_MS * 0.8, easing: 'ease-in', fill: 'forwards' });
    }
    a.finished.then(done, done);
    if (opts.onClose) opts.onClose();
  };

  // ---------- gestures ----------
  const pts = new Map();
  let g = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let tapTimer = 0;
  const cur = () => slides[idx];
  const speed = (hist) => {
    const now = performance.now();
    const old = hist.find((p) => now - p.t < 90) || hist[hist.length - 1];
    const last = hist[hist.length - 1];
    const dt = Math.max(16, last.t - old.t);
    return { vx: (last.x - old.x) / dt, vy: (last.y - old.y) / dt };
  };
  const pinchOf = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; };

  el.addEventListener('pointerdown', (e) => {
    if (closing || e.target.closest('.vw-btn')) return;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer in tests */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = cur();
    if (!s.fw) return;
    if (pts.size === 1) {
      g = { kind: 'pending', sx: e.clientX, sy: e.clientY, z0: { ...s.z }, t: performance.now(), hist: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
      setZ(s, s.z); // stop any glide where it is heading
    } else if (pts.size === 2) {
      clearTimeout(tapTimer);
      if (g && g.kind === 'swipe') setTrack(0, 200);
      if (g && g.kind === 'pull') { el.classList.remove('pulling'); bg.style.transition = 'opacity .2s'; bg.style.opacity = '1'; setZ(s, g.z0, 200); }
      const p = pinchOf();
      g = { kind: 'pinch', d0: p.d, m0: p.m, z0: { ...(g && g.kind === 'pull' ? g.z0 : s.z) }, startS: s.z.s };
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g || closing) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = cur();
    if (g.kind === 'pinch') {
      if (pts.size < 2) return;
      const p = pinchOf();
      let sc = g.z0.s * (p.d / g.d0);
      if (sc > MAX_ZOOM) sc = MAX_ZOOM + (sc - MAX_ZOOM) * 0.25;
      if (sc < 1) sc = 1 - (1 - sc) * 0.6;
      const z = zoomAt(g.z0, sc, g.m0.x, g.m0.y);
      z.x += p.m.x - g.m0.x;
      z.y += p.m.y - g.m0.y;
      g.m = p.m;
      setZ(s, z);
      if (g.startS <= 1.01) bg.style.opacity = String(clamp(0.35 + (sc - 0.5) * 1.3, 0.35, 1));
      return;
    }
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    g.hist.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (g.hist.length > 6) g.hist.shift();
    if (g.kind === 'pending') {
      if (Math.hypot(dx, dy) < 7) return;
      clearTimeout(tapTimer);
      if (s.z.s > 1.01) g.kind = 'pan';
      else if (Math.abs(dx) > Math.abs(dy) && n > 1) g.kind = 'swipe';
      else { g.kind = 'pull'; el.classList.add('pulling'); bg.style.transition = 'none'; }
    }
    if (g.kind === 'pan') {
      const b = bounds(s, g.z0.s);
      setZ(s, { s: g.z0.s, x: rubber(g.z0.x + dx, b.minX, b.maxX), y: rubber(g.z0.y + dy, b.minY, b.maxY) });
    } else if (g.kind === 'swipe') {
      const edge = (idx === 0 && dx > 0) || (idx === n - 1 && dx < 0);
      setTrack(edge ? dx * 0.3 : dx);
    } else if (g.kind === 'pull') {
      const k = 1 - Math.min(Math.abs(dy) / H, 1) * 0.35;
      setZ(s, { s: g.z0.s * k, x: g.sx - (g.sx - g.z0.x) * k + dx, y: g.sy - (g.sy - g.z0.y) * k + dy });
      bg.style.opacity = String(clamp(1 - Math.abs(dy) / (H * 0.45), 0, 1));
    }
  });

  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g || closing) return;
    const s = cur();
    if (g.kind === 'pinch') {
      if (pts.size === 1) { // one finger stays: carry on dragging the zoomed picture
        const [p] = [...pts.values()];
        g = { kind: s.z.s > 1.01 ? 'pan' : 'pending', sx: p.x, sy: p.y, z0: { ...s.z }, t: 0, hist: [{ x: p.x, y: p.y, t: performance.now() }] };
        return;
      }
      if (pts.size > 0) return;
      const startS = g.startS;
      const m = g.m || g.m0;
      g = null;
      bg.style.transition = 'opacity .3s ease';
      bg.style.opacity = '1';
      if (startS <= 1.01 && s.z.s < 0.8) { close(); return; } // pinched it small: put it away
      let z = s.z;
      if (z.s < 1) z = rest(s);
      else if (z.s > MAX_ZOOM) z = zoomAt(z, MAX_ZOOM, m.x, m.y);
      setZ(s, z.s <= 1 ? rest(s) : settle(s, z), 320);
      return;
    }
    const gg = g;
    g = null;
    const dx = e.clientX - gg.sx;
    const dy = e.clientY - gg.sy;
    if (gg.kind === 'pending') {
      if (!gg.t || performance.now() - gg.t > 350) return;
      const now = performance.now();
      if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) { // double tap
        clearTimeout(tapTimer);
        lastTap.t = 0;
        setZ(s, s.z.s > 1.01 ? rest(s) : settle(s, zoomAt(rest(s), TAP_ZOOM, e.clientX, e.clientY)), 320);
        return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      tapTimer = setTimeout(() => {
        if (closing) return;
        if (opts.tapClose !== false && s.z.s <= 1.01) close();
        else el.classList.toggle('hide-ui');
      }, 300);
      return;
    }
    const v = speed(gg.hist);
    if (gg.kind === 'pan') {
      const glide = { s: s.z.s, x: s.z.x + v.vx * 220, y: s.z.y + v.vy * 220 };
      setZ(s, settle(s, glide), 460, GLIDE);
    } else if (gg.kind === 'swipe') {
      const next = (dx < -W * 0.2 || v.vx < -0.35) && dx < 0 ? idx + 1 : (dx > W * 0.2 || v.vx > 0.35) && dx > 0 ? idx - 1 : idx;
      go(next, next === idx ? 300 : clamp(380 - Math.abs(v.vx) * 80, 220, 380));
    } else if (gg.kind === 'pull') {
      el.classList.remove('pulling');
      if (Math.abs(dy) > 110 || (Math.abs(v.vy) > 0.5 && Math.sign(v.vy) === Math.sign(dy))) { close(); return; }
      bg.style.transition = 'opacity .3s ease';
      bg.style.opacity = '1';
      setZ(s, gg.z0, 340);
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.querySelector('.vw-x').addEventListener('click', close);
  el.addEventListener('wheel', (e) => { // trackpad / mouse on a computer
    e.preventDefault();
    const s = cur();
    if (!s.fw) return;
    const sc = clamp(s.z.s * Math.exp(-e.deltaY / 300), 1, MAX_ZOOM);
    setZ(s, sc <= 1 ? rest(s) : settle(s, zoomAt(s.z, sc, e.clientX, e.clientY)));
  }, { passive: false });

  const onKey = (e) => {
    if (closing) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') go(idx + 1);
    if (e.key === 'ArrowLeft') go(idx - 1);
  };
  document.addEventListener('keydown', onKey);

  const onResize = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    placeSlides();
    setTrack(0);
    for (const s of slides) if (s.fw) { size(s, s.img.naturalWidth || s.fw, s.img.naturalHeight || s.fh); setZ(s, s.z); }
  };
  window.addEventListener('resize', onResize);

  return { el, close, index: () => idx };
}
