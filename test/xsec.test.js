const test = require('node:test');
const assert = require('node:assert');
const G = require('../js/geom.js');
const X = require('../js/xsec.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg || ''} ${a} vs ${b}`);
const road = (o = {}) => Object.assign({ id: 'r', V: 40, cls: '3-3', lanes: 2, laneW: 3, shoulderW: 0.5, sidewalkW: 0, conn: {}, ips: [{ x: 0, y: -100, R: 0, A1: 0, A2: 0 }, { x: 0, y: 100, R: 0, A1: 0, A2: 0 }] }, o);
function model(r, gAt) {
  const al = G.computeAlignment(r.ips);
  al.samples = G.sample(al, 1);
  const rows = X.stationsOf(al); rows.forEach((q) => { q.g = gAt(q.x, q.y); });
  return X.buildModel(r, al, rows);
}
const run = (r, gAt, line) => { const M = model(r, gAt), pts = X.densify(line, 0.1); pts.forEach((p) => { p.g = gAt(p.x, p.y); }); return X.section(pts, [M]); };

test('平地を横切る断面: 路面は計画高から 2% の拝み勾配、幅員の外は地盤のまま', () => {
  const r = road({ vips: [{ s: 0, z: 10 }, { s: 200, z: 10 }] });
  const pts = run(r, () => 10, [{ x: -20, y: 0 }, { x: 20, y: 0 }]);
  const at = (d) => pts.reduce((a, p) => (Math.abs(p.d - d) < Math.abs(a.d - d) ? p : a));
  near(at(20).z, 10, 1e-6, '中心');
  assert.strictEqual(at(20).kind, 'road');
  near(at(20 + 3.5).z, 10 - 0.02 * 3.5, 1e-3, '路肩端');
  assert.strictEqual(at(0).kind, null);
});

test('盛土・切土ののり面勾配（盛 1:1.5、切 1:1.0）', () => {
  const fill = run(road({ vips: [{ s: 0, z: 13 }, { s: 200, z: 13 }] }), () => 10, [{ x: -30, y: 0 }, { x: 30, y: 0 }]);
  const edge = 13 - 0.02 * 3.5, p = fill.find((q) => Math.abs(q.d - (30 - 3.5 - 1.5)) < 0.05);
  assert.strictEqual(p.kind, 'fill');
  near(p.z, edge - 1.5 / 1.5, 0.02, '盛土 1:1.5');
  const cut = run(road({ vips: [{ s: 0, z: 7 }, { s: 200, z: 7 }] }), () => 10, [{ x: -30, y: 0 }, { x: 30, y: 0 }]);
  const c = cut.find((q) => Math.abs(q.d - (30 + 3.5 + 1)) < 0.05);
  assert.strictEqual(c.kind, 'cut');
  near(c.z, 7 - 0.07 + 1, 0.02, '切土 1:1.0');
});

test('盛土高 8m 超は橋梁（地盤はそのまま、桁上面に計画高）', () => {
  const pts = run(road({ vips: [{ s: 0, z: 25 }, { s: 200, z: 25 }] }), () => 10, [{ x: -20, y: 0 }, { x: 20, y: 0 }]);
  const mid = pts.find((q) => Math.abs(q.d - 20) < 0.05);
  near(mid.z, 10, 1e-6); near(mid.deck, 25, 1e-6);
});

test('断面線と道路の交差位置・交差角', () => {
  const c = X.crossings([{ x: -10, y: -10 }, { x: 10, y: 10 }], [{ x: 0, y: -50 }, { x: 0, y: 50 }]);
  assert.strictEqual(c.length, 1);
  near(c[0].d, Math.hypot(10, 10), 1e-6); near(c[0].ang, 45, 1e-6);
});
