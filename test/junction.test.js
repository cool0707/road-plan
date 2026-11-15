const test = require('node:test');
const assert = require('node:assert');
const J = require('../js/v3d-junction.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg || ''} ${a} vs ${b}`);
/* 折れ線 pts から測点列を作る（view3d の roadStations / existingStations と同じ形） */
function road(pts, W, o = {}) {
  const rows = [], vk = [];
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(l / 2.5), th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    for (let k = i ? 1 : 0; k <= n; k++) {
      rows.push({ s: s + (l * k) / n, x: a[0] + ((b[0] - a[0]) * k) / n, y: a[1] + ((b[1] - a[1]) * k) / n, c: Math.cos(th), sn: Math.sin(th), z: o.z ?? 0, slope: [-0.02, -0.02], k: 0, bridge: false });
      if (k === 0 || k === n) vk.push(rows.length - 1);
    }
    s += l;
  }
  return Object.assign({ rows, W, E: W + (o.sw || 0), sw: o.sw || 0, cw: o.cw || 0, L: s, vk }, o.extra || {});
}
const surfZ = (R, r, d) => r.z + r.slope[d >= 0 ? 0 : 1] * Math.min(Math.abs(d), R.W);
const inAny = (pad, x, y) => J.inPad(pad, x, y);

test('計画道路が 2 車線の既存道路と直交: 4 枝の交差点、既存道路は手前で切り、横断歩道と停止線', () => {
  const plan = road([[-80, 0], [80, 0]], 3.75, { sw: 2.5, cw: 6, extra: { road: { lanes: 2, laneW: 3 } } });
  const ex = road([[0, -80], [0, 80]], 3.5, { z: 0.6 });
  const out = J.build([plan], [ex], surfZ);
  assert.strictEqual(out.pads.length, 1);
  const pad = out.pads[0];
  assert.strictEqual(pad.arms, 4);
  assert.ok(pad.plan);
  // 交差点の中心と隅切りの部分は舗装、ブロックの角（道路の外）は舗装しない
  assert.ok(inAny(pad, 0, 0));
  assert.ok(inAny(pad, 4.2, 4.2), '隅切り');
  assert.ok(!inAny(pad, 12, 12), 'ブロックの角');
  // 既存道路は 2 本に分かれ、交差点の手前で終わる
  assert.strictEqual(out.exs.length, 2);
  for (const R of out.exs) for (const r of R.rows) assert.ok(Math.abs(r.y) > 3.75 + 3, `切った既存道路が交差点に残る ${r.y}`);
  // 切る位置で計画道路の路面高にすりつく（計画道路の端の高さ = 0 − 2% × 3.75）
  const cut = out.exs.map((R) => (R.rows[0].y > 0 ? R.rows[0] : R.rows[R.rows.length - 1]));
  for (const r of cut) near(r.z, -0.02 * 3.75, 0.02, '切る位置の高さ');
  // 遠くは元の高さのまま
  near(out.exs[0].rows[0].z + out.exs[1].rows[out.exs[1].rows.length - 1].z, 1.2, 0.01, '遠くの高さ');
  // 計画道路: 区画線と歩道は交差点の中で途切れる
  const q = pad.plans[0];
  assert.ok(q.marks.length === 1 && q.marks[0][0] < 80 && q.marks[0][1] > 80);
  assert.ok(J.inGaps(80, q.walk[1]) && J.inGaps(80, q.walk[-1]));
  assert.ok(!J.inGaps(60, q.walk[1]));
  // 横断歩道 4 か所・停止線 4 本・隅の歩道 4 か所
  assert.strictEqual(pad.lines.filter((l) => l.kind === 'zebra').length, 4);
  assert.strictEqual(pad.lines.filter((l) => l.kind === 'stop').length, 4);
  assert.strictEqual(pad.walks.length, 4);
});

test('左側通行: 停止線は交差点へ向かう車線（左側）だけ', () => {
  const plan = road([[-80, 0], [80, 0]], 3.75, { cw: 6, extra: { road: { lanes: 2, laneW: 3 } } });
  const ex = road([[0, -80], [0, 80]], 3.5);
  const pad = J.build([plan], [ex], surfZ).pads[0];
  for (const l of pad.lines.filter((x) => x.kind === 'stop' && x.R === plan)) {
    const s = (l.s0 + l.s1) / 2, d = (l.d[0] + l.d[1]) / 2;
    // 東側（s > 80）は西向きに走って交差点へ入る → 左側通行で南側（中心線の右、d < 0）。西側は北側
    if (s > 80) assert.ok(d < 0, `東側の停止線 ${d}`); else assert.ok(d > 0, `西側の停止線 ${d}`);
  }
});

