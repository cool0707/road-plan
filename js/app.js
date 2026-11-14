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
    base: 'gsi-pale', baseOpacity: 1, existingVisible: true, existingWidth: false, healTol: 8, view: null, googleKey: '', traffic: null, study: null,
    defaults: { cls: '3-3', V: 40, lanes: 2, laneW: 3.0, shoulderW: 0.75, sidewalkW: 0, shitei: false, snow: '', bike: false },
  };
}
function loadProject() {
  try { const p = JSON.parse(localStorage.getItem(LS_KEY)); if (p && p.version === 1) return Object.assign(newProject(), p); } catch (e) { /* 壊れた保存データは無視 */ }
  return null;
}
let project = loadProject() || newProject();
const ui = { tool: 'select', sel: null, tab: 'design', draw: null, measure: [], pick: null, link: null, dragging: false, imageUrl: null, profiles: new Map(), snap: null, vdock: false, vdrag: null };

function save() {
  const c = map.getCenter();
  project.view = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
  try { localStorage.setItem(LS_KEY, JSON.stringify(project)); }
  catch (e) {
    // 容量超過: 取り直せるデータ（既存道路 → センサスの区間）から順に保存をあきらめる
    const tr = project.traffic && Object.assign({}, project.traffic, { obs: project.traffic.obs.filter((o) => o.src !== 'census') });
    try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign({}, project, { existing: [] }))); }
    catch (e2) { try { localStorage.setItem(LS_KEY, JSON.stringify(Object.assign({}, project, { existing: [], traffic: tr }))); } catch (e3) { /* 容量超過 */ } }
  }
}

/* undo / redo: 計画道路・下絵配置・既存道路・交通量データのスナップショット
 * 既存道路と交通量の観測データは件数が多いので配列の参照だけを持つ（要素は書き換えず、変更時は常に新しい配列・新しい要素を作る） */
