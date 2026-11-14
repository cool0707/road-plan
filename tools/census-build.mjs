#!/usr/bin/env node
/* 令和3年度 全国道路・街路交通情勢調査 一般交通量調査（国土交通省）の公開データから、アプリ同梱用のデータを作る。
 *
 *   node tools/census-build.mjs --csv <箇所別基本表・時間帯別交通量表 CSV のディレクトリ> [--geom <区間形状 GeoJSON のディレクトリ>]... [--out data/census-r3]
 *
 * 出力
 *   js/trafficmodel.js           全国の統計から作る原単位表（道路種別×沿道状況×車線数ごとの交通量・交通容量、昼夜率、ピーク率、時間係数）
 *   <out>/index.json             同梱している範囲（タイル一覧）
 *   <out>/<z>/<x>/<y>.json       区間ごとの交通量（上り・下り別）と、照合用に間引いた区間形状
 *
 * 形状は可視化ツール（WEB マップ）の GeoJSON（タイル／区間ごと、どちらでも可）を読む。形状が無い区間はタイルに入らない。
 * 出典: 国土交通省「令和3年度 全国道路・街路交通情勢調査 一般交通量調査 箇所別基本表・時間帯別交通量表」を加工して作成 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), opt = { csv: null, geom: [], out: 'data/census-r3', z: 11 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--csv') opt.csv = args[++i];
  else if (args[i] === '--geom') opt.geom.push(args[++i]);
  else if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--z') opt.z = +args[++i];
}
if (!opt.csv) { console.error('--csv <dir> が必要です'); process.exit(1); }
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sjis = new TextDecoder('shift_jis');
const num = (s) => { const v = parseFloat(s); return isFinite(v) ? v : null; };
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const splitLine = (l) => { // 引用符つきの欄（カンマを含む路線名など）に対応
  if (!l.includes('"')) return l.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur); return out;
};
const parseCsv = (file) => sjis.decode(fs.readFileSync(file)).split(/\r?\n/).filter((l) => l).map(splitLine);
const sid = (v) => (/^\d{10,11}$/.test(v) ? v.padStart(11, '0') : ''); // 北海道〜福岡以前の県は先頭の 0 が落ちている

/* ───────── 箇所別基本表 ───────── */
const GROUP = { 1: 'H', 2: 'H', 3: 'N', 4: 'P', 5: 'P', 6: 'P', 7: 'P' }; // H: 高速・都市高速 / N: 一般国道 / P: 都道府県道・指定市道
const laneCat = (n) => (n <= 1 ? 1 : n <= 3 ? 2 : n <= 5 ? 4 : 6);
const secs = new Map(), units = new Map();
for (const f of fs.readdirSync(opt.csv).filter((n) => /^kasyo\d\d\.csv$/.test(n)).sort()) {
  const rows = parseCsv(path.join(opt.csv, f));
  for (const r of rows.slice(1)) {
    if (r.length < 150 || !sid(r[0])) continue;
    const dir = (o) => ({ obs: +r[o + 2] || 0, kobetsu: +r[o + 3] || 0, h: +r[o + 4] || 0, date: r[o + 5] || '', s12: num(r[o + 6]), l12: num(r[o + 7]), t12: num(r[o + 8]), t24: num(r[o + 11]) });
    const s = {
      id: sid(r[0]), type: +r[3], name: r[5], prev: sid(r[7]), next: sid(r[12]), oneway: +r[26] || 0, len: num(r[23]),
      unit: +r[30] + '-' + +r[31], up: dir(32), dn: dir(44), t12: num(r[58]), t24: num(r[61]),
      dnr: num(r[62]), pk: num(r[63]), lg: num(r[64]), konz: num(r[65]),
      spd: [num(r[75]), num(r[82]), num(r[89]), num(r[96])], // 朝夕 上り・下り / 昼間 上り・下り [km/h]
      lanes: num(r[122]), limit: num(r[140]), area: +r[143] || 0, sigD: num(r[135]),
    };
    secs.set(s.id, s);
    if (!units.has(s.unit)) units.set(s.unit, s);
  }
}
console.log(`箇所別基本表: ${secs.size} 区間`);

