// App shell: tabs, settings, backup, startup.
import * as db from './db.js';
import * as ai from './ai.js';
import * as places from './places.js';
import * as food from './food.js';
import * as nails from './nails.js';
import * as edits from './edits.js';
import { CFG } from './config.js';
import { fmtBytes, firstUrl, linkKind } from './logic.js';
import { $, $$, esc, toast, busy, confirmBox, openSheet, layerCount } from './ui.js';

const VERSION = 'aeafe8ed58';
const TABS = { food, nails, edits };
const mounted = new Set();
let current = '';

async function show(tab) {
  current = tab;
  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${tab}`; });
  db.setKv('tab', tab);
  const node = $(`#view-${tab}`);
  if (!mounted.has(tab)) {
    mounted.add(tab);
    if (tab === 'settings') await settings(node);
    else await TABS[tab].mount(node);
  } else if (tab === 'food') {
    await food.refresh();
  } else if (tab === 'settings') {
    await settings(node);
  }
}

// ---------- settings ----------

async function aiSettings() {
  const legacy = await db.getKv('aiKey', ''); // version 1 stored only a Claude key
  return {
    provider: await db.getKv('aiProvider', legacy ? 'claude' : ai.DEFAULT_PROVIDER),
    keys: { gemini: await db.getKv('geminiKey', ''), claude: await db.getKv('claudeKey', legacy) },
    models: { gemini: ai.modelSetting('gemini', await db.getKv('geminiModel', ai.defaultModel('gemini'))), claude: await db.getKv('claudeModel', await db.getKv('aiModel', ai.defaultModel('claude'))) },
  };
}

