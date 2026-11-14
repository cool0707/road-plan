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

test('縦断: 勾配直線と放物線縦断曲線が接線で連続する', () => {
  const pf = G.computeProfile([{ s: 0, z: 10 }, { s: 200, z: 16, VCL: 80 }, { s: 999, z: 12 }], 400);
  assert.deepStrictEqual(pf.issues, []);
  near(pf.pts[2].s, 400, 1e-9, 'EP は延長に合わせる');
  near(pf.grades[0], 0.03, 1e-12, 'g1'); near(pf.grades[1], -0.02, 1e-12, 'g2');
  const c = pf.curves[0];
  assert.ok(c.crest, '凸形');
  near(c.R, 80 / 0.05, 1e-6, 'R = L/Δg');
  for (const s of [c.bvc, c.evc]) {
    const a = G.profileAt(pf, s - 1e-6), b = G.profileAt(pf, s + 1e-6);
    near(a.z, b.z, 1e-5, '高さ連続'); near(a.g, b.g, 1e-5, '勾配連続');
  }
  // VIP 位置の縦距 = Δg·L/8
  near(16 - G.profileAt(pf, 200).z, (0.05 * 80) / 8, 1e-9, '中央縦距');
  near(G.profileAt(pf, 0).z, 10, 1e-9); near(G.profileAt(pf, 400).z, 12, 1e-9);
  near(G.maxGradeIn(pf, 150, 230), 0.03, 1e-9, '区間最大勾配');
  near(G.maxGradeIn(pf, 190, 210), Math.max(Math.abs(G.profileAt(pf, 190).g), Math.abs(G.profileAt(pf, 210).g)), 1e-9, '曲線内');
});

test('縦断: 曲線の重なりと順序不正を検出', () => {
  const pf = G.computeProfile([{ s: 0, z: 0 }, { s: 50, z: 3, VCL: 80 }, { s: 90, z: 0, VCL: 60 }, { s: 200, z: 1 }], 200);
  assert.ok(pf.issues.some((i) => i.type === 'overlap' && i.i === 1));
  const pf2 = G.computeProfile([{ s: 0, z: 0 }, { s: 120, z: 3 }, { s: 100, z: 0 }, { s: 200, z: 1 }], 200);
  assert.ok(pf2.issues.some((i) => i.type === 'order'));
});

test('縦断照査: 勾配・縦断曲線の規定', () => {
  const road = { cls: '3-3', V: 40, lanes: 2, laneW: 3, shoulderW: 0.75, sidewalkW: 0, ips: [{ x: 0, y: 0 }, { x: 300, y: 0 }], conn: { start: null, end: null } };
  const al = G.computeAlignment(road.ips);
  const run = (vips) => Rules.check(road, al, { vplan: { pf: G.computeProfile(vips, al.length), ends: {}, comb: [] } });
  const ok = run([{ s: 0, z: 0 }, { s: 150, z: 6, VCL: 60 }, { s: 300, z: 3 }]);
  assert.ok(!ok.some((r) => r.level === 'error' && /縦断/.test(r.cat)), JSON.stringify(ok.filter((r) => r.level === 'error')));
  const steep = run([{ s: 0, z: 0 }, { s: 300, z: 33 }]); // 11% > 特例 10%
  assert.ok(steep.some((r) => r.level === 'error' && r.cat === '縦断勾配'));
  const ex = run([{ s: 0, z: 0 }, { s: 300, z: 25 }]); // 8.3%: 標準 7% 超・特例 10% 以下
  assert.ok(ex.some((r) => r.level === 'warn' && r.cat === '縦断勾配'));
  const noVc = run([{ s: 0, z: 0 }, { s: 150, z: 6 }, { s: 300, z: 3 }]);
  assert.ok(noVc.some((r) => r.level === 'error' && r.cat === '縦断曲線'));
  const shortR = run([{ s: 0, z: 0 }, { s: 150, z: 6, VCL: 35 }, { s: 300, z: 3 }]); // R=35/0.06=583 OK, L=35 OK
  assert.ok(!shortR.some((r) => r.level === 'error' && r.cat === '縦断曲線'));
  const smallR = run([{ s: 0, z: 0 }, { s: 150, z: 10, VCL: 35 }, { s: 300, z: 0 }]); // Δg=13.3% → R=262 < 450
  assert.ok(smallR.some((r) => r.level === 'error' && r.cat === '縦断曲線' && /R=/.test(r.title)));
});

test('片勾配: IP に設定した値を使い、未設定なら必要片勾配から自動', () => {
  const road = { cls: '3-2', V: 60, lanes: 2, laneW: 3.25, shoulderW: 0.75, sidewalkW: 0, ips: [{ x: 0, y: 0 }, { x: 100, y: 0, R: 200 }, { x: 200, y: 100 }] };
  const auto = Rules.superelevation(road, 1, 200);
  assert.strictEqual(auto.set, false);
  near(auto.e, Rules.curveSpeed(road, 200).e, 1e-12);
  road.ips[1].e = 4;
  const set = Rules.superelevation(road, 1, 200);
  assert.strictEqual(set.set, true);
  near(set.e, 0.04, 1e-12);
  near(set.vSafe, Math.sqrt(127 * 200 * (0.04 + Rules.T[60].f)), 1e-9);
  assert.ok(set.vSafe < auto.vSafe + 1e-9 || auto.e <= 0.04);
});