/* ───────── 時間帯別交通量表（観測した調査単位区間の 1 時間ごとの台数。7 時台 → 翌 6 時台） ───────── */
const hourly = new Map(); // unit → { 1: [24]（上り・全車）, 2: [24]（下り） }
for (const f of fs.readdirSync(opt.csv).filter((n) => /^zkntrf\d\d\.csv$/.test(n)).sort()) {
  for (const r of parseCsv(path.join(opt.csv, f)).slice(1)) {
    if (r.length < 37 || r[4] !== '1') continue; // 観測した区間だけ
    const key = +r[0] + '-' + +r[1], ud = r[9];
    if (ud !== '1' && ud !== '2') continue;
    const h = hourly.get(key) || {}; hourly.set(key, h);
    const a = h[ud] || (h[ud] = new Array(24).fill(0)); h.n24 = r[6] === '2';
    for (let k = 0; k < 24; k++) { const v = num(r[11 + k]); if (v != null) a[k] += v; }
  }
}
console.log(`時間帯別交通量表: ${hourly.size} 調査単位区間`);
/* 朝ピーク（7・8 時台の大きい方）と夕ピーク（17・18 時台の大きい方）の 1 時間交通量 */
const peaks = (a) => (a ? { am: Math.max(a[0], a[1]), pm: Math.max(a[10], a[11]) } : null);

/* ───────── 原単位表（全国） ───────── */
const acc = {}, push = (k, f, v) => { if (v == null || !isFinite(v)) return; ((acc[k] || (acc[k] = {}))[f] || (acc[k][f] = [])).push(v); };
for (const s of secs.values()) {
  const g = GROUP[s.type];
  if (!g || !s.area || !s.lanes || !s.t12) continue;
  const k = `${g}${s.area}${laneCat(s.lanes)}`, ka = `${g}${s.area}`, real = s.up.obs === 1 || s.dn.obs === 1;
  if (s.konz > 0) push(k, 'cap', s.t12 / s.konz / s.lanes);
  if (real) {
    push(k, 'vol', s.t24 / s.lanes);
    push(ka, 'dn', s.dnr); push(ka, 'pk', s.pk); push(ka, 'lg', s.lg);
    if (s.spd[2] > 0 || s.spd[3] > 0) push(ka, 'v0', Math.max(s.spd[2] || 0, s.spd[3] || 0));
  }
}
const model = { src: '国土交通省 令和3年度 全国道路・街路交通情勢調査 一般交通量調査（箇所別基本表・時間帯別交通量表）を加工して作成', n: secs.size, cap12: {}, vol24: {}, dn: {}, pk: {}, lg: {}, v0: {}, hr: {}, am: {}, pm: {} };
for (const [k, v] of Object.entries(acc)) {
  if (k.length === 3) { if (v.cap && v.cap.length >= 5) model.cap12[k] = Math.round(median(v.cap) / 10) * 10; if (v.vol && v.vol.length >= 5) model.vol24[k] = Math.round(median(v.vol) / 10) * 10; }
  else { model.dn[k] = +median(v.dn || []).toFixed(2); model.pk[k] = +median(v.pk || []).toFixed(1); model.lg[k] = +median(v.lg || []).toFixed(1); if (v.v0) model.v0[k] = Math.round(median(v.v0)); }
}
/* 時間係数: 24 時間観測の調査単位区間について、1 時間ごとの台数 ÷ 24 時間台数（上下計）の平均。
 * 朝・夕ピークの方向別比率: 方向別ピーク 1 時間 ÷ その方向の昼間 12 時間 の中央値 */
