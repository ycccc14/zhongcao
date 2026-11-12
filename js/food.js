// 美食 page: map + list of places to try, detail page, add/review/edit forms, tidy-up.
import * as db from './db.js';
import * as img from './img.js';
import * as ai from './ai.js';
import * as net from './net.js';
import * as places from './places.js';
import { openImport, gather, release, sourceOf, picPicker } from './importer.js';
import {
  uid, today, km, fmtKm, fmtMin, travelAdvice, navLinks, FOOD_STATUS, priceText, promoStatus, livePromos,
  findDuplicate, sameRestaurant, mergeFood, foodFromAi, geoQueries, SOURCE_LABEL, CUISINES, cuisineOf, cuisineInfo,
} from './logic.js';
import { el, esc, $, $$, openPage, openSheet, toast, confirmBox, busy, lightbox, copy, pickFiles } from './ui.js';

let root = null;
let foods = [];
// view: 'map' = map with the places in view listed underneath; 'list' = full list only
let ui = { view: 'map', status: 'want', promo: false, cuisine: '', base: '', q: '' };
let map = null;
let layer = null;

async function load() { foods = await db.all('food'); }
const saveUi = () => db.setKv('foodUi', ui);

export async function mount(node) {
  root = node;
  ui = { ...ui, ...(await db.getKv('foodUi', {})) };
  delete ui.tag; // older versions filtered by free-text tag
  await load();
  render();
}

export async function refresh() { if (root) { await load(); render(); } }

// ---------- list / map ----------

async function baseSpot() {
  const ps = await places.list();
  return ps.find((p) => p.id === ui.base) || ps[0] || null;
}

function visible() {
  const on = today();
  const q = ui.q.trim().toLowerCase();
  return foods.filter((f) => (ui.status === 'all' || f.status === ui.status)
    && (!ui.promo || livePromos(f, on).length)
    && (!ui.cuisine || cuisineOf(f) === ui.cuisine)
    && (!q || [f.name, f.branch, f.area, f.city, f.cuisine, cuisineInfo(cuisineOf(f)).label, ...(f.tags || []), ...(f.dishes || []).map((d) => d.name)].join(' ').toLowerCase().includes(q)));
}

