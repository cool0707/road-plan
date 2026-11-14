/* Road Plan — 状態管理・地図・描画・ツール */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d));
const deg = (r) => (r * 180) / Math.PI;
const uid = () => Math.random().toString(36).slice(2, 9);
const station = (s) => { const k = Math.floor(s / 20 + 1e-9); return `No.${k}+${fmt(Math.max(0, s - 20 * k), 2)}`; };
const azimuth = (th) => (((90 - deg(th)) % 360) + 360) % 360;
const COLORS = { line: '#0d99ff', clothoid: '#f59e0b', arc: '#f24822' };
const ELNAME = { line: '直線', clothoid: 'クロソイド', arc: '円曲線' };

/* ───────── プロジェクト状態 ───────── */
const LS_KEY = 'roadplan.project.v1';
function newProject() {
  return {
    version: 1, name: '無題の道路計画', origin: null, roads: [], existing: [], image: null,
    base: 'gsi-pale', baseOpacity: 1, existingVisible: true, existingWidth: false, view: null, googleKey: '',
    defaults: { cls: '3-3', V: 40, lanes: 2, laneW: 3.0, shoulderW: 0.75, sidewalkW: 0, shitei: false },
  };
}
function loadProject() {
  try { const p = JSON.parse(localStorage.getItem(LS_KEY)); if (p && p.version === 1) return Object.assign(newProject(), p); } catch (e) { /* 壊れた保存データは無視 */ }
  return null;
}
let project = loadProject() || newProject();
const ui = { tool: 'select', sel: null, tab: 'design', draw: null, measure: [], pick: null, dragging: false, imageUrl: null, profiles: new Map(), snap: null };

function save() {
  const c = map.getCenter();
  project.view = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
  try { localStorage.setItem(LS_KEY, JSON.stringify(project)); }
  catch (e) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign({}, project, { existing: [] }))); } catch (e2) { /* 容量超過 */ }
  }
}

/* undo / redo: 計画道路と下絵配置のスナップショット */
const hist = { undo: [], redo: [], last: null };
const snapshot = () => JSON.stringify({ roads: project.roads, image: project.image });
function commit() {
  hist.undo.push(hist.last); if (hist.undo.length > 100) hist.undo.shift();
  hist.redo = []; hist.last = snapshot();
  save(); refresh();
}
function restore(s) {
  const o = JSON.parse(s); project.roads = o.roads; project.image = o.image;
  if (ui.sel && ui.sel.type === 'road' && !roadById(ui.sel.id)) ui.sel = null;
  if (ui.sel && ui.sel.type === 'road' && ui.sel.ip != null && ui.sel.ip >= roadById(ui.sel.id).ips.length) ui.sel.ip = null;
  ui.profiles.clear(); save(); syncImageLayer(); refresh();
}
function undo() { if (!hist.undo.length) return; hist.redo.push(hist.last); hist.last = hist.undo.pop(); restore(hist.last); }
function redo() { if (!hist.redo.length) return; hist.undo.push(hist.last); hist.last = hist.redo.pop(); restore(hist.last); }

const roadById = (id) => project.roads.find((r) => r.id === id);
const selRoad = () => (ui.sel && ui.sel.type === 'road' ? roadById(ui.sel.id) : null);

/* ───────── ローカル座標（原点まわりの平面近似, m） ───────── */
const P = {
  origin() { return project.origin || map.getCenter(); },
  k(lat) {
    const f = (lat * Math.PI) / 180;
    return { la: 111132.92 - 559.82 * Math.cos(2 * f) + 1.175 * Math.cos(4 * f), lo: 111412.84 * Math.cos(f) - 93.5 * Math.cos(3 * f) };
  },
  toXY(ll) { const o = this.origin(), k = this.k(o.lat); const lat = ll.lat ?? ll[0], lng = ll.lng ?? ll[1]; return { x: (lng - o.lng) * k.lo, y: (lat - o.lat) * k.la }; },
  toLL(x, y) { const o = this.origin(), k = this.k(o.lat); return L.latLng(o.lat + y / k.la, o.lng + x / k.lo); },
};

/* ───────── 地図 ───────── */
const map = L.map('map', { zoomControl: false, doubleClickZoom: false, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90, maxZoom: 22, minZoom: 4 });
map.setView(project.view ? [project.view.lat, project.view.lng] : [35.6812, 139.7671], project.view ? project.view.zoom : 16);
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
[['image', 250], ['existing', 350], ['design', 420], ['labels', 450]].forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
map.getPane('labels').style.pointerEvents = 'none';
const exRenderer = L.canvas({ pane: 'existing', tolerance: 8 });
const gExisting = L.layerGroup().addTo(map), gRoads = L.layerGroup().addTo(map), gPreview = L.layerGroup().addTo(map),
  gHandles = L.layerGroup().addTo(map), gHover = L.layerGroup().addTo(map), gMisc = L.layerGroup().addTo(map);

