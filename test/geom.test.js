const test = require('node:test');
const assert = require('node:assert');
const G = require('../js/geom.js');
const Rules = require('../js/rules.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg || ''} ${a} vs ${b}`);

test('クロソイド終点座標が級数解と一致', () => {
  const R = 100, L = 50, tau = L / (2 * R);
  const X = L * (1 - tau ** 2 / 10 + tau ** 4 / 216 - tau ** 6 / 9360);
  const Y = L * (tau / 3 - tau ** 3 / 42 + tau ** 5 / 1320);
  const s = G.spiral(R, L);
  near(s.X, X, 1e-6, 'X');
  near(s.Y, Y, 1e-6, 'Y');
});

test('対称・非対称・左右の曲線で終点が次の接線に乗る', () => {
  const cases = [
    [{ x: 0, y: 0 }, { x: 300, y: 0, R: 100, A1: 60, A2: 60 }, { x: 500, y: 250 }],
    [{ x: 0, y: 0 }, { x: 300, y: 0, R: 80, A1: 40, A2: 70 }, { x: 450, y: -300 }],
    [{ x: 0, y: 0 }, { x: 300, y: 50, R: 150, A1: 0, A2: 0 }, { x: 350, y: 400 }],
    [{ x: 0, y: 0 }, { x: 200, y: 0, R: 60, A1: 45, A2: 0 }, { x: 100, y: 200 }],
  ];
  for (const ips of cases) {
    const al = G.computeAlignment(ips);
    assert.deepStrictEqual(al.issues, []);
    const end = G.poseAt(al, al.length);
    near(end.x, ips[2].x, 1e-6, 'EP x');
    near(end.y, ips[2].y, 1e-6, 'EP y');
    near(G.wrap(end.th - al.dirs[1]), 0, 1e-9, 'EP 方向');
    const c = al.curves[1];
    near(c.L1 + c.Lc + c.L2, c.CL, 1e-9);
    near(al.length, al.dists[0] - c.T1 + c.CL + al.dists[1] - c.T2, 1e-6, '延長');
  }
});

test('S字（複数IP）と重複検出', () => {
  const ips = [{ x: 0, y: 0 }, { x: 200, y: 0, R: 80, A1: 50, A2: 50 }, { x: 350, y: 150, R: 80, A1: 50, A2: 50 }, { x: 600, y: 150 }];
  const al = G.computeAlignment(ips);
  assert.deepStrictEqual(al.issues, []);
  const end = G.poseAt(al, al.length);
  near(end.x, 600, 1e-6); near(end.y, 150, 1e-6);
  ips[1].R = ips[2].R = 400;
  assert.ok(G.computeAlignment(ips).issues.some((i) => i.type === 'overlap'));
});

test('project: 測点とオフセット', () => {
  const al = G.computeAlignment([{ x: 0, y: 0 }, { x: 300, y: 0, R: 100, A1: 60, A2: 60 }, { x: 500, y: 250 }]);
  const pts = G.sample(al).all;
  const p = G.poseAt(al, 250);
  const q = G.project(al, pts, p.x - Math.sin(p.th) * 3, p.y + Math.cos(p.th) * 3);
  near(q.s, 250, 1e-3); near(q.offset, 3, 1e-3);
});

test('照査: 最小曲線半径と緩和区間', () => {
  const road = { cls: '3-3', V: 40, lanes: 2, laneW: 3, shoulderW: 0.75, sidewalkW: 0, conn: {}, ips: [{ x: 0, y: 0 }, { x: 200, y: 0, R: 40, A1: 20, A2: 40 }, { x: 300, y: 200 }] };
  const res = Rules.check(road, G.computeAlignment(road.ips));
  assert.ok(res.some((r) => r.level === 'error' && r.cat === '曲線半径'));
  assert.ok(res.some((r) => r.level === 'error' && r.cat === '緩和区間'));
  road.ips[1].R = 100; road.ips[1].A1 = road.ips[1].A2 = 60;
  const ok = Rules.check(road, G.computeAlignment(road.ips));
  assert.ok(!ok.some((r) => r.level === 'error'), JSON.stringify(ok.filter((r) => r.level === 'error')));
});

test('既存道路の区間分割: 交差点・屈曲点で区切る', () => {
  // 東へ 100m → 北へ 50m（L 字）。x=40 で南北道路が横断
  const xy = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }];
  const cross = [{ x: 40, y: -20 }, { x: 40, y: 20 }];
  const br = G.polyBreaks(xy, [cross]);
  assert.strictEqual(br.length, 4);
  near(br[1], 0.4, 1e-9, '交差'); assert.strictEqual(br[2], 1); assert.strictEqual(br[3], 2);
  assert.deepStrictEqual(G.pieceAt(br, G.polyNearest(xy, { x: 70, y: 3 })), [br[1], 1]);
  const pts = xy.map((p) => [p.y, p.x]);
  const part = G.polySlice(pts, br[1], 1);
  assert.deepStrictEqual(part, [[0, 40], [0, 100]]);
  assert.deepStrictEqual(G.polySlice(pts, 0.4, 2), [[0, 40], [0, 100], [50, 100]]);
  // 緩い折れ（10°）では区切らない
  const gentle = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 50 * Math.tan(10 * Math.PI / 180) }];
  assert.deepStrictEqual(G.polyBreaks(gentle, []), [0, 2]);
});
