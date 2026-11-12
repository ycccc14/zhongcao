// "My places" (home / school / work …), the location picker map, and Leaflet helpers.
import * as db from './db.js';
import * as net from './net.js';
import { CFG } from './config.js';
import { uid, linkKind, firstUrl } from './logic.js';
import { el, esc, $, openPage, openSheet, toast, confirmBox, busy } from './ui.js';

export const PLACE_KINDS = {
  home: { label: '家', icon: '🏠' }, school: { label: '学校', icon: '🏫' }, work: { label: '公司', icon: '💼' },
  gym: { label: '健身房', icon: '🏋️' }, other: { label: '其他', icon: '📍' },
};

let cache = null;
export async function list() {
  if (!cache) cache = (await db.all('places')).sort((a, b) => (a.order || 0) - (b.order || 0));
  return cache;
}
export const icon = (p) => (PLACE_KINDS[p.kind] || PLACE_KINDS.other).icon;
async function savePlace(p) { await db.put('places', p); cache = null; }
async function removePlace(id) { await db.del('places', id); cache = null; }

// ---------- Leaflet ----------

export function makeMap(node, opts) {
  const L = window.L;
  const map = L.map(node, { zoomControl: false, attributionControl: true, tap: false, ...(opts || {}) });
  L.tileLayer(CFG.tiles, { maxZoom: 19, subdomains: 'abcd', attribution: CFG.tilesAttr, detectRetina: false }).addTo(map);
  map.attributionControl.setPrefix(false);
  return map;
}

export function placeMarker(p) {
  const L = window.L;
  return L.marker([p.lat, p.lng], {
    icon: L.divIcon({ className: 'pin-place', html: `<span>${icon(p)}</span><b>${esc(p.name)}</b>`, iconSize: [36, 36], iconAnchor: [18, 18] }),
    zIndexOffset: 500,
  });
}

// ---------- picker: choose a point on a map ----------
// start = {lat,lng} or null; returns Promise<{lat,lng,label}|null>
export function pickLocation(title, start, hintQuery) {
  return new Promise((resolve) => {
    let result = null;
    openPage(title || '选位置', async (body, page) => {
      body.classList.add('picker');
      body.innerHTML = `<div class="picker-search"><input type="search" placeholder="搜索地址/店名，或粘贴 Google Maps 链接" value="${esc(hintQuery || '')}"><button class="btn small">搜索</button></div>
        <div class="picker-results"></div>
        <div class="picker-map"><div class="map"></div><div class="crosshair">📍</div></div>
        <div class="picker-foot"><button class="btn ghost" data-a="me">◎ 我的位置</button><button class="btn grow" data-a="ok">选这里</button></div>`;
      const places = await list();
      const map = makeMap($('.map', body));
      const first = start && start.lat != null ? start : places[0] || { lat: 3.139, lng: 101.687 };
      map.setView([first.lat, first.lng], start && start.lat != null ? 16 : 12);
      places.forEach((p) => placeMarker(p).addTo(map));
      setTimeout(() => map.invalidateSize(), 250);
      const input = $('input', body);
      const results = $('.picker-results', body);
      const search = async () => {
        const q = input.value.trim();
        if (!q) return;
        results.innerHTML = '<p class="muted pad">搜索中…</p>';
        if (linkKind(firstUrl(q)) === 'maps') {
          try {
            const r = await net.readLink(q);
            if (r.lat != null) { map.setView([r.lat, r.lng], 17); results.innerHTML = ''; toast(r.place ? `已定位：${r.place}` : '已定位'); return; }
            if (r.place) { input.value = r.place; }
          } catch (e) { toast(e.message); }
        }
        const c = map.getCenter();
        const found = await net.geocode(input.value.trim(), { lat: c.lat, lng: c.lng });
        if (!found.length) { results.innerHTML = '<p class="muted pad">没找到，换个关键词，或者直接拖动地图</p>'; return; }
        results.innerHTML = found.map((f, i) => `<button class="result" data-i="${i}"><b>${esc(f.name)}</b><small>${esc(f.address)}</small></button>`).join('');
        results.onclick = (e) => {
          const b = e.target.closest('.result');
          if (!b) return;
          const f = found[+b.dataset.i];
          map.setView([f.lat, f.lng], 17);
          results.innerHTML = '';
        };
      };
      $('.btn', $('.picker-search', body)).onclick = search;
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
      if (hintQuery && !(start && start.lat != null)) search();
      $('.picker-foot', body).onclick = async (e) => {
        const a = e.target.closest('[data-a]');
        if (!a) return;
        if (a.dataset.a === 'me') {
          try { const p = await net.myLocation(); map.setView([p.lat, p.lng], 17); } catch (err) { toast(err.message); }
          return;
        }
        const c = map.getCenter();
        result = { lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6) };
        page.close();
      };
    }, { cls: 'page-picker', onClose: () => resolve(result) });
  });
}