const hrAcc = {}, pkAcc = {};
for (const [key, h] of hourly) {
  const u = units.get(key), g = u && GROUP[u.type];
  if (!g || !u.area) continue;
  const ka = `${g}${u.area}`;
  for (const ud of ['1', '2']) {
    const a = h[ud]; if (!a) continue;
    const d12 = a.slice(0, 12).reduce((x, y) => x + y, 0), p = peaks(a);
    if (d12 > 200) { (pkAcc[ka] || (pkAcc[ka] = { am: [], pm: [] })).am.push(p.am / d12); pkAcc[ka].pm.push(p.pm / d12); }
  }
  if (h.n24 && h[1] && h[2]) {
    const tot = h[1].map((v, i) => v + h[2][i]), sum = tot.reduce((x, y) => x + y, 0);
    if (sum > 500 && tot.slice(12).some((v) => v > 0)) { const t = hrAcc[ka] || (hrAcc[ka] = { n: 0, a: new Array(24).fill(0) }); t.n++; tot.forEach((v, i) => { t.a[i] += v / sum; }); }
  }
}
for (const [k, t] of Object.entries(hrAcc)) if (t.n >= 5) model.hr[k] = t.a.map((v) => +(v / t.n).toFixed(4)); // 添字 0 = 7 時台
for (const [k, t] of Object.entries(pkAcc)) if (t.am.length >= 5) { model.am[k] = +median(t.am).toFixed(4); model.pm[k] = +median(t.pm).toFixed(4); }
fs.writeFileSync(path.join(root, 'js/trafficmodel.js'),
  `/* 自動生成（tools/census-build.mjs）。編集しない。\n * ${model.src}\n * キー: 道路種別（H 高速・都市高速 / N 一般国道 / P 都道府県道・指定市道）＋ 沿道状況（1 DID商業 / 2 DID / 3 その他市街部 / 4 平地部 / 5 山地部）＋ 車線数区分（1 / 2 / 4 / 6）\n * cap12: 交通容量 [台/12h/車線]（= 昼間12時間交通量 ÷ 混雑度 の中央値） / vol24: 実測区間の 24 時間交通量 [台/日/車線] の中央値\n * dn: 昼夜率 / pk: 昼間12時間ピーク比率 [%] / lg: 大型車混入率 [%] / v0: 昼間非混雑時旅行速度 [km/h] / hr: 時間係数（7 時台から） / am・pm: 方向別ピーク 1 時間 ÷ 方向別昼間 12 時間 */\n(function (root) {\n  const M = ${JSON.stringify(model)};\n  if (typeof module !== 'undefined' && module.exports) module.exports = M; else root.TRAFFIC_MODEL = M;\n})(typeof self !== 'undefined' ? self : this);\n`);
console.log('js/trafficmodel.js を書き出しました');

/* ───────── 区間形状 ───────── */
if (!opt.geom.length) { console.log('--geom の指定がないので区間タイルは作りません'); process.exit(0); }
const K = 111320, lines = new Map(); // id → [[ [lng,lat], ... ], ...]
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.geojson$/.test(e.name) ? [path.join(d, e.name)] : []));
let nf = 0;
for (const d of opt.geom) for (const f of walk(d)) {
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { continue; }
  nf++;
  for (const ft of j.features || []) {
    const id = ft.properties && (ft.properties.census || ft.properties.R03cen), g = ft.geometry;
    if (!id || !g) continue;
    const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    const arr = lines.get(id) || []; lines.set(id, arr);
    for (const p of parts) if (p.length >= 2) arr.push(p);
  }
}
console.log(`形状: ${nf} ファイル・${lines.size} 区間`);
const dist = (a, b) => { const c = Math.cos((a[1] * Math.PI) / 180); return Math.hypot((a[0] - b[0]) * K * c, (a[1] - b[1]) * K); };
function simplify(pts, tol) { // Douglas–Peucker [m]
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const c = Math.cos((pts[0][1] * Math.PI) / 180), X = (p) => p[0] * K * c, Y = (p) => p[1] * K;
  const rec = (a, b) => {
    let bd = tol, bi = -1; const ax = X(pts[a]), ay = Y(pts[a]), vx = X(pts[b]) - ax, vy = Y(pts[b]) - ay, l2 = vx * vx + vy * vy;
    for (let k = a + 1; k < b; k++) { const px = X(pts[k]) - ax, py = Y(pts[k]) - ay, t = l2 ? Math.max(0, Math.min(1, (px * vx + py * vy) / l2)) : 0, d = Math.hypot(px - vx * t, py - vy * t); if (d > bd) { bd = d; bi = k; } }
    if (bi > 0) { keep[bi] = 1; rec(a, bi); rec(bi, b); }
  };
  rec(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}
const plen = (p) => { let l = 0; for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]); return l; };
const dTo = (p, pts) => { let d = Infinity; for (const q of pts) d = Math.min(d, dist(p, q)); return d; };
const ptsOf = (id) => { const l = lines.get(id); return l ? l.flat() : null; };