const hist = { undo: [], redo: [], last: null };
const snapshot = () => ({ s: JSON.stringify({ roads: project.roads, image: project.image, tedits: project.traffic ? project.traffic.edits : null }), ex: project.existing, tobs: project.traffic ? project.traffic.obs : null });
function commit() {
  hist.undo.push(hist.last); if (hist.undo.length > 100) hist.undo.shift();
  hist.redo = []; hist.last = snapshot();
  save(); refresh();
  if (typeof V3D !== 'undefined') V3D.changed();
}
function restore(h) {
  const o = JSON.parse(h.s); project.roads = o.roads; project.image = o.image;
  if (project.traffic) { project.traffic.obs = h.tobs || []; project.traffic.edits = o.tedits || {}; }
  if (project.existing !== h.ex) {
    project.existing = h.ex;
    if (ui.sel && ui.sel.type === 'existing' && !project.existing.some((e) => e.id === ui.sel.id)) ui.sel = null;
    renderExisting();
  }
  if (ui.sel && ui.sel.type === 'road' && !roadById(ui.sel.id)) ui.sel = null;
  if (ui.sel && ui.sel.type === 'road' && ui.sel.ip != null && ui.sel.ip >= roadById(ui.sel.id).ips.length) ui.sel.ip = null;
  ui.profiles.clear(); save(); syncImageLayer(); refresh();
  if (typeof V3D !== 'undefined') V3D.changed();
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
[['image', 250], ['exband', 340], ['existing', 350], ['design', 420], ['labels', 450]].forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
map.getPane('labels').style.pointerEvents = 'none';
map.getPane('exband').style.pointerEvents = 'none';
const exRenderer = L.canvas({ pane: 'existing', tolerance: 8 });
const exBandRenderer = L.canvas({ pane: 'exband' }); // WebGL が使えないときの帯の描画先
const gExisting = L.layerGroup().addTo(map), gRoads = L.layerGroup().addTo(map), gPreview = L.layerGroup().addTo(map),
  gHandles = L.layerGroup().addTo(map), gHover = L.layerGroup().addTo(map), gMisc = L.layerGroup().addTo(map);

const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
const BASES = {
  'gsi-vector': { name: '地理院ベクトル（Google 風）', vector: true },
  'gsi-pale': { name: '地理院地図（淡色）', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', maxNativeZoom: 18, attr: GSI_ATTR },
  'gsi-std': { name: '地理院地図（標準）', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', maxNativeZoom: 18, attr: GSI_ATTR },
  'gsi-photo': { name: '地理院 航空写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxNativeZoom: 18, attr: GSI_ATTR },
  osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNativeZoom: 19, attr: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' },
  'google-road': { name: 'Google マップ', google: 'roadmap' },
  'google-sat': { name: 'Google 航空写真', google: 'satellite' },
  none: { name: 'なし（白地）' },
};
let baseLayer = null;
const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src + ' を読み込めません')); document.head.appendChild(s); });
let mapLibreReady = null;
function loadMapLibre() { // ベクトル背景を選んだときだけ MapLibre GL を読み込む
  if (!mapLibreReady) {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/maplibre/maplibre-gl.css'; document.head.appendChild(css);
    mapLibreReady = loadScript('vendor/maplibre/maplibre-gl.js').then(() => loadScript('vendor/maplibre/leaflet-maplibre-gl.js')).then(() => loadScript('js/vectorstyle.js'))
      .catch((e) => { mapLibreReady = null; throw e; });
  }
  return mapLibreReady;
}
async function vectorBaseLayer() {
  await loadMapLibre();
  const cv = document.createElement('canvas');
  if (!cv.getContext('webgl2') && !cv.getContext('webgl')) throw new Error('このブラウザは WebGL に対応していません');
  const layer = L.maplibreGL({
    style: gsiGoogleStyle(), localIdeographFontFamily: '"Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans JP", sans-serif',
    printUrl: BASES['gsi-pale'].url, maxNativeZoom: 18, // PDF の背景はラスタ（淡色）で代用
  });
  layer.setOpacity = function (o) { if (this._container) this._container.style.opacity = o; this._opacity = o; return this; };
  layer.on('add', function () { this.setOpacity(this._opacity ?? 1); });
  return layer;
}
async function setBase(key) {
  const b = BASES[key] || BASES['gsi-pale'];
  let url = b.url, attr = b.attr, maxNative = b.maxNativeZoom;
  if (b.vector) {
    let layer;
    try { layer = await vectorBaseLayer(); } catch (e) { toast('ベクトル地図を表示できません: ' + e.message, 'err'); return false; }
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = layer.setOpacity(project.baseOpacity).addTo(map);
    project.base = key;
    return true;
  }
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
const checksOf = (road) => Rules.check(road, calc(road), { profile: ui.profiles.get(road.id), vplan: vplanOf(road) });

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
    lanes, speed: ms || CLS_SPEED[t.highway] || 40, speedEst: !ms, oneway: t.oneway === 'yes' || t.junction === 'roundabout', surface: t.surface || '', pts, bbox: bboxOf(pts),
    sep: !!((t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no') || (t.layer && t.layer !== '0')) || undefined, // 高架・トンネル（計画道路と平面交差しない）
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
  commitEx();
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
  if (n) commitEx();
  toast(n ? `重複していた既存道路 ${n} 本を除去しました` : '重複している既存道路はありません');
}
function commitEx() { renderExisting(); commit(); }
function deleteExisting(id) {
  project.existing = project.existing.filter((e) => e.id !== id);
  if (ui.sel && ui.sel.type === 'existing' && ui.sel.id === id) ui.sel = null;
  commitEx();
}
function clearExisting() {
  if (!project.existing.length) return;
  project.existing = [];
  if (ui.sel && ui.sel.type === 'existing') ui.sel = null;
  commitEx();
}
/* 既存道路の区間: 交差点（他の既存道路との交差・接続）と屈曲点で区切る */
function existingBreaks(ex) {
  const xy = ex.pts.map((p) => P.toXY(p)), b = ex.bbox, pad = 0.0001;
  const others = project.existing.filter((o) => o !== ex && !(o.bbox[0] > b[2] + pad || o.bbox[2] < b[0] - pad || o.bbox[1] > b[3] + pad || o.bbox[3] < b[1] - pad))
    .map((o) => o.pts.map((p) => P.toXY(p)));
  return { xy, breaks: Geom.polyBreaks(xy, others) };
}
function existingPiece(ex, at) {
  const { xy, breaks } = existingBreaks(ex), u = Geom.polyNearest(xy, P.toXY(at)), pc = Geom.pieceAt(breaks, u);
  return { piece: pc, whole: pc[0] === 0 && pc[1] === ex.pts.length - 1, len: Geom.polyLenTo(xy, pc[1]) - Geom.polyLenTo(xy, pc[0]), total: Geom.polyLen(xy) };
}
/* 選択中の区間だけを削除し、残りを前後の別々の既存道路として残す */
function deleteExistingPiece() {
  const sel = ui.sel, ex = sel && sel.type === 'existing' && project.existing.find((e) => e.id === sel.id);
  if (!ex) return;
  const pc = sel.piece || [0, ex.pts.length - 1];
  if (pc[0] === 0 && pc[1] === ex.pts.length - 1) return deleteExisting(ex.id);
  const base = ex.id.replace(/~\w+$/, ''), parts = [];
  [[0, pc[0]], [pc[1], ex.pts.length - 1]].forEach(([u0, u1]) => {
    const pts = Geom.polySlice(ex.pts, u0, u1);
    if (pts.length < 2 || Geom.polyLen(pts.map((p) => P.toXY(p))) < 0.5) return;
    parts.push(Object.assign({}, ex, { id: `${base}~${uid()}`, pts, bbox: bboxOf(pts) }));
  });
  const i = project.existing.indexOf(ex);
  project.existing = [...project.existing.slice(0, i), ...parts, ...project.existing.slice(i + 1)];
  ui.sel = null;
  commitEx();
}
/* 途切れの修復: どこにもつながっていない端点を、tol m 以内の他の道路（端点・延長線との交点・前方の最近点）へ延ばす */
const llArr = (xy) => { const ll = P.toLL(xy.x, xy.y); return [ll.lat, ll.lng]; };
function healExisting(tol) {
  if (!project.existing.length) return;
  const xys = project.existing.map((e) => e.pts.map((p) => P.toXY(p)));
  const ops = Geom.healGaps(xys, { tol });
  const n = ops.filter((o) => !o.insert).length;
  if (!n) return toast(`${fmt(tol, 0)}m 以内に途切れている既存道路はありません`);
  const pts = Geom.applyHeal(project.existing.map((e) => e.pts), ops, llArr);
  project.existing = project.existing.map((e, i) => (pts[i] === e.pts ? e : Object.assign({}, e, { pts: pts[i], bbox: bboxOf(pts[i]) })));
  commitEx();
  toast(`途切れていた既存道路 ${n} か所をつなぎました（Ctrl+Z で元に戻せます）`);
}
/* 既存道路 ex の線分 si の位置 w に頂点を挿入した新しい要素（頂点上なら挿入しない） */
function exInsert(ex, si, w, ll) {
  if (w <= 1e-6 || w >= 1 - 1e-6) return ex;
  const pts = ex.pts.slice(); pts.splice(si + 1, 0, ll);
  return Object.assign({}, ex, { pts, bbox: bboxOf(pts) });
}
const dupMsg = (r) => (r.skipped ? `（重複 ${r.skipped} 本は除外）` : '');
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function fetchOSM() {
  if (map.getZoom() < 14) return toast('表示範囲が広すぎます。ズーム 14 以上に拡大してください', 'err');
  const b = map.getBounds();
  const q = `[out:json][timeout:25];way["highway"]["highway"!~"^(footway|path|steps|cycleway|pedestrian|construction|proposed|corridor|platform|elevator|bridleway|bus_guideway|raceway|rest_area|services)$"]["area"!="yes"](${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()});out tags geom;`;
  let last;
  const res = await busy('OpenStreetMap から既存道路を取得中…', async () => {
    for (const url of OVERPASS) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        return addExisting(j.elements.filter((e) => e.type === 'way' && e.geometry).map(osmToEx));
      } catch (e) { last = e; }
    }
    return null;
  });
  if (res) toast(`既存道路 ${res.added} 本を取得しました${dupMsg(res)}（© OpenStreetMap contributors）`);
  else toast('既存道路の取得に失敗しました: ' + (last && last.message), 'err');
}
async function fetchGSI() {
  if (map.getZoom() < 15) return toast('表示範囲が広すぎます。ズーム 15 以上に拡大してください', 'err');
  const b = map.getBounds(), z = 16, n = 2 ** z;
  const tx = (lng) => Math.floor(((lng + 180) / 360) * n);
  const ty = (lat) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
  const jobs = [];
  for (let x = tx(b.getWest()); x <= tx(b.getEast()); x++) for (let y = ty(b.getNorth()); y <= ty(b.getSouth()); y++) jobs.push([x, y]);
  if (jobs.length > 40) return toast('表示範囲が広すぎます。もう少し拡大してください', 'err');
  const list = [];
  let okCount = 0;
  const res = await busy('国土地理院 道路中心線を取得中…', async () => {
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
    return okCount ? addExisting(list) : null;
  });
  if (!res) return toast('地理院 道路中心線タイルを取得できませんでした', 'err');
  toast(`道路中心線 ${res.added} 本を取得しました${dupMsg(res)}（国土地理院ベクトルタイル提供実験）`);
}
/* 既存道路の描画
 * ・帯（幅員/中心線）は不透明色で 1 枚に描き、ペイン全体に透明度をかける → 重なり部分が濃くならない
 * ・表示は MapLibre GL（WebGL）: 座標を整数ピクセルに丸めず・間引かずにアンチエイリアス描画するので滑らか
 *   WebGL が使えないときは Leaflet canvas（間引きなし）で代用
 * ・クリック判定は Leaflet の透明な線で行う */
