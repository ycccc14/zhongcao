// 美甲 page: photo wall grouped by colour / style / shape / length / vibe / season, auto-classified by AI.
// One design = one record with all its photos (swipe through them on the wall and on the detail page).
import * as db from './db.js';
import * as img from './img.js';
import * as ai from './ai.js';
import { openImport, gather, release, sourceOf } from './importer.js';
import { NAIL_COLORS, NAIL_STYLES, NAIL_SHAPES, NAIL_LENGTHS, NAIL_VIBES, SEASONS, nailFromAi, uid, SOURCE_LABEL, groupNails, sameNailGroups, mergeNails, nailImages } from './logic.js';
import { el, esc, $, $$, openPage, openSheet, toast, confirmBox, busy, lightbox, chips } from './ui.js';

const GROUPS = {
  color: { label: '颜色', values: () => Object.keys(NAIL_COLORS), of: (n) => (n.color ? [n.color] : []), name: (v) => NAIL_COLORS[v].label },
  style: { label: '款式', values: () => NAIL_STYLES, of: (n) => n.styles || [] },
  shape: { label: '甲型', values: () => NAIL_SHAPES, of: (n) => (n.shape ? [n.shape] : []) },
  length: { label: '长度', values: () => NAIL_LENGTHS, of: (n) => (n.length ? [n.length] : []) },
  vibe: { label: '风格', values: () => NAIL_VIBES, of: (n) => n.vibes || [] },
  season: { label: '季节', values: () => SEASONS, of: (n) => n.seasons || [] },
};
const BATCH = 10; // photos per AI call: the AI can only tell "same design" inside one call

let root = null;
let nails = [];
let ui = { group: 'color', value: '', fav: false };

// Older versions saved each photo of an upload as its own design (same name twice): fold those together once.
async function mergeOldDuplicates() {
  if (await db.getKv('nailsMerged', false)) return;
  for (const { keep, merged } of sameNailGroups(await db.all('nails'))) {
    await db.put('nails', mergeNails(keep, merged));
    for (const m of merged) await db.del('nails', m.id);
  }
  await db.setKv('nailsMerged', true);
}

export async function mount(node) {
  root = node;
  ui = { ...ui, ...(await db.getKv('nailUi', {})) };
  await mergeOldDuplicates();
  nails = await db.all('nails');
  render();
}
export async function refresh() { if (root) { nails = await db.all('nails'); render(); } }
const saveUi = () => db.setKv('nailUi', ui);

function swatch(v) {
  const c = NAIL_COLORS[v];
  return `<i class="sw" style="background:${c.hex}"></i>`;
}

