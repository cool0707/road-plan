const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/v3d-city.js');

/* 最小の protobuf エンコーダー（テスト用の MVT を組み立てる） */
const varint = (v) => { const o = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 128; o.push(b); } while (v); return o; };
const field = (n, wire, bytes) => [...varint(n * 8 + wire), ...bytes];
const lenf = (n, bytes) => field(n, 2, [...varint(bytes.length), ...bytes]);
const zig = (v) => (v < 0 ? -v * 2 - 1 : v * 2);
function polygonGeom(rings) {
  const out = []; let x = 0, y = 0;
  for (const r of rings) {
    out.push(...varint(1 * 8 + 1), ...varint(zig(r[0][0] - x)), ...varint(zig(r[0][1] - y))); x = r[0][0]; y = r[0][1];
    out.push(...varint((r.length - 1) * 8 + 2));
    for (let i = 1; i < r.length; i++) { out.push(...varint(zig(r[i][0] - x)), ...varint(zig(r[i][1] - y))); x = r[i][0]; y = r[i][1]; }
    out.push(...varint(1 * 8 + 7));
  }
  return out;
}
function mvt(layerName, key, feats) {
  const str = (s) => [...Buffer.from(s)];
  const layer = [...lenf(1, str(layerName)), ...feats.flatMap((f, i) => lenf(2, [...lenf(2, [0, i]), ...field(3, 0, [3]), ...lenf(4, polygonGeom(f.rings))])), ...lenf(3, str(key)), ...feats.flatMap((f) => lenf(4, field(4, 0, varint(f.value)))), ...field(5, 0, varint(4096))];
  return new Uint8Array(lenf(3, layer));
}

test('MVT: 多角形と属性を読める（要らないレイヤーは読み飛ばす）', () => {
  const buf = mvt('BldA', 'vt_code', [{ value: 3101, rings: [[[10, 10], [110, 10], [110, 60], [10, 60]]] }, { value: 3103, rings: [[[200, 200], [300, 200], [300, 300], [200, 300]], [[220, 220], [220, 280], [280, 280], [280, 220]]] }]);
  const t = C.parseMVT(buf, { BldA: true });
  assert.strictEqual(t.BldA.feats.length, 2);
  assert.deepStrictEqual(t.BldA.feats[0].rings[0], [[10, 10], [110, 10], [110, 60], [10, 60]]);
  assert.strictEqual(t.BldA.feats[1].props.vt_code, 3103);
  assert.strictEqual(t.BldA.feats[1].rings.length, 2);
  assert.deepStrictEqual(C.parseMVT(buf, { WA: true }), {});
  const p = C.tilePolys(t.BldA, 0, 0);
  assert.strictEqual(p.length, 2);
  assert.strictEqual(p[1].holes.length, 1);
});

test('タイル境界で分かれた建物を 1 つにつなぐ', () => {
  const E = 4096, L = (rings) => ({ extent: E, feats: [{ type: 3, props: { vt_code: 3101 }, rings }] });
  // 幅 200 の長方形が x = 4096 の境界をまたぐ（両タイルとも 80 の余白つきで切られている）
  const A = C.tilePolys(L([[[4000, 100], [4176, 100], [4176, 300], [4000, 300]]]), 0, 0);
  const B = C.tilePolys(L([[[-80, 100], [104, 100], [104, 300], [-80, 300]]]), 1, 0);
  const g = C.mergeTiles(A.concat(B), E);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].parts.length, 1);
  assert.strictEqual(g[0].parts[0].outer.length, 4);
  assert.strictEqual(Math.abs(C.area2(g[0].parts[0].outer)) / 2, 200 * 200);
  // 境界に接しているだけの別々の建物はまとめない
  const P = C.tilePolys(L([[[3900, 100], [4096, 100], [4096, 200], [3900, 200]]]), 0, 0), Q = C.tilePolys(L([[[0, 500], [100, 500], [100, 600], [0, 600]]]), 1, 0);
  assert.strictEqual(C.mergeTiles(P.concat(Q), E).length, 2);
});

test('外接長方形: 斜めの長方形の向きと大きさ', () => {
  const c = Math.cos(0.5), s = Math.sin(0.5), ring = [[-10, -4], [10, -4], [10, 4], [-10, 4]].map(([x, y]) => [x * c - y * s + 30, x * s + y * c - 7]);
  const b = C.obb(ring);
  assert.ok(Math.abs(b.hu - 10) < 1e-9 && Math.abs(b.hv - 4) < 1e-9);
  assert.ok(Math.abs(Math.abs(b.ux * c + b.uy * s) - 1) < 1e-9);
  assert.ok(Math.abs(b.fill - 1) < 1e-9);
});

test('高さ: 実測があればその値、なければ種別から推定', () => {
  const sq = (x, y, w) => [[x, y], [x + w, y], [x + w, y + w], [x, y + w]];
  const bl = [{ code: 3103, parts: [{ outer: sq(0, 0, 30), holes: [], seam: new Set() }], area: 900 }, { code: 3101, parts: [{ outer: sq(100, 0, 10), holes: [], seam: new Set() }], area: 100 }];
  const n = C.assignHeights(bl, [{ ring: sq(-2, -2, 34), h: 173, x0: -2, y0: -2, x1: 32, y1: 32 }, { ring: sq(5, 5, 8), h: 12, x0: 5, y0: 5, x1: 13, y1: 13 }]);
  assert.strictEqual(n, 1);
  assert.strictEqual(bl[0].h, 173);
  assert.strictEqual(bl[1].h, undefined);
  assert.strictEqual(C.classify(3103, 900, 15, 15, 173).h, 173);
  assert.strictEqual(C.classify(3103, 900, 15, 15, 173).kind, 2);
  const est = C.classify(3101, 100, 105, 5);
  assert.ok(est.gable && est.h > 2 && est.h < 10);
  const tower = C.classify(3103, 900, 15, 15);
  assert.ok(tower.h >= 40 && tower.h <= 180);
});