async function settings(node) {
  const cfg = await aiSettings();
  const ps = await places.list();
  let est = null;
  try { est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { est = null; }
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const last = await db.getKv('lastBackup', 0);
  const P = ai.PROVIDERS;
  const pick = cfg.provider;
  node.innerHTML = `<header class="tab-head"><h1>设置</h1></header>
    <section class="box"><h3>🤖 AI 识别</h3>
      <div class="seg wide prov">${Object.entries(P).map(([id, p]) => `<button data-prov="${id}" class="${id === pick ? 'on' : ''}">${esc(p.label)}</button>`).join('')}</div>
      ${Object.entries(P).map(([id, p]) => `<div class="prov-box" data-box="${id}" ${id === pick ? '' : 'hidden'}>
        <p class="hint">${id === 'gemini'
          ? `免费：用 Google 账号登录 <a href="${p.keyUrl}" target="_blank" rel="noopener">aistudio.google.com/apikey</a>，点「Create API key」，复制贴到这里。不用绑卡。<br>⚠️ 免费版发给 Google 的截图和文字可能会被 Google 用来改进产品，别用它识别私密内容。`
          : `付费：到 <a href="${p.keyUrl}" target="_blank" rel="noopener">console.anthropic.com</a> 充值后创建 key。不会被拿去训练，自己上传的视频只看画面不听声音。`}</p>
        <label class="field"><span>${id === 'gemini' ? 'Gemini' : 'Claude'} API key</span><input type="password" name="key-${id}" value="${esc(cfg.keys[id])}" placeholder="${p.keyHint}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <div class="field"><span>识别模型</span>${Object.entries(p.models).map(([mid, m]) => `<label class="radio"><input type="radio" name="model-${id}" value="${mid}" ${mid === cfg.models[id] ? 'checked' : ''}><span><b>${esc(m.label)}</b><small>${esc(m.note)}</small></span></label>`).join('')}</div></div>`).join('')}
      <div class="row gap"><button class="btn ghost" data-a="test">测试</button><button class="btn grow" data-a="save-key">保存</button></div>
      <p class="status-line">${cfg.keys[pick] ? `✅ 正在用 ${esc(P[pick].label)}` : '⚠️ 还没设置，暂时只能手动填写'}</p></section>
    <section class="box"><h3>📍 我的地点</h3><p class="hint">${ps.length ? ps.map((p) => `${places.icon(p)} ${esc(p.name)}`).join('　') : '设置家、学校、公司，餐厅就会显示距离和交通建议'}</p>
      <button class="btn ghost wide" data-a="places">管理地点</button></section>
    <section class="box"><h3>💾 数据</h3>
      <p class="hint">所有记录和图片都只存在这台手机的这个 App 里。换手机或删掉 App 前，记得导出备份。</p>
      <p>已用空间：${est ? fmtBytes(est.usage) : '—'}${persisted ? ' · 已锁定不被清理' : ''}　上次备份：${last ? new Date(last).toLocaleDateString() : '从未'}</p>
      <div class="row gap"><button class="btn ghost grow" data-a="export">导出备份</button><button class="btn ghost grow" data-a="import">导入备份</button></div></section>
    <section class="box"><h3>ℹ️ 关于</h3><p class="hint">种草本 v${esc(VERSION)} · 地图 © OpenStreetMap · 路线 OSRM${CFG.helper ? '' : ' · ⚠️ 链接读取服务未设置'}</p>
      <button class="link-btn" data-a="howto">怎么从小红书 / IG 加进来？</button></section>`;
  let shown = pick;
  node.onclick = async (e) => {
    const pv = e.target.closest('[data-prov]');
    if (pv) {
      shown = pv.dataset.prov;
      $$('[data-prov]', node).forEach((b) => b.classList.toggle('on', b === pv));
      $$('.prov-box', node).forEach((b) => { b.hidden = b.dataset.box !== shown; });
      return;
    }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    const k = $(`[name=key-${shown}]`, node).value.trim();
    const m = ($(`[name=model-${shown}]:checked`, node) || {}).value || ai.defaultModel(shown);
    if (a.dataset.a === 'test') {
      if (!k) { toast('请先贴上 API key'); return; }
      const w = busy('测试中…');
      const r = await ai.testKey(shown, k, m);
      w.done();
      toast(r.error || `可以用 ✓（${r.model}）`, r.error ? 6000 : 3500);
    }
    if (a.dataset.a === 'save-key') {
      await db.setKv('aiProvider', shown);
      await db.setKv(`${shown}Key`, k);
      await db.setKv(`${shown}Model`, m);
      ai.configure({ provider: shown, keys: { [shown]: k }, models: { [shown]: m } });
      toast('已保存 ✓');
      settings(node);
    }
    if (a.dataset.a === 'places') places.manage(() => settings(node));
    if (a.dataset.a === 'export') exportBackup(() => settings(node));
    if (a.dataset.a === 'import') importBackup();
    if (a.dataset.a === 'howto') howto();
  };
}

function howto() {
  openSheet('从小红书 / IG 加进来', (box) => {
    box.innerHTML = `<ol class="howto"><li>小红书：把笔记截图（图片、正文、评论里的地址都可以截，多截几张更准）。视频可以录屏。</li>
      <li>回到种草本，点对应页面右上角的「＋」，选截图 / 录屏，再按「开始识别」。</li>
      <li>IG：帖子右上角「⋯」→「复制链接」，贴到「＋」里。私人账号读不到，用截图就好。</li>
      <li>小红书链接读不到内容（小红书要求登录），所以只能用截图。</li></ol>
      <p class="hint">识别完会让你检查一遍再保存。图片会存在手机里，原笔记删了也看得到。</p>`;
  });
}

// ---------- backup ----------

const STORES = ['food', 'nails', 'edits', 'places'];

async function exportBackup(done) {
  const w = busy('正在打包…');
  try {
    const parts = ['{"app":"zhongcao","v":1,"at":', String(Date.now())];
    for (const s of STORES) parts.push(`,${JSON.stringify(s)}:`, JSON.stringify(await db.all(s)));
    parts.push(',"images":[');
    const ids = await db.keys('images');
    const b64 = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
    for (let i = 0; i < ids.length; i++) {
      w.set('正在打包图片…', `${i + 1} / ${ids.length}`);
      const im = await db.get('images', ids[i]);
      parts.push(`${i ? ',' : ''}${JSON.stringify({ id: im.id, w: im.w, h: im.h, at: im.at, full: await b64(im.blob), thumb: im.thumb ? await b64(im.thumb) : '' })}`);
    }
    parts.push(']}');
    const blob = new Blob(parts, { type: 'application/json' });
    const name = `种草本备份-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    w.done();
    // Sharing needs a fresh tap (packaging takes too long for the first one), so ask for it.
    openSheet('备份准备好了', (box, sheet) => {
      box.innerHTML = `<p class="confirm-msg">${esc(name)}<br><small class="muted">${fmtBytes(blob.size)}</small></p>
        <p class="hint">iPhone：点下面按钮后选「存储到文件」，放到 iCloud 云盘最安全。</p><button class="btn wide" data-a="save">保存备份文件</button>`;
      $('[data-a=save]', box).onclick = async () => {
        try {
          if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: name });
          else {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = name; a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 60000);
          }
          await db.setKv('lastBackup', Date.now());
          sheet.close();
          toast(`备份好了（${fmtBytes(blob.size)}）✓`);
          if (done) done();
        } catch (e) { if (e.name !== 'AbortError') toast(`保存失败：${e.message}`, 4000); }
      };
    });
  } catch (e) {
    w.done();
    toast(`备份失败：${e.message}`, 4000);
  }
}