// ---------- manage places ----------

export function manage(onChange) {
  openPage('我的地点', async (body) => {
    const draw = async () => {
      const places = await list();
      body.innerHTML = `<p class="hint">设置常去的地方，餐厅会显示离这些地方多远、怎么去。</p>
        <div class="list">${places.map((p) => `<button class="item place-item" data-id="${p.id}"><span class="emoji">${icon(p)}</span>
          <span class="grow"><b>${esc(p.name)}</b><small>${esc(p.address || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`)}</small></span><span class="chev">›</span></button>`).join('')
          || '<p class="empty">还没有地点</p>'}</div>
        <div class="quick-add">${Object.entries(PLACE_KINDS).map(([k, v]) => `<button class="chip" data-kind="${k}">${v.icon} 加${v.label}</button>`).join('')}</div>`;
    };
    await draw();
    body.onclick = async (e) => {
      const item = e.target.closest('.place-item');
      const add = e.target.closest('[data-kind]');
      if (item) { const p = (await list()).find((x) => x.id === item.dataset.id); edit(p, async () => { await draw(); if (onChange) onChange(); }); }
      if (add) edit({ id: '', kind: add.dataset.kind, name: PLACE_KINDS[add.dataset.kind].label }, async () => { await draw(); if (onChange) onChange(); });
    };
  });
}

function edit(p, after) {
  openSheet(p.id ? '修改地点' : '新地点', (box, sheet) => {
    let spot = p.lat != null ? { lat: p.lat, lng: p.lng } : null;
    box.innerHTML = `<label class="field"><span>名字</span><input name="name" value="${esc(p.name)}" maxlength="20"></label>
      <div class="field"><span>类型</span><div class="chips">${Object.entries(PLACE_KINDS).map(([k, v]) => `<button type="button" class="chip ${k === p.kind ? 'on' : ''}" data-k="${k}">${v.icon} ${v.label}</button>`).join('')}</div></div>
      <div class="field"><span>位置</span><p class="where">${spot ? esc(p.address || '已选位置') : '还没选'}</p>
        <div class="row gap wrap"><button class="btn small ghost" data-a="map">在地图上选 / 搜索</button><button class="btn small ghost" data-a="me">◎ 用现在的位置</button></div></div>
      <div class="row gap">${p.id ? '<button class="btn ghost danger" data-a="del">删除</button>' : ''}<button class="btn grow" data-a="save">保存</button></div>`;
    let kind = p.kind;
    let address = p.address || '';
    const where = $('.where', box);
    const setSpot = async (s) => {
      spot = s;
      where.textContent = '已选位置，正在查地址…';
      address = await net.reverse(s.lat, s.lng);
      where.textContent = address || `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`;
    };
    box.onclick = async (e) => {
      const k = e.target.closest('[data-k]');
      if (k) { kind = k.dataset.k; box.querySelectorAll('[data-k]').forEach((c) => c.classList.toggle('on', c === k)); return; }
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'map') { const s = await pickLocation('选位置', spot, spot ? '' : $('[name=name]', box).value); if (s) setSpot(s); }
      if (a.dataset.a === 'me') { const w = busy('定位中…'); try { await setSpot(await net.myLocation()); } catch (err) { toast(err.message); } w.done(); }
      if (a.dataset.a === 'del' && await confirmBox(`删除「${p.name}」？`, '删除', true)) { await removePlace(p.id); sheet.close(); after(); }
      if (a.dataset.a === 'save') {
        const name = $('[name=name]', box).value.trim() || PLACE_KINDS[kind].label;
        if (!spot) { toast('请先选位置'); return; }
        await savePlace({ ...p, id: p.id || uid(), name, kind, lat: spot.lat, lng: spot.lng, address, order: p.order || Date.now() });
        sheet.close();
        after();
      }
    };
  });
}
