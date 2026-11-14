const test = require('node:test');
const assert = require('node:assert');
const G = require('../js/geom.js');
const X = require('../js/xsec.js');
const S = require('../js/study.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg || ''} ${a} vs ${b}`);
const road = (o = {}) => Object.assign({ id: 'r', V: 40, cls: '3-3', lanes: 2, laneW: 3, shoulderW: 0.5, sidewalkW: 0, conn: {}, ips: [{ x: 0, y: -100, R: 0, A1: 0, A2: 0 }, { x: 0, y: 100, R: 0, A1: 0, A2: 0 }] }, o);
/* 道路 r と地盤 gAt(x, y) から、土工のモデルと横断方向の地盤 */
function setup(r, gAt, pitch) {
  const al = G.computeAlignment(r.ips);
  al.samples = G.sample(al, 1).all;
  const rows = S.stations(al, pitch); rows.forEach((q) => { q.g = gAt(q.x, q.y); });
  const M = X.buildModel(r, al, rows), off = S.offsets(M.E);
  const lat = M.rows.map((q) => off.map((d) => gAt(q.x - q.sn * d, q.y + q.c * d)));
  return { al, M, off, lat };
}
/* 横断勾配のない単純な断面（計算を手で確かめる用） */
const flatModel = (z, E = 5) => ({ E, W: E, sw: 0, L: 100, rows: [{ s: 0, z, g: 10, slope: [0, 0] }, { s: 100, z, g: 10, slope: [0, 0] }] });

test('土工: 平地の盛土・切土の断面積とのり尻までの幅', () => {
  const M = flatModel(12), off = S.offsets(M.E), gs = off.map(() => 10);
  const f = S.crossSection(M, M.rows[0], off, gs);
  near(f.fill, 2 * 10 + 2 * (3 * 2) / 2, 0.02, '盛土 2m: 路体 20 + のり面 3×2');
  near(f.cut, 0, 1e-9);
  near(f.wl, 5 + 3, 0.01, '盛土 1:1.5 ののり尻');
  near(f.ll, 3 * Math.sqrt(1 + 1 / 2.25), 0.01, 'のり面の斜面長');
  assert.strictEqual(f.kl, 'fill'); assert.strictEqual(f.open, false);
  const Mc = flatModel(8), c = S.crossSection(Mc, Mc.rows[0], off, gs);
  near(c.cut, 2 * 10 + 2 * (2 * 2) / 2, 0.02, '切土 2m: 20 + のり面 2×2');
  near(c.wr, 5 + 2, 0.01, '切土 1:1.0 ののり肩');
  assert.strictEqual(c.kr, 'cut');
});

test('土工: 片切片盛（横断方向に傾いた地盤）と、地山に取り付かない急斜面', () => {
  const M = flatModel(10), off = S.offsets(M.E);
  const cs = S.crossSection(M, M.rows[0], off, off.map((d) => 10 + 0.2 * d)); // 左（+d）が高い 20% の斜面
  assert.strictEqual(cs.kl, 'cut'); assert.strictEqual(cs.kr, 'fill');
  near(cs.cut - (0.2 * 5 * 5) / 2, (1 * 1.25) / 2, 0.05, '左: 路体の三角形 2.5 + のり面（1m の段差を 1:1.0 と 20% の差 0.8 で詰める → 1.25m）');
  near(cs.wl, 5 + 1 / (1 - 0.2), 0.01);
  near(cs.wr, 5 + 1 / (1 / 1.5 - 0.2), 0.02, '右: 盛土のり面 1:1.5 が 20% の斜面に追いつく');
  const steep = S.crossSection(M, M.rows[0], off, off.map((d) => 10 + 0.8 * d)); // 80% の斜面: 盛土 1:1.5（67%）は地山に届かない
  assert.strictEqual(steep.open, true);
  near(steep.wr, 5 + S.REACH, 1e-6);
});

test('土工: 平均断面法の土量・用地面積・土量配分', () => {
  const M = flatModel(12), off = S.offsets(M.E), ew = S.earthwork(M, off, M.rows.map(() => off.map(() => 10)), { C: 0.9, margin: 1 });
  near(ew.fillV, 26 * 100, 2, '盛土量');
  near(ew.rowA, (16 + 2) * 100, 1, '用地面積 = (のり尻間 16m + 余裕 2m) × 100m');
  near(ew.slopeFill, 2 * 3 * Math.sqrt(1 + 1 / 2.25) * 100, 2, 'のり面積');
  near(ew.borrow, 2600, 2); near(ew.surplus, 0, 1e-9);
  near(ew.mass[1].v, -2600, 2, '土積（切土×C − 盛土の累計）');
  const b = S.balance(1000, 600, 0.9);
  near(b.reuse, 600, 1e-9); near(b.borrow, 0, 1e-9); near(b.surplus, 1000 - 600 / 0.9, 1e-9);
});

test('土工: 実際の線形・計画高（谷を渡る区間は橋梁になり、土量に入らない）', () => {
  const r = road({ vips: [{ s: 0, z: 30 }, { s: 200, z: 30 }] });
  const gAt = (x, y) => (Math.abs(y) < 30 ? 15 : 30 - 0.0); // 中央 60m は深さ 15m の谷
  const { M, off, lat } = setup(r, gAt, 5), ew = S.earthwork(M, off, lat, {});
  assert.strictEqual(ew.bridges.length, 1);
  assert.ok(ew.bridges[0].s0 > 55 && ew.bridges[0].s0 < 70 && ew.bridges[0].s1 > 130 && ew.bridges[0].s1 < 145, `橋梁区間 ${ew.bridges[0].s0}〜${ew.bridges[0].s1}`);
  near(ew.bridgeLen, ew.bridges[0].s1 - ew.bridges[0].s0, 1e-6);
  near(ew.bridges[0].h, 15, 1e-6);
  assert.ok(ew.fillV < 5, '橋梁区間の下は盛土にしない');
  assert.ok(ew.cutV > 0 && ew.cutV < 60, `平地の区間は拝み勾配ぶんのわずかな切土だけ: ${ew.cutV}`);
});

test('用地・支障物件: 用地の帯にかかる建物だけを数える', () => {
  const r = road({ vips: [{ s: 0, z: 10 }, { s: 200, z: 10 }] }), { M, off, lat } = setup(r, () => 10, 10);
  const ew = S.earthwork(M, off, lat, { margin: 1 }), edges = S.rowEdges(M, ew);
  near(Math.abs(edges[0].l[0]), 3.5 + 1, 0.2, '平地: 道路端 3.5m + 余裕 1m');
  const box = (x0, y0, w, h) => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
  const b = (ring, o = {}) => Object.assign({ code: 3101, parts: [{ outer: ring, holes: [] }], area: 100 }, o);
  const hits = S.hitBuildings([b(box(3, 0, 10, 10)), b(box(20, 0, 10, 10)), b(box(-30, -50, 60, 8), { code: 3102, area: 480 }), b(box(-1, 60, 2, 2), { h: 9.6, area: 4 })], edges);
  assert.deepStrictEqual(hits.list.map((h) => h.i), [2, 0, 3], '離れた建物は入らない。道路をまたぐ大きな建物・帯の中に収まる小さな建物は入る（測点順）');
  assert.strictEqual(hits.n, 3); near(hits.area, 584, 1e-9);
  assert.deepStrictEqual(hits.list.map((h) => h.floors), [4, 2, 3], '階数: 堅ろう建物 4・普通建物 2・実測 9.6m → 3');
  near(hits.floor, 480 * 4 + 100 * 2 + 4 * 3, 1e-9);
});

test('水域の横断: 橋梁でない区間は警告の対象', () => {
  const pts = []; for (let s = 0; s <= 100; s += 2) pts.push({ s, x: 0, y: s });
  const river = [[[-50, 40], [50, 40], [50, 60], [-50, 60]]], pond = [[[-5, 80], [5, 80], [5, 90], [-5, 90]], [[-1, 82], [1, 82], [1, 88], [-1, 88]]]; // 池は中に島（穴）
  const w = S.waterCross(pts, [river, pond], (s) => s >= 38 && s <= 62);
  assert.strictEqual(w.length, 3);
  near(w[0].s0, 40, 1.01); near(w[0].s1, 60, 1.01); assert.strictEqual(w[0].bridged, true);
  assert.strictEqual(w[1].bridged, false); near(w[1].len, 2 + 1, 1.01, '島の手前の水面');
});

test('交差: 高低差から平面交差・立体交差・不成立を分ける', () => {
  assert.strictEqual(S.crossType(0.4, false), 'grade');
  assert.strictEqual(S.crossType(-0.9, false), 'grade');
  assert.strictEqual(S.crossType(3, false), 'conflict');
  assert.strictEqual(S.crossType(4.5 + X.DECK, false), 'over');
  assert.strictEqual(S.crossType(-7, false), 'under');
  assert.strictEqual(S.crossType(3, true), 'sepex');
});

test('交差: 途中で横切る道路の測点・交差角・高低差・間隔', () => {
  const r = road({ vips: [{ s: 0, z: 10 }, { s: 100, z: 10, VCL: 0 }, { s: 200, z: 16 }], conn: { start: { name: '国道', width: 9, bearing: 0, mode: 'cross' } } });
  const { al, M } = setup(r, () => 10, 5);
  const others = [
    { name: '市道 A', width: 6, xy: [{ x: -50, y: -60 }, { x: 50, y: -60 }] },                    // 測点 40・直交・高低差 0
    { name: '市道 A', width: 4, xy: [{ x: -50, y: -60 }, { x: -80, y: -60 }] },                   // 同じ道路の続き（交差しない）
    { name: '市道 B', width: 4, xy: [{ x: -50, y: -30 }, { x: 0, y: -30 }] }, { name: '市道 B', width: 7, xy: [{ x: 0, y: -30 }, { x: 50, y: -30 }] }, // 交差点で 2 本に分かれたデータ
    { name: '県道', width: 7, xy: [{ x: -40, y: 20 }, { x: 40, y: 100 }] },                       // 測点 160 付近・斜め・高低差 +3.6m
    { name: '高架', width: 8, sep: true, xy: [{ x: -40, y: 90 }, { x: 40, y: 90 }] },
    { name: '側道', width: 4, xy: [{ x: 1, y: -100 }, { x: -1, y: 100 }] },                       // ほぼ並行
  ];
  const list = S.crossingList(M, al, r, others);
  assert.deepStrictEqual(list.map((c) => c.name), ['国道', '市道 A', '市道 B', '県道', '高架']);
  assert.strictEqual(list[0].end, 'start'); near(list[0].ang, 90, 1e-6);
  near(list[1].s, 40, 0.01); near(list[1].ang, 90, 1e-6); assert.strictEqual(list[1].type, 'grade'); assert.strictEqual(list[1].major, true);
  near(list[2].s, 70, 0.01); assert.strictEqual(list[2].width, 7, '2 本に分かれた道路は広い方の幅員');
  near(list[3].s, 160, 0.01); near(list[3].ang, 45, 0.01); near(list[3].dz, 3.6, 0.01); assert.strictEqual(list[3].type, 'conflict');
  assert.strictEqual(list[4].type, 'sepex');
  const gaps = S.spacing(list);
  assert.deepStrictEqual(gaps.map((g) => Math.round(g.gap)), [40, 30]);
  const noPlan = S.crossingList(setup(road(), () => 10, 5).M, al, road(), others);
  assert.ok(noPlan.every((c) => c.type === 'grade' || c.type === 'sepex'), '縦断計画が無ければ高低差は判定しない');
});

test('道路の区分（道路構造令 第3条の表）', () => {
  // 第3種
  assert.strictEqual(S.classFor(3, 'nat', 'flat', 25000), 1); assert.strictEqual(S.classFor(3, 'nat', 'flat', 20000), 1); assert.strictEqual(S.classFor(3, 'nat', 'flat', 19999), 2);
  assert.strictEqual(S.classFor(3, 'nat', 'mount', 25000), 2); assert.strictEqual(S.classFor(3, 'nat', 'mount', 3000), 4); assert.strictEqual(S.classFor(3, 'nat', 'flat', 100), 3);
  assert.strictEqual(S.classFor(3, 'pref', 'flat', 30000), 2); assert.strictEqual(S.classFor(3, 'pref', 'flat', 1000), 3); assert.strictEqual(S.classFor(3, 'pref', 'mount', 5000), 3); assert.strictEqual(S.classFor(3, 'pref', 'mount', 1000), 4);
  assert.strictEqual(S.classFor(3, 'city', 'flat', 2000), 3); assert.strictEqual(S.classFor(3, 'city', 'flat', 1000), 4); assert.strictEqual(S.classFor(3, 'city', 'flat', 499), 5);
  assert.strictEqual(S.classFor(3, 'city', 'mount', 2000), 4); assert.strictEqual(S.classFor(3, 'city', 'mount', 300), 5);
  // 第4種
  assert.strictEqual(S.classFor(4, 'nat', 'flat', 12000), 1); assert.strictEqual(S.classFor(4, 'nat', 'flat', 300), 2);
  assert.strictEqual(S.classFor(4, 'pref', 'flat', 5000), 2); assert.strictEqual(S.classFor(4, 'pref', 'flat', 300), 3);
  assert.strictEqual(S.classFor(4, 'city', 'flat', 3999), 3); assert.strictEqual(S.classFor(4, 'city', 'flat', 499), 4);
  // 第1種・第2種
  assert.strictEqual(S.classFor(1, 'exp', 'flat', 30000), 1); assert.strictEqual(S.classFor(1, 'exp', 'flat', 15000), 2); assert.strictEqual(S.classFor(1, 'exp', 'flat', 9000), 3);
  assert.strictEqual(S.classFor(1, 'exp', 'mount', 35000), 2); assert.strictEqual(S.classFor(1, 'exp', 'mount', 5000), 4);
  assert.strictEqual(S.classFor(1, 'mot', 'flat', 25000), 2); assert.strictEqual(S.classFor(1, 'mot', 'flat', 15000), 3); assert.strictEqual(S.classFor(1, 'mot', 'mount', 25000), 3); assert.strictEqual(S.classFor(1, 'mot', 'mount', 15000), 4);
  assert.strictEqual(S.classFor(2, 'exp', 'flat', 1), 1); assert.strictEqual(S.classFor(2, 'mot', 'flat', 1, false), 1); assert.strictEqual(S.classFor(2, 'mot', 'flat', 1, true), 2);
  // 種と道路の種類が合わない
  assert.strictEqual(S.classFor(3, 'exp', 'flat', 10000), null); assert.strictEqual(S.classFor(1, 'pref', 'flat', 10000), null);
});

test('車線数（道路構造令 第5条の設計基準交通量）', () => {
  assert.deepStrictEqual(S.lanesFor('3-3', 'flat', 8000), { lanes: 2, two: 8000, per: 8000 });
  assert.strictEqual(S.lanesFor('3-3', 'flat', 8001).lanes, 4);
  assert.strictEqual(S.lanesFor('3-3', 'mount', 6001).lanes, 4);
  assert.strictEqual(S.lanesFor('3-2', 'flat', 40000).lanes, 6, '40000 ÷ 9000 = 4.4 → 5 → 2 の倍数で 6');
  assert.strictEqual(S.lanesFor('3-1', 'flat', 5000).lanes, 4, '第3種第1級は 2 車線の値がなく 4 車線以上');
  assert.strictEqual(S.lanesFor('1-3', 'mount', 10000).lanes, 2); assert.strictEqual(S.lanesFor('1-3', 'mount', 20000).lanes, 4);
  assert.strictEqual(S.lanesFor('2-1', 'flat', 80000).lanes, 6);
  assert.strictEqual(S.lanesFor('4-2', 'flat', 10000).lanes, 2);
  const many = S.lanesFor('4-2', 'flat', 9000, true); // 交差点の多い第4種: 2 車線 ×0.8、1 車線当たり ×0.6
  near(many.two, 8000, 1e-9); near(many.per, 6000, 1e-9); assert.strictEqual(many.lanes, 4);
  assert.strictEqual(S.lanesFor('4-3', 'flat', 30000, true).lanes, 6, '30000 ÷ 6000 = 5 → 6');
  assert.strictEqual(S.lanesFor('3-4', 'flat', 9000).lanes, null, '第3種第4級・平地部は多車線の値がない');
  assert.strictEqual(S.lanesFor('3-5', 'flat', 300).single, true);
  assert.deepStrictEqual(S.medianOf('1-1'), { w: 4.5, must: true }); assert.deepStrictEqual(S.medianOf('3-1'), { w: 1.75, must: true }); assert.deepStrictEqual(S.medianOf('4-2'), { w: 1.0, must: false });
});

test('概算事業費: 数量 × 単価、諸経費・測量設計費', () => {
  const c = S.cost({ cutV: 1000, fillV: 500, borrow: 0, surplus: 400, slopeA: 200, paveA: 700, walkA: 0, bridgeA: 100, len: 100, rowA: 2000, compA: 300 }, { cut: 1000, fill: 2000, spoil: 500, slope: 1000, pave: 10000, bridge: 500000, drain: 50000, land: 10000, comp: 200000, misc: 20, survey: 10 });
  const direct = 1000 * 1000 + 500 * 2000 + 400 * 500 + 200 * 1000 + 700 * 10000 + 100 * 500000 + 100 * 50000;
  near(c.direct, direct, 1e-6); near(c.misc, direct * 0.2, 1e-6); near(c.works, direct * 1.2, 1e-6); near(c.survey, direct * 1.2 * 0.1, 1e-6);
  near(c.land, 2e7, 1e-6); near(c.comp, 6e7, 1e-6); near(c.total, direct * 1.32 + 8e7, 1e-3);
  assert.strictEqual(S.cost({}, {}).total, 0);
});

test('費用便益: 走行経費原単位の補間（マニュアル 表−2）', () => {
  near(S.runCost('urban', 'pc', 30), 26.70, 1e-9); near(S.runCost('urban', 'pc', 32.5), (26.70 + 26.05) / 2, 1e-9);
  near(S.runCost('urban', 'large', 3), 101.08, 1e-9, '5km/h 未満は 5km/h の値'); near(S.runCost('flat', 'small', 80), 22.84, 1e-9, '60km/h 超は 60km/h の値');
  near(S.runCost('exp', 'pc', 20), 13.77, 1e-9); near(S.runCost('exp', 'large', 87.5), (39.13 + 41.23) / 2, 1e-9); near(S.runCost('mount', 'pc', 60), 17.87, 1e-9);
});

test('費用便益: 現在価値・B/C・EIRR', () => {
  const o = { benefit: { time: 100, run: 20, acc: 5 }, works: 1000, land: 200, years: 3, maint: 10, rate: 0.04, horizon: 50 };
  const r = S.bcr(o), df = (t) => 1.04 ** -t;
  let ann = 0; for (let t = 0; t < 50; t++) ann += df(3 + t);
  near(r.Bt, 100 * ann, 1e-6); near(r.B, 125 * ann, 1e-6);
  near(r.Cc, 1200 * (1 + df(1) + df(2)) / 3, 1e-6); near(r.Cm, 10 * ann, 1e-6);
  near(r.bc, r.B / (r.Cc + r.Cm), 1e-9); near(r.npv, r.B - r.C, 1e-9);
  const q = S.bcr(Object.assign({}, o, { rate: r.eirr })); near(q.B - q.C, 0, 1e-4, 'EIRR は純現在価値が 0 になる割引率');
  const res = S.bcr(Object.assign({}, o, { residual: true })); near(res.C, r.C - 200 * df(53), 1e-6, '用地の残存価値を控除');
  assert.strictEqual(S.bcr(Object.assign({}, o, { benefit: { time: 1, run: 0, acc: 0 } })).eirr, null, '便益が小さければ EIRR なし');
  const sv = S.sensitivity(o);
  near(sv[0].hi, r.bc * 1.1, 1e-9); assert.ok(sv[1].lo < r.bc && sv[1].hi > r.bc && sv[2].lo < r.bc && sv[2].hi > r.bc);
});

test('費用便益: リンクの交通量と所要時間から年間便益（走行時間・走行経費・交通事故）', () => {
  // 既存の 1km（市街地・2 車線）が 20km/h → 30km/h になり、1km の計画道路に 4000 台が移る
  const edge = (a, b, pts, o) => Object.assign({ a, b, pts, len: 1000, kind: 'pr', area: 3, lanesEff: 2, width: 7, oneway: 0, fac: { lg: 10 } }, o);
  const net = { nodes: [{}, {}], edges: [edge(0, 1, [[0, 0], [1000, 0]]), edge(0, 1, [[0, 0], [500, 300], [1000, 0]], { planned: true })] };
  const res = { g: { ok: [1, 1, 1, 1] }, before: { x: [5000, 5000, 0, 0], t: [3, 3, 1.5, 1.5] }, after: { x: [3000, 3000, 2000, 2000], t: [2, 2, 1.5, 1.5] } };
  const b = S.benefits(net, res, { small: 0.2 });
  const a = 0.72 * 48.89 + 0.18 * 52.07 + 0.1 * 101.93;
  near(b.time, (10000 * 3 - 6000 * 2 - 4000 * 1.5) * a * 365, 1, '走行時間短縮');
  const rc = (v) => 0.72 * S.runCost('urban', 'pc', v) + 0.18 * S.runCost('urban', 'small', v) + 0.1 * S.runCost('urban', 'large', v);
  near(b.run, (10000 * rc(20) - 6000 * rc(30) - 4000 * rc(40)) * 365, 1, '走行経費減少');
  near(b.before.acc, 1130 * 10 * 1 * 1000, 1e-3, 'その他市街部・2 車線: 1130 × 千台km/日 [千円/年]（整備なしでは計画道路との交差点は数えない）');
  near(b.acc, -280 * 10 * 1 * 1000, 1e-3, '走行台キロは同じ。両端が主要交差点（幅員 5.5m 以上の道路どうし）になるぶん 280 × 千台箇所/日 だけ増える');
  const four = S.benefits({ nodes: net.nodes, edges: [net.edges[0], Object.assign({}, net.edges[1], { lanesEff: 4 })] }, res, {});
  near(four.after.acc, (1130 * 6 + 280 * 6 + 760 * 4 + 310 * 4) * 1000, 1e-3, '計画道路が 4 車線なら 760 × X1 + 310 × X2');
});

test('騒音: パワーレベル式と道路端の等価騒音レベル', () => {
  near(S.lwa(60, false, true), 45.8 + 30 * Math.log10(60), 1e-9); near(S.lwa(60, true, true), 53.2 + 30 * Math.log10(60), 1e-9);
  near(S.lwa(40, false, false), 82.3 + 10 * Math.log10(40), 1e-9); near(S.lwa(80, true, false), 88.8 + 10 * Math.log10(60), 1e-9, '非定常は 60km/h まで');
  const L = S.laeq(1000, 0, 60, true, [10]);
  near(L, 45.8 + 30 * Math.log10(60) - 10 * Math.log10(2 * 10 * (60 / 3.6)) + 10 * Math.log10(1000 / 3600), 1e-9);
  assert.ok(L > 66 && L < 70, `1000 台/時・60km/h・10m で 68dB 前後: ${L}`);
  near(S.laeq(2000, 0, 60, true, [10]) - L, 3.01, 0.01, '交通量 2 倍で +3dB');
  near(L - S.laeq(1000, 0, 60, true, [20]), 3.01, 0.01, '距離 2 倍で −3dB（線音源）');
  assert.ok(S.laeq(1000, 0.2, 60, true, [10]) > L + 1, '大型車が混じると上がる');
  const o = { q: 20000, heavy: 0.1, V: 50, steady: true, night: 0.1, road: road({ sidewalkW: 2.5 }) }, n = S.noise(o);
  assert.ok(n.day > n.night && n.day > 60 && n.day < 80, `${n.day} / ${n.night}`);
  const d = S.noiseDistance(o, 65, 60);
  assert.ok(d > 0, '道路端では 65dB を超える'); const at = S.noise(Object.assign({}, o, { dist: d })); assert.ok(Math.max(at.day - 65, at.night - 60) < 0.01 && Math.max(at.day - 65, at.night - 60) > -0.01);
  assert.strictEqual(S.noiseDistance(Object.assign({}, o, { q: 200 }), 70, 65), 0);
});

test('検討項目: 区分・車線数・交差・土工の指摘が出る', () => {
  const r = road({ lanes: 2, vips: [{ s: 0, z: 10 }, { s: 200, z: 10 }] }), { al, M, off, lat } = setup(r, () => 10, 10), ew = S.earthwork(M, off, lat, {});
  const cross = [{ s: 50, name: '県道', ang: 50, type: 'grade', major: true, z: 10, g: 10, dz: 0 }, { s: 70, name: '市道', ang: 90, type: 'grade', z: 10, g: 10, dz: 0 }, { s: 150, name: '国道', ang: 90, type: 'conflict', z: 13, g: 10, dz: 3 }];
  const out = S.review(r, al, { ew, cross, gaps: S.spacing(cross), hits: { n: 2, area: 150 }, water: [{ s0: 100, s1: 110, len: 10, bridged: false }] }, { q: 12000, src: '交通量の予測', kind: 'pref', terrain: 'flat' });
  const find = (cat, lv) => out.filter((x) => x.cat === cat && x.level === lv);
  assert.strictEqual(find('道路の区分', 'warn').length, 1, '県道・平地・12000 台 → 第2級。第3級は 1 級下');
  assert.strictEqual(find('車線数', 'error').length, 1, '12000 > 8000 → 4 車線が必要');
  assert.strictEqual(find('交差', 'error').length, 2, '交差角 50° と、高さが合わない交差');
  assert.strictEqual(find('交差', 'warn').length, 1, '間隔 20m は制動停止視距 40m 未満');
  assert.strictEqual(find('支障物件', 'warn').length, 1); assert.strictEqual(find('水域の横断', 'warn').length, 1);
  const ok = S.review(road({ cls: '3-2', V: 60, lanes: 2, laneW: 3.25 }), al, {}, { q: 5000, kind: 'pref', terrain: 'flat' });
  assert.ok(ok.some((x) => x.cat === '道路の区分' && x.level === 'ok') && ok.some((x) => x.cat === '車線数' && x.level === 'ok'));
  assert.ok(S.review(road({ cls: '4-1', V: 60, lanes: 4 }), al, {}, {}).filter((x) => x.cat === '横断構成').length === 2, '4 車線の中央帯と、第4種第1級の植樹帯');
});