const tiles = new Map(), n2 = 2 ** opt.z;
const tx = (lng) => Math.floor(((lng + 180) / 360) * n2), ty = (lat) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n2); };
let nOut = 0, nUnoriented = 0; const kens = new Set(); // 形状のある区間が 1 つでもある都道府県（47 そろえば全国）
for (const [id, raw] of lines) {
  const s = secs.get(id); if (!s) continue;
  // 重複（タイルの重なり分）を除き、短すぎる断片を捨てて間引く
  const seen = new Set(); let ps = [];
  for (const p of raw) { const k = p[0].join() + '|' + p[p.length - 1].join() + '|' + p.length; if (seen.has(k)) continue; seen.add(k); ps.push(simplify(p, 3)); }
  const longest = Math.max(...ps.map(plen)); ps = ps.filter((p) => plen(p) >= Math.min(15, longest));
  // 向きを「起点 → 終点」（下り方向）に揃える: 起点側・終点側で接続する区間の形状との距離で決める
  const A = s.prev && s.prev !== id ? ptsOf(s.prev) : null, B = s.next && s.next !== id ? ptsOf(s.next) : null;
  let oriented = 0; const flags = ps.map((p) => {
    const p0 = p[0], p1 = p[p.length - 1];
    let sc = 0;
    if (A) sc += dTo(p0, A) - dTo(p1, A);
    if (B) sc += dTo(p1, B) - dTo(p0, B);
    if (Math.abs(sc) < 5) return 0;
    oriented++; if (sc > 0) p.reverse(); return 1;
  });
  if (oriented && oriented < ps.length) { // 決まらなかった断片は、決まった断片の全体的な向きに合わせる
    let vx = 0, vy = 0; ps.forEach((p, i) => { if (flags[i]) { vx += p[p.length - 1][0] - p[0][0]; vy += p[p.length - 1][1] - p[0][1]; } });
    ps.forEach((p, i) => { if (!flags[i] && (p[p.length - 1][0] - p[0][0]) * vx + (p[p.length - 1][1] - p[0][1]) * vy < 0) p.reverse(); });
  }
  if (!oriented) nUnoriented++;
  const h = hourly.get(s.unit), pu = h && peaks(h[1]), pd = h && peaks(h[2]);
  const D = (d) => [d.obs === 1 ? (d.kobetsu ? 2 : 1) : 0, d.s12, d.l12, d.t24]; // 0: 非観測（推定値） / 1: 令和3年度に観測 / 2: 個別調査の観測値を活用
  const rec = [id, s.type, s.name, s.lanes || 0, s.area, oriented ? 1 : 0, (s.up.date || s.dn.date || '').slice(0, 8), ...D(s.dn), ...D(s.up),
    s.dnr, s.pk, s.konz, s.spd, s.limit, s.oneway, pd ? [pd.am, pd.pm] : null, pu ? [pu.am, pu.pm] : null,
    ps.map((p) => { let la = 0, lo = 0; return p.flatMap((q) => { const a = Math.round(q[1] * 1e5), b = Math.round(q[0] * 1e5), o = [a - la, b - lo]; la = a; lo = b; return o; }); })];
  const all = ps.flat(), xs = all.map((q) => tx(q[0])), ys = all.map((q) => ty(q[1]));
  for (let x = Math.min(...xs); x <= Math.max(...xs); x++) for (let y = Math.min(...ys); y <= Math.max(...ys); y++) { const k = `${x}/${y}`; (tiles.get(k) || tiles.set(k, []).get(k)).push(rec); }
  nOut++; kens.add(id.slice(0, 2));
}
const out = path.resolve(root, opt.out);
fs.rmSync(out, { recursive: true, force: true });
for (const [k, list] of tiles) {
  const f = path.join(out, String(opt.z), k + '.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ s: list }));
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({
  version: 1, z: opt.z, sections: nOut, kens: [...kens].sort(), tiles: [...tiles.keys()].sort(),
  source: '国土交通省 令和3年度 全国道路・街路交通情勢調査 一般交通量調査（箇所別基本表・時間帯別交通量表・一般交通量調査結果WEBマップ）を加工して作成',
  fields: ['区間番号', '道路種別', '路線名', '車線数', '代表沿道状況', '向きあり', '観測年月日', '下り:観測区分', '下り:小型12h', '下り:大型12h', '下り:24h', '上り:観測区分', '上り:小型12h', '上り:大型12h', '上り:24h', '昼夜率', 'ピーク比率%', '混雑度', '旅行速度[朝夕上り,朝夕下り,昼間上り,昼間下り]', '指定最高速度', '一方通行', '下り:[朝ピーク,夕ピーク]', '上り:[朝ピーク,夕ピーク]', '形状（緯度・経度×1e5 の差分、起点→終点）'],
}));
console.log(`${nOut} 区間を ${tiles.size} タイルに書き出しました（向き不明 ${nUnoriented}）: ${opt.out}`);
