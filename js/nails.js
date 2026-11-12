// 美甲 page: photo wall grouped by colour / style / shape / length / vibe / season, auto-classified by AI.
import * as db from './db.js';
import * as img from './img.js';
import * as ai from './ai.js';
import { openImport, gather, release, sourceOf } from './importer.js';
import { NAIL_COLORS, NAIL_STYLES, NAIL_SHAPES, NAIL_LENGTHS, NAIL_VIBES, SEASONS, nailFromAi, uid, SOURCE_LABEL } from './logic.js';
import { el, esc, $, $$, openPage, openSheet, toast, confirmBox, busy, lightbox, chips } from './ui.js';

const GROUPS = {
  color: { label: '颜色', values: () => Object.keys(NAIL_COLORS), of: (n) => (n.color ? [n.color] : []), name: (v) => NAIL_COLORS[v].label },
  style: { label: '款式', values: () => NAIL_STYLES, of: (n) => n.styles || [] },
  shape: { label: '甲型', values: () => NAIL_SHAPES, of: (n) => (n.shape ? [n.shape] : []) },
  length: { label: '长度', values: () => NAIL_LENGTHS, of: (n) => (n.length ? [n.length] : []) },
  vibe: { label: '风格', values: () => NAIL_VIBES, of: (n) => n.vibes || [] },
  season: { label: '季节', values: () => SEASONS, of: (n) => n.seasons || [] },
};

let root = null;
let nails = [];
let ui = { group: 'color', value: '', fav: false };

export async function mount(node) {
  root = node;
  ui = { ...ui, ...(await db.getKv('nailUi', {})) };
  nails = await db.all('nails');
  render();
}
export async function refresh() { if (root) { nails = await db.all('nails'); render(); } }
const saveUi = () => db.setKv('nailUi', ui);

