// 修图口令 page: AI photo-editing prompts with before/after pictures. Videos are broken into frames + subtitles.
import * as db from './db.js';
import * as img from './img.js';
import * as ai from './ai.js';
import { openImport, gather, release, sourceOf } from './importer.js';
import { uid, normBox, normalizeTool, EDIT_TOOLS, SOURCE_LABEL } from './logic.js';
import { el, esc, $, $$, openPage, openSheet, toast, confirmBox, busy, lightbox, copy } from './ui.js';

let root = null;
let edits = [];
let ui = { tool: '', tag: '', q: '', fav: false };

export async function mount(node) {
  root = node;
  ui = { ...ui, ...(await db.getKv('editUi', {})) };
  edits = await db.all('edits');
  render();
}
export async function refresh() { if (root) { edits = await db.all('edits'); render(); } }
const saveUi = () => db.setKv('editUi', ui);

function render() {
  const tools = [...new Set(edits.map((e) => e.tool).filter(Boolean))];
  const tagCount = {};
  for (const e of edits) for (const t of e.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
  const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);
  const q = ui.q.trim().toLowerCase();
  const list = edits.filter((e) => (!ui.tool || e.tool === ui.tool) && (!ui.tag || (e.tags || []).includes(ui.tag)) && (!ui.fav || e.fav)
    && (!q || [e.title, e.tool, ...(e.tags || []), ...(e.prompts || []).map((p) => p.text)].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => b.created - a.created);

  root.innerHTML = `<header class="tab-head"><h1>修图口令</h1><span class="grow"></span>
      <button class="icon-btn ${ui.fav ? 'on' : ''}" data-a="fav" aria-label="只看收藏">${ui.fav ? '♥' : '♡'}</button><button class="add-btn" data-a="add" aria-label="添加">＋</button></header>
    <div class="filters"><input class="search full" type="search" placeholder="搜口令、效果…" value="${esc(ui.q)}">
      ${tools.length || tags.length ? `<div class="chips scroll"><button class="chip ${!ui.tool && !ui.tag ? 'on' : ''}" data-tool="">全部</button>
        ${tools.map((t) => `<button class="chip ${ui.tool === t ? 'on' : ''}" data-tool="${esc(t)}">${esc(t)}</button>`).join('')}
        ${tags.map((t) => `<button class="chip soft ${ui.tag === t ? 'on' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}</div>
    <div class="ecards">${list.map((e) => `<div class="ecard" data-id="${e.id}">
      <button class="eimgs ${e.before ? 'two' : ''}" data-open="${e.id}">${e.before ? `<span><img data-img="${e.before}" alt=""><i>前</i></span>` : ''}${e.after ? `<span><img data-img="${e.after}" alt=""><i>后</i></span>` : '<span class="noimg">✨</span>'}</button>
      <div class="ebody"><button class="etitle" data-open="${e.id}"><b>${esc(e.title || '口令')}</b>${e.tool ? `<em>${esc(e.tool)}</em>` : ''}</button>
        ${(e.prompts || []).slice(0, 1).map((p) => `<p class="eprompt">${esc(p.text)}</p>`).join('')}
        <button class="copy-btn" data-copy="${e.id}">复制口令${(e.prompts || []).length > 1 ? `（${e.prompts.length} 段）` : ''}</button></div></div>`).join('')}</div>
    ${!list.length ? `<div class="empty-state"><div class="big">✨</div><p>${edits.length ? '没有符合的口令' : '把小红书/IG 的修图口令截图、链接或视频丢进来，AI 会只留下口令和前后对比图'}</p><button class="btn" data-a="add">＋ 添加口令</button></div>` : ''}`;
  (async () => { for (const im of $$('img[data-img]', root)) im.src = await img.url(im.dataset.img, 'thumb'); })();

  root.onclick = (ev) => {
    const t = ev.target;
    const tb = t.closest('[data-tool]');
    if (tb) { ui.tool = tb.dataset.tool === ui.tool ? '' : tb.dataset.tool; if (!tb.dataset.tool) ui.tag = ''; saveUi(); render(); return; }
    const tg = t.closest('[data-tag]');
    if (tg) { ui.tag = ui.tag === tg.dataset.tag ? '' : tg.dataset.tag; saveUi(); render(); return; }
    const cp = t.closest('[data-copy]');
    if (cp) { const e = edits.find((x) => x.id === cp.dataset.copy); copy(promptText(e)); return; }
    const op = t.closest('[data-open]');
    if (op) { openDetail(op.dataset.open); return; }
    const a = t.closest('[data-a]');
    if (!a) return;
    if (a.dataset.a === 'add') startAdd();
    if (a.dataset.a === 'fav') { ui.fav = !ui.fav; saveUi(); render(); }
  };
  const s = $('.search', root);
  let timer = 0;
  s.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { ui.q = s.value; saveUi(); const pos = s.selectionStart; render(); const n = $('.search', root); n.focus(); n.setSelectionRange(pos, pos); }, 350); };
}

const promptText = (e) => (e.prompts || []).map((p) => (e.prompts.length > 1 && p.label ? `${p.label}：${p.text}` : p.text)).join('\n\n');

// ---------- detail ----------

function compareHtml(before, after) {
  if (!before) return `<button class="cmp single" data-a="zoom"><img src="${after}" alt="效果图"></button>`;
  return `<div class="cmp" style="--pos:50%"><img class="cmp-after" src="${after}" alt="效果图"><div class="cmp-before"><img src="${before}" alt="原图"></div>
    <div class="cmp-bar"><span>⇆</span></div><i class="lbl l">前</i><i class="lbl r">后</i></div>
    <div class="row gap center"><button class="link-btn" data-a="zoom-b">看原图</button><button class="link-btn" data-a="zoom">看效果图</button></div>`;
}

function bindCompare(node) {
  const cmp = $('.cmp:not(.single)', node);
  if (!cmp) return;
  const setPos = (x) => {
    const r = cmp.getBoundingClientRect();
    cmp.style.setProperty('--pos', `${Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100))}%`);
  };
  let down = false;
  cmp.addEventListener('pointerdown', (e) => { down = true; try { cmp.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } setPos(e.clientX); });
  cmp.addEventListener('pointermove', (e) => { if (down) setPos(e.clientX); });
  cmp.addEventListener('pointerup', () => { down = false; });
  cmp.addEventListener('pointercancel', () => { down = false; });
}

function openDetail(id) {
  let e = edits.find((x) => x.id === id);
  if (!e) return;
  openPage(e.title || '口令', async (body, page) => {
    const acts = page.setActions('<button class="icon-btn" data-a="edit" aria-label="编辑">✎</button>');
    const draw = async () => {
      const before = await img.url(e.before);
      const after = await img.url(e.after);
      body.innerHTML = `${after ? compareHtml(before, after) : ''}
        <div class="detail-head"><h1>${esc(e.title || '口令')}</h1><p class="meta">${[e.tool, ...(e.tags || []).map((t) => `#${t}`)].filter(Boolean).map(esc).join(' · ')}</p>
          <button class="chip ${e.fav ? 'on' : ''}" data-a="fav">${e.fav ? '♥ 已收藏' : '♡ 收藏'}</button></div>
        ${(e.prompts || []).map((p, i) => `<section class="prompt-box">${p.label ? `<h4>${esc(p.label)}</h4>` : ''}<p class="pre">${esc(p.text)}</p>
          <button class="btn small" data-cp="${i}">复制</button></section>`).join('')}
        ${(e.prompts || []).length > 1 ? '<button class="btn ghost wide" data-a="copyall">复制全部口令</button>' : ''}
        ${(e.steps || []).length ? `<section class="box"><h3>步骤</h3><ol>${e.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>` : ''}
        ${e.tips ? `<section class="box"><h3>小提示</h3><p>${esc(e.tips)}</p></section>` : ''}
        ${(e.sources || []).filter((s) => s.url).map((s) => `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener">🔗 ${esc(SOURCE_LABEL[s.kind] || '来源')} ${esc(s.title || '')}</a>`).join('')}
        <button class="btn ghost danger wide" data-a="del">删除</button>`;
      bindCompare(body);
      body.onclick = async (ev) => {
        const cp = ev.target.closest('[data-cp]');
        if (cp) { copy(e.prompts[+cp.dataset.cp].text); return; }
        const a = ev.target.closest('[data-a]');
        if (!a) return;
        const pics = [before && { src: before, caption: '原图' }, after && { src: after, caption: '效果图' }].filter(Boolean);
        if (a.dataset.a === 'zoom') lightbox(pics, pics.length - 1, { name: 'after' });
        if (a.dataset.a === 'zoom-b') lightbox(pics, 0, { name: 'before' });
        if (a.dataset.a === 'copyall') copy(promptText(e));
        if (a.dataset.a === 'fav') { e.fav = !e.fav; await save(e); draw(); }
        if (a.dataset.a === 'del' && await confirmBox('删除这条口令？', '删除', true)) { await db.del('edits', e.id); await db.sweepImages(); page.close(); refresh(); }
      };
    };
    acts.onclick = () => editForm(e, async (v) => { e = v; await save(e); page.setTitle(e.title || '口令'); draw(); });
    await draw();
  }, { cls: 'page-detail' });
}

async function save(e) { e.updated = Date.now(); await db.put('edits', e); const i = edits.findIndex((x) => x.id === e.id); if (i >= 0) edits[i] = e; else edits.push(e); render(); }

function editForm(e, done) {
  openPage('编辑口令', (body, page) => {
    body.innerHTML = `${fieldsHtml(e)}
      <div class="field"><span>前后图</span><div class="row gap"><button class="btn small ghost" data-a="pick-before">换原图</button><button class="btn small ghost" data-a="pick-after">换效果图</button>
        ${e.before ? '<button class="btn small ghost" data-a="no-before">不要原图</button>' : ''}</div></div>
      <button class="btn wide sticky-save" data-a="save">保存</button>`;
    let before = e.before;
    let after = e.after;
    body.onclick = async (ev) => {
      const a = ev.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'add-prompt') addPromptRow($('.prompts', body), { label: '', text: '' });
      if (a.dataset.a === 'rm-prompt') a.closest('.prompt-edit').remove();
      if (a.dataset.a.startsWith('pick-')) {
        const input = $('#file-input');
        input.accept = 'image/*'; input.multiple = false; input.value = '';
        input.onchange = async () => {
          const f = input.files[0];
          if (!f) return;
          const id = await img.save(f);
          if (a.dataset.a === 'pick-before') before = id; else after = id;
          toast('已更换 ✓');
        };
        input.click();
      }
      if (a.dataset.a === 'no-before') { before = ''; toast('保存后会去掉原图'); }
      if (a.dataset.a === 'save') {
        await done({ ...e, ...readFields(body), before, after });
        await db.sweepImages();
        page.close();
      }
    };
  });
}

function fieldsHtml(e) {
  return `<label class="field"><span>名字</span><input name="title" value="${esc(e.title)}"></label>
    <label class="field"><span>工具 / App</span><input name="tool" list="tools" value="${esc(e.tool)}"><datalist id="tools">${EDIT_TOOLS.map((t) => `<option value="${esc(t)}">`).join('')}</datalist></label>
    <div class="field"><span>口令</span><div class="prompts">${(e.prompts || []).map(promptRowHtml).join('')}</div><button type="button" class="btn small ghost" data-a="add-prompt">＋ 加一段</button></div>
    <label class="field"><span>步骤（一行一步）</span><textarea name="steps" rows="3">${esc((e.steps || []).join('\n'))}</textarea></label>
    <label class="field"><span>小提示</span><input name="tips" value="${esc(e.tips)}"></label>
    <label class="field"><span>标签（空格分开）</span><input name="tags" value="${esc((e.tags || []).join(' '))}"></label>`;
}
const promptRowHtml = (p) => `<div class="prompt-edit"><input data-k="label" value="${esc(p.label)}" placeholder="段落名（可空）"><textarea data-k="text" rows="4">${esc(p.text)}</textarea><button type="button" class="link-btn danger" data-a="rm-prompt">删除这段</button></div>`;
const addPromptRow = (box, p) => box.appendChild(el(promptRowHtml(p)));
function readFields(node) {
  const q = (n) => $(`[name=${n}]`, node);
  return {
    title: q('title').value.trim(), tool: normalizeTool(q('tool').value),
    prompts: $$('.prompt-edit', node).map((r) => ({ label: $('[data-k=label]', r).value.trim(), text: $('[data-k=text]', r).value.trim() })).filter((p) => p.text),
    steps: q('steps').value.split('\n').map((s) => s.trim()).filter(Boolean),
    tips: q('tips').value.trim(), tags: q('tags').value.split(/[\s,，#]+/).filter(Boolean),
  };
}

// ---------- add ----------

export function startAdd(preset) {
  openImport('edits', runImport, () => manual(), preset);
}

function manual() {
  const e = { id: uid(), title: '', tool: '', prompts: [{ label: '', text: '' }], steps: [], tips: '', tags: [], before: '', after: '', sources: [], created: Date.now(), fav: false };
  editForm(e, async (v) => { if (!v.prompts.length) { toast('没有口令，没保存'); return; } await save(v); toast('已保存 ✓'); });
}

async function runImport(input) {
  const w = busy('准备中…');
  let g = null;
  try {
    g = await gather('edits', input, (t, d) => w.set(t, d));
    if (!ai.ready()) throw new Error('自动拆解需要 AI key（设置 → AI 识别，Gemini 免费）。也可以用「手动添加」');
    w.set('AI 正在找口令和前后对比图…', g.videos.length ? '视频会多花一点时间' : '');
    const res = await ai.readEdit(g.pics.map((p) => ({ part: p.part, note: p.note })), g.src, await ai.videoParts(g.videoBlobs));
    const note = ai.takeNote();
    if (note) toast(note, 3500);
    const effects = (res.effects || []).filter((x) => (x.prompts || []).some((p) => p.text && p.text.trim()));
    w.done();
    if (!effects.length) { toast('没找到口令。可以手动添加', 3500); release(g); return; }
    review(effects.map((x) => ({
      title: x.title, tool: normalizeTool(res.tool), prompts: x.prompts.filter((p) => p.text.trim()), steps: x.steps || [], tips: x.tips || '', tags: x.tags || [],
      before: x.before.image >= 0 && x.before.image < g.pics.length ? { i: x.before.image, box: normBox(x.before.box) } : null,
      after: x.after.image >= 0 && x.after.image < g.pics.length ? { i: x.after.image, box: normBox(x.after.box) } : null,
    })), g);
  } catch (e) {
    w.done();
    release(g);
    toast(e.message || '出错了', 4000);
  }
}

async function cropUrl(src, box) {
  const im = new Image();
  im.src = src;
  await im.decode();
  return img.draw(im, 600, box).toDataURL('image/jpeg', 0.85);
}

function review(effects, g) {
  let saved = false;
  openPage(effects.length > 1 ? `找到 ${effects.length} 个口令` : '确认口令', (body, page) => {
    body.innerHTML = `<p class="hint">检查一下口令和前后图。图不对可以「换」或「调整框选」。</p><div class="review-list"></div>
      <button class="btn wide sticky-save" data-a="save">保存</button>`;
    const listNode = $('.review-list', body);
    const items = effects.map((fx) => {
      const node = el(`<div class="review-item"><label class="keep"><input type="checkbox" checked> 保存这个</label>
        <div class="ba"><div class="ba-slot" data-w="before"></div><div class="ba-slot" data-w="after"></div></div>${fieldsHtml({ ...fx, sources: [] })}</div>`);
      listNode.appendChild(node);
      const drawSlot = async (which) => {
        const slot = $(`[data-w=${which}]`, node);
        const s = fx[which];
        const src = s ? await cropUrl(g.pics[s.i].previewUrl, s.box) : '';
        slot.innerHTML = `<b>${which === 'before' ? '原图' : '效果图'}</b>${src ? `<img src="${src}" alt="">` : '<div class="noimg">无</div>'}
          <div class="row gap center"><button type="button" class="link-btn" data-swap="${which}">换</button>${s ? `<button type="button" class="link-btn" data-crop="${which}">调整框选</button>` : ''}
          ${which === 'before' && s ? '<button type="button" class="link-btn" data-none="before">不要</button>' : ''}</div>`;
      };
      drawSlot('before'); drawSlot('after');
      node.addEventListener('click', async (ev) => {
        const a = ev.target.closest('[data-a]');
        if (a && a.dataset.a === 'add-prompt') addPromptRow($('.prompts', node), { label: '', text: '' });
        if (a && a.dataset.a === 'rm-prompt') a.closest('.prompt-edit').remove();
        const sw = ev.target.closest('[data-swap]');
        if (sw) { const i = await choosePic(g.pics, fx[sw.dataset.swap] ? fx[sw.dataset.swap].i : -1); if (i != null) { fx[sw.dataset.swap] = { i, box: null }; drawSlot(sw.dataset.swap); } }
        const cr = ev.target.closest('[data-crop]');
        if (cr) { const s = fx[cr.dataset.crop]; const box = await cropEditor(g.pics[s.i].previewUrl, s.box); if (box !== undefined) { s.box = box; drawSlot(cr.dataset.crop); } }
        const no = ev.target.closest('[data-none]');
        if (no) { fx.before = null; drawSlot('before'); }
      });
      return { fx, node };
    });
    $('[data-a=save]', body).onclick = async () => {
      const w = busy('保存中…');
      try {
        let n = 0;
        for (const { fx, node } of items) {
          if (!$('.keep input', node).checked) continue;
          const v = readFields(node);
          if (!v.prompts.length) continue;
          const rec = { id: uid(), ...v, before: fx.before ? await g.pics[fx.before.i].save(fx.before.box) : '', after: fx.after ? await g.pics[fx.after.i].save(fx.after.box) : '', sources: [sourceOf(g, g.videos.length ? 'video' : 'shot')], fav: false, created: Date.now() + n, updated: Date.now() };
          await db.put('edits', rec);
          n++;
        }
        saved = true;
        w.done();
        toast(`已保存 ${n} 个口令 ✓`);
        page.close();
        refresh();
      } catch (e) { w.done(); toast(e.message || '保存失败'); }
    };
  }, { onClose: () => { release(g); if (!saved) toast('没有保存'); } });
}

function choosePic(pics, current) {
  return new Promise((resolve) => {
    let out = null;
    openSheet('选一张', (box, sheet) => {
      box.innerHTML = `<div class="pic-pick">${pics.map((p, i) => `<button class="pp ${i === current ? 'on' : ''}" data-i="${i}"><img src="${p.previewUrl}" alt="">${p.note ? `<small>${esc(p.note)}</small>` : ''}</button>`).join('')}</div>`;
      box.onclick = (e) => { const b = e.target.closest('.pp'); if (b) { out = +b.dataset.i; sheet.close(); } };
    }, { cls: 'tall', onClose: () => resolve(out) });
  });
}

// Drag a rectangle over the picture. Resolves the new fraction box, null for the whole picture, undefined if cancelled.
function cropEditor(src, box) {
  return new Promise((resolve) => {
    let out;
    openSheet('调整框选', (wrap, sheet) => {
      wrap.innerHTML = `<div class="crop"><img src="${src}" alt=""><div class="crop-box"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div></div>
        <div class="row gap"><button class="btn ghost grow" data-a="all">整张图</button><button class="btn grow" data-a="ok">好了</button></div>`;
      const area = $('.crop', wrap);
      const rect = $('.crop-box', wrap);
      let b = box ? { ...box } : { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
      const drawBox = () => { Object.assign(rect.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }); };
      drawBox();
      let drag = null;
      area.addEventListener('pointerdown', (e) => {
        const r = area.getBoundingClientRect();
        const h = e.target.dataset.h || (e.target === rect ? 'move' : null);
        if (!h) return;
        try { area.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
        drag = { h, x: e.clientX, y: e.clientY, b0: { ...b }, r };
        e.preventDefault();
      });
      area.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = (e.clientX - drag.x) / drag.r.width;
        const dy = (e.clientY - drag.y) / drag.r.height;
        const o = drag.b0;
        let { x, y, w, h } = o;
        if (drag.h === 'move') { x = Math.max(0, Math.min(1 - w, o.x + dx)); y = Math.max(0, Math.min(1 - h, o.y + dy)); }
        if (drag.h.includes('w')) { x = Math.max(0, Math.min(o.x + o.w - 0.05, o.x + dx)); w = o.x + o.w - x; }
        if (drag.h.includes('e')) { w = Math.max(0.05, Math.min(1 - o.x, o.w + dx)); }
        if (drag.h.includes('n')) { y = Math.max(0, Math.min(o.y + o.h - 0.05, o.y + dy)); h = o.y + o.h - y; }
        if (drag.h.includes('s')) { h = Math.max(0.05, Math.min(1 - o.y, o.h + dy)); }
        b = { x, y, w, h };
        drawBox();
      });
      area.addEventListener('pointerup', () => { drag = null; });
      wrap.onclick = (e) => {
        const a = e.target.closest('[data-a]');
        if (!a) return;
        out = a.dataset.a === 'all' ? null : b;
        sheet.close();
      };
    }, { cls: 'tall', sticky: true, onClose: () => resolve(out) });
  });
}

export const count = () => edits.length;
