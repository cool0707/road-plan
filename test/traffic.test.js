const test = require('node:test');
const assert = require('node:assert');
const T = require('../js/traffic.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);
const line = (id, pts, o = {}) => Object.assign({ id, kind: 'pr', lanes: 2, oneway: 0, speed: 50, speedEst: true, xy: pts.map(([x, y]) => ({ x, y })) }, o);

test('時間帯の換算: 実測値はそのまま、無い時間帯は昼夜率・ピーク率で換算して conv を立てる', () => {
  const f = { dn: 1.3, pk: 10, am: 0.1, pm: 0.09 };
  assert.deepStrictEqual(T.valueOf({ d12: 10000 }, 'd12', f), { v: 10000, conv: false });
  const day = T.valueOf({ d12: 10000 }, 'day', f); near(day.v, 13000, 1e-6); assert.strictEqual(day.conv, true);
  near(T.valueOf({ day: 13000 }, 'd12', f).v, 10000, 1e-6);
  near(T.valueOf({ d12: 10000 }, 'am', f).v, 1000, 1e-6);
  near(T.valueOf({ d12: 10000 }, 'peak', f).v, 1000, 1e-6);
  assert.deepStrictEqual(T.valueOf({ day: 13000, d12: 10000 }, 'night', f), { v: 3000, conv: false });
  assert.strictEqual(T.valueOf({}, 'day', f), null);
  const hr = Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 19 ? 100 : 10)); hr[8] = 300; hr[17] = 250;
  const h = T.fromHourly(hr);
  assert.strictEqual(h.d12, 100 * 10 + 300 + 250); assert.strictEqual(h.am, 300); assert.strictEqual(h.pm, 250); assert.strictEqual(h.peak, 300);
  assert.deepStrictEqual(T.valueOf({ hr }, 'am', f), { v: 300, conv: false });
});

test('ネットワーク: T字の端点接続・次数2の統合・計画道路との平面交差', () => {
  const roads = [
    line('a1', [[0, 0], [500, 0]]), line('a2', [[500, 0], [1000, 0]]), // 同じ属性で連続 → 1 本に
    line('b', [[400, 300], [400, 0.5]], { kind: 're' }), // a1 の途中に端点が載る T字
    line('p', [[700, -200], [700, 200]], { planned: true, kind: 'se' }), // a2 を横切る計画道路
  ];
  const net = T.buildNetwork(roads);
  const ex = net.edges.filter((e) => !e.planned && e.kind === 'pr'), pl = net.edges.filter((e) => e.planned);
  assert.strictEqual(ex.length, 3, '幹線は T字点と交差点で 3 本に分かれる');
  near(ex.reduce((s, e) => s + e.len, 0), 1000, 1e-6);
  assert.strictEqual(pl.length, 2, '計画道路は交差点で 2 本');
  assert.strictEqual(net.nodes.filter((n) => n.deg === 3).length, 1);
  assert.strictEqual(net.nodes.filter((n) => n.deg === 4).length, 1);
  const net2 = T.buildNetwork(roads, { crossPlanned: false });
  assert.strictEqual(net2.edges.filter((e) => e.planned).length, 1, '平面交差なしなら計画道路は切られない');
});

test('二重制約の OD 表は発生量・集中量に一致する', () => {
  const O = [100, 200, 300], D = [150, 250, 200], F = new Float64Array([0, 1, 2, 1, 0, 1, 2, 1, 0]);
  const od = T.furness(O, D, F, 3);
  for (let i = 0; i < 3; i++) { near(od[i * 3] + od[i * 3 + 1] + od[i * 3 + 2], O[i], 0.05, '発生'); near(od[i] + od[3 + i] + od[6 + i], D[i], 0.05, '集中'); assert.strictEqual(od[i * 3 + i], 0); }
});

