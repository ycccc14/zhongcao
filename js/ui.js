// Small UI toolkit: element helper, toast, pages, sheets, confirm, copy, photo viewer.
import { escapeHtml } from './logic.js';

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
export const esc = escapeHtml;

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer = 0;
export function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2400);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制 ✓');
}

// ---------- layers (pages & sheets) with the back button ----------

const layers = [];

function pushLayer(node, onClose) {
  const layer = { node, onClose };
  layers.push(layer);
  // The newest layer is always on top: a page opened from a sheet (e.g. the map picker) must not hide behind it.
  node.style.zIndex = String(100 + layers.length * 10);
  history.pushState({ layer: layers.length }, '');
  return layer;
}

function removeLayer(layer, fromPop) {
  const i = layers.indexOf(layer);
  if (i < 0) return;
  layers.splice(i, 1);
  layer.node.classList.add('leaving');
  setTimeout(() => layer.node.remove(), 220);
  if (layer.onClose) layer.onClose();
  if (!fromPop) history.back();
}

// Back button / swipe: close layers above the history entry we landed on.
window.addEventListener('popstate', () => {
  const depth = (history.state && history.state.layer) || 0;
  while (layers.length > depth) removeLayer(layers[layers.length - 1], true);
});

export const closeTop = () => { const top = layers[layers.length - 1]; if (top) removeLayer(top); };
export const layerCount = () => layers.length;

// Full-screen page. render(body, page) fills it; returns {close, body, setTitle, setActions}.
export function openPage(title, render, opts) {
  opts = opts || {};
  const node = el(`<section class="page ${opts.cls || ''}" role="dialog" aria-label="${esc(title)}">
    <header class="page-head"><button class="back" aria-label="返回">‹</button><h2>${esc(title)}</h2><div class="acts"></div></header>
    <div class="page-body"></div></section>`);
  document.body.appendChild(node);
  const page = {
    node,
    body: $('.page-body', node),
    close: () => removeLayer(layer),
    setTitle: (t) => { $('h2', node).textContent = t; },
    setActions: (html) => { $('.acts', node).innerHTML = html; return $('.acts', node); },
  };
  const layer = pushLayer(node, opts.onClose);
  $('.back', node).onclick = page.close;
  render(page.body, page);
  return page;
}

// Bottom sheet. render(box, sheet).
export function openSheet(title, render, opts) {
  opts = opts || {};
  const node = el(`<div class="sheet-wrap"><div class="sheet ${opts.cls || ''}" role="dialog">
    <div class="grip"></div>${title ? `<h3>${esc(title)}</h3>` : ''}<div class="sheet-body"></div></div></div>`);
  document.body.appendChild(node);
  const sheet = { node, body: $('.sheet-body', node), close: () => removeLayer(layer) };
  const layer = pushLayer(node, opts.onClose);
  node.addEventListener('click', (e) => { if (e.target === node && !opts.sticky) sheet.close(); });
  render(sheet.body, sheet);
  return sheet;
}

export function confirmBox(msg, okText, danger) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet('', (box, sheet) => {
      box.innerHTML = `<p class="confirm-msg">${esc(msg)}</p><div class="row gap">
        <button class="btn ghost grow" data-a="no">取消</button><button class="btn grow ${danger ? 'danger' : ''}" data-a="yes">${esc(okText || '确定')}</button></div>`;
      box.onclick = (e) => {
        const a = e.target.closest('[data-a]');
        if (!a) return;
        answered = true;
        resolve(a.dataset.a === 'yes');
        sheet.close();
      };
    }, { onClose: () => { if (!answered) resolve(false); } });
  });
}

// Shows a working message over everything; returns {set(text), done()}.
export function busy(text) {
  const node = el(`<div class="busy"><div class="busy-card"><div class="spinner"></div><p>${esc(text)}</p><small></small></div></div>`);
  document.body.appendChild(node);
  return {
    set: (t, small) => { $('p', node).textContent = t; $('small', node).textContent = small || ''; },
    done: () => node.remove(),
  };
}