function importBackup() {
  const input = $('#file-input');
  input.accept = 'application/json,.json';
  input.multiple = false;
  input.value = '';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    if (!await confirmBox('导入会把备份里的记录加进来（同一条会被备份覆盖），继续？', '导入')) return;
    const w = busy('正在读取备份…');
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'zhongcao') throw new Error('这不是种草本的备份文件');
      const toBlob = async (u) => (u ? (await fetch(u)).blob() : null);
      for (let i = 0; i < (data.images || []).length; i++) {
        w.set('正在导入图片…', `${i + 1} / ${data.images.length}`);
        const im = data.images[i];
        await db.put('images', { id: im.id, w: im.w, h: im.h, at: im.at, blob: await toBlob(im.full), thumb: await toBlob(im.thumb) });
      }
      for (const s of STORES) if (Array.isArray(data[s])) await db.putMany(s, data[s]);
      w.done();
      toast('导入完成 ✓');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      w.done();
      toast(`导入失败：${e.message}`, 4000);
    }
  };
  input.click();
}

// ---------- startup ----------

async function start() {
  ai.configure(await aiSettings());
  $('.tabs').onclick = (e) => { const b = e.target.closest('.tab'); if (b && b.dataset.tab !== current) show(b.dataset.tab); };
  // Android share target / links like ?share=<text>&to=food
  const params = new URLSearchParams(location.search);
  const shared = params.get('share') || params.get('text') || params.get('url') || '';
  const want = params.get('to');
  await show(want && (TABS[want] || want === 'settings') ? want : await db.getKv('tab', 'food'));
  if (shared && firstUrl(shared)) {
    history.replaceState(null, '', location.pathname);
    const kind = linkKind(firstUrl(shared));
    const target = want && TABS[want] ? want : 'food';
    if (kind) TABS[target].startAdd(shared);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  watchUpdates();
  document.body.classList.add('ready');
  try { if (sessionStorage.getItem('zc-updated')) { sessionStorage.removeItem('zc-updated'); toast('已更新到最新版本 ✓', 3000); } } catch (e) { /* private mode */ }
}

// ---------- updates ----------
// Each time the app opens or comes back to the front it asks for the newest version. The new version installs in the
// background and then the app reloads into it, unless something is open (a form, a sheet), in which case it waits.
function watchUpdates() {
  if (!('serviceWorker' in navigator) || CFG.isDev || location.protocol !== 'https:') return;
  const hadController = !!navigator.serviceWorker.controller;
  let pending = false;
  let reloading = false;
  const reload = () => {
    if (reloading) return;
    if (layerCount() || document.querySelector('.busy')) { pending = true; return; }
    reloading = true;
    try { sessionStorage.setItem('zc-updated', '1'); } catch (e) { /* private mode */ }
    location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) reload(); });
  window.addEventListener('popstate', () => { if (pending) setTimeout(reload, 300); }); // a page/sheet was closed
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (pending) reload(); else reg.update().catch(() => {});
    });
  }).catch(() => {});
}

// iPhone ignores user-scalable=no; block its pinch-zoom gestures on the page (Leaflet and the photo viewer use pointer events).
for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
window.addEventListener('error', (e) => { if (e.message && !/ResizeObserver/.test(e.message)) toast(`出错了：${e.message}`, 4000); });
window.addEventListener('unhandledrejection', (e) => { const m = e.reason && e.reason.message; if (m) toast(`出错了：${m}`, 4000); });
start();