/* 2 本の並行経路（短くて容量の小さい道と、遠回りで容量の大きい道） */
function twoRoutes() {
  const roads = [
    line('in', [[-500, 0], [0, 0]], { kind: 'tr' }), line('out', [[2000, 0], [2500, 0]], { kind: 'tr' }),
    line('short', [[0, 0], [2000, 0]], { kind: 'se' }), line('long', [[0, 0], [1000, 800], [2000, 0]], { kind: 'pr' }),
  ];
  const net = T.buildNetwork(roads);
  T.prepare(net, [], { area: 3 });
  return net;
}
test('利用者均衡: 使われる経路の所要時間が等しくなる', () => {
  const net = twoRoutes(), per = 'day';
  T.baseVolumes(net, per);
  const g = T.graphOf(net, per); T.setCase(g, true);
  const zn = net.nodes.map((n, i) => (n.deg === 1 ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(zn.length, 2);
  const od = new Float64Array([0, 30000, 0, 0]), P = T.DEFAULTS;
  const ue = T.assign(g, od, zn, 'ue', P);
  const ei = (id) => net.edges.findIndex((e) => e.rid === id), arc = (id) => { const i = ei(id); return ue.x[2 * i] > ue.x[2 * i + 1] ? 2 * i : 2 * i + 1; };
  const xs = ue.x[arc('short')], xl = ue.x[arc('long')];
  near(xs + xl, 30000, 1, '保存則');
  assert.ok(xs > 0 && xl > 0, '両方の経路が使われる');
  near(ue.t[arc('short')], ue.t[arc('long')], 0.05 * ue.t[arc('short')], '等時間');
  const aon = T.assign(g, od, zn, 'aon', P);
  assert.ok(aon.x[arc('short')] === 30000 || aon.x[2 * ei('short')] + aon.x[2 * ei('short') + 1] === 30000, '最短経路配分は全量が短い道');
  for (const m of ['inc', 'sue']) { const r = T.assign(g, od, zn, m, P), i = ei('short'), j = ei('long'); near(r.x[2 * i] + r.x[2 * i + 1] + r.x[2 * j] + r.x[2 * j + 1], 30000, 1, m + ' 保存則'); }
});

test('観測データの優先順位: 実測 > 常時観測 > センサス > センサス推定値、向きは方位で決まる', () => {
  const net = T.buildNetwork([line('a', [[0, 0], [1000, 0]]), line('x', [[1000, -300], [1000, 300]]), line('y', [[0, -300], [0, 300]])]);
  const census = { id: 'c', src: 'census', date: '20211001', ls: [[{ x: 0, y: 2 }, { x: 1000, y: 2 }]], a: { d12: 5000, day: 6500 }, b: { d12: 4000, day: 5200 }, meta: { type: 4, lanes: 2, area: 2, dn: 1.3, pk: 10, konz: 0.9, t12: 9000 } };
  const est = Object.assign({}, census, { id: 'e', est: true, a: { d12: 1 }, b: { d12: 1 } });
  const field = { id: 'f', src: 'field', date: '20260401', p: { x: 500, y: -3 }, av: { x: -1, y: 0 }, a: { d12: 7000 }, b: { d12: 6000 } }; // a 方向 = 西行き
  T.prepare(net, [est, census], {}); T.baseVolumes(net, 'd12');
  const e = () => net.edges.find((q) => q.rid === 'a');
  assert.strictEqual(e().ob.o.id, 'c'); assert.deepStrictEqual(e().bst, ['real', 'real']);
  const fw = e().pts[0][0] < e().pts[1][0] ? 0 : 1; // 東行きの添字
  assert.strictEqual(e().base[fw], 5000); assert.strictEqual(e().base[1 - fw], 4000);
  near(e().cap12, 10000, 1e-6, 'センサスの交通容量 = 交通量 ÷ 混雑度');
  T.baseVolumes(net, 'day'); assert.strictEqual(e().base[fw], 6500); assert.strictEqual(e().bconv[fw], false);
  T.baseVolumes(net, 'am'); assert.strictEqual(e().bconv[fw], true, '無い時間帯は換算');
  T.prepare(net, [est, census, field], {}); T.baseVolumes(net, 'd12');
  assert.strictEqual(e().ob.o.id, 'f'); assert.strictEqual(e().base[fw], 6000, '東行き = b 方向'); assert.strictEqual(e().base[1 - fw], 7000);
  T.prepare(net, [est], {}); T.baseVolumes(net, 'd12');
  assert.deepStrictEqual(e().bst, ['est', 'est'], 'センサスの非観測区間は推定扱い');
  T.prepare(net, [], { area: 4 }); T.baseVolumes(net, 'd12');
  assert.deepStrictEqual(e().bst, ['attr', 'attr']); assert.ok(e().base[0] > 0, '属性からの推定値');
});

/* 混雑した幹線と、それを迂回する計画道路 */
function bypassCase(planned) {
  const roads = [
    line('w', [[-1500, 0], [0, 0]], { kind: 'tr' }), line('main', [[0, 0], [1000, 0], [2000, 0]], { kind: 'tr' }), line('e', [[2000, 0], [3500, 0]], { kind: 'tr' }),
    line('n', [[1000, 0], [1000, 1200]], { kind: 'se' }), line('s', [[1000, 0], [1000, -1200]], { kind: 'se' }),
  ];
  if (planned) roads.push(line('bp', [[0, 0], [1000, -400], [2000, 0]], { planned: true, kind: 'pr', lanes: 2, speed: 60, cross: true }));
  const net = T.buildNetwork(roads);
  const obs = [
    { id: 'o1', src: 'field', date: '20260401', p: { x: -700, y: 0 }, av: { x: 1, y: 0 }, a: { day: 14000 }, b: { day: 13500 } },
    { id: 'o2', src: 'field', date: '20260401', p: { x: 2700, y: 0 }, av: { x: 1, y: 0 }, a: { day: 13000 }, b: { day: 13000 } },
    { id: 'o3', src: 'field', date: '20260401', p: { x: 1000, y: 600 }, av: { x: 0, y: 1 }, a: { day: 2500 }, b: { day: 2500 } },
    { id: 'o4', src: 'field', date: '20260401', p: { x: 1000, y: -900 }, av: { x: 0, y: -1 }, a: { day: 2000 }, b: { day: 2500 } },
  ];
  T.prepare(net, obs, { area: 2 });
  return net;
}
test('予測: 現況を再現し、計画道路で幹線の交通量と混雑度が下がる（全手法）', () => {
  for (const assign of Object.keys(T.ASSIGN_METHODS)) for (const od of Object.keys(T.OD_METHODS)) {
    const net = bypassCase(true), r = T.run(net, { assign, od, internal: 0 });
    assert.ok(!r.failed, `${assign}/${od}`);
    const mainI = net.edges.map((e, i) => (e.rid === 'main' ? i : -1)).filter((i) => i >= 0);
    const two = (c, i) => c.x[2 * i] + c.x[2 * i + 1];
    const b = Math.max(...mainI.map((i) => two(r.before, i))), a = Math.max(...mainI.map((i) => two(r.after, i)));
    assert.ok(a < b * 0.97, `${assign}/${od}: 幹線が減る ${Math.round(b)} → ${Math.round(a)}`);
    assert.ok(r.plan.bp.max > 100, `${assign}/${od}: 計画道路に交通が乗る`);
    assert.ok(r.sum.after.vht <= r.sum.before.vht * 1.02, `${assign}/${od}: 総走行時間が増えない`);
    net.edges.forEach((e, i) => { if (e.planned) assert.strictEqual(two(r.before, i), 0, '計画道路なしでは計画道路の交通量は 0'); });
    if (od === 'entropy' && assign !== 'aon' && assign !== 'div') assert.ok(r.fit.rmse < 0.15, `${assign}: 現況再現 RMSE ${r.fit.rmse}`);
  }
});

test('計画道路が無ければ前後は同じ。出入口が足りなければ失敗を返す', () => {
  const net = bypassCase(false), r = T.run(net, { internal: 0 });
  assert.strictEqual(r.hasPlan, false); assert.strictEqual(r.after, r.before);
  const lone = T.buildNetwork([line('a', [[0, 0], [100, 0]], { kind: 'sv' })]); T.prepare(lone, [], { area: 2 });
  assert.strictEqual(T.run(lone, {}).failed, true);
});

test('伸び率を掛けると交通量が増える', () => {
  const r1 = T.run(bypassCase(true), { internal: 0 }), r2 = T.run(bypassCase(true), { internal: 0, growth: 1.2 });
  near(r2.trips / r1.trips, 1.2, 0.01);
});