// ---------- photo viewer ----------
// items: [{src, caption}] ; pinch / double-tap to zoom, swipe to change, pull down to close.
export function lightbox(items, start, opts) {
  opts = opts || {};
  let idx = Math.max(0, Math.min(start || 0, items.length - 1));
  const node = el(`<div class="lb" role="dialog" aria-label="查看图片">
    <div class="lb-track"></div>
    <div class="lb-top"><span class="lb-count"></span><span class="grow"></span>
      <button class="lb-btn lb-save" aria-label="保存/分享">⇩</button><button class="lb-btn lb-x" aria-label="关闭">✕</button></div>
    <div class="lb-cap"></div></div>`);
  const track = $('.lb-track', node);
  items.forEach((it) => track.appendChild(el(`<div class="lb-slide"><div class="lb-zoom"><img alt="" draggable="false" src="${esc(it.src)}"></div></div>`)));
  document.body.appendChild(node);
  const slides = $$('.lb-slide', node);
  const W = () => node.clientWidth;
  const H = () => node.clientHeight;
  let z = { s: 1, x: 0, y: 0 };

  const applyZoom = (anim) => {
    const zoom = $('.lb-zoom', slides[idx]);
    zoom.style.transition = anim ? 'transform .2s' : 'none';
    zoom.style.transform = `translate(${z.x}px,${z.y}px) scale(${z.s})`;
  };
  const clampZoom = () => {
    z.s = Math.max(1, Math.min(z.s, 6));
    if (z.s === 1) { z.x = 0; z.y = 0; return; }
    z.x = Math.min(0, Math.max(W() - W() * z.s, z.x));
    z.y = Math.min(0, Math.max(H() - H() * z.s, z.y));
  };
  const show = (anim) => {
    track.style.transition = anim ? 'transform .25s ease' : 'none';
    track.style.transform = `translateX(${-idx * 100}%)`;
    $('.lb-count', node).textContent = items.length > 1 ? `${idx + 1} / ${items.length}` : '';
    $('.lb-cap', node).textContent = items[idx].caption || '';
    $('.lb-cap', node).hidden = !items[idx].caption;
  };
  const resetZoom = () => { z = { s: 1, x: 0, y: 0 }; slides.forEach((s) => { $('.lb-zoom', s).style.transform = ''; }); };
  show(false);

  const pts = new Map();
  let gesture = null;
  let lastTap = 0;
  node.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.lb-btn')) return;
    try { node.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      gesture = { kind: 'pending', sx: e.clientX, sy: e.clientY, z0: { ...z }, t: Date.now() };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z0: { ...z } };
    }
  });
  node.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !gesture) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.kind === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.max(0.8, Math.min(gesture.z0.s * (d / gesture.d0), 6));
      const k = s / gesture.z0.s;
      z = { s, x: m.x - (gesture.m0.x - gesture.z0.x) * k, y: m.y - (gesture.m0.y - gesture.z0.y) * k };
      applyZoom(false);
      return;
    }
    const dx = e.clientX - gesture.sx;
    const dy = e.clientY - gesture.sy;
    if (gesture.kind === 'pending' && Math.hypot(dx, dy) > 8) {
      gesture.kind = z.s > 1 ? 'pan' : Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy > 0 ? 'pull' : 'none';
    }
    if (gesture.kind === 'pan') { z = { s: z.s, x: gesture.z0.x + dx, y: gesture.z0.y + dy }; applyZoom(false); }
    if (gesture.kind === 'swipe') { track.style.transition = 'none'; track.style.transform = `translateX(calc(${-idx * 100}% + ${dx}px))`; }
    if (gesture.kind === 'pull') { track.style.transition = 'none'; track.style.transform = `translate(${-idx * 100}%, ${dy}px)`; node.style.background = `rgba(0,0,0,${Math.max(0.3, 1 - dy / 400)})`; }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!gesture) return;
    const g = gesture;
    if (g.kind === 'pinch') {
      if (pts.size === 0) { clampZoom(); applyZoom(true); gesture = null; }
      else { const [p] = [...pts.values()]; gesture = { kind: 'pan', sx: p.x, sy: p.y, z0: { ...z } }; }
      return;
    }
    gesture = null;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (g.kind === 'pending' && Date.now() - g.t < 300) {
      const now = Date.now();
      if (now - lastTap < 300) { // double tap
        lastTap = 0;
        if (z.s > 1) z = { s: 1, x: 0, y: 0 };
        else { const s = 2.6; z = { s, x: e.clientX - e.clientX * s, y: e.clientY - e.clientY * s }; clampZoom(); }
        applyZoom(true);
      } else lastTap = now;
      return;
    }
    if (g.kind === 'pan') { clampZoom(); applyZoom(true); }
    if (g.kind === 'swipe') {
      if (dx < -60 && idx < items.length - 1) { idx++; resetZoom(); } else if (dx > 60 && idx > 0) { idx--; resetZoom(); }
      show(true);
    }
    if (g.kind === 'pull') {
      if (dy > 120) { close(); return; }
      node.style.background = '';
      show(true);
    }
  };
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);

  const layer = pushLayer(node);
  const close = () => removeLayer(layer);
  $('.lb-x', node).onclick = close;
  // Load the file before the tap: sharing must start right away after a tap (iPhone forgets it otherwise).
  const files = new Map();
  const prepare = (i) => {
    if (!files.has(i)) files.set(i, fetch(items[i].src).then((r) => r.blob()).then((b) => new File([b], `${opts.name || 'zhongcao'}-${i + 1}.jpg`, { type: b.type || 'image/jpeg' })).catch(() => null));
    return files.get(i);
  };
  prepare(idx);
  track.addEventListener('transitionend', () => prepare(idx));
  $('.lb-save', node).onclick = () => {
    const i = idx;
    let ready = null;
    prepare(i).then((f) => { ready = f; });
    const go = (file) => {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file] }).catch((e) => { if (e.name !== 'AbortError') toast('保存失败'); });
      } else {
        const a = document.createElement('a');
        a.href = items[i].src; a.download = file ? file.name : 'zhongcao.jpg'; a.click();
      }
    };
    // A resolved promise still runs its callback in a microtask, which keeps the tap; check right after.
    Promise.resolve().then(() => Promise.resolve()).then(() => (ready ? go(ready) : prepare(i).then(go)));
  };
  window.addEventListener('resize', () => { resetZoom(); show(false); });
  return { close };
}

// Chip group for multi/single select. values: [value] or [{value,label}]. Returns element with .value getter.
export function chips(values, selected, multi) {
  const sel = new Set([].concat(selected || []).filter(Boolean));
  const box = el('<div class="chips"></div>');
  for (const v of values) {
    const value = typeof v === 'object' ? v.value : v;
    const lab = typeof v === 'object' ? v.label : v;
    const b = el(`<button type="button" class="chip ${sel.has(value) ? 'on' : ''}" data-v="${esc(value)}">${typeof v === 'object' && v.html ? v.html : esc(lab)}</button>`);
    b.onclick = () => {
      if (multi) { if (sel.has(value)) sel.delete(value); else sel.add(value); }
      else { const had = sel.has(value); sel.clear(); if (!had) sel.add(value); }
      $$('.chip', box).forEach((c) => c.classList.toggle('on', sel.has(c.dataset.v)));
      box.dispatchEvent(new Event('change'));
    };
    box.appendChild(b);
  }
  Object.defineProperty(box, 'value', { get: () => (multi ? [...sel] : [...sel][0] || '') });
  return box;
}

export function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const input = $('#file-input');
    input.accept = accept;
    input.multiple = !!multiple;
    input.value = '';
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}