async function render() {
  const ps = await places.list();
  const base = await baseSpot();
  const on = today();
  const counts = { want: 0, been: 0, skip: 0 };
  for (const f of foods) counts[f.status] = (counts[f.status] || 0) + 1;
  const promoCount = foods.filter((f) => f.status !== 'skip' && livePromos(f, on).length).length;
  // cuisine chips: only types that exist (in the current want/been filter), most common first
  const pool = foods.filter((f) => ui.status === 'all' || f.status === ui.status);
  const cuisineCount = {};
  for (const f of pool) { const k = cuisineOf(f); cuisineCount[k] = (cuisineCount[k] || 0) + 1; }
  if (ui.cuisine && !cuisineCount[ui.cuisine]) ui.cuisine = '';
  const cuisineChips = Object.entries(cuisineCount).sort((a, b) => b[1] - a[1]);

  root.innerHTML = `<header class="tab-head"><h1>美食地图</h1>
      <div class="seg"><button data-view="map" class="${ui.view === 'map' ? 'on' : ''}">🗺 地图</button><button data-view="list" class="${ui.view === 'list' ? 'on' : ''}">☰ 清单</button></div>
      <button class="icon-btn" data-a="tidy" aria-label="整理">🧹</button><button class="add-btn" data-a="add" aria-label="添加">＋</button></header>
    <div class="filters">
      <div class="chips scroll">
        <button class="chip ${ui.status === 'want' ? 'on' : ''}" data-st="want">想吃 ${counts.want || ''}</button>
        <button class="chip ${ui.status === 'been' ? 'on' : ''}" data-st="been">吃过 ${counts.been || ''}</button>
        <button class="chip ${ui.status === 'all' ? 'on' : ''}" data-st="all">全部</button>
        <button class="chip hot ${ui.promo ? 'on' : ''}" data-a="promo">🔥 优惠中 ${promoCount || ''}</button>
      </div>
      ${cuisineChips.length ? `<div class="chips scroll cuisines"><button class="chip soft ${!ui.cuisine ? 'on' : ''}" data-cuisine="">全部菜系</button>
        ${cuisineChips.map(([k, n]) => { const c = cuisineInfo(k); return `<button class="chip soft ${ui.cuisine === k ? 'on' : ''}" data-cuisine="${k}">${c.icon} ${esc(c.label)} ${n}</button>`; }).join('')}</div>` : ''}
      <div class="base-row"><span>距离从</span>
        ${ps.length ? `<select class="base">${ps.map((p) => `<option value="${p.id}" ${base && p.id === base.id ? 'selected' : ''}>${places.icon(p)} ${esc(p.name)}</option>`).join('')}</select>` : ''}
        <button class="link-btn" data-a="places">${ps.length ? '管理地点' : '＋ 设置家/学校/公司'}</button>
        <input class="search" type="search" placeholder="搜店名/菜" value="${esc(ui.q)}"></div>
    </div>
    <div class="food-body ${ui.view}"></div>`;

  const body = $('.food-body', root);
  const list = visible();
  if (base) list.sort((a, b) => (km(base, a) ?? 1e9) - (km(base, b) ?? 1e9));
  else list.sort((a, b) => b.created - a.created);

  if (!foods.length) {
    body.innerHTML = `<div class="empty-state"><div class="big">🍜</div><p>还没有收藏的店</p>
      <p class="hint">在小红书看到想吃的，复制链接或截图，点右上角「＋」。AI 会整理出菜系、地址、价格、推荐菜和优惠，放到地图上。</p>
      <button class="btn" data-a="add">＋ 添加第一家</button>${ps.length ? '' : '<br><button class="link-btn" data-a="places">先设置家 / 学校 / 公司的位置</button>'}</div>`;
  } else if (ui.view === 'map') {
    const unplaced = list.filter((f) => f.lat == null);
    body.innerHTML = `<div class="map-wrap"><div class="map"></div>
      <div class="map-tools"><button class="icon-btn" data-a="fit" aria-label="显示全部">⤢</button><button class="icon-btn" data-a="me" aria-label="我的位置">◎</button></div></div>
      <div class="map-list-head"><b class="in-view"></b><span class="muted">${base ? `按离${esc(base.name)}的距离` : '最新的在前'}</span></div>
      <div class="cards map-list"></div>
      ${unplaced.length ? `<details class="unplaced-box"><summary>${unplaced.length} 家还没定位（不在地图上）</summary><div class="cards">${unplaced.map((f) => card(f, base, on)).join('')}</div></details>` : ''}`;
    fillThumbs(body);
    drawMap($('.map', body), list, ps, base);
  } else {
    body.innerHTML = list.length ? `<div class="cards">${list.map((f) => card(f, base, on)).join('')}</div>`
      : `<div class="empty-state"><div class="big">🍜</div><p>没有符合条件的店</p><button class="btn" data-a="add">＋ 从小红书/截图添加</button></div>`;
    fillThumbs(body);
  }
  bind();
}

function card(f, base, on) {
  const d = base ? km(base, f) : null;
  const adv = travelAdvice(d);
  const promos = livePromos(f, on);
  const dishes = (f.dishes || []).slice(0, 3).map((x) => x.name).join(' · ');
  const c = cuisineInfo(cuisineOf(f));
  return `<button class="fcard" data-id="${f.id}">
    <div class="fthumb">${f.images && f.images[0] ? `<img data-img="${f.images[0]}" alt="">` : `<span>${c.icon}</span>`}${f.status === 'been' ? '<i class="been">吃过</i>' : ''}</div>
    <div class="finfo"><b>${esc(f.name)}${f.branch ? ` <small>${esc(f.branch)}</small>` : ''}</b>
      <span class="meta"><i class="ctag">${c.icon} ${esc(c.label)}</i> ${[f.cuisine && f.cuisine !== c.label ? f.cuisine : '', priceText(f.price), f.area].filter(Boolean).map(esc).join(' · ')}</span>
      ${dishes ? `<span class="dishes">👍 ${esc(dishes)}</span>` : ''}
      <span class="meta2">${d != null ? `📍 ${fmtKm(d)} · ${adv.mode === 'walk' ? '🚶' : '🚗'} ${fmtMin(adv.mode === 'walk' ? adv.walk : adv.drive)}` : f.lat == null ? '📍 未定位' : ''}
      ${promos.length ? `<em class="promo-badge">🔥 ${esc(promos[0].title || '优惠')}</em>` : ''}</span></div></button>`;
}

async function fillThumbs(node) {
  for (const im of $$('img[data-img]', node)) im.src = await img.url(im.dataset.img, 'thumb');
}