// Photos side by side, swiped with the finger (native scroll-snap), with dots under them.
function strip(ids, cls, kind, title) {
  const many = ids.length > 1;
  return `<div class="${cls}"><div class="pics">${ids.map((id) => `<img data-img="${id}" data-kind="${kind}" alt="${esc(title || '')}">`).join('')}</div>
    ${many ? `<div class="dots">${ids.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div><i class="pcount">${ids.length}</i>` : ''}</div>`;
}
function wireStrips(scope) {
  for (const s of $$('.pics', scope)) {
    const dots = $$('.dots i', s.parentNode);
    if (!dots.length) continue;
    s.addEventListener('scroll', () => {
      const i = Math.round(s.scrollLeft / Math.max(1, s.clientWidth));
      dots.forEach((d, k) => d.classList.toggle('on', k === i));
    }, { passive: true });
  }
  (async () => { for (const im of $$('img[data-img]', scope)) im.src = await img.url(im.dataset.img, im.dataset.kind === 'full' ? '' : 'thumb'); })();
}
const shownIndex = (s) => Math.round(s.scrollLeft / Math.max(1, s.clientWidth));

function render() {
  const g = GROUPS[ui.group];
  const counts = {};
  for (const n of nails) for (const v of g.of(n)) counts[v] = (counts[v] || 0) + 1;
  const values = g.values().filter((v) => counts[v]);
  if (ui.value && !counts[ui.value]) ui.value = '';
  let list = nails.filter((n) => (!ui.fav || n.fav) && (!ui.value || g.of(n).includes(ui.value)));
  list = list.sort((a, b) => b.created - a.created);
  const unsorted = nails.filter((n) => !n.ai && !n.styles.length && !n.color).length;

  root.innerHTML = `<header class="tab-head"><h1>美甲灵感</h1><span class="grow"></span>
      <button class="icon-btn ${ui.fav ? 'on' : ''}" data-a="fav" aria-label="只看收藏">${ui.fav ? '♥' : '♡'}</button><button class="add-btn" data-a="add" aria-label="添加">＋</button></header>
    <div class="filters"><div class="seg wide">${Object.entries(GROUPS).map(([k, v]) => `<button data-group="${k}" class="${ui.group === k ? 'on' : ''}">${v.label}</button>`).join('')}</div>
      <div class="chips scroll"><button class="chip ${!ui.value ? 'on' : ''}" data-v="">全部 ${nails.length}</button>
        ${values.map((v) => `<button class="chip ${ui.value === v ? 'on' : ''}" data-v="${esc(v)}">${ui.group === 'color' ? swatch(v) : ''}${esc(g.name ? g.name(v) : v)} ${counts[v]}</button>`).join('')}</div></div>
    ${unsorted && ai.ready() ? `<button class="banner" data-a="classify">${unsorted} 款还没分类，点这里让 AI 分类 ›</button>` : ''}
    <div class="wall">${list.map((n, i) => `<div class="nail" role="button" tabindex="0" data-id="${n.id}" style="--i:${Math.min(i, 12)}">${strip(nailImages(n), 'nail-strip', 'thumb', n.title)}${n.fav ? '<i class="heart">♥</i>' : ''}${n.done ? '<i class="done">做过</i>' : ''}
      ${n.title ? `<span>${esc(n.title)}</span>` : ''}</div>`).join('')}</div>
    ${!list.length ? `<div class="empty-state"><div class="big">💅</div><p>${nails.length ? '这个分类还没有' : '上传喜欢的美甲照片，AI 会自动按颜色、款式、甲型分类，同一款的几张图放在一起'}</p><button class="btn" data-a="add">＋ 上传照片</button></div>` : ''}`;
  wireStrips(root);

  root.onclick = (e) => {
    const gb = e.target.closest('[data-group]');
    if (gb) { ui.group = gb.dataset.group; ui.value = ''; saveUi(); render(); return; }
    const vb = e.target.closest('[data-v]');
    if (vb) { ui.value = vb.dataset.v; saveUi(); render(); return; }
    const card = e.target.closest('.nail');
    if (card) { const s = $('.pics', card); openDetail(card.dataset.id, s ? shownIndex(s) : 0); return; }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    if (a.dataset.a === 'add') startAdd();
    if (a.dataset.a === 'fav') { ui.fav = !ui.fav; saveUi(); render(); }
    if (a.dataset.a === 'classify') classifySaved();
  };
}

// ---------- add ----------

export function startAdd(preset) {
  openImport('nails', runImport, null, preset);
}

// AI answers per photo, plus which AI call (batch) each came from: design numbers only mean something inside one call.
async function classify(parts, src, step) {
  const out = parts.map((_, i) => ({ batch: Math.floor(i / BATCH), r: null }));
  if (!ai.ready()) return out;
  for (let i = 0; i < parts.length; i += BATCH) {
    step(`AI 正在分类… ${Math.min(i + BATCH, parts.length)} / ${parts.length}`);
    const res = await ai.readNails(parts.slice(i, i + BATCH), src);
    for (const it of res.items || []) if (it.index >= 0 && it.index < BATCH && i + it.index < parts.length) out[i + it.index].r = it;
  }
  return out;
}

async function runImport(input) {
  const w = busy('准备中…');
  let g = null;
  try {
    g = await gather('nails', input, (t, d) => w.set(t, d));
    if (!g.pics.length) throw new Error('没有找到图片');
    if (!ai.ready()) toast('还没有填 AI key，先存下来，之后可以一键分类', 3500);
    const results = await classify(g.pics.map((p) => p.part), g.src, (t) => w.set(t));
    const src = sourceOf(g, 'shot');
    const keep = results.map((x, i) => i).filter((i) => !(results[i].r && !results[i].r.is_nail));
    const skipped = results.length - keep.length;
    // Without AI each photo stays its own design (merge them by hand on the detail page).
    const groups = ai.ready() ? groupNails(keep.map((i) => results[i])).map((grp) => grp.map((k) => keep[k])) : keep.map((i) => [i]);
    let n = 0;
    let saved = 0;
    for (const grp of groups) {
      const ids = [];
      for (const i of grp) { w.set('保存中…', `${++saved} / ${keep.length}`); ids.push(await g.pics[i].save()); }
      const r = (grp.map((i) => results[i].r).find(Boolean));
      const rec = r ? nailFromAi(r, ids) : { ...nailFromAi({}, ids), ai: false };
      rec.sources = src.url ? [src] : [];
      rec.created = Date.now() + n;
      await db.put('nails', rec);
      n++;
    }
    w.done();
    const msg = [`已保存 ${n} 款`, keep.length > groups.length ? '同款已放一起' : '', skipped ? `跳过 ${skipped} 张非美甲图` : ''].filter(Boolean).join('，');
    toast(`${msg} ✓${ai.takeNote() ? '（用了 Flash-Lite）' : ''}`, 3500);
    await refresh();
  } catch (e) {
    w.done();
    toast(e.message || '出错了', 4000);
  } finally {
    release(g);
  }
}

async function classifySaved() {
  const todo = nails.filter((n) => !n.ai && !n.styles.length && !n.color);
  const w = busy('准备中…');
  try {
    const parts = [];
    for (const n of todo) { const rec = await db.get('images', nailImages(n)[0]); parts.push(await img.forAi(rec.blob)); }
    const results = await classify(parts, null, (t) => w.set(t));
    for (let i = 0; i < todo.length; i++) {
      if (!results[i].r) continue;
      const fresh = nailFromAi(results[i].r, nailImages(todo[i]));
      await db.put('nails', { ...fresh, id: todo[i].id, fav: todo[i].fav, done: todo[i].done, sources: todo[i].sources, created: todo[i].created });
    }
    w.done();
    toast('分类好了 ✓');
    await refresh();
  } catch (e) { w.done(); toast(e.message, 4000); }
}

// ---------- detail ----------

function openDetail(id, startAt) {
  let n = nails.find((x) => x.id === id);
  if (!n) return;
  let at = startAt || 0;
  openPage(n.title || '美甲', async (body, page) => {
    const draw = () => {
      const ids = nailImages(n);
      at = Math.max(0, Math.min(at, ids.length - 1));
      const tag = (v) => `<span class="tag">${esc(v)}</span>`;
      body.innerHTML = `${strip(ids, 'nail-big', 'full', n.title)}
        <div class="pic-acts"><button class="link-btn" data-a="add-pic">＋ 加照片</button>${ids.length > 1 ? '<button class="link-btn" data-a="rm-pic">移除这张</button>' : ''}<button class="link-btn" data-a="merge">合并同款…</button></div>
        <div class="detail-head"><h1>${esc(n.title || '未命名款式')}</h1>
          <div class="row gap"><button class="chip ${n.fav ? 'on' : ''}" data-a="fav">${n.fav ? '♥ 已收藏' : '♡ 收藏'}</button><button class="chip ${n.done ? 'on' : ''}" data-a="done">${n.done ? '✓ 做过了' : '做过了？'}</button></div></div>
        <section class="box"><h3>分类 <button class="link-btn" data-a="edit">修改</button></h3>
          ${n.color ? `<p>${swatch(n.color)} ${esc(NAIL_COLORS[n.color].label)} ${(n.colors || []).map((c) => `<i class="sw" style="background:${esc(c.hex)}" title="${esc(c.name)}"></i>`).join('')}</p>` : ''}
          <div class="tags">${[...(n.styles || []), n.shape, n.length && `${n.length}甲`, ...(n.vibes || []), ...(n.seasons || []).map((s) => `${s}天`)].filter(Boolean).map(tag).join('') || '<span class="muted">还没分类</span>'}</div>
          ${n.note ? `<p class="summary">${esc(n.note)}</p>` : ''}</section>
        ${(n.sources || []).filter((s) => s.url).map((s) => `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener">🔗 ${esc(SOURCE_LABEL[s.kind] || '来源')} ${esc(s.title || '')}</a>`).join('')}
        <p class="hint">${ids.length > 1 ? '左右滑动看同款的其他照片，' : ''}点图片可以放大、分享给美甲师。</p>
        <button class="btn ghost danger wide" data-a="del">删除这一款</button>`;
      wireStrips(body);
      const s = $('.nail-big .pics', body);
      if (at) requestAnimationFrame(() => { s.scrollLeft = at * s.clientWidth; });
      s.addEventListener('scroll', () => { at = shownIndex(s); }, { passive: true });
    };
    draw();
    body.onclick = async (e) => {
      const pic = e.target.closest('.nail-big img');
      if (pic) {
        const ids = nailImages(n);
        const imgs = $$('.nail-big img', body);
        const urls = await Promise.all(ids.map((x) => img.url(x)));
        lightbox(urls.map((src, i) => ({ src, caption: n.title, from: imgs[i] })), imgs.indexOf(pic), { name: 'nails' });
        return;
      }
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'fav') { n.fav = !n.fav; await save(n); draw(); }
      if (a.dataset.a === 'done') { n.done = !n.done; await save(n); draw(); }
      if (a.dataset.a === 'edit') editTags(n, async (v) => { n = v; await save(n); page.setTitle(n.title || '美甲'); draw(); });
      if (a.dataset.a === 'add-pic') openImport('nails', async (input) => { n = await addPhotos(n, input); at = nailImages(n).length - 1; draw(); }, null);
      if (a.dataset.a === 'rm-pic' && await confirmBox('从这一款里移除这张照片？', '移除', true)) {
        const ids = nailImages(n).filter((_, i) => i !== at);
        n = { ...n, images: ids, image: ids[0] };
        await save(n); await db.sweepImages(); draw();
      }
      if (a.dataset.a === 'merge') {
        const others = await pickSame(n);
        if (others && others.length) {
          n = mergeNails(n, others);
          await db.put('nails', n);
          for (const o of others) await db.del('nails', o.id);
          await refresh();
          toast(`合并好了，这一款现在有 ${nailImages(n).length} 张照片 ✓`);
          draw();
        }
      }
      if (a.dataset.a === 'del' && await confirmBox(nailImages(n).length > 1 ? `删除这一款（${nailImages(n).length} 张照片）？` : '删除这一款美甲？', '删除', true)) {
        await db.del('nails', n.id); await db.sweepImages(); page.close(); refresh();
      }
    };
  }, { cls: 'page-detail' });
}

// More photos of the same design (auto-cropped like any upload).
async function addPhotos(n, input) {
  const w = busy('准备中…');
  let g = null;
  try {
    g = await gather('nails', input, (t, d) => w.set(t, d));
    const ids = [...nailImages(n)];
    for (let i = 0; i < g.pics.length; i++) { w.set('保存中…', `${i + 1} / ${g.pics.length}`); ids.push(await g.pics[i].save()); }
    const rec = { ...n, images: ids, image: ids[0] };
    await save(rec);
    w.done();
    toast(`加了 ${g.pics.length} 张 ✓`);
    return rec;
  } catch (e) {
    w.done();
    toast(e.message || '出错了', 4000);
    return n;
  } finally {
    release(g);
  }
}

// Choose other designs that are really this one. Resolves the chosen records (or null).
function pickSame(n) {
  return new Promise((resolve) => {
    let out = null;
    const others = nails.filter((x) => x.id !== n.id).sort((a, b) => (a.title === n.title ? -1 : 0) - (b.title === n.title ? -1 : 0) || b.created - a.created);
    openSheet('哪些是同一款？', (box, sheet) => {
      box.innerHTML = others.length ? `<p class="hint">选中的会并进「${esc(n.title || '这一款')}」，照片放在一起。</p>
        <div class="pic-pick">${others.map((x) => `<button type="button" class="pp" data-id="${x.id}"><img data-img="${nailImages(x)[0]}" alt=""><span>✓</span><small>${esc(x.title || '')}</small></button>`).join('')}</div>
        <button class="btn wide" data-a="ok">合并</button>` : '<p class="hint">还没有别的款式。</p>';
      (async () => { for (const im of $$('img[data-img]', box)) im.src = await img.url(im.dataset.img, 'thumb'); })();
      const sel = new Set();
      box.onclick = (e) => {
        const b = e.target.closest('.pp');
        if (b) { if (sel.has(b.dataset.id)) sel.delete(b.dataset.id); else sel.add(b.dataset.id); b.classList.toggle('on', sel.has(b.dataset.id)); return; }
        if (e.target.closest('[data-a=ok]')) { out = others.filter((x) => sel.has(x.id)); sheet.close(); }
      };
    }, { cls: 'tall', onClose: () => resolve(out) });
  });
}

async function save(n) { n.updated = Date.now(); await db.put('nails', n); const i = nails.findIndex((x) => x.id === n.id); if (i >= 0) nails[i] = n; render(); }

function editTags(n, done) {
  openSheet('修改分类', (box, sheet) => {
    box.innerHTML = `<label class="field"><span>名字</span><input name="title" value="${esc(n.title)}"></label>
      <div class="field"><span>颜色</span><div class="s-color"></div></div><div class="field"><span>款式</span><div class="s-style"></div></div>
      <div class="field"><span>甲型</span><div class="s-shape"></div></div><div class="field"><span>长度</span><div class="s-length"></div></div>
      <div class="field"><span>风格</span><div class="s-vibe"></div></div><div class="field"><span>季节</span><div class="s-season"></div></div>
      <label class="field"><span>备注</span><input name="note" value="${esc(n.note)}"></label><button class="btn wide" data-a="ok">保存</button>`;
    const c = {
      color: chips(Object.keys(NAIL_COLORS).map((k) => ({ value: k, label: NAIL_COLORS[k].label, html: `${swatch(k)}${esc(NAIL_COLORS[k].label)}` })), n.color),
      styles: chips(NAIL_STYLES, n.styles, true), shape: chips(NAIL_SHAPES, n.shape), length: chips(NAIL_LENGTHS, n.length),
      vibes: chips(NAIL_VIBES, n.vibes, true), seasons: chips(SEASONS, n.seasons, true),
    };
    $('.s-color', box).appendChild(c.color); $('.s-style', box).appendChild(c.styles); $('.s-shape', box).appendChild(c.shape);
    $('.s-length', box).appendChild(c.length); $('.s-vibe', box).appendChild(c.vibes); $('.s-season', box).appendChild(c.seasons);
    $('[data-a=ok]', box).onclick = () => {
      done({ ...n, title: $('[name=title]', box).value.trim(), note: $('[name=note]', box).value.trim(), color: c.color.value, styles: c.styles.value, shape: c.shape.value, length: c.length.value, vibes: c.vibes.value, seasons: c.seasons.value, ai: true });
      sheet.close();
    };
  }, { cls: 'tall' });
}

export const count = () => nails.length;
export { uid };