const EX_C = { band: '#0f9d8f', center: '#0b7a6f', sel: '#0d99ff' };
const exGL = { state: 'none', band: null, line: null, data: null, wide: null, lat: null, selFid: null, ids: new Map() };
function exGLInit() {
  if (exGL.state !== 'none') return;
  exGL.state = 'loading';
  const empty = { type: 'FeatureCollection', features: [] };
  const style = (layers) => ({ version: 8, sources: { ex: { type: 'geojson', data: empty }, sel: { type: 'geojson', data: empty } }, layers });
  const round = { 'line-cap': 'round', 'line-join': 'round' }, isSel = ['boolean', ['feature-state', 'sel'], false];
  loadMapLibre().then(() => {
    const cv = document.createElement('canvas');
    if (!cv.getContext('webgl2') && !cv.getContext('webgl')) throw new Error('WebGL 非対応');
    const make = (pane, layers) => new Promise((res, rej) => {
      const lyr = L.maplibreGL({ pane, interactive: false, attributionControl: false, style: style(layers) }).addTo(map);
      lyr.getContainer().style.pointerEvents = 'none';
      const gl = lyr.getMaplibreMap();
      gl.once('load', () => res(gl)); gl.once('error', (e) => rej(e.error || e));
    });
    return Promise.all([
      make('exband', [{ id: 'band', type: 'line', source: 'ex', layout: round, paint: { 'line-color': ['case', isSel, EX_C.sel, EX_C.band], 'line-width': 3 } }]),
      make('existing', [
        { id: 'center', type: 'line', source: 'ex', paint: { 'line-color': ['case', isSel, EX_C.sel, EX_C.center], 'line-width': ['case', isSel, 2, 1], 'line-opacity': 0.9, 'line-dasharray': [6, 4] } },
        { id: 'sel', type: 'line', source: 'sel', layout: round, paint: { 'line-color': EX_C.sel } },
      ]),
    ]);
  }).then(([band, line]) => { Object.assign(exGL, { state: 'ready', band, line }); renderExisting(); })
    .catch(() => { exGL.state = 'failed'; renderExisting(); });
}
/* 幅員 [m] → 線幅 [px]（MapLibre のズーム = Leaflet のズーム - 1、512px タイル基準） */
function exWidthExpr(lat, minPx, prop = ['get', 'w']) {
  const k = 512 / (40075016.686 * Math.cos((lat * Math.PI) / 180)), stops = [];
  for (let z = 6; z <= 23; z++) stops.push(z, ['max', minPx, ['*', prop, k * 2 ** z]]);
  return ['interpolate', ['exponential', 2], ['zoom'], ...stops];
}
function renderExistingGL(sel, wide) {
  const { band, line } = exGL, list = project.existingVisible ? project.existing : [];
  if (exGL.data !== list) {
    exGL.data = list; exGL.ids = new Map(); exGL.selFid = null;
    band.removeFeatureState({ source: 'ex' }); line.removeFeatureState({ source: 'ex' });
    const fc = { type: 'FeatureCollection', features: list.map((ex, i) => {
      exGL.ids.set(ex.id, i + 1);
      return { type: 'Feature', id: i + 1, properties: { w: ex.width }, geometry: { type: 'LineString', coordinates: ex.pts.map((p) => [p[1], p[0]]) } };
    }) };
    band.getSource('ex').setData(fc); line.getSource('ex').setData(fc);
  }
  const lat = Math.round(map.getCenter().lat * 10) / 10;
  if (exGL.wide !== wide || exGL.lat !== lat) {
    exGL.wide = wide; exGL.lat = lat;
    band.setPaintProperty('band', 'line-width', wide ? exWidthExpr(lat, 3) : 3);
    line.setLayoutProperty('center', 'visibility', wide ? 'visible' : 'none');
    line.setPaintProperty('sel', 'line-width', wide ? exWidthExpr(lat, 6) : ['case', ['get', 'piece'], 7, 6]);
    line.setPaintProperty('sel', 'line-opacity', wide ? ['case', ['get', 'piece'], 0.55, 0.3] : 0.95);
  }
  const fid = sel ? exGL.ids.get(sel.ex.id) : null;
  if (exGL.selFid !== fid) {
    for (const gl of [band, line]) {
      if (exGL.selFid != null) gl.setFeatureState({ source: 'ex', id: exGL.selFid }, { sel: false });
      if (fid != null) gl.setFeatureState({ source: 'ex', id: fid }, { sel: true });
    }
    exGL.selFid = fid;
  }
  line.getSource('sel').setData({ type: 'FeatureCollection', features: sel ? [{ type: 'Feature', properties: { w: sel.ex.width, piece: !!sel.pts },
    geometry: { type: 'LineString', coordinates: (sel.pts || sel.ex.pts).map((p) => [p[1], p[0]]) } }] : [] });
}
function renderExisting() {
  gExisting.clearLayers();
  const wide = project.existingWidth, ppm = wide ? pxPerM() : 0;
  map.getPane('exband').style.opacity = wide ? 0.35 : 0.75;
  if (project.existing.length && exGL.state === 'none') exGLInit();
  const useGL = exGL.state === 'ready';
  const selEx = project.existingVisible && ui.sel && ui.sel.type === 'existing' ? project.existing.find((e) => e.id === ui.sel.id) : null;
  const sel = selEx ? { ex: selEx, pts: ui.sel.piece && !ui.sel.whole ? Geom.polySlice(selEx.pts, ui.sel.piece[0], ui.sel.piece[1]) : null } : null;
  if (useGL) renderExistingGL(sel, wide);
  if (!project.existingVisible) return;
  const pl = (pts, o) => L.polyline(pts, Object.assign({ smoothFactor: 0, interactive: false, lineCap: 'round', lineJoin: 'round' }, o)).addTo(gExisting);
  const bandW = (ex, min) => (wide ? Math.max(min, ex.width * ppm) : min);
  for (const ex of project.existing) {
    const on = sel && sel.ex === ex;
    // クリック判定用（透明）
    pl(ex.pts, { renderer: exRenderer, pane: 'existing', opacity: 0, weight: Math.max(8, bandW(ex, 3)), interactive: true })
      .on('click', (e) => {
        if (ui.tool !== 'select') return; L.DomEvent.stopPropagation(e);
        const at = [e.latlng.lat, e.latlng.lng];
        select(Object.assign({ type: 'existing', id: ex.id, at }, existingPiece(ex, at)));
      });
    if (useGL) continue;
    pl(ex.pts, { renderer: exBandRenderer, pane: 'exband', color: on ? EX_C.sel : EX_C.band, weight: bandW(ex, 3), opacity: 1 });
    if (wide) pl(ex.pts, { renderer: exRenderer, pane: 'existing', color: on ? EX_C.sel : EX_C.center, weight: on ? 2 : 1, opacity: 0.9, dashArray: '6 4', lineCap: 'butt' });
  }
  if (sel && !useGL) {
    const piece = !!sel.pts;
    pl(sel.pts || sel.ex.pts, { renderer: exRenderer, pane: 'existing', color: EX_C.sel, weight: wide ? bandW(sel.ex, 6) : piece ? 7 : 6, opacity: wide ? (piece ? 0.55 : 0.3) : 0.95 });
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
/* 画面上の点 cp に最も近い既存道路上の点（tol px 以内）。端点には優先して吸着する */
function exSnapAt(cp, excludeId, tol = 12) {
  const ll = map.containerPointToLatLng(cp), pad = map.containerPointToLatLng(L.point(cp.x + tol, cp.y - tol));
  const dLat = Math.abs(pad.lat - ll.lat), dLng = Math.abs(pad.lng - ll.lng);
  let best = null;
  if (project.existingVisible) for (const ex of project.existing) {
    if (ex.id === excludeId) continue;
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
      const end = i === 1 && t === 0 ? 0 : i === ex.pts.length - 1 && t === 1 ? 1 : null;
      if (d < tol && (!best || d < best.d || (end != null && best.end == null && d < best.d + 4))) best = { d, ex, i, t, pt: L.point(px, py), isEnd: end != null, end };
      prev = cur;
    }
  }
  if (!best) return null;
  // 線分上の点を線分の座標から補間（頂点上は頂点の座標そのもの。丸め誤差で接続が切れないように）
  const a = best.ex.pts[best.i - 1], b = best.ex.pts[best.i], at = L.latLng(a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t);
  return Object.assign(best, { latlng: at, si: best.i - 1 });
}
function snapAt(cp, excludeId) {
  const tol = 12, ll = map.containerPointToLatLng(cp), pad = map.containerPointToLatLng(L.point(cp.x + tol, cp.y - tol));
  let best = exSnapAt(cp, null, tol);
  if (best) {
    const ex = best.ex, a = P.toXY(ex.pts[best.i - 1]), b = P.toXY(ex.pts[best.i]);
    return {
      latlng: best.latlng,
      ref: { refType: 'existing', refId: ex.id, name: ex.name || ex.clsJa, bearing: Math.atan2(b.y - a.y, b.x - a.x), width: ex.width, speed: ex.speed, speedEst: ex.speedEst, isEnd: best.isEnd },
      label: `${ex.name || ex.clsJa}${best.isEnd ? ' 端点' : ''}・幅員 約${fmt(ex.width, 1)}m`,
    };
  }
  best = null;
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
      ref: { refType: 'design', refId: r.id, name: r.name, bearing: p.th, width: Rules.carriage(r), speed: r.V, speedEst: false, isEnd: best.pr.s < 0.5 || best.pr.s > calc(r).length - 0.5 },
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
  if (al.length > 0) { // 幅員・車線数の吹き出し（道路中央・左側）
    const lg = al.elements.reduce((m, e) => (e.L > m.L ? e : m), al.elements[0]), p = Geom.poseAt(al, lg ? lg.s0 + lg.L / 2 : al.length / 2), q = tick(p, sw + 14 / Math.max(pxPerM(), 0.2))[0];
    label(q, `${road.lanes}車線 ・ 全幅 ${fmt(Rules.totalWidth(road), 2)}m`, 'wd', [0, 10]).addTo(g);
  }
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
  if (ui.link) drawLinkPreview();
  if (typeof xsecRender === 'function') xsecRender();
  if (ui.sel && ui.sel.type === 'existing' && ui.sel.at) L.circleMarker(ui.sel.at, { radius: 5, color: '#0d99ff', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(gMisc);
  if (!ui.dragging) renderHandles();
  $('#zoomLabel').textContent = 'z ' + map.getZoom().toFixed(1);
  if (typeof TrafficUI !== 'undefined') TrafficUI.render();
  if (typeof StudyUI !== 'undefined') StudyUI.render();
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
  if (ui.sel && ui.sel.type === 'existing' && ui.tool === 'select') renderExEnds();
  if (typeof xsecHandles === 'function') xsecHandles();
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
  xsec: '断面を見たい所をクリックして線を引く（折れ線可）・ <kbd>ダブルクリック</kbd>/<kbd>Enter</kbd> で確定 ・ <kbd>Backspace</kbd> で1点戻す ・ <kbd>Esc</kbd> で終了',
  exlink: '途切れた道路の端点（または道路上）をクリック → 経由点 → つなぐ先の道路をクリックで確定 ・ <kbd>Enter</kbd> で行き止まりのまま確定 ・ <kbd>Alt</kbd> で吸着オフ ・ <kbd>Esc</kbd> で終了',
  tobs: '交通量を観測した地点の道路をクリックしてください（下の表に方向別の台数を入力します） ・ <kbd>Esc</kbd> で終了',
};
function setTool(t) {
  if (ui.tool === 'draw' && t !== 'draw') ui.draw = null;
  ui.tool = t; ui.measure = []; if (t !== 'pick') ui.pick = null;
  if (typeof xsecStart === 'function') { if (t === 'xsec') xsecStart(); else xsecStop(); }
  ui.link = t === 'exlink' ? { pts: [], start: null, cursor: null } : null;
  if (t === 'exlink' && !project.existingVisible) { project.existingVisible = true; save(); }
  showSnap(null);
  if (t === 'draw') {
    if (!project.origin || (!project.roads.length && !project.image)) { const c = map.getCenter(); project.origin = { lat: c.lat, lng: c.lng }; alCache.clear(); }
    ui.draw = { ips: [], startRef: null, endRef: null, cursor: null }; ui.sel = null;
  }
  $('#map').className = $('#map').className.replace(/\btool-\w+/g, '').trim() + ' tool-' + t;
  updateHint();
  renderExisting(); refresh();
}
function updateHint() {
  const t = ui.tool, h = $('#hint'), d = project.defaults;
  h.hidden = !HINTS[t];
  h.innerHTML = (HINTS[t] || '') + (t === 'draw' ? `<div class="hint-sub">幅員: <b>${d.lanes}車線・全幅 ${fmt(Rules.totalWidth(d), 2)}m</b>（右パネルで変更できます）</div>` : '');
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
  toast(`${road.name} を作成（${road.lanes}車線・全幅 ${fmt(Rules.totalWidth(road), 2)}m）。幅員・車線数は右パネルの一番上で変更できます`);
}

/* ───────── ツール: 既存道路をつなぐ・描き足す ───────── */
const exSnapLabel = (sn) => `${sn.ex.name || sn.ex.clsJa}${sn.isEnd ? ' 端点' : ''}`;
function drawLinkPreview() {
  const k = ui.link, pts = k.pts.slice();
  if (k.cursor && pts.length) pts.push(k.cursor);
  if (pts.length >= 2) L.polyline(pts, { pane: 'design', color: EX_C.sel, weight: 3, dashArray: '6 5', interactive: false }).addTo(gPreview);
  k.pts.forEach((p) => L.circleMarker(p, { pane: 'design', radius: 4, color: EX_C.sel, weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(gPreview));
}
/* 既存道路 ex の、点 ll に最も近い線分上に頂点を入れる（T 字の接続点。頂点の近く 0.3m 以内なら入れない） */
function exInsertNear(ex, ll) {
  const xy = ex.pts.map((p) => P.toXY(p)), q = P.toXY(ll), u = Geom.polyNearest(xy, q);
  const si = Math.min(Math.floor(u), xy.length - 2), w = u - si, segL = Math.hypot(xy[si + 1].x - xy[si].x, xy[si + 1].y - xy[si].y);
  if (w * segL < 0.3 || (1 - w) * segL < 0.3) return ex;
  return exInsert(ex, si, w, ll);
}
function finishLink(endSnap) {
  const k = ui.link;
  if (!k || k.pts.length < 2) { if (k) Object.assign(k, { pts: [], start: null, cursor: null }); return renderMap(); }
  const path = k.pts.map((p) => [p[0], p[1]]), start = k.start;
  const upd = new Map(), get = (id) => upd.get(id) || project.existing.find((e) => e.id === id);
  // 道路の途中につないだ所には頂点を入れておく（交差点として区切れるように）
  for (const sn of [start, endSnap]) if (sn && !sn.isEnd) { const e = get(sn.ex.id); if (e) upd.set(e.id, exInsertNear(e, sn.latlng)); }
  let result, msg;
  if (start && start.isEnd) { // 端点から延ばす
    const e = get(start.ex.id), pts = start.end ? e.pts.concat(path.slice(1)) : path.slice(1).reverse().concat(e.pts);
    result = Object.assign({}, e, { pts, bbox: bboxOf(pts) }); msg = `「${e.name || e.clsJa}」を延ばしてつなぎました`;
  } else if (endSnap && endSnap.isEnd) {
    const e = get(endSnap.ex.id), rev = path.slice(0, -1);
    const pts = endSnap.end ? e.pts.concat(rev.reverse()) : rev.concat(e.pts);
    result = Object.assign({}, e, { pts, bbox: bboxOf(pts) }); msg = `「${e.name || e.clsJa}」を延ばしてつなぎました`;
  } else {
    const src = (start && start.ex) || (endSnap && endSnap.ex);
    const base = src ? Object.assign({}, src) : { name: '', cls: 'residential', clsJa: CLS_JA.residential, width: CLS_WIDTH.residential, lanes: null, speed: CLS_SPEED.residential, speedEst: true, oneway: false, surface: '' };
    result = Object.assign(base, { id: 'man-' + uid(), src: '手動', widthNote: src ? `つないだ道路（${src.src}）から` : '道路種別から推定', pts: path, bbox: bboxOf(path) });
    msg = '既存道路を描き足しました';
  }
  upd.set(result.id, result);
  const known = new Set(project.existing.map((e) => e.id));
  project.existing = project.existing.map((e) => upd.get(e.id) || e).concat(known.has(result.id) ? [] : [result]);
  Object.assign(k, { pts: [], start: null, cursor: null });
  showSnap(null); commitEx();
  toast(msg + '（続けてつなげます。Esc で終了）');
}
function linkClick(e) {
  const k = ui.link, sn = e.originalEvent.altKey ? null : exSnapAt(e.containerPoint);
  const ll = sn ? sn.latlng : e.latlng, p = [ll.lat, ll.lng], last = k.pts[k.pts.length - 1];
  if (last && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) < 5) return;
  k.pts.push(p);
  if (k.pts.length === 1) k.start = sn;
  else if (sn) { k.cursor = null; return finishLink(sn); }
  renderMap();
}
/* 選択中の既存道路の端点ハンドル: ドラッグして他の道路に吸着させる */
function renderExEnds() {
  const ex = project.existing.find((e) => e.id === ui.sel.id);
  if (!ex || !project.existingVisible) return;
  const n = ex.pts.length;
  [0, 1].forEach((end) => {
    const idx = end ? n - 1 : 0, nb = ex.pts[end ? n - 2 : 1];
    const m = L.marker(ex.pts[idx], { draggable: true, icon: L.divIcon({ className: 'ip-h end ex-end', iconSize: [12, 12] }), zIndexOffset: 1000, bubblingMouseEvents: false, title: (end ? '終点' : '始点') + '（ドラッグして他の道路につなぐ）' });
    const ghost = L.polyline([nb, ex.pts[idx]], { pane: 'design', color: EX_C.sel, weight: 3, dashArray: '6 5', interactive: false });
    m.on('dragstart', () => { ui.dragging = true; ghost.addTo(gHandles); });
    m.on('drag', (ev) => {
      let ll = m.getLatLng(), sn = null;
      if (!(ev.originalEvent && ev.originalEvent.altKey)) { sn = exSnapAt(map.latLngToContainerPoint(ll), ex.id); if (sn) { ll = sn.latlng; m.setLatLng(ll); } }
      m._snap = sn; ghost.setLatLngs([nb, ll]);
      showSnap(sn && { latlng: sn.latlng, label: exSnapLabel(sn) });
    });
    m.on('dragend', () => {
      ui.dragging = false; showSnap(null);
      const ll = m.getLatLng(), sn = m._snap, pts = ex.pts.slice();
      pts[idx] = [ll.lat, ll.lng];
      const moved = Object.assign({}, ex, { pts, bbox: bboxOf(pts) }), upd = new Map([[ex.id, moved]]);
      if (sn && !sn.isEnd) upd.set(sn.ex.id, exInsertNear(sn.ex, sn.latlng));
      project.existing = project.existing.map((e) => upd.get(e.id) || e);
      const at = ui.sel.at || pts[idx];
      ui.sel = Object.assign({ type: 'existing', id: ex.id, at }, existingPiece(moved, at));
      commitEx();
    });
    m.addTo(gHandles);
  });
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
  if (typeof TrafficUI !== 'undefined' && TrafficUI.mapClick(e)) return;
  if (ui.tool === 'draw') {
    const d = ui.draw, snap = e.originalEvent.altKey ? null : snapAt(e.containerPoint);
    const ll = snap ? snap.latlng : e.latlng, xy = P.toXY(ll), lastIp = d.ips[d.ips.length - 1];
    if (lastIp) { const lp = map.latLngToContainerPoint(P.toLL(lastIp.x, lastIp.y)); if (lp.distanceTo(map.latLngToContainerPoint(ll)) < 5) return; }
    d.ips.push(xy);
    if (snap && d.ips.length === 1) d.startRef = snap.ref;
    else if (snap) { d.endRef = snap.ref; d.cursor = null; return finishDraw(); }
    renderMap();
  } else if (ui.tool === 'exlink') {
    linkClick(e);
  } else if (ui.tool === 'xsec') {
    xsecClick(e);
  } else if (ui.tool === 'measure') {
    if (ui.measure.length >= 2) ui.measure = [];
    ui.measure.push(P.toXY(e.latlng)); renderMap();
  } else if (ui.tool === 'pick') {
    ui.pick.push(P.toXY(e.latlng));
    if (ui.pick.length === 2) finishScalePick();
  } else if (ui.sel) select(null);
});
map.on('dblclick', () => { if (ui.tool === 'draw') { ui.draw.cursor = null; finishDraw(); } else if (ui.tool === 'exlink') { ui.link.cursor = null; finishLink(null); } else if (ui.tool === 'xsec') xsecFinish(); });
let moveRaf = 0;
map.on('mousemove', (e) => {
  if (moveRaf) return;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = 0;
    const xy = P.toXY(e.latlng);
    let txt = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
    if (project.origin) txt += ` ・ X ${fmt(xy.x, 1)}  Y ${fmt(xy.y, 1)} m`;
    const road = selRoad();
    if (road && ui.tool === 'select') { const al = calc(road), pr = Geom.project(al, al.samples, xy.x, xy.y); if (pr && pr.dist < 60) {
      txt += ` ・ ${station(pr.s)}（${pr.offset >= 0 ? '左' : '右'} ${fmt(Math.abs(pr.offset), 2)}m）`;
      const pf = Geom.computeProfile(road.vips, al.length), h = groundAt(road, pr.s);
      if (pf) { const z = Geom.profileAt(pf, pr.s).z; txt += ` ・ 計画高 ${fmt(z, 2)}m` + (h != null ? `（地盤 ${fmt(h, 2)}m・${z >= h ? '盛' : '切'} ${fmt(Math.abs(z - h), 2)}m）` : ''); }
      else if (h != null) txt += ` ・ 地盤高 ${fmt(h, 2)}m`;
    } }
    $('#status').textContent = txt;
    if (ui.tool === 'draw' && ui.draw) {
      const snap = e.originalEvent.altKey ? null : snapAt(e.containerPoint);
      showSnap(snap);
      ui.draw.cursor = ui.draw.ips.length ? P.toXY(snap ? snap.latlng : e.latlng) : null;
      gPreview.clearLayers(); drawPreview();
    }
    if (ui.tool === 'xsec') xsecMove(e);
    if (ui.tool === 'exlink' && ui.link) {
      const sn = e.originalEvent.altKey ? null : exSnapAt(e.containerPoint);
      showSnap(sn && { latlng: sn.latlng, label: exSnapLabel(sn) });
      const ll = sn ? sn.latlng : e.latlng;
      ui.link.cursor = [ll.lat, ll.lng];
      gPreview.clearLayers(); drawLinkPreview();
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
function refresh() {
  renderMap(); renderPanels();
  if (typeof TrafficUI !== 'undefined') TrafficUI.schedule();
  if (typeof StudyUI !== 'undefined') StudyUI.schedule();
  // 線形を変えると現況地盤は取り直しになる。計画縦断がある道路は自動で取り直す
  const r = selRoad();
  if (r && r.vips && !ui.dragging && groundWanted.has(r.id) && !ui.profiles.has(r.id) && !groundLoading.has(r.id)) setTimeout(() => { if (!ui.profiles.has(r.id) && roadById(r.id)) loadProfile(r); }, 300);
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : ''); el.textContent = msg;
  $('#toasts').appendChild(el);
  if (kind !== 'busy') setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4000);
  return el;
}
/* 処理が終わるまで消えない「取得中」表示 */
async function busy(msg, fn) {
  const el = toast(msg, 'busy');
  try { return await fn(); } finally { el.remove(); }
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
const groundWanted = new Set(), groundLoading = new Set();
async function loadProfile(road) {
  const al = calc(road); if (al.length < 1 || groundLoading.has(road.id)) return;
  const step = Math.max(5, al.length / 400), pts = [], key = JSON.stringify(road.ips);
  groundLoading.add(road.id);
  try {
    await busy('地理院 標高タイルから現況地盤高を取得中…', async () => {
      for (let s = 0; s <= al.length + 1e-6; s += step) { const p = Geom.poseAt(al, Math.min(s, al.length)); pts.push({ s: p.s, h: await elevation(P.toLL(p.x, p.y)) }); }
      const last = pts[pts.length - 1];
      if (last && last.s < al.length - 0.5) { const p = Geom.poseAt(al, al.length); pts.push({ s: al.length, h: await elevation(P.toLL(p.x, p.y)) }); }
    });
  } finally { groundLoading.delete(road.id); }
  if (JSON.stringify(road.ips) !== key) return; // 取得中に線形が変わった
  const ok = pts.filter((p) => p.h != null);
  if (ok.length < 2) { groundWanted.delete(road.id); return toast('標高データを取得できませんでした', 'err'); }
  groundWanted.add(road.id);
  // 約 20m 区間の平均勾配
  let maxGrade = 0, maxAt = 0;
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
    const ds = ok[j].s - ok[i].s; if (ds < 20) continue;
    const g = (Math.abs(ok[j].h - ok[i].h) / ds) * 100; if (g > maxGrade) { maxGrade = g; maxAt = (ok[i].s + ok[j].s) / 2; } break;
  }
  ui.profiles.set(road.id, { pts: ok, maxGrade, maxAt, length: al.length });
  refresh();
}

/* ───────── 計画縦断（計画高） ───────── */
const r2 = (v) => Math.round(v * 100) / 100;
const groundAt = (road, s) => { const g = ui.profiles.get(road.id); return g ? Geom.interpProfile(g.pts, s) : null; };
function vplanOf(road) {
  const al = calc(road), pf = Geom.computeProfile(road.vips, al.length);
  if (!pf) return null;
  const gr = ui.profiles.get(road.id), out = { pf, cut: null, fill: null, ends: {}, comb: [] };
  if (gr) {
    for (const p of gr.pts) {
      const d = Geom.profileAt(pf, p.s).z - p.h;
      if (d < 0 && (!out.cut || -d > out.cut.d)) out.cut = { d: -d, s: p.s };
      if (d > 0 && (!out.fill || d > out.fill.d)) out.fill = { d, s: p.s };
    }
    if (road.conn.start) out.ends.start = pf.pts[0].z - Geom.interpProfile(gr.pts, 0);
    if (road.conn.end) out.ends.end = pf.pts[pf.pts.length - 1].z - Geom.interpProfile(gr.pts, al.length);
  }
  al.curves.forEach((c) => {
    if (!c || c.none || c.sTS == null) return;
    const g = Geom.maxGradeIn(pf, c.sTS, c.sST) * 100, e = Math.abs(Rules.superelevation(road, c.ip, c.R).e) * 100;
    out.comb.push({ ip: c.ip, grade: g, e, value: Math.hypot(g, e) });
  });
  return out;
}
/* 縦断変化点 i の縦断曲線長を、規定（R・曲線長）を満たし前後に収まる長さにする */
function fitVCL(road, i) {
  const al = calc(road), pf = Geom.computeProfile(road.vips, al.length), v = road.vips[i];
  if (!pf || i <= 0 || i >= road.vips.length - 1) return;
  const t = Rules.T[road.V], c = pf.curves[i - 1], dg = Math.abs(c.dg);
  if (dg < 0.0005) { v.VCL = 0; return; }
  const need = Math.ceil(Math.max(t.vL, (c.crest ? t.vR : t.vRc) * dg));
  const room = Math.min(pf.pts[i].s - pf.pts[i - 1].s - pf.pts[i - 1].VCL / 2, pf.pts[i + 1].s - pf.pts[i].s - pf.pts[i + 1].VCL / 2) * 2;
  v.VCL = Math.max(0, Math.floor(Math.min(need, room)));
}
/* 現況地盤の点列を Douglas–Peucker で間引いて縦断変化点の案にする */
function groundVips(pts, L, tol) {
  const keep = new Set([0, pts.length - 1]);
  const dp = (a, b) => {
    let best = -1, bd = tol;
    for (let k = a + 1; k < b; k++) {
      const t = (pts[k].s - pts[a].s) / (pts[b].s - pts[a].s), d = Math.abs(pts[k].h - (pts[a].h + (pts[b].h - pts[a].h) * t));
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep.add(best); dp(a, best); dp(best, b); }
  };
  dp(0, pts.length - 1);
  const out = [];
  [...keep].sort((a, b) => a - b).forEach((k, j, arr) => {
    const p = pts[k], s = j === 0 ? 0 : j === arr.length - 1 ? L : Math.round(p.s);
    if (out.length && s - out[out.length - 1].s < 20 && j !== arr.length - 1) return; // 20m 未満の変化点は作らない
    out.push({ s, z: r2(p.h), VCL: 0 });
  });
  if (out.length >= 2 && out[out.length - 1].s - out[out.length - 2].s < 20 && out.length > 2) out.splice(out.length - 2, 1);
  return out;
}
async function createVplan(road, mode) {
  const al = calc(road); if (al.length < 1) return;
  if (!ui.profiles.get(road.id)) await loadProfile(road);
  const gr = ui.profiles.get(road.id);
  if (mode === 'ground' && gr) road.vips = groundVips(gr.pts, al.length, Math.max(0.5, Math.min(3, al.length / 200)));
  else road.vips = [{ s: 0, z: r2(groundAt(road, 0) ?? 0), VCL: 0 }, { s: al.length, z: r2(groundAt(road, al.length) ?? 0), VCL: 0 }];
  for (let i = 1; i < road.vips.length - 1; i++) fitVCL(road, i);
  ui.vdock = true; commit(); setTimeout(() => map.invalidateSize(), 0);
  toast(gr ? '計画縦断を作成しました。縦断図の ● をドラッグ、またはダブルクリックで変化点を追加して計画高を調整できます' : '標高を取得できなかったため計画高 0m で作成しました。数値で入力してください', gr ? undefined : 'err');
}
/* 縦断変化点を追加（s を省略すると最も長い区間の中央） */
function addVip(road, s) {
  const al = calc(road), pf = Geom.computeProfile(road.vips, al.length);
  if (!pf) return;
  if (s == null) { let k = 0; pf.grades.forEach((_, j) => { if (pf.pts[j + 1].s - pf.pts[j].s > pf.pts[k + 1].s - pf.pts[k].s) k = j; }); s = (pf.pts[k].s + pf.pts[k + 1].s) / 2; }
  s = Math.round(s * 10) / 10;
  let i = road.vips.findIndex((v, j) => j > 0 && pf.pts[j].s > s);
  if (i < 1) i = road.vips.length - 1;
  if (Math.abs(pf.pts[i].s - s) < 1 || Math.abs(pf.pts[i - 1].s - s) < 1) return toast('既存の変化点に近すぎます', 'err');
  road.vips.splice(i, 0, { s, z: pf.pts[i - 1].z + pf.grades[i - 1] * (s - pf.pts[i - 1].s), VCL: 0 }); // 勾配線上に置く（勾配差 0 から調整）
  fitVCL(road, i);
  return i;
}
/* 縦断の測点一覧（20m ピッチ ＋ 変化点・縦断曲線始終点） */
function vplanRows(road) {
  const al = calc(road), pf = Geom.computeProfile(road.vips, al.length);
  if (!pf) return [];
  const n = pf.pts.length, m = new Map(), add = (s, name) => { const k = Math.round(s * 1000); if (s < -1e-6 || s > al.length + 1e-6) return; const r = m.get(k); if (r) { if (name && !r.name.includes(name)) r.name = r.name ? r.name + '・' + name : name; } else m.set(k, { s, name: name || '' }); };
  for (let s = 0; s <= al.length + 1e-6; s += 20) add(s, '');
  pf.pts.forEach((p, i) => add(p.s, i === 0 ? 'BP' : i === n - 1 ? 'EP' : 'VIP' + i));
  pf.curves.forEach((c) => { if (c.L > 0) { add(c.bvc, 'BVC' + c.i); add(c.evc, 'EVC' + c.i); } });
  return [...m.values()].sort((a, b) => a.s - b.s).map((r) => {
    const q = Geom.profileAt(pf, r.s), h = groundAt(road, r.s);
    return Object.assign(r, { station: station(r.s), z: q.z, g: q.g, h, d: h == null ? null : q.z - h });
  });
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
