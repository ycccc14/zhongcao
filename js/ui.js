// Small UI toolkit: element helper, toast, pages, sheets, confirm, copy, photo viewer.
import { escapeHtml } from './logic.js';
import { openViewer } from './viewer.js';

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

// iPhone Safari has drawn Leaflet maps above fixed overlays whatever the z-index (see js/pre.js and app.css).
// As a safety net, maps under a full-screen page or photo viewer are hidden: they can't be seen there anyway.
// Under a half-transparent sheet the map stays visible behind the dimmed background.
function markCovered() {
  const opaque = (l) => l.node.classList.contains('page') || l.node.classList.contains('lb');
  const coveredAt = (i) => layers.slice(i + 1).some(opaque);
  const main = document.querySelector('main');
  if (main) main.classList.toggle('covered', coveredAt(-1));
  layers.forEach((l, i) => l.node.classList.toggle('covered', coveredAt(i)));
}

const ENTER_MS = 460; // pages slide in this long (app.css pageIn)
const LEAVE_MS = 340;

// dismiss(): the layer animates itself away and removes its node (the photo viewer).
function pushLayer(node, onClose, dismiss) {
  const layer = { node, onClose, dismiss };
  layers.push(layer);
  // The newest layer is always on top: a page opened from a sheet (e.g. the map picker) must not hide behind it.
  node.style.zIndex = String(100 + layers.length * 10);
  history.pushState({ layer: layers.length }, '');
  // Hide maps under a new full-screen layer only once it has slid in, so the page behind stays whole while it moves.
  const opaque = node.classList.contains('page') || node.classList.contains('lb');
  if (opaque) setTimeout(markCovered, ENTER_MS); else markCovered();
  return layer;
}

function removeLayer(layer, fromPop) {
  const i = layers.indexOf(layer);
  if (i < 0) return;
  layers.splice(i, 1);
  markCovered();
  if (layer.dismiss) layer.dismiss();
  else {
    layer.node.classList.add('leaving');
    setTimeout(() => layer.node.remove(), LEAVE_MS);
  }
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
  if (!opts.sticky) dragToClose($('.sheet', node), node, sheet.close);
  render(sheet.body, sheet);
  return sheet;
}

// Pull a sheet down by its grip / title: it follows the finger, and a long or quick pull closes it.
function dragToClose(sh, wrap, close) {
  let d = null;
  sh.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.grip, .sheet > h3') || e.target.closest('button, a, input, textarea, select')) return;
    d = { y: e.clientY, last: e.clientY, t: performance.now(), v: 0, dy: 0 };
    try { sh.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    sh.classList.add('dragging');
  });
  sh.addEventListener('pointermove', (e) => {
    if (!d) return;
    const now = performance.now();
    d.v = (e.clientY - d.last) / Math.max(8, now - d.t);
    d.last = e.clientY;
    d.t = now;
    const raw = e.clientY - d.y;
    d.dy = raw > 0 ? raw : -Math.sqrt(-raw) * 2; // upwards it only stretches a little
    sh.style.transform = `translateY(${d.dy}px)`;
    wrap.style.backgroundColor = `rgba(20, 10, 10, ${(0.4 * Math.max(0.15, 1 - Math.max(0, d.dy) / (sh.offsetHeight || 600))).toFixed(3)})`;
  });
  const end = () => {
    if (!d) return;
    const { dy, v } = d;
    d = null;
    sh.classList.remove('dragging');
    if (dy > Math.min(140, sh.offsetHeight * 0.3) || (v > 0.55 && dy > 10)) {
      sh.style.setProperty('--from', `${Math.max(0, dy)}px`); // the closing slide starts where the finger let go
      sh.style.transform = '';
      close();
    } else {
      sh.style.transition = 'transform .4s cubic-bezier(.32, .72, 0, 1)';
      sh.style.transform = '';
      wrap.style.backgroundColor = '';
      setTimeout(() => { sh.style.transition = ''; }, 420);
    }
  };
  sh.addEventListener('pointerup', end);
  sh.addEventListener('pointercancel', end);
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
// items: [{src, caption, from?: the <img> on the page it opens out of}]. The viewer itself is js/viewer.js
// (zoom, swipe, pull down to close); here it gets the back button and the save / share button.
export function lightbox(items, start, opts) {
  opts = opts || {};
  let layer = null;
  const v = openViewer(items, start, {
    cls: 'lb',
    buttons: '<button class="vw-btn lb-save" aria-label="保存/分享">⇩</button>',
    onClose: () => { if (layer) removeLayer(layer); },
  });
  layer = pushLayer(v.el, null, v.close);
  // Load the file before the tap: sharing must start right away after a tap (iPhone forgets it otherwise).
  const files = new Map();
  const prepare = (i) => {
    if (!files.has(i)) files.set(i, fetch(items[i].src).then((r) => r.blob()).then((b) => new File([b], `${opts.name || 'zhongcao'}-${i + 1}.jpg`, { type: b.type || 'image/jpeg' })).catch(() => null));
    return files.get(i);
  };
  prepare(v.index());
  v.el.addEventListener('transitionend', () => prepare(v.index()));
  $('.lb-save', v.el).onclick = () => {
    const i = v.index();
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
  return { close: v.close };
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