async function drawMap(node, list, ps, base) {
  const L = window.L;
  if (map) { map.remove(); map = null; }
  map = places.makeMap(node);
  layer = L.layerGroup().addTo(map);
  const pts = [];
  const markers = new Map();
  for (const p of ps) { places.placeMarker(p).addTo(layer); pts.push([p.lat, p.lng]); }
  const on = today();
  const placed = list.filter((x) => x.lat != null);
  for (const f of placed) {
    const thumb = f.images && f.images[0] ? await img.url(f.images[0], 'thumb') : '';
    const hot = livePromos(f, on).length;
    const c = cuisineInfo(cuisineOf(f));
    const m = L.marker([f.lat, f.lng], {
      icon: L.divIcon({ className: `pin-food ${f.status}${hot ? ' hot' : ''}`, html: `<div class="pf">${thumb ? `<img src="${thumb}" alt="">` : c.icon}</div><i class="pc">${c.icon}</i>`, iconSize: [44, 44], iconAnchor: [22, 22] }),
      title: f.name,
    });
    m.on('click', () => focusCard(f.id));
    m.addTo(layer);
    markers.set(f.id, m);
    pts.push([f.lat, f.lng]);
  }
  // The list under the map shows the places inside the visible map area, nearest first.
  const fillList = () => {
    if (!map) return;
    const bounds = map.getBounds();
    const inView = placed.filter((f) => bounds.contains([f.lat, f.lng]));
    const box = $('.map-list', root);
    if (!box) return;
    $('.in-view', root).textContent = inView.length ? `地图范围内 ${inView.length} 家` : '地图范围内没有店，拖动或缩小地图看看';
    box.innerHTML = inView.map((f) => card(f, base, on)).join('');
    fillThumbs(box);
  };
  const fit = () => {
    if (pts.length > 1) map.fitBounds(pts, { padding: [36, 36], maxZoom: 15 });
    else if (pts.length === 1) map.setView(pts[0], 15);
    else map.setView([3.139, 101.687], 11);
  };
  fit();
  map.on('moveend', fillList);
  fillList();
  node._fit = fit;
  node._markers = markers;
  setTimeout(() => { if (map) { map.invalidateSize(); fillList(); } }, 200);
}