const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
const BASES = {
  'gsi-pale': { name: '地理院地図（淡色）', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', maxNativeZoom: 18, attr: GSI_ATTR },
  'gsi-std': { name: '地理院地図（標準）', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', maxNativeZoom: 18, attr: GSI_ATTR },
  'gsi-photo': { name: '地理院 航空写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxNativeZoom: 18, attr: GSI_ATTR },
  osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNativeZoom: 19, attr: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' },
  'google-road': { name: 'Google マップ', google: 'roadmap' },
  'google-sat': { name: 'Google 航空写真', google: 'satellite' },
  none: { name: 'なし（白地）' },
};
let baseLayer = null;
async function setBase(key) {
  const b = BASES[key] || BASES['gsi-pale'];
  let url = b.url, attr = b.attr, maxNative = b.maxNativeZoom;
  if (b.google) {
    // Google Map Tiles API（公式のタイルAPI）。APIキーが必要。
    if (!project.googleKey) { toast('Google マップを使うには左パネルで Map Tiles API のキーを設定してください', 'err'); return false; }
    try {
      const r = await fetch('https://tile.googleapis.com/v1/createSession?key=' + encodeURIComponent(project.googleKey), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mapType: b.google, language: 'ja-JP', region: 'JP' }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      url = `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${j.session}&key=${encodeURIComponent(project.googleKey)}`;
      attr = '© Google'; maxNative = 22;
    } catch (e) { toast('Google タイルのセッション作成に失敗しました（APIキーと Map Tiles API の有効化を確認）: ' + e.message, 'err'); return false; }
  }
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = url ? L.tileLayer(url, { maxZoom: 22, maxNativeZoom: maxNative, attribution: attr, opacity: project.baseOpacity }).addTo(map) : null;
  project.base = key;
  return true;
}

/* ───────── 下絵画像（回転・拡縮可能なオーバーレイ） ───────── */
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('roadplan', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
};
function imageCorners() { // 左上, 右上, 右下, 左下
  const im = project.image, hw = im.w / 2, hh = (im.w * im.aspect) / 2, t = (im.rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].map(([x, y]) => P.toLL(im.cx + x * c - y * s, im.cy + x * s + y * c));
}
const RotImage = L.Layer.extend({
  initialize(url) { this._url = url; },
  onAdd(m) {
    const img = (this._img = L.DomUtil.create('img', 'rot-image leaflet-zoom-hide'));
    img.onload = () => this._reset(); img.src = this._url;
    m.getPane('image').appendChild(img); this._reset();
  },
  onRemove() { this._img.remove(); },
  getEvents() { return { zoomend: this._reset, viewreset: this._reset }; },
  update() { if (this._map) this._reset(); },
  _reset() {
    const im = project.image, img = this._img;
    if (!im || !img.naturalWidth) return;
    const [tl, tr, , bl] = imageCorners().map((ll) => this._map.latLngToLayerPoint(ll));
    const w = img.naturalWidth, h = img.naturalHeight;
    img.style.transform = `matrix(${(tr.x - tl.x) / w},${(tr.y - tl.y) / w},${(bl.x - tl.x) / h},${(bl.y - tl.y) / h},${tl.x},${tl.y})`;
    img.style.opacity = im.opacity;
  },
});
let imageLayer = null;
function syncImageLayer() {
  const want = project.image && project.image.visible && ui.imageUrl;
  if (!want) { if (imageLayer) { map.removeLayer(imageLayer); imageLayer = null; } return; }
  if (!imageLayer || imageLayer._url !== ui.imageUrl) { if (imageLayer) map.removeLayer(imageLayer); imageLayer = new RotImage(ui.imageUrl).addTo(map); } else imageLayer.update();
}
function addImageFile(file) {
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      if (!project.origin) project.origin = { lat: map.getCenter().lat, lng: map.getCenter().lng };
      const b = map.getBounds(), c = P.toXY(map.getCenter());
      const viewW = P.toXY(b.getNorthEast()).x - P.toXY(b.getSouthWest()).x;
      project.image = { cx: c.x, cy: c.y, w: viewW * 0.6, rot: 0, aspect: img.naturalHeight / img.naturalWidth, opacity: 0.7, visible: true };
      ui.imageUrl = fr.result; idb.set('image', fr.result).catch(() => toast('画像をブラウザに保存できませんでした（再読込で消えます）', 'err'));
      ui.sel = { type: 'image' }; syncImageLayer(); commit();
      toast('下絵を配置しました。ハンドルで移動・回転・拡縮、右パネルで縮尺合わせができます');
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}

/* ───────── 線形計算（キャッシュ付き） ───────── */
const alCache = new Map();
function calc(road) {
  const key = JSON.stringify(road.ips);
  const c = alCache.get(road.id);
  if (c && c.key === key) return c.al;
  const al = Geom.computeAlignment(road.ips), sm = Geom.sample(al);
  al.samples = sm.all; al.byEl = sm.byEl;
  if (road.id) alCache.set(road.id, { key, al });
  return al;
}
const checksOf = (road) => Rules.check(road, calc(road), { profile: ui.profiles.get(road.id) });

/* 接線接続の拘束: 端点の隣の IP を既存道路の延長線上に載せる */
function normalize(road) {
  const ips = road.ips, n = ips.length;
  const fix = (a, b, conn) => {
    if (!conn || conn.mode !== 'tangent') return;
    const ux = Math.cos(conn.bearing), uy = Math.sin(conn.bearing);
    let d = (b.x - a.x) * ux + (b.y - a.y) * uy;
    if (Math.abs(d) < 1) d = d < 0 ? -1 : 1;
    b.x = a.x + ux * d; b.y = a.y + uy * d;
  };
  if (n < 2) return;
  fix(ips[0], ips[1], road.conn.start);
  if (n > 2) fix(ips[n - 1], ips[n - 2], road.conn.end);
}

/* IP i に、前後の区間に収まる推奨曲線（R, A）を設定 */
function fitCurve(road, i) {
  const ips = road.ips, n = ips.length, a = ips[i - 1], b = ips[i], c = ips[i + 1];
  const d1 = Math.hypot(b.x - a.x, b.y - a.y), d2 = Math.hypot(c.x - b.x, c.y - b.y);
  const delta = Math.abs(Geom.wrap(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)));
  if (delta < 1e-4 || delta > Math.PI - 0.02) { b.R = 0; b.A1 = 0; b.A2 = 0; return; }
  const m1 = d1 * (i - 1 > 0 ? 0.5 : 1) * 0.98, m2 = d2 * (i + 1 < n - 1 ? 0.5 : 1) * 0.98;
  const floorTo = (v, q) => Math.floor(v / q + 1e-9) * q;
  let R = Rules.recommend(road.V, delta).R;
  for (let k = 0; k < 80 && R > 1; k++) {
    const Rr = R >= 100 ? floorTo(R, 5) : R >= 20 ? floorTo(R, 1) : floorTo(R, 0.5);
    const A = Math.ceil(Math.sqrt(Rr * Rules.recommendL(road.V, Rr, delta)) * 10 - 1e-6) / 10;
    const cv = Geom.curveAt(delta, Rr, A, A);
    if (cv.T1 <= m1 && cv.T2 <= m2) { b.R = Rr; b.A1 = b.A2 = +A.toFixed(1); return; }
    R *= 0.9;
  }
  b.R = 1; b.A1 = b.A2 = 0;
}
function autoCurves(road) { for (let i = 1; i < road.ips.length - 1; i++) fitCurve(road, i); }

/* ───────── 既存道路 ───────── */
const CLS_SPEED = { motorway: 100, motorway_link: 60, trunk: 60, trunk_link: 40, primary: 60, primary_link: 40, secondary: 50, secondary_link: 40, tertiary: 40, tertiary_link: 30, unclassified: 40, residential: 30, living_street: 20, service: 20, track: 20 };
const CLS_WIDTH = { motorway: 7, trunk: 7, primary: 7, secondary: 6.5, tertiary: 6, unclassified: 5, residential: 5, living_street: 4, service: 4, track: 3 };
const CLS_JA = { motorway: '高速道路', trunk: '国道', primary: '主要地方道', secondary: '一般都道府県道', tertiary: '主要な一般道', unclassified: '一般道', residential: '生活道路', living_street: '生活道路', service: '敷地内・通路', track: '農道・林道' };
function bboxOf(pts) { let a = 90, b = 180, c = -90, d = -180; for (const p of pts) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); } return [a, b, c, d]; }
function osmToEx(w) {
  const t = w.tags || {}, cls = (t.highway || '').replace(/_link$/, '');
  const lanes = parseInt(t.lanes, 10) || null, ms = parseInt(t.maxspeed, 10) || null, tw = parseFloat(t.width) || null;
  const pts = w.geometry.map((g) => [g.lat, g.lon]);
  return {
    id: 'osm-' + w.id, src: 'OSM', name: t.name || t.ref || '', cls: t.highway, clsJa: CLS_JA[cls] || t.highway,
    width: tw || (lanes ? lanes * 3.0 + 1.0 : CLS_WIDTH[cls] || 5), widthNote: tw ? 'width タグ' : lanes ? '車線数から推定' : '道路種別から推定',
    lanes, speed: ms || CLS_SPEED[t.highway] || 40, speedEst: !ms, oneway: t.oneway === 'yes', surface: t.surface || '', pts, bbox: bboxOf(pts),
  };
}
const GSI_W = { '3m未満': 2.5, '3m-5.5m未満': 4.25, '5.5m-13m未満': 7.0, '13m-19.5m未満': 16, '19.5m以上': 20 };
function gsiToEx(f, id, coords) {
  const p = f.properties || {}, pts = coords.map((c) => [c[1], c[0]]);
  const ctg = p.rdCtg || '', sp = /高速/.test(ctg) ? 100 : /国道/.test(ctg) ? 60 : /都道府県/.test(ctg) ? 50 : 30;
  return {
    id, src: '地理院', name: p.name || p.rtCode || '', cls: ctg || '道路', clsJa: ctg || '道路中心線',
    width: GSI_W[p.rnkWidth] || 5, widthNote: p.rnkWidth ? `幅員区分 ${p.rnkWidth}` : '不明（仮定値）', lanes: null, speed: sp, speedEst: true, oneway: false, surface: '', pts, bbox: bboxOf(pts),
  };
}
/* 重複判定: 既存線の近傍（tol m 以内・ほぼ平行）に cover 以上が収まる線は重複とみなす */
const DUP_TOL = 6, DUP_COVER = 0.85, DUP_CELL = 20;
function dupIndex() {
  const cells = new Map();
  const key = (i, j) => i + ',' + j;
  return {
    add(xy) {
      for (let k = 1; k < xy.length; k++) {
        const a = xy[k - 1], b = xy[k], seg = [a.x, a.y, b.x, b.y];
        const i0 = Math.floor((Math.min(a.x, b.x) - DUP_TOL) / DUP_CELL), i1 = Math.floor((Math.max(a.x, b.x) + DUP_TOL) / DUP_CELL);
        const j0 = Math.floor((Math.min(a.y, b.y) - DUP_TOL) / DUP_CELL), j1 = Math.floor((Math.max(a.y, b.y) + DUP_TOL) / DUP_CELL);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const c = key(i, j); if (!cells.has(c)) cells.set(c, []); cells.get(c).push(seg); }
      }
    },
    near(x, y, dx, dy) { // (x,y) 付近に方向 (dx,dy) とほぼ平行な線分があるか
      const segs = cells.get(key(Math.floor(x / DUP_CELL), Math.floor(y / DUP_CELL)));
      if (!segs) return false;
      for (const [ax, ay, bx, by] of segs) {
        const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
        if (!l2) continue;
        if (Math.abs(vx * dy - vy * dx) > 0.5 * Math.sqrt(l2)) continue; // 30° 以上の交差は別の道路
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2));
        if (Math.hypot(x - ax - vx * t, y - ay - vy * t) <= DUP_TOL) return true;
      }
      return false;
    },
  };
}
function isDup(xy, idx) {
  let tot = 0, hit = 0;
  for (let k = 1; k < xy.length; k++) {
    const a = xy[k - 1], b = xy[k], l = Math.hypot(b.x - a.x, b.y - a.y);
    if (!l) continue;
    const n = Math.max(1, Math.ceil(l / 3)), dx = (b.x - a.x) / l, dy = (b.y - a.y) / l;
    for (let s = 0; s < n; s++) { const t = (s + 0.5) / n; tot++; if (idx.near(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, dx, dy)) hit++; }
  }
  return tot > 0 && hit / tot >= DUP_COVER;
}
const exLen = (xy) => { let l = 0; for (let k = 1; k < xy.length; k++) l += Math.hypot(xy[k].x - xy[k - 1].x, xy[k].y - xy[k - 1].y); return l; };
function addExisting(list) {
  const m = new Map(project.existing.map((e) => [e.id, e]));
  const fresh = [];
  list.forEach((e) => { if (e.pts.length < 2) return; if (m.has(e.id)) m.set(e.id, e); else fresh.push(e); }); // 同じ ID は更新
  const idx = dupIndex();
  for (const e of m.values()) idx.add(e.pts.map((p) => P.toXY(p)));
  let skipped = 0;
  fresh.map((e) => ({ e, xy: e.pts.map((p) => P.toXY(p)) })).sort((a, b) => exLen(b.xy) - exLen(a.xy)).forEach(({ e, xy }) => {
    if (isDup(xy, idx)) { skipped++; return; }
    idx.add(xy); m.set(e.id, e);
  });
  project.existing = [...m.values()]; project.existingVisible = true;
  save(); renderExisting(); renderPanels();
  return { added: list.length - skipped, skipped };
}
function dedupeExisting() {
  const idx = dupIndex(), keep = [];
  project.existing.map((e) => ({ e, xy: e.pts.map((p) => P.toXY(p)) })).sort((a, b) => exLen(b.xy) - exLen(a.xy)).forEach(({ e, xy }) => {
    if (isDup(xy, idx)) return;
    idx.add(xy); keep.push(e);
  });
  const n = project.existing.length - keep.length;
  const ids = new Set(keep.map((e) => e.id));
  project.existing = project.existing.filter((e) => ids.has(e.id));
  if (ui.sel && ui.sel.type === 'existing' && !ids.has(ui.sel.id)) ui.sel = null;
  save(); renderExisting(); refresh();
  toast(n ? `重複していた既存道路 ${n} 本を除去しました` : '重複している既存道路はありません');
}
function deleteExisting(id) {
  project.existing = project.existing.filter((e) => e.id !== id);
  if (ui.sel && ui.sel.type === 'existing' && ui.sel.id === id) ui.sel = null;
  save(); renderExisting(); refresh();
}
const dupMsg = (r) => (r.skipped ? `（重複 ${r.skipped} 本は除外）` : '');
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function fetchOSM() {
  if (map.getZoom() < 14) return toast('表示範囲が広すぎます。ズーム 14 以上に拡大してください', 'err');
  const b = map.getBounds();
  const q = `[out:json][timeout:25];way["highway"]["highway"!~"^(footway|path|steps|cycleway|pedestrian|construction|proposed|corridor|platform|elevator|bridleway|bus_guideway|raceway|rest_area|services)$"]["area"!="yes"](${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()});out tags geom;`;
  toast('OpenStreetMap から既存道路を取得中…');
  let last;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const list = j.elements.filter((e) => e.type === 'way' && e.geometry).map(osmToEx);
      const res = addExisting(list);
      return toast(`既存道路 ${res.added} 本を取得しました${dupMsg(res)}（© OpenStreetMap contributors）`);
    } catch (e) { last = e; }
  }
  toast('既存道路の取得に失敗しました: ' + (last && last.message), 'err');
}
async function fetchGSI() {
  if (map.getZoom() < 15) return toast('表示範囲が広すぎます。ズーム 15 以上に拡大してください', 'err');
  const b = map.getBounds(), z = 16, n = 2 ** z;
  const tx = (lng) => Math.floor(((lng + 180) / 360) * n);
  const ty = (lat) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
  const jobs = [];
  for (let x = tx(b.getWest()); x <= tx(b.getEast()); x++) for (let y = ty(b.getNorth()); y <= ty(b.getSouth()); y++) jobs.push([x, y]);
  if (jobs.length > 40) return toast('表示範囲が広すぎます。もう少し拡大してください', 'err');
  toast('国土地理院 道路中心線を取得中…');
  const list = [];
  let okCount = 0;
  await Promise.all(jobs.map(async ([x, y]) => {
    try {
      const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/experimental_rdcl/${z}/${x}/${y}.geojson`);
      if (!r.ok) return;
      const j = await r.json(); okCount++;
      (j.features || []).forEach((f, i) => {
        const g = f.geometry; if (!g) return;
        const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        parts.forEach((c, k) => list.push(gsiToEx(f, `gsi-${x}-${y}-${i}-${k}`, c)));
      });
    } catch (e) { /* タイル欠損は無視 */ }
  }));
  if (!okCount) return toast('地理院 道路中心線タイルを取得できませんでした', 'err');
  const res = addExisting(list);
  toast(`道路中心線 ${res.added} 本を取得しました${dupMsg(res)}（国土地理院ベクトルタイル提供実験）`);
}
function renderExisting() {
  gExisting.clearLayers();
  if (!project.existingVisible) return;
  const selId = ui.sel && ui.sel.type === 'existing' ? ui.sel.id : null;
  const wide = project.existingWidth, ppm = wide ? pxPerM() : 0;
  for (const ex of project.existing) {
    const on = ex.id === selId;
    const click = (e) => { if (ui.tool !== 'select') return; L.DomEvent.stopPropagation(e); select({ type: 'existing', id: ex.id, at: [e.latlng.lat, e.latlng.lng] }); };
    if (wide) { // 幅員どおりの帯 + 中心線
      L.polyline(ex.pts, { renderer: exRenderer, pane: 'existing', color: on ? '#0d99ff' : '#0f9d8f', weight: Math.max(3, ex.width * ppm), opacity: on ? 0.45 : 0.3, lineCap: 'butt', lineJoin: 'round' })
        .on('click', click).addTo(gExisting);
      L.polyline(ex.pts, { renderer: exRenderer, pane: 'existing', color: on ? '#0d99ff' : '#0b7a6f', weight: on ? 2 : 1, opacity: 0.9, dashArray: '6 4', interactive: false }).addTo(gExisting);
    } else {
      L.polyline(ex.pts, { renderer: exRenderer, pane: 'existing', color: on ? '#0d99ff' : '#0f9d8f', weight: on ? 6 : 3, opacity: on ? 0.95 : 0.7 })
        .on('click', click).addTo(gExisting);
    }
  }
}
function existingInfo(ex, at) {
  const xy = ex.pts.map((p) => P.toXY(p));
  let len = 0, best = 0, bd = Infinity;
  const q = at ? P.toXY(at) : xy[0];
  for (let i = 1; i < xy.length; i++) {
    const a = xy[i - 1], b = xy[i], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
    len += Math.sqrt(l2);
    const t = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / l2)) : 0;
    const d = Math.hypot(q.x - a.x - vx * t, q.y - a.y - vy * t);
    if (d < bd) { bd = d; best = i; }
  }
  const a = xy[best - 1] || xy[0], b = xy[best] || xy[xy.length - 1];
  return { length: len, bearing: Math.atan2(b.y - a.y, b.x - a.x) };
}

/* ───────── スナップ ───────── */
function snapAt(cp, excludeId) {
  const tol = 12, ll = map.containerPointToLatLng(cp), pad = map.containerPointToLatLng(L.point(cp.x + tol, cp.y - tol));
  const dLat = Math.abs(pad.lat - ll.lat), dLng = Math.abs(pad.lng - ll.lng);
  let best = null;
  if (project.existingVisible) for (const ex of project.existing) {
    const b = ex.bbox;
    if (ll.lat < b[0] - dLat || ll.lat > b[2] + dLat || ll.lng < b[1] - dLng || ll.lng > b[3] + dLng) continue;
    let prev = map.latLngToContainerPoint(ex.pts[0]);
    for (let i = 1; i < ex.pts.length; i++) {
      const cur = map.latLngToContainerPoint(ex.pts[i]), vx = cur.x - prev.x, vy = cur.y - prev.y, l2 = vx * vx + vy * vy;
      let t = l2 ? Math.max(0, Math.min(1, ((cp.x - prev.x) * vx + (cp.y - prev.y) * vy) / l2)) : 0;
      // 道路の端点には吸着させる（延伸接続用）
      if (i === 1 && Math.hypot(cp.x - prev.x, cp.y - prev.y) < tol) t = 0;
      if (i === ex.pts.length - 1 && Math.hypot(cp.x - cur.x, cp.y - cur.y) < tol) t = 1;
      const px = prev.x + vx * t, py = prev.y + vy * t, d = Math.hypot(cp.x - px, cp.y - py);
      if (d < tol && (!best || d < best.d)) best = { d, ex, i, pt: L.point(px, py), isEnd: (i === 1 && t === 0) || (i === ex.pts.length - 1 && t === 1) };
      prev = cur;
    }
  }
  if (best) {
    const ex = best.ex, a = P.toXY(ex.pts[best.i - 1]), b = P.toXY(ex.pts[best.i]);
    return {
      latlng: map.containerPointToLatLng(best.pt),
      ref: { refType: 'existing', refId: ex.id, name: ex.name || ex.clsJa, bearing: Math.atan2(b.y - a.y, b.x - a.x), width: ex.width, speed: ex.speed, speedEst: ex.speedEst, isEnd: best.isEnd },
      label: `${ex.name || ex.clsJa}${best.isEnd ? ' 端点' : ''}・幅員 約${fmt(ex.width, 1)}m`,
    };
  }
  const q = P.toXY(ll), tolM = P.toXY(pad).x - q.x;
  for (const road of project.roads) {
    if (road.id === excludeId || road.visible === false) continue;
    const al = calc(road), pr = Geom.project(al, al.samples, q.x, q.y);
    if (pr && pr.dist < tolM && (!best || pr.dist < best.d)) best = { d: pr.dist, road, pr };
  }
  if (best) {
    const r = best.road, p = best.pr.pose;
    return {
      latlng: P.toLL(p.x, p.y),
      ref: { refType: 'design', refId: r.id, name: r.name, bearing: p.th, width: Rules.carriage(r), speed: r.V, speedEst: false, isEnd: best.pr.s < 0.5 || best.pr.s > al.length - 0.5 },
      label: `${r.name}・${station(best.pr.s)}`,
    };
  }
  return null;
}
const makeConn = (ref, roadDir) => Object.assign({}, ref, { mode: Rules.foldAngle(roadDir - ref.bearing) < 20 ? 'tangent' : 'cross' });
let snapMarker = null;
function showSnap(s) {
  if (snapMarker) { map.removeLayer(snapMarker); snapMarker = null; }
  if (s) snapMarker = L.circleMarker(s.latlng, { radius: 7, color: '#14ae5c', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false, pane: 'labels' })
    .bindTooltip('接続: ' + esc(s.label), { permanent: true, direction: 'top', offset: [0, -8], className: 'snap-tip' }).addTo(map);
}

/* ───────── 描画 ───────── */
function drawRoad(road, g, selected, preview) {
  const al = calc(road), sm = al.samples;
  if (sm.length < 2) return al;
  const hw = Rules.carriage(road) / 2, sh = hw + road.shoulderW, sw = sh + road.sidewalkW;
  const off = (d) => sm.map((p) => P.toLL(p.x - Math.sin(p.th) * d, p.y + Math.cos(p.th) * d));
  const base = { pane: 'design', interactive: false };
  const Ls = off(sh), Rs = off(-sh);
  if (road.sidewalkW > 0) {
    const Lw = off(sw), Rw = off(-sw);
    L.polygon([...Lw, ...Ls.slice().reverse()], { ...base, stroke: false, fillColor: '#b8a48c', fillOpacity: 0.6 }).addTo(g);
    L.polygon([...Rw, ...Rs.slice().reverse()], { ...base, stroke: false, fillColor: '#b8a48c', fillOpacity: 0.6 }).addTo(g);
    L.polyline(Lw, { ...base, color: '#6b5b45', weight: 1 }).addTo(g); L.polyline(Rw, { ...base, color: '#6b5b45', weight: 1 }).addTo(g);
  }
  L.polygon([...Ls, ...Rs.slice().reverse()], { ...base, stroke: false, fillColor: '#3f4a5a', fillOpacity: preview ? 0.3 : 0.55 }).addTo(g);
  L.polyline(Ls, { ...base, color: '#1f2937', weight: 1 }).addTo(g); L.polyline(Rs, { ...base, color: '#1f2937', weight: 1 }).addTo(g);
  if (road.shoulderW > 0) { L.polyline(off(hw), { ...base, color: '#fff', weight: 1, opacity: 0.9 }).addTo(g); L.polyline(off(-hw), { ...base, color: '#fff', weight: 1, opacity: 0.9 }).addTo(g); }
  al.elements.forEach((e, i) => {
    L.polyline(al.byEl[i].map((p) => P.toLL(p.x, p.y)), { ...base, color: e.bad ? '#f24822' : COLORS[e.type], weight: selected || preview ? 3 : 2.5, dashArray: e.bad ? '4 4' : null }).addTo(g);
  });
  if (!preview) {
    L.polyline(sm.map((p) => P.toLL(p.x, p.y)), { pane: 'design', color: '#000', opacity: 0, weight: Math.max(14, Math.min(40, 2 * sw * pxPerM())) })
      .on('click', (e) => { if (ui.tool !== 'select') return; L.DomEvent.stopPropagation(e); select({ type: 'road', id: road.id }); }).addTo(g);
  }
  return al;
}
const pxPerM = () => { const c = map.getCenter(); return 1 / ((156543.03392 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** map.getZoom()); };
function label(ll, text, cls, anchor) {
  return L.marker(ll, { pane: 'labels', interactive: false, icon: L.divIcon({ className: 'pt-label ' + (cls || ''), html: esc(text), iconSize: null, iconAnchor: anchor || [-8, 5] }) });
}
function drawAnnotations(road, al, g) {
  const sw = Rules.totalWidth(road) / 2, z = map.getZoom(), base = { pane: 'design', interactive: false };
  const tick = (p, len) => [P.toLL(p.x - Math.sin(p.th) * len, p.y + Math.cos(p.th) * len), P.toLL(p.x + Math.sin(p.th) * len, p.y - Math.cos(p.th) * len)];
  L.polyline(road.ips.map((p) => P.toLL(p.x, p.y)), { ...base, color: '#0d99ff', weight: 1, dashArray: '5 5', opacity: 0.9 }).addTo(g);
  if (z >= 15) {
    const pitch = z >= 18 ? 20 : z >= 16.5 ? 100 : 500;
    for (let s = 0; s <= al.length; s += 20) {
      const p = Geom.poseAt(al, s), major = Math.round(s) % pitch === 0;
      if (z < 17 && !major) continue;
      L.polyline(tick(p, sw + (major ? 3 : 1.5) / Math.max(pxPerM(), 0.2)), { ...base, color: '#555', weight: 1 }).addTo(g);
      if (major) { const q = tick(p, sw + 4 / Math.max(pxPerM(), 0.2))[1]; label(q, 'No.' + Math.round(s / 20), 'st', [-3, -3]).addTo(g); }
    }
    if (z >= 16.5) for (const pt of al.points) {
      L.polyline(tick(pt, sw + 6 / Math.max(pxPerM(), 0.2)), { ...base, color: '#1e1e1e', weight: 1.5 }).addTo(g);
      label(tick(pt, sw + 8 / Math.max(pxPerM(), 0.2))[0], pt.name, '', [-3, 12]).addTo(g);
    }
  }
}

function renderMap() {
  gRoads.clearLayers(); gPreview.clearLayers(); gMisc.clearLayers();
  for (const road of project.roads) {
    if (road.visible === false) continue;
    const on = ui.sel && ui.sel.type === 'road' && ui.sel.id === road.id;
    const al = drawRoad(road, gRoads, on, false);
    if (on) drawAnnotations(road, al, gRoads);
  }
  if (ui.draw) drawPreview();
  if (ui.measure.length) drawMeasure();
  if (ui.sel && ui.sel.type === 'existing' && ui.sel.at) L.circleMarker(ui.sel.at, { radius: 5, color: '#0d99ff', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(gMisc);
  if (!ui.dragging) renderHandles();
  $('#zoomLabel').textContent = 'z ' + map.getZoom().toFixed(1);
}

/* ハンドル（IP・中点・下絵） */
function renderHandles() {
  gHandles.clearLayers();
  const road = selRoad();
  if (road && road.visible !== false && ui.tool === 'select') {
    const n = road.ips.length, al = calc(road);
    const badIps = new Set(al.issues.map((i) => i.ip));
    road.ips.forEach((ip, i) => {
      const end = i === 0 || i === n - 1, conn = i === 0 ? road.conn.start : i === n - 1 ? road.conn.end : null;
      const cls = 'ip-h' + (end ? ' end' : '') + (ui.sel.ip === i ? ' sel' : '') + (badIps.has(i) ? ' bad' : '') + (conn ? ' conn' : '');
      const m = L.marker(P.toLL(ip.x, ip.y), { draggable: true, icon: L.divIcon({ className: cls, iconSize: [12, 12] }), zIndexOffset: 1000, bubblingMouseEvents: false, title: i === 0 ? 'BP（起点）' : i === n - 1 ? 'EP（終点）' : 'IP' + i });
      m._ip = i;
      m.on('click', () => select({ type: 'road', id: road.id, ip: i }));
      m.on('dragstart', () => { ui.dragging = true; ui.sel = { type: 'road', id: road.id, ip: i }; });
      m.on('drag', (e) => {
        let ll = m.getLatLng(), snap = null;
        if (end && !(e.originalEvent && e.originalEvent.altKey)) { snap = snapAt(map.latLngToContainerPoint(ll), road.id); if (snap) { ll = snap.latlng; m.setLatLng(ll); } }
        showSnap(snap); m._snap = snap;
        const xy = P.toXY(ll); ip.x = xy.x; ip.y = xy.y;
        if (end) {
          const key = i === 0 ? 'start' : 'end', old = road.conn[key];
          const dir = i === 0 ? Math.atan2(road.ips[1].y - ip.y, road.ips[1].x - ip.x) : Math.atan2(ip.y - road.ips[n - 2].y, ip.x - road.ips[n - 2].x);
          road.conn[key] = snap ? (old && old.refId === snap.ref.refId ? Object.assign({}, snap.ref, { mode: old.mode, speed: old.speed }) : makeConn(snap.ref, dir)) : null;
        }
        normalize(road);
        gHandles.eachLayer((h) => { if (h !== m && h._ip != null) h.setLatLng(P.toLL(road.ips[h._ip].x, road.ips[h._ip].y)); else if (h !== m && h._mid != null) h.setLatLng(midLL(road, h._mid)); });
        renderMap(); schedulePanel();
      });
      m.on('dragend', () => { ui.dragging = false; showSnap(null); ui.profiles.delete(road.id); commit(); });
      m.addTo(gHandles);
      if (!end) label(P.toLL(ip.x, ip.y), 'IP' + i, 'ipn', [-9, 16]).addTo(gRoads);
    });
    for (let i = 0; i < n - 1; i++) {
      const m = L.marker(midLL(road, i), { icon: L.divIcon({ className: 'mid-h', iconSize: [8, 8] }), bubblingMouseEvents: false, title: 'クリックで IP を追加' });
      m._mid = i;
      m.on('click', () => {
        const a = road.ips[i], b = road.ips[i + 1];
        road.ips.splice(i + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, R: 0, A1: 0, A2: 0 });
        ui.sel = { type: 'road', id: road.id, ip: i + 1 }; commit();
        toast('IP を追加しました。ドラッグして位置を決めると曲線が入ります');
      });
      m.addTo(gHandles);
    }
  }
  if (ui.sel && ui.sel.type === 'image' && project.image && project.image.visible) {
    const im = project.image, cs = imageCorners();
    const outline = L.polygon(cs, { color: '#7b61ff', weight: 1.5, dashArray: '6 4', fill: false, interactive: false }).addTo(gHandles);
    const mc = L.marker(P.toLL(im.cx, im.cy), { draggable: true, icon: L.divIcon({ className: 'img-h', iconSize: [12, 12] }), title: 'ドラッグで移動', bubblingMouseEvents: false });
    const mr = L.marker(cs[1], { draggable: true, icon: L.divIcon({ className: 'img-h', iconSize: [12, 12] }), title: 'ドラッグで回転・拡縮', bubblingMouseEvents: false });
    const upd = () => { const c = imageCorners(); outline.setLatLngs(c); imageLayer && imageLayer.update(); return c; };
    mc.on('drag', () => { const xy = P.toXY(mc.getLatLng()); im.cx = xy.x; im.cy = xy.y; mr.setLatLng(upd()[1]); schedulePanel(); });
    mr.on('drag', () => {
      const xy = P.toXY(mr.getLatLng()), dx = xy.x - im.cx, dy = xy.y - im.cy;
      im.w = Math.max(1, (2 * Math.hypot(dx, dy)) / Math.sqrt(1 + im.aspect * im.aspect));
      im.rot = deg(Math.atan2(dy, dx) - Math.atan2(im.aspect, 1)); upd(); schedulePanel();
    });
    mc.on('dragend', commit); mr.on('dragend', commit);
    mc.addTo(gHandles); mr.addTo(gHandles);
  }
}
const midLL = (road, i) => P.toLL((road.ips[i].x + road.ips[i + 1].x) / 2, (road.ips[i].y + road.ips[i + 1].y) / 2);

/* ───────── ツール: 道路を描く ───────── */
const HINTS = {
  draw: 'クリックで IP を追加 ・ 既存道路の近くで吸着して接続 ・ <kbd>ダブルクリック</kbd>/<kbd>Enter</kbd> で確定 ・ <kbd>Backspace</kbd> で1点戻す ・ <kbd>Alt</kbd> で吸着オフ ・ <kbd>Esc</kbd> で中止',
  measure: '2点をクリックして距離と方位角を計測 ・ <kbd>Esc</kbd> で終了',
  pick: '下絵上で実距離が分かる 2 点をクリックしてください ・ <kbd>Esc</kbd> で中止',
};
function setTool(t) {
  if (ui.tool === 'draw' && t !== 'draw') ui.draw = null;
  ui.tool = t; ui.measure = []; if (t !== 'pick') ui.pick = null;
  showSnap(null);
  if (t === 'draw') {
    if (!project.origin || (!project.roads.length && !project.image)) { const c = map.getCenter(); project.origin = { lat: c.lat, lng: c.lng }; alCache.clear(); }
    ui.draw = { ips: [], startRef: null, endRef: null, cursor: null }; ui.sel = null;
  }
  $('#map').className = $('#map').className.replace(/\btool-\w+/g, '').trim() + ' tool-' + t;
  const h = $('#hint'); h.hidden = !HINTS[t]; h.innerHTML = HINTS[t] || '';
  renderExisting(); refresh();
}
function previewRoad() {
  const d = ui.draw, ips = d.ips.map((p) => ({ x: p.x, y: p.y, R: 0, A1: 0, A2: 0 }));
  if (d.cursor) ips.push({ x: d.cursor.x, y: d.cursor.y, R: 0, A1: 0, A2: 0 });
  const road = Object.assign({ id: null, ips, conn: { start: null, end: null } }, project.defaults);
  autoCurves(road);
  return road;
}
function drawPreview() {
  const road = previewRoad();
  if (road.ips.length >= 2) {
    const al = drawRoad(road, gPreview, false, true);
    if (ui.draw.cursor) {
      const i = al.dists.length - 1;
      label(P.toLL(ui.draw.cursor.x, ui.draw.cursor.y), `${fmt(al.dists[i], 1)}m ・ 方位角 ${fmt(azimuth(al.dirs[i]), 1)}°`, 'ms', [-14, 30]).addTo(gPreview);
    }
  }
  ui.draw.ips.forEach((p) => L.circleMarker(P.toLL(p.x, p.y), { radius: 4, color: '#0d99ff', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(gPreview));
}
function finishDraw() {
  const d = ui.draw;
  if (!d || d.ips.length < 2) return setTool('select');
  const road = Object.assign({ id: uid(), name: `計画道路 ${project.roads.length + 1}`, visible: true }, project.defaults, {
    ips: d.ips.map((p) => ({ x: p.x, y: p.y, R: 0, A1: 0, A2: 0 })), conn: { start: null, end: null },
  });
  const n = road.ips.length, dir = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
  if (d.startRef) road.conn.start = makeConn(d.startRef, dir(road.ips[0], road.ips[1]));
  if (d.endRef) road.conn.end = makeConn(d.endRef, dir(road.ips[n - 2], road.ips[n - 1]));
  normalize(road); autoCurves(road);
  project.roads.push(road);
  ui.draw = null; ui.tool = 'select'; ui.sel = { type: 'road', id: road.id };
  setTool('select'); commit();
}

/* 計測 */
function drawMeasure() {
  const pts = ui.measure.map((p) => P.toLL(p.x, p.y));
  pts.forEach((ll) => L.circleMarker(ll, { radius: 4, color: '#1e1e1e', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(gMisc));
  if (pts.length === 2) {
    const [a, b] = ui.measure, d = Math.hypot(b.x - a.x, b.y - a.y);
    L.polyline(pts, { color: '#1e1e1e', weight: 1.5, dashArray: '4 4', interactive: false }).addTo(gMisc);
    label(pts[1], `${fmt(d, 2)}m ・ 方位角 ${fmt(azimuth(Math.atan2(b.y - a.y, b.x - a.x)), 1)}°`, 'ms', [-10, 28]).addTo(gMisc);
  }
}

/* ───────── 地図イベント ───────── */
map.on('click', (e) => {
  if (ui.tool === 'draw') {
    const d = ui.draw, snap = e.originalEvent.altKey ? null : snapAt(e.containerPoint);
    const ll = snap ? snap.latlng : e.latlng, xy = P.toXY(ll), lastIp = d.ips[d.ips.length - 1];
    if (lastIp) { const lp = map.latLngToContainerPoint(P.toLL(lastIp.x, lastIp.y)); if (lp.distanceTo(map.latLngToContainerPoint(ll)) < 5) return; }
    d.ips.push(xy);
    if (snap && d.ips.length === 1) d.startRef = snap.ref;
    else if (snap) { d.endRef = snap.ref; d.cursor = null; return finishDraw(); }
    renderMap();
  } else if (ui.tool === 'measure') {
    if (ui.measure.length >= 2) ui.measure = [];
    ui.measure.push(P.toXY(e.latlng)); renderMap();
  } else if (ui.tool === 'pick') {
    ui.pick.push(P.toXY(e.latlng));
    if (ui.pick.length === 2) finishScalePick();
  } else if (ui.sel) select(null);
});
map.on('dblclick', () => { if (ui.tool === 'draw') { ui.draw.cursor = null; finishDraw(); } });
let moveRaf = 0;
map.on('mousemove', (e) => {
  if (moveRaf) return;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    const xy = P.toXY(e.latlng);
    let txt = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
    if (project.origin) txt += ` ・ X ${fmt(xy.x, 1)}  Y ${fmt(xy.y, 1)} m`;
    const road = selRoad();
    if (road && ui.tool === 'select') { const al = calc(road), pr = Geom.project(al, al.samples, xy.x, xy.y); if (pr && pr.dist < 60) txt += ` ・ ${station(pr.s)}（${pr.offset >= 0 ? '左' : '右'} ${fmt(Math.abs(pr.offset), 2)}m）`; }
    $('#status').textContent = txt;
    if (ui.tool === 'draw' && ui.draw) {
      const snap = e.originalEvent.altKey ? null : snapAt(e.containerPoint);
      showSnap(snap);
      ui.draw.cursor = ui.draw.ips.length ? P.toXY(snap ? snap.latlng : e.latlng) : null;
      gPreview.clearLayers(); drawPreview();
    }
  });
});
map.on('zoomend', () => { if (project.existingWidth) renderExisting(); if (!ui.dragging) renderMap(); });
map.on('moveend', () => save());

function select(sel) {
  const exChanged = (ui.sel && ui.sel.type === 'existing') || (sel && sel.type === 'existing');
  ui.sel = sel;
  if (exChanged) renderExisting();
  refresh();
}
let panelRaf = 0;
function schedulePanel() { if (!panelRaf) panelRaf = requestAnimationFrame(() => { panelRaf = 0; renderPanels(); }); }
function refresh() { renderMap(); renderPanels(); }

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : ''); el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4000);
}

/* ───────── 標高（地理院 標高タイル）による現況縦断 ───────── */
const demCache = new Map();
function demTile(kind, z, x, y) {
  const key = `${kind}/${z}/${x}/${y}`;
  if (!demCache.has(key)) demCache.set(key, new Promise((res) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { try { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0); res(g.getImageData(0, 0, 256, 256).data); } catch (e) { res(null); } };
    img.onerror = () => res(null);
    img.src = `https://cyberjapandata.gsi.go.jp/xyz/${kind}/${z}/${x}/${y}.png`;
  }));
  return demCache.get(key);
}
async function elevation(ll) {
  for (const [kind, z] of [['dem5a_png', 15], ['dem_png', 14]]) {
    const n = 2 ** z, r = (ll.lat * Math.PI) / 180;
    const fx = ((ll.lng + 180) / 360) * n, fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
    const data = await demTile(kind, z, Math.floor(fx), Math.floor(fy));
    if (!data) continue;
    const i = (Math.min(255, Math.floor((fy % 1) * 256)) * 256 + Math.min(255, Math.floor((fx % 1) * 256))) * 4;
    const v = data[i] * 65536 + data[i + 1] * 256 + data[i + 2];
    if (v === 8388608 || data[i + 3] === 0) continue;
    return (v < 8388608 ? v : v - 16777216) * 0.01;
  }
  return null;
}
async function loadProfile(road) {
  const al = calc(road); if (al.length < 1) return;
  toast('地理院 標高タイルから現況地盤高を取得中…');
  const step = Math.max(5, al.length / 400), pts = [];
  for (let s = 0; s <= al.length + 1e-6; s += step) { const p = Geom.poseAt(al, Math.min(s, al.length)); pts.push({ s: p.s, h: await elevation(P.toLL(p.x, p.y)) }); }
  const ok = pts.filter((p) => p.h != null);
  if (ok.length < 2) return toast('標高データを取得できませんでした', 'err');
  // 約 20m 区間の平均勾配
  let maxGrade = 0, maxAt = 0;
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
    const ds = ok[j].s - ok[i].s; if (ds < 20) continue;
    const g = (Math.abs(ok[j].h - ok[i].h) / ds) * 100; if (g > maxGrade) { maxGrade = g; maxAt = (ok[i].s + ok[j].s) / 2; } break;
  }
  ui.profiles.set(road.id, { pts: ok, maxGrade, maxAt, length: al.length });
  refresh();
}

/* 下絵の縮尺合わせ */
function finishScalePick() {
  const [a, b] = ui.pick, d = Math.hypot(b.x - a.x, b.y - a.y), im = project.image;
  ui.pick = null;
  const v = prompt(`選択した 2 点間の実際の距離 [m] を入力してください\n（現在の配置での距離: ${fmt(d, 2)} m）`);
  const real = parseFloat(v);
  if (im && real > 0 && d > 0) { const f = real / d; im.w *= f; im.cx = a.x + (im.cx - a.x) * f; im.cy = a.y + (im.cy - a.y) * f; syncImageLayer(); ui.sel = { type: 'image' }; setTool('select'); commit(); toast(`下絵を ${fmt(f, 4)} 倍に拡縮しました`); }
  else setTool('select');
}