function swatch(v) {
  const c = NAIL_COLORS[v];
  return `<i class="sw" style="background:${c.hex}"></i>`;
}

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
    ${unsorted && ai.ready() ? `<button class="banner" data-a="classify">${unsorted} 张还没分类，点这里让 AI 分类 ›</button>` : ''}
    <div class="wall">${list.map((n) => `<button class="nail" data-id="${n.id}"><img data-img="${n.image}" alt="${esc(n.title)}">${n.fav ? '<i class="heart">♥</i>' : ''}${n.done ? '<i class="done">做过</i>' : ''}
      ${n.title ? `<span>${esc(n.title)}</span>` : ''}</button>`).join('')}</div>
    ${!list.length ? `<div class="empty-state"><div class="big">💅</div><p>${nails.length ? '这个分类还没有' : '上传喜欢的美甲照片，AI 会自动按颜色、款式、甲型分类'}</p><button class="btn" data-a="add">＋ 上传照片</button></div>` : ''}`;
  (async () => { for (const im of $$('img[data-img]', root)) im.src = await img.url(im.dataset.img, 'thumb'); })();

  root.onclick = (e) => {
    const gb = e.target.closest('[data-group]');
    if (gb) { ui.group = gb.dataset.group; ui.value = ''; saveUi(); render(); return; }
    const vb = e.target.closest('[data-v]');
    if (vb) { ui.value = vb.dataset.v; saveUi(); render(); return; }
    const card = e.target.closest('.nail');
    if (card) { openDetail(card.dataset.id, list.map((n) => n.id)); return; }
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

async function classify(parts, src, step) {
  const out = new Array(parts.length).fill(null);
  if (!ai.ready()) return out;
  for (let i = 0; i < parts.length; i += 6) {
    step(`AI 正在分类… ${Math.min(i + 6, parts.length)} / ${parts.length}`);
    const res = await ai.readNails(parts.slice(i, i + 6), src);
    for (const it of res.items || []) if (it.index >= 0 && it.index < 6 && i + it.index < parts.length) out[i + it.index] = it;
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
    let n = 0;
    let skipped = 0;
    for (let i = 0; i < g.pics.length; i++) {
      const r = results[i];
      if (r && !r.is_nail) { skipped++; continue; }
      w.set('保存中…', `${i + 1} / ${g.pics.length}`);
      const id = await g.pics[i].save();
      const rec = r ? nailFromAi(r, id) : { ...nailFromAi({}, id), ai: false };
      rec.sources = src.url ? [src] : [];
      await db.put('nails', rec);
      n++;
    }
    w.done();
    toast(`已保存 ${n} 张${skipped ? `（跳过 ${skipped} 张不是美甲的图）` : ''} ✓${ai.takeNote() ? '（这次用 Flash-Lite）' : ''}`, 3000);
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
    for (const n of todo) { const rec = await db.get('images', n.image); parts.push(await img.forAi(rec.blob)); }
    const results = await classify(parts, null, (t) => w.set(t));
    for (let i = 0; i < todo.length; i++) {
      if (!results[i]) continue;
      const fresh = nailFromAi(results[i], todo[i].image);
      await db.put('nails', { ...fresh, id: todo[i].id, fav: todo[i].fav, done: todo[i].done, sources: todo[i].sources, created: todo[i].created });
    }
    w.done();
    toast('分类好了 ✓');
    await refresh();
  } catch (e) { w.done(); toast(e.message, 4000); }
}

// ---------- detail ----------

function openDetail(id, order) {
  let n = nails.find((x) => x.id === id);
  if (!n) return;
  openPage(n.title || '美甲', async (body, page) => {
    const draw = async () => {
      const full = await img.url(n.image);
      const tag = (v) => `<span class="tag">${esc(v)}</span>`;
      body.innerHTML = `<button class="nail-big"><img src="${full}" alt=""></button>
        <div class="detail-head"><h1>${esc(n.title || '未命名款式')}</h1>
          <div class="row gap"><button class="chip ${n.fav ? 'on' : ''}" data-a="fav">${n.fav ? '♥ 已收藏' : '♡ 收藏'}</button><button class="chip ${n.done ? 'on' : ''}" data-a="done">${n.done ? '✓ 做过了' : '做过了？'}</button></div></div>
        <section class="box"><h3>分类 <button class="link-btn" data-a="edit">修改</button></h3>
          ${n.color ? `<p>${swatch(n.color)} ${esc(NAIL_COLORS[n.color].label)} ${(n.colors || []).map((c) => `<i class="sw" style="background:${esc(c.hex)}" title="${esc(c.name)}"></i>`).join('')}</p>` : ''}
          <div class="tags">${[...(n.styles || []), n.shape, n.length && `${n.length}甲`, ...(n.vibes || []), ...(n.seasons || []).map((s) => `${s}天`)].filter(Boolean).map(tag).join('') || '<span class="muted">还没分类</span>'}</div>
          ${n.note ? `<p class="summary">${esc(n.note)}</p>` : ''}</section>
        ${(n.sources || []).filter((s) => s.url).map((s) => `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener">🔗 ${esc(SOURCE_LABEL[s.kind] || '来源')} ${esc(s.title || '')}</a>`).join('')}
        <p class="hint">点图片可以放大、分享给美甲师。</p>
        <button class="btn ghost danger wide" data-a="del">删除</button>`;
    };
    await draw();
    body.onclick = async (e) => {
      if (e.target.closest('.nail-big')) {
        const ids = order.map((x) => nails.find((y) => y.id === x)).filter(Boolean);
        const urls = await Promise.all(ids.map((x) => img.url(x.image)));
        lightbox(urls.map((src, i) => ({ src, caption: ids[i].title })), ids.findIndex((x) => x.id === n.id), { name: 'nails' });
        return;
      }
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'fav') { n.fav = !n.fav; await save(n); draw(); }
      if (a.dataset.a === 'done') { n.done = !n.done; await save(n); draw(); }
      if (a.dataset.a === 'edit') editTags(n, async (v) => { n = v; await save(n); page.setTitle(n.title || '美甲'); draw(); });
      if (a.dataset.a === 'del' && await confirmBox('删除这张美甲？', '删除', true)) {
        await db.del('nails', n.id); await db.sweepImages(); page.close(); refresh();
      }
    };
  }, { cls: 'page-detail' });
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