// A pin was tapped: highlight its card in the list under the map.
function focusCard(id) {
  const c = $(`.map-list .fcard[data-id="${id}"]`, root);
  if (!c) return;
  $$('.map-list .fcard.picked', root).forEach((x) => x.classList.remove('picked'));
  c.classList.add('picked');
  c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function bind() {
  root.onclick = async (e) => {
    const t = e.target;
    const v = t.closest('[data-view]');
    if (v) { ui.view = v.dataset.view; saveUi(); render(); return; }
    const st = t.closest('[data-st]');
    if (st) { ui.status = st.dataset.st; saveUi(); render(); return; }
    const cu = t.closest('[data-cuisine]');
    if (cu) { ui.cuisine = ui.cuisine === cu.dataset.cuisine ? '' : cu.dataset.cuisine; saveUi(); render(); return; }
    const fc = t.closest('.fcard');
    if (fc) { openDetail(fc.dataset.id); return; }
    const a = t.closest('[data-a]');
    if (!a) return;
    const act = a.dataset.a;
    if (act === 'add') startAdd();
    if (act === 'promo') { ui.promo = !ui.promo; saveUi(); render(); }
    if (act === 'places') places.manage(render);
    if (act === 'tidy') tidy();
    if (act === 'fit') { const n = $('.map', root); if (n && n._fit) n._fit(); }
    if (act === 'me') { try { const p = await net.myLocation(); map.setView([p.lat, p.lng], 15); window.L.circleMarker([p.lat, p.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#3b82f6', fillOpacity: 1 }).addTo(layer); } catch (err) { toast(err.message); } }
  };
  const sel = $('.base', root);
  if (sel) sel.onchange = () => { ui.base = sel.value; saveUi(); render(); };
  const s = $('.search', root);
  let timer = 0;
  s.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { ui.q = s.value; saveUi(); const pos = s.selectionStart; render().then(() => { const n = $('.search', root); n.focus(); n.setSelectionRange(pos, pos); }); }, 350); };
}

// ---------- detail ----------

export async function openDetail(id) {
  const f = foods.find((x) => x.id === id) || await db.get('food', id);
  if (!f) return;
  openPage(f.name, async (body, page) => {
    const acts = page.setActions('<button class="icon-btn" data-a="edit" aria-label="编辑">✎</button>');
    acts.onclick = () => openForm(f, null, async (v) => { Object.assign(f, v); page.setTitle(f.name); await refresh(); drawDetail(body, f); });
    await drawDetail(body, f);
  }, { cls: 'page-detail' });
}

async function drawDetail(body, f) {
  const on = today();
  const ps = await places.list();
  const imgs = await Promise.all((f.images || []).map((i) => img.url(i)));
  const promos = (f.promos || []).map((p) => ({ p, s: promoStatus(p, on) })).sort((a, b) => ['active', 'ending', 'soon', 'unknown', 'expired'].indexOf(a.s.key) - ['active', 'ending', 'soon', 'unknown', 'expired'].indexOf(b.s.key));
  const nav = navLinks(f);
  body.innerHTML = `
    ${imgs.length ? `<div class="gallery">${imgs.map((u, i) => `<button class="g-item" data-i="${i}"><img src="${u}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
    <div class="detail-head">
      <h1>${esc(f.name)}${f.branch ? ` <small>${esc(f.branch)}</small>` : ''}</h1>
      <p class="meta"><i class="ctag">${cuisineInfo(cuisineOf(f)).icon} ${esc(cuisineInfo(cuisineOf(f)).label)}</i> ${[f.cuisine, priceText(f.price)].filter(Boolean).map(esc).join(' · ')}</p>
      ${f.summary ? `<p class="summary">${esc(f.summary)}</p>` : ''}
      <div class="status-row">${Object.entries(FOOD_STATUS).map(([k, v]) => `<button class="chip ${f.status === k ? 'on' : ''}" data-status="${k}">${k === 'want' ? '😋' : k === 'been' ? '✅' : '🙅'} ${v}</button>`).join('')}</div>
      ${f.status === 'been' ? `<div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}" class="${n <= (f.rating || 0) ? 'on' : ''}">★</button>`).join('')}</div>` : ''}
    </div>
    ${promos.length ? `<section class="box"><h3>🔥 优惠</h3>${promos.map(({ p, s }) => `<div class="promo ${s.key}"><div><b>${esc(p.title || '优惠')}</b>${s.label ? `<span class="pill ${s.key}">${esc(s.label)}</span>` : ''}</div>
      ${p.detail ? `<p>${esc(p.detail)}</p>` : ''}<small>${[p.start && p.end ? `${p.start} → ${p.end}` : p.end ? `截止 ${p.end}` : p.start ? `${p.start} 起` : '', p.time].filter(Boolean).map(esc).join(' · ')}</small></div>`).join('')}</section>` : ''}
    ${(f.dishes || []).length ? `<section class="box"><h3>👍 推荐菜单</h3><ul class="dishes">${f.dishes.map((d) => `<li>${d.star ? '<i class="must">必点</i>' : ''}<b>${esc(d.name)}</b>${d.price ? `<span class="price">${esc(d.price)}</span>` : ''}${d.note ? `<small>${esc(d.note)}</small>` : ''}</li>`).join('')}</ul></section>` : ''}
    <section class="box"><h3>📍 位置与交通</h3>
      ${f.address ? `<p class="addr">${esc(f.address)} <button class="link-btn" data-a="copy-addr">复制</button></p>` : ''}
      ${f.lat == null ? `<p class="warn">还没定位。<button class="link-btn" data-a="locate">设置位置</button></p>` : `${f.geo === 'auto' ? '<p class="hint">按地址自动定位的，不准的话 <button class="link-btn" data-a="locate">改位置</button></p>' : ''}<div class="mini-map"></div>`}
      <div class="travel">${f.lat != null && ps.length ? ps.map((p) => `<div class="tr" data-place="${p.id}"><span class="emoji">${places.icon(p)}</span><div class="grow"><b>从${esc(p.name)} · ${fmtKm(km(p, f))}</b><small class="adv">计算中…</small></div>
        <a class="mini-btn" href="${navLinks(f, p).transit}" target="_blank" rel="noopener">公交</a></div>`).join('') : f.lat != null ? '<p class="hint"><button class="link-btn" data-a="places">设置家/学校/公司</button>，就能看到距离和交通建议</p>' : ''}</div>
      <div class="nav-row"><a class="btn small" href="${nav.google}" target="_blank" rel="noopener">Google 导航</a><a class="btn small ghost" href="${nav.waze}" target="_blank" rel="noopener">Waze</a>
        ${nav.grab ? `<a class="btn small ghost" href="${nav.grab}">Grab</a>` : ''}<a class="btn small ghost" href="${nav.apple}" target="_blank" rel="noopener">Apple 地图</a></div>
    </section>
    ${f.hours || f.phone ? `<section class="box"><h3>🕒 营业</h3>${f.hours ? `<p>${esc(f.hours)}</p>` : ''}${f.phone ? `<p><a href="tel:${esc(f.phone)}">${esc(f.phone)}</a></p>` : ''}</section>` : ''}
    ${(f.tags || []).length ? `<div class="tags">${f.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    ${f.notes ? `<section class="box"><h3>📝 我的笔记</h3><p class="pre">${esc(f.notes)}</p></section>` : ''}
    ${(f.sources || []).filter((s) => s.url).length ? `<section class="box"><h3>🔗 来源</h3>${f.sources.filter((s) => s.url).map((s) => `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(SOURCE_LABEL[s.kind] || '链接')} · ${esc(s.title || s.url)}</a>`).join('')}</section>` : ''}
    <button class="btn ghost danger wide" data-a="delete">删除这家店</button>`;

  body.onclick = async (e) => {
    const g = e.target.closest('.g-item');
    if (g) { lightbox(imgs.map((src) => ({ src })), +g.dataset.i, { name: f.name }); return; }
    const st = e.target.closest('[data-status]');
    if (st) { f.status = st.dataset.status; await persist(f); drawDetail(body, f); return; }
    const star = e.target.closest('[data-star]');
    if (star) { f.rating = +star.dataset.star; await persist(f); drawDetail(body, f); return; }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    if (a.dataset.a === 'copy-addr') copy(f.address);
    if (a.dataset.a === 'places') places.manage(() => drawDetail(body, f));
    if (a.dataset.a === 'locate') {
      const s = await places.pickLocation(`${f.name} 的位置`, f.lat != null ? f : null, f.lat != null ? '' : [f.name, f.branch, f.area, f.city].filter(Boolean).join(' '));
      if (s) { f.lat = s.lat; f.lng = s.lng; f.geo = 'manual'; f.routes = {}; await persist(f); drawDetail(body, f); }
    }
    if (a.dataset.a === 'delete' && await confirmBox(`删除「${f.name}」？`, '删除', true)) {
      await db.del('food', f.id);
      await db.sweepImages();
      $('.back', body.closest('.page')).click();
      refresh();
    }
  };

  if (f.lat != null) {
    const mm = $('.mini-map', body);
    if (mm) {
      const m = places.makeMap(mm, { dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false });
      m.setView([f.lat, f.lng], 15);
      window.L.marker([f.lat, f.lng], { icon: window.L.divIcon({ className: 'pin-food want', html: `<div class="pf">${imgs[0] ? `<img src="${imgs[0]}" alt="">` : cuisineInfo(cuisineOf(f)).icon}</div>`, iconSize: [44, 44], iconAnchor: [22, 22] }) }).addTo(m);
      setTimeout(() => m.invalidateSize(), 300);
      mm.onclick = () => window.open(nav.google, '_blank');
    }
    fillTravel(body, f, ps);
  }
}

async function fillTravel(body, f, ps) {
  f.routes = f.routes || {};
  let changed = false;
  for (const p of ps) {
    const row = $(`.tr[data-place="${p.id}"] .adv`, body);
    if (!row) continue;
    const key = `${p.lat},${p.lng}>${f.lat},${f.lng}`;
    let r = f.routes[p.id] && f.routes[p.id].key === key ? f.routes[p.id].r : null;
    const d = km(p, f);
    row.textContent = travelAdvice(d).say + '（估算）';
    if (!r) {
      r = await net.route(p, f);
      if (r) { f.routes[p.id] = { key, r }; changed = true; }
    }
    const adv = travelAdvice(d, r);
    row.innerHTML = `${esc(adv.say)}${adv.estimated ? '（估算）' : ''}${adv.transitHint ? ` · <a href="${navLinks(f, p).transit}" target="_blank" rel="noopener">${adv.transitHint}</a>` : ''}`;
  }
  if (changed) await db.put('food', f);
}

async function persist(f) {
  f.updated = Date.now();
  await db.put('food', f);
  const i = foods.findIndex((x) => x.id === f.id);
  if (i >= 0) foods[i] = f; else foods.push(f);
  render();
}

// ---------- add ----------

export function startAdd(preset) {
  openImport('food', runImport, () => openForm(foodFromAi({ name: '' }), null, refresh), preset);
}

async function runImport(input) {
  const w = busy('准备中…');
  let g = null;
  try {
    g = await gather('food', input, (t, d) => w.set(t, d));
    let found = [];
    if (ai.ready()) {
      w.set('AI 正在读笔记…', '图片多的话需要半分钟左右');
      const res = await ai.readFood(g.pics.map((p) => p.part), g.src, await ai.videoParts(g.videoBlobs));
      const note = ai.takeNote();
      if (note) toast(note, 3500);
      found = (res.restaurants || []).map((r) => ({ rec: foodFromAi(r), pics: (r.images || []).filter((i) => i >= 0 && i < g.pics.length) }));
      if (!found.length) toast('没认出餐厅，可以手动填写');
    } else {
      toast('还没有填 AI key，只能手动填写（设置里可以免费申请 Gemini key）', 3500);
    }
    if (!found.length) found = [{ rec: foodFromAi({ name: g.src ? g.src.title : '' }), pics: g.pics.map((_, i) => i) }];
    const near = await baseSpot();
    for (const f of found) {
      w.set('正在找位置…', f.rec.name);
      await autoLocate(f.rec, near, g.src);
    }
    w.done();
    review(found, g);
  } catch (e) {
    w.done();
    release(g);
    toast(e.message || '出错了', 4000);
  }
}

async function autoLocate(rec, near, src) {
  if (src && src.kind === 'maps' && src.lat != null) { rec.lat = src.lat; rec.lng = src.lng; rec.geo = 'manual'; return; }
  for (const q of geoQueries(rec)) {
    if (!q) continue;
    const hits = await net.geocode(q, near);
    if (hits.length) {
      const best = near ? hits.slice().sort((a, b) => km(near, a) - km(near, b))[0] : hits[0];
      // Prefer a hit near home/school/work unless the post clearly names another city.
      const pick = near && km(near, hits[0]) > 300 && km(near, best) < 300 && !rec.city ? best : hits[0];
      rec.lat = pick.lat; rec.lng = pick.lng; rec.geo = 'auto';
      if (!rec.address) rec.address = pick.address;
      return;
    }
  }
}

// Review screen after recognition: one form per restaurant found.
function review(found, g) {
  let saved = false;
  openPage(found.length > 1 ? `识别到 ${found.length} 家店` : '确认信息', (body, page) => {
    body.innerHTML = `<p class="hint">${ai.ready() ? 'AI 整理好了，检查一下再保存。点照片可以选择要保存哪些。' : '填写一下再保存。'}</p><div class="review-list"></div>
      <button class="btn wide sticky-save" data-a="save">保存</button>`;
    const listNode = $('.review-list', body);
    const forms = found.map((f, i) => {
      const wrap = el(`<div class="review-item"><label class="keep"><input type="checkbox" checked> 保存这家</label><div class="form-slot"></div></div>`);
      listNode.appendChild(wrap);
      const dup = findDuplicate(foods, f.rec);
      const form = foodFormFields($('.form-slot', wrap), f.rec, { pics: g.pics, picked: f.pics, dup });
      return { f, wrap, form, i };
    });
    $('[data-a=save]', body).onclick = async () => {
      const w = busy('保存中…');
      try {
        let n = 0;
        for (const { f, wrap, form } of forms) {
          if (!$('.keep input', wrap).checked) continue;
          const rec = form.value();
          rec.sources = [sourceOf(g, 'shot')];
          const dup = form.mergeInto();
          // The same post saved before: don't store its photos twice.
          const seen = dup && rec.sources[0].url && (dup.sources || []).some((s) => s.url === rec.sources[0].url);
          rec.images = [];
          if (!seen) for (const pi of form.pics()) rec.images.push(await g.pics[pi].save());
          if (dup) await db.put('food', mergeFood(dup, { ...rec, id: dup.id }));
          else await db.put('food', rec);
          n++;
        }
        saved = true;
        w.done();
        toast(n ? `已保存 ${n} 家 ✓` : '没有保存');
        page.close();
        await refresh();
      } catch (e) {
        w.done();
        toast(e.message || '保存失败');
      }
    };
  }, { onClose: () => { release(g); if (!saved) toast('没有保存'); } });
}

// Edit an existing record (or a blank one).
export function openForm(rec, _unused, after) {
  const isNew = !foods.some((x) => x.id === rec.id);
  openPage(isNew ? '添加店' : '编辑', (body, page) => {
    body.innerHTML = '<div class="form-slot"></div><button class="btn wide sticky-save" data-a="save">保存</button>';
    const form = foodFormFields($('.form-slot', body), rec, { existing: true });
    $('[data-a=save]', body).onclick = async () => {
      const v = form.value();
      if (!v.name.trim()) { toast('请填写店名'); return; }
      v.images = await form.images();
      await db.put('food', v);
      await db.sweepImages();
      page.close();
      if (after) after(v); else refresh();
    };
  });
}

// The editable fields. opts.pics (review: pictures to choose from), opts.existing (edit: manage saved images).
function foodFormFields(slot, rec, opts) {
  const r = JSON.parse(JSON.stringify(rec));
  const dishesText = (r.dishes || []).map((d) => [d.star ? '★' : '', d.name, d.price ? ` | ${d.price}` : '', d.note ? ` | ${d.note}` : ''].join('')).join('\n');
  slot.innerHTML = `
    ${opts.dup ? `<div class="dup"><b>可能已经收藏过：「${esc(opts.dup.name)}」</b><label><input type="checkbox" class="merge" checked> 合并到那一条（照片、菜单、优惠会加进去）</label></div>` : ''}
    ${opts.pics ? '<div class="field"><span>要保存的照片</span><div class="pics-slot"></div></div>' : ''}
    ${opts.existing ? '<div class="field"><span>照片</span><div class="saved-pics"></div><button type="button" class="btn small ghost" data-a="addpic">＋ 加照片</button></div>' : ''}
    <label class="field"><span>店名</span><input name="name" value="${esc(r.name)}" placeholder="店名"></label>
    <div class="field"><span>菜系</span><div class="chips cuisine-pick">${CUISINES.map((c) => `<button type="button" class="chip ${cuisineOf(r) === c.key ? 'on' : ''}" data-cat="${c.key}">${c.icon} ${esc(c.label)}</button>`).join('')}</div></div>
    <div class="row gap"><label class="field grow"><span>分店</span><input name="branch" value="${esc(r.branch)}"></label><label class="field grow"><span>菜系细分</span><input name="cuisine" value="${esc(r.cuisine)}" placeholder="如 韩式烤肉"></label></div>
    <label class="field"><span>地址</span><textarea name="address" rows="2">${esc(r.address)}</textarea></label>
    <div class="row gap"><label class="field grow"><span>地区/商场</span><input name="area" value="${esc(r.area)}"></label><label class="field grow"><span>城市</span><input name="city" value="${esc(r.city)}"></label></div>
    <div class="field"><span>位置</span><p class="where">${r.lat != null ? `已定位${r.geo === 'auto' ? '（按地址自动找的）' : ''}` : '未定位'}</p><button type="button" class="btn small ghost" data-a="loc">在地图上选 / 粘贴 Google Maps 链接</button></div>
    <div class="field"><span>价格</span><div class="row gap price-row"><input name="currency" value="${esc(r.price.currency)}" placeholder="RM" class="cur">
      <input name="min" type="number" inputmode="decimal" value="${r.price.min ?? ''}" placeholder="最低"><span>–</span><input name="max" type="number" inputmode="decimal" value="${r.price.max ?? ''}" placeholder="最高">
      <input name="per" value="${esc(r.price.per)}" placeholder="人均" class="per"></div></div>
    <label class="field"><span>推荐菜（一行一道：★必点 菜名 | 价格 | 备注）</span><textarea name="dishes" rows="4">${esc(dishesText)}</textarea></label>
    <div class="field"><span>优惠</span><div class="promos"></div><button type="button" class="btn small ghost" data-a="addpromo">＋ 加优惠</button></div>
    <label class="field"><span>营业时间</span><input name="hours" value="${esc(r.hours)}"></label>
    <label class="field"><span>标签（空格分开）</span><input name="tags" value="${esc((r.tags || []).join(' '))}"></label>
    <label class="field"><span>一句话</span><input name="summary" value="${esc(r.summary)}"></label>
    <label class="field"><span>我的笔记</span><textarea name="notes" rows="2">${esc(r.notes)}</textarea></label>`;
  const q = (n) => $(`[name=${n}]`, slot);
  let picker = null;
  if (opts.pics) { picker = picPicker(opts.pics, opts.picked); $('.pics-slot', slot).appendChild(picker); }
  let images = (r.images || []).slice();
  const drawSaved = async () => {
    const box = $('.saved-pics', slot);
    if (!box) return;
    box.innerHTML = '';
    for (const [i, id] of images.entries()) {
      box.appendChild(el(`<div class="pk"><img src="${await img.url(id, 'thumb')}" alt=""><button type="button" data-rmimg="${i}" aria-label="移除">✕</button></div>`));
    }
  };
  drawSaved();
  const promoBox = $('.promos', slot);
  const promoRow = (p) => el(`<div class="promo-edit"><input data-p="title" value="${esc(p.title)}" placeholder="优惠名称（如 买一送一）">
    <input data-p="detail" value="${esc(p.detail)}" placeholder="内容">
    <div class="row gap"><label>开始<input type="date" data-p="start" value="${esc(p.start)}"></label><label>结束<input type="date" data-p="end" value="${esc(p.end)}"></label></div>
    <div class="row gap"><input data-p="time" value="${esc(p.time)}" placeholder="时段（如 平日 3-6pm）" class="grow"><button type="button" class="link-btn danger" data-a="rmpromo">删除</button></div></div>`);
  (r.promos || []).forEach((p) => promoBox.appendChild(promoRow(p)));
  let category = cuisineOf(r);
  slot.addEventListener('click', async (e) => {
    const cat = e.target.closest('[data-cat]');
    if (cat) { category = cat.dataset.cat; $$('[data-cat]', slot).forEach((c) => c.classList.toggle('on', c === cat)); return; }
    const a = e.target.closest('[data-a]');
    const rmi = e.target.closest('[data-rmimg]');
    if (rmi) { images.splice(+rmi.dataset.rmimg, 1); drawSaved(); return; }
    if (!a) return;
    if (a.dataset.a === 'addpromo') promoBox.appendChild(promoRow({ title: '', detail: '', start: '', end: '', time: '' }));
    if (a.dataset.a === 'rmpromo') a.closest('.promo-edit').remove();
    if (a.dataset.a === 'loc') {
      const s = await places.pickLocation('选位置', r.lat != null ? r : null, r.lat != null ? '' : [q('name').value, q('branch').value, q('area').value, q('city').value].filter(Boolean).join(' '));
      if (s) { r.lat = s.lat; r.lng = s.lng; r.geo = 'manual'; r.routes = {}; $('.where', slot).textContent = '已定位（手动选的）'; }
    }
    if (a.dataset.a === 'addpic') {
      const files = await pickFiles('image/*', true);
      const w = busy('加照片…');
      for (const f of files) images.push(await img.save(f));
      w.done();
      drawSaved();
    }
  });
  const num = (v) => (v === '' || v == null || Number.isNaN(+v) ? null : +v);
  return {
    pics: () => (picker ? picker.value : []),
    images: async () => images,
    mergeInto: () => (opts.dup && $('.merge', slot) && $('.merge', slot).checked ? opts.dup : null),
    value: () => ({
      ...r,
      name: q('name').value.trim(), branch: q('branch').value.trim(), cuisine: q('cuisine').value.trim(), category,
      address: q('address').value.trim(), area: q('area').value.trim(), city: q('city').value.trim(),
      price: { ...r.price, currency: q('currency').value.trim(), min: num(q('min').value), max: num(q('max').value), per: q('per').value.trim() },
      dishes: q('dishes').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const star = /^[★*]/.test(l);
        const [name, price, note] = l.replace(/^[★*]\s*/, '').split('|').map((x) => x.trim());
        return { name, price: price || '', note: note || '', star };
      }),
      promos: $$('.promo-edit', slot).map((n) => Object.fromEntries($$('[data-p]', n).map((i) => [i.dataset.p, i.value.trim()]))).filter((p) => p.title || p.detail),
      hours: q('hours').value.trim(),
      tags: q('tags').value.split(/[\s,，#]+/).filter(Boolean),
      summary: q('summary').value.trim(),
      notes: q('notes').value.trim(),
      updated: Date.now(),
    }),
  };
}

// ---------- tidy up: duplicates and old promos ----------

function tidy() {
  openPage('整理清单', (body) => {
    const draw = () => {
      const on = today();
      const pairs = [];
      for (let i = 0; i < foods.length; i++) for (let j = i + 1; j < foods.length; j++) if (sameRestaurant(foods[i], foods[j])) pairs.push([foods[i], foods[j]]);
      const expired = foods.reduce((n, f) => n + (f.promos || []).filter((p) => promoStatus(p, on).key === 'expired').length, 0);
      const unplaced = foods.filter((f) => f.lat == null);
      body.innerHTML = `<section class="box"><h3>可能重复的店</h3>${pairs.length ? pairs.map(([a, b], i) => `<div class="pair"><span><b>${esc(a.name)}</b> ＋ <b>${esc(b.name)}</b></span><button class="btn small" data-merge="${i}">合并</button></div>`).join('') : '<p class="muted">没有重复 ✓</p>'}</section>
        <section class="box"><h3>过期优惠</h3>${expired ? `<p>${expired} 条优惠已经结束</p><button class="btn small" data-a="clean">清除过期优惠</button>` : '<p class="muted">没有过期优惠 ✓</p>'}</section>
        <section class="box"><h3>还没定位的店</h3>${unplaced.length ? unplaced.map((f) => `<button class="item" data-open="${f.id}"><span class="grow">${esc(f.name)}</span><span class="chev">›</span></button>`).join('') : '<p class="muted">都定位好了 ✓</p>'}</section>`;
      body.onclick = async (e) => {
        const m = e.target.closest('[data-merge]');
        if (m) {
          const [a, b] = pairs[+m.dataset.merge];
          await db.put('food', mergeFood(a, b));
          await db.del('food', b.id);
          await load(); toast('已合并 ✓'); draw(); render();
        }
        const o = e.target.closest('[data-open]');
        if (o) openDetail(o.dataset.open);
        const a = e.target.closest('[data-a=clean]');
        if (a) {
          for (const f of foods) {
            const keep = (f.promos || []).filter((p) => promoStatus(p, on).key !== 'expired');
            if (keep.length !== (f.promos || []).length) { f.promos = keep; await db.put('food', f); }
          }
          toast('已清除 ✓'); draw(); render();
        }
      };
    };
    draw();
  });
}

export const count = () => foods.length;
export { uid };