test('狭い道路が接するだけの T 字: 計画道路の中央線は切らず、外側線だけ切って脇道に停止線', () => {
  const plan = road([[-80, 0], [80, 0]], 3.5, { cw: 6, extra: { road: { lanes: 2, laneW: 3 } } });
  const ex = road([[10, 0], [10, 60]], 1.5); // 計画道路の中心線で終わる幅 3m の道路
  const pad = J.build([plan], [ex], surfZ).pads[0];
  assert.strictEqual(pad.arms, 3);
  const q = pad.plans[0];
  assert.deepStrictEqual(q.marks, []);
  assert.ok(J.inGaps(90, q.walk[1]), '脇道の側の外側線は切る');
  assert.deepStrictEqual(q.walk[-1], [], '反対側は切らない');
  assert.strictEqual(pad.lines.length, 1);
  assert.strictEqual(pad.lines[0].kind, 'stop');
  assert.strictEqual(pad.lines[0].R, ex);
});

test('既存道路どうしの十字路: 頂点を共有する 4 本から交差点を作り、高さは枝の平均で水平', () => {
  const a = road([[-50, 0], [0, 0]], 2.5, { z: 1 }), b = road([[0, 0], [50, 0]], 2.5, { z: 1 }), c = road([[0, -50], [0, 0]], 2.5, { z: 3 }), d = road([[0, 0], [0, 50]], 2.5, { z: 3 });
  const out = J.build([], [a, b, c, d], surfZ);
  assert.strictEqual(out.pads.length, 1);
  const pad = out.pads[0];
  assert.strictEqual(pad.arms, 4);
  assert.ok(!pad.plan);
  near(pad.padZ(0, 0), 2, 1e-9);
  assert.deepStrictEqual(pad.lines, [], '既存道路だけの交差点には横断歩道を描かない');
  assert.strictEqual(out.exs.length, 4);
  for (const R of out.exs) { const e = R.rows.find((r) => Math.hypot(r.x, r.y) < 10); assert.ok(e, '切った端'); near(e.z, 2, 0.05); }
});

test('橋で越える所・高低差の大きい所は交差点にしない', () => {
  const plan = road([[-80, 0], [80, 0]], 3.75, { z: 10 });
  plan.rows.forEach((r) => { r.bridge = Math.abs(r.x) < 20; });
  const ex = road([[0, -80], [0, 80]], 3.5);
  assert.strictEqual(J.build([plan], [ex], surfZ).pads.length, 0);
  const cut = road([[-80, 0], [80, 0]], 3.75, { z: -8 });
  assert.strictEqual(J.build([cut], [road([[0, -80], [0, 80]], 3.5)], surfZ).pads.length, 0);
});

test('近くの交差点で舗装面が重なるときは 1 つにまとめる', () => {
  const plan = road([[-80, 0], [80, 0]], 3.75, { cw: 6, extra: { road: { lanes: 2, laneW: 3 } } });
  const out = J.build([plan], [road([[0, -60], [0, 60]], 3.5), road([[9, -60], [9, 60]], 3.5)], surfZ);
  assert.strictEqual(out.pads.length, 1);
  assert.strictEqual(out.pads[0].arms, 6);
});

test('区間の引き算と補間', () => {
  assert.deepStrictEqual(J.minus(10, [[2, 3], [5, 4]]), [[0, 2], [3, 4], [5, 10]]);
  assert.deepStrictEqual(J.minus(10, [[2, 3]], 4), [[4, 10]]);
  const R = road([[0, 0], [10, 0]], 2);
  const r = J.rowAt(R.rows, 3.3);
  near(r.x, 3.3, 1e-9);
  const sl = J.slice(R.rows, 1.2, 6.1);
  near(sl[0].s, 1.2, 1e-9); near(sl[sl.length - 1].s, 6.1, 1e-9);
});
