/* Road Plan — 3D ビューの交差点
 * 計画道路・既存道路の中心線が交わる所（既存道路どうしの分岐点、計画道路と既存道路・計画道路どうしの交差、
 * 計画道路の端が他の道路に接する T 字）を交差点として、次のものを作る（three.js は使わない。描画は view3d.js）。
 *  - 交差点の舗装面（隅切り＝縁石の巻き込みの円弧つき）。既存道路はその手前で切り、路面の高さを交差点の高さへすりつける
 *  - 計画道路の区画線・歩道を交差点の中で途切れさせる区間、隅の歩道（巻き込み部）
 *  - 横断歩道・停止線（計画道路が関わる交差点だけ）
 * ブラウザでは V3DJunction、node（テスト）では module.exports。 */
'use strict';

(function (root) {
  const sstep = (v) => { const t = Math.min(1, Math.max(0, v)); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const cross = (ax, ay, bx, by) => ax * by - ay * bx;

  /* 測点列 rows（s の昇順）の s の位置を補間する */
  function rowAt(rows, s) {
    const n = rows.length;
    if (s <= rows[0].s) return rows[0];
    if (s >= rows[n - 1].s) return rows[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m].s <= s) lo = m; else hi = m; }
    const a = rows[lo], b = rows[hi], t = (s - a.s) / (b.s - a.s || 1);
    const c = lerp(a.c, b.c, t), sn = lerp(a.sn, b.sn, t), l = Math.hypot(c, sn) || 1;
    return {
      s, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t), g: a.g != null && b.g != null ? lerp(a.g, b.g, t) : a.g, k: lerp(a.k || 0, b.k || 0, t),
      c: c / l, sn: sn / l, slope: [lerp(a.slope[0], b.slope[0], t), lerp(a.slope[1], b.slope[1], t)], bridge: t < 0.5 ? a.bridge : b.bridge,
    };
  }
  /* rows の [s0, s1] の部分（両端は補間した測点） */
  function slice(rows, s0, s1) {
    const out = [rowAt(rows, s0)];
    for (const r of rows) if (r.s > s0 + 1e-3 && r.s < s1 - 1e-3) out.push(r);
    out.push(rowAt(rows, s1));
    return out;
  }
  /* 区間 [0, L] から gaps（[a, b] の並び）を除いた区間 */
  function minus(L, gaps, s0 = 0) {
    const g = gaps.map(([a, b]) => [Math.max(s0, Math.min(a, b)), Math.min(L, Math.max(a, b))]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
    const out = []; let cur = s0;
    for (const [a, b] of g) { if (a > cur) out.push([cur, a]); cur = Math.max(cur, b); }
    if (cur < L) out.push([cur, L]);
    return out;
  }
  const inGaps = (s, gaps, pad = 0) => gaps.some(([a, b]) => s >= Math.min(a, b) - pad && s <= Math.max(a, b) + pad);

  /* 横断位置 d（中心線の左が正）の平面位置 */
  const at = (r, d) => ({ x: r.x - r.sn * d, y: r.y + r.c * d });

  function bbox(rows, m = 0) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rows) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x); y1 = Math.max(y1, r.y); }
    return [x0 - m, y0 - m, x1 + m, y1 + m];
  }
  const overlap = (a, b) => !(a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3]);

  /* 2 本の測点列の中心線の交点 → [{ x, y, sa, sb }] */
  function crossings(A, B) {
    const out = [], ra = A.rows, rb = B.rows;
    if (!overlap(A.bb, B.bb)) return out;
    for (let i = 1; i < ra.length; i++) {
      const a = ra[i - 1], b = ra[i];
      const ax0 = Math.min(a.x, b.x), ax1 = Math.max(a.x, b.x), ay0 = Math.min(a.y, b.y), ay1 = Math.max(a.y, b.y);
      if (ax1 < B.bb[0] || ax0 > B.bb[2] || ay1 < B.bb[1] || ay0 > B.bb[3]) continue;
      for (let j = 1; j < rb.length; j++) {
        const c = rb[j - 1], d = rb[j];
        if (Math.max(c.x, d.x) < ax0 || Math.min(c.x, d.x) > ax1 || Math.max(c.y, d.y) < ay0 || Math.min(c.y, d.y) > ay1) continue;
        const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y, den = cross(rx, ry, sx, sy);
        if (Math.abs(den) < 1e-9) continue;
        const qx = c.x - a.x, qy = c.y - a.y, t = cross(qx, qy, sx, sy) / den, u = cross(qx, qy, rx, ry) / den;
        if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
        out.push({ x: a.x + rx * t, y: a.y + ry * t, sa: lerp(a.s, b.s, t), sb: lerp(c.s, d.s, u) });
      }
    }
    return out;
  }
  /* 点 p に最も近い中心線上の位置 → { s, x, y, dist } */
  function nearest(R, p) {
    let best = null;
    const rows = R.rows;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
      const x = a.x + vx * t, y = a.y + vy * t, dist = Math.hypot(p.x - x, p.y - y);
      if (!best || dist < best.dist) best = { s: lerp(a.s, b.s, t), x, y, dist };
    }
    return best;
  }
  /* 中心 C・半径 rho の円と中心線の交点（交差点の「枝」の付け根）。dir: 交差点から離れる向きが s の増える向きなら +1 */
  function exits(R, C, rho) {
    const out = [], rows = R.rows;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i], vx = b.x - a.x, vy = b.y - a.y, fx = a.x - C.x, fy = a.y - C.y;
      const A = vx * vx + vy * vy, Bq = 2 * (fx * vx + fy * vy), Cq = fx * fx + fy * fy - rho * rho, disc = Bq * Bq - 4 * A * Cq;
      if (A < 1e-12 || disc <= 0) continue;
      const sq = Math.sqrt(disc);
      for (const t of [(-Bq - sq) / (2 * A), (-Bq + sq) / (2 * A)]) {
        if (t < 0 || t >= 1) continue;
        const x = a.x + vx * t, y = a.y + vy * t, dir = (x - C.x) * vx + (y - C.y) * vy > 0 ? 1 : -1;
        out.push({ s: lerp(a.s, b.s, t), x, y, dir });
      }
    }
    return out;
  }
  /* 同じ道路の枝を s の順に並べ、交差点の内側になる区間を返す（cut(arm) は枝ごとの切る位置） */
  function innerSpans(arms, L, cut) {
    const as = [...arms].sort((p, q) => p.sE - q.sE), out = [];
    for (let k = 0; k < as.length; k++) {
      const a = as[k];
      if (a.dir > 0) { if (k === 0) out.push([0, cut(a)]); }
      else {
        const b = as[k + 1];
        if (!b) out.push([cut(a), L]);
        else if (b.dir > 0) out.push([cut(a), cut(b)]);
      }
    }
    return out.filter(([p, q]) => q > p);
  }

  /* 隅切りの半径 [m]（縁石の巻き込み）。計画道路どうし 10m、計画道路と 2 車線の既存道路 7m、狭い道路 5m、既存道路どうし 3m */
  function cornerRadius(a, b) {
    if (a.plan && b.plan) return 10;
    if (a.plan || b.plan) { const o = a.plan ? b : a; return o.w * 2 >= 5.5 ? 7 : 5; }
    return 3;
  }

  const XW = 4, XGAP = 0.6, STOP = 1.5; // 横断歩道の幅（道路方向）・交差点からの離れ・停止線までの間隔

  /* 交差点を探して作る。
   * plans: 計画道路の測点（view3d の roadStations）、exs: 既存道路の測点（existingStations。vk = 元の頂点の測点番号）
   * surfZ(R, r, d): 横断位置 d の路面高。戻り値: { pads, exs: 交差点の手前で切った既存道路 } */
  function build(plans, exs, surfZ) {
    const roads = [...plans.map((R) => Object.assign(R, { plan: true })), ...exs.map((R) => Object.assign(R, { plan: false }))];
    roads.forEach((R) => { R.bb = bbox(R.rows, R.W + 2); R.L = R.rows[R.rows.length - 1].s; });
    const pts = [];
    const add = (x, y, mem) => pts.push({ x, y, mem, rw: Math.max(...mem.map((m) => m.R.W)) });
    const atGrade = (A, sa, B, sb) => {
      const ra = rowAt(A.rows, sa), rb = rowAt(B.rows, sb);
      if (ra.bridge || rb.bridge) return false;
      const dz = Math.abs(ra.z - rb.z);
      return A.plan && B.plan ? dz <= 1.5 : dz <= 6;
    };
    // 1) 既存道路の頂点を共有する所（端は 1 本、途中は 2 本の枝。3 本以上で交差点）
    const node = new Map();
    for (const R of exs) for (const m of R.vk || []) {
      const r = R.rows[m], key = r.x.toFixed(2) + ',' + r.y.toFixed(2);
      if (!node.has(key)) node.set(key, { x: r.x, y: r.y, mem: [], deg: 0 });
      const o = node.get(key); o.mem.push({ R, s: r.s }); o.deg += m === 0 || m === R.rows.length - 1 ? 1 : 2;
    }
    for (const o of node.values()) if (o.deg >= 3) add(o.x, o.y, o.mem);
    // 2) 計画道路と他の道路の交差
    for (let i = 0; i < plans.length; i++) {
      const A = plans[i];
      for (const B of [...plans.slice(i + 1), ...exs]) for (const c of crossings(A, B)) if (atGrade(A, c.sa, B, c.sb)) add(c.x, c.y, [{ R: A, s: c.sa }, { R: B, s: c.sb }]);
    }
    // 3) 端が他の道路の中心線の近くで終わる T 字（計画道路の端、計画道路の脇で終わる既存道路の端）
    const tee = (A, s, others, reach) => {
      const p = rowAt(A.rows, s);
      for (const B of others) {
        if (B === A || p.x < B.bb[0] || p.x > B.bb[2] || p.y < B.bb[1] || p.y > B.bb[3]) continue;
        const q = nearest(B, p);
        if (q && q.dist <= reach(B) && q.s > 0.5 && q.s < B.L - 0.5 && atGrade(A, s, B, q.s)) add(q.x, q.y, [{ R: A, s }, { R: B, s: q.s }]);
      }
    };
    for (const A of plans) for (const s of [0, A.L]) tee(A, s, roads, (B) => B.W + 1);
    for (const A of exs) for (const s of [0, A.L]) tee(A, s, plans, (B) => B.W + 1.5);

    // 近い点をまとめて 1 つの交差点にする
    const par = pts.map((_, i) => i), find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < Math.max(3, 0.75 * (a.rw + b.rw))) par[find(i)] = find(j);
    }
    const gm = new Map();
    pts.forEach((p, i) => { const k = find(i); if (!gm.has(k)) gm.set(k, []); gm.get(k).push(p); });
    // 舗装面が重なる交差点は 1 つにまとめて作り直す（まとめると大きくなりすぎるときは別々のまま）
    let items = [...gm.values()].map((g) => ({ g, pad: junction(g, surfZ) })).filter((o) => o.pad);
    const apart = new Set();
    for (let changed = true, guard = 0; changed && guard < 50; guard++) {
      changed = false;
      for (let i = 0; i < items.length && !changed; i++) for (let j = i + 1; j < items.length && !changed; j++) {
        const a = items[i], b = items[j], key = a.g[0].x + ',' + a.g[0].y + '|' + b.g[0].x + ',' + b.g[0].y;
        if (apart.has(key) || !padsOverlap(a.pad, b.pad)) continue;
        const g = [...a.g, ...b.g], pad = junction(g, surfZ);
        if (!pad) { apart.add(key); continue; }
        items.splice(j, 1); items[i] = { g, pad }; changed = true;
      }
    }
    const pads = items.map((o) => o.pad), cutsEx = new Map();
    for (const pad of pads) {
      for (const [R, spans] of pad.cuts) { if (!cutsEx.has(R)) cutsEx.set(R, []); cutsEx.get(R).push(...spans); }
      delete pad.cuts;
    }
    // 既存道路の高さ・横断勾配を交差点へすりつける。切る位置では交差点の路面に一致させる（2 つの交差点の間では近い方を優先）
    const blends = new Map();
    for (const pad of pads) for (const b of pad.blends) { if (!blends.has(b.R)) blends.set(b.R, []); blends.get(b.R).push(b); delete pad.blends; }
    for (const [R, bs] of blends) for (const r of R.rows) {
      let W = 0, sw = 0, sz = 0, s0 = 0, s1 = 0;
      for (const b of bs) {
        const q = (r.s - b.sCut) * b.dir;
        if (q > b.B || q < -b.inner) continue; // 交差点の向こう側（反対の枝）には効かせない
        const w = q <= 0 ? 1 : 1 - sstep(q / b.B), k = w / (1 - w + 1e-6);
        W = Math.max(W, w); sw += k; sz += k * b.z0; s0 += k * b.sl[0]; s1 += k * b.sl[1];
      }
      if (!(W > 0)) continue;
      r.z += (sz / sw - r.z) * W; r.slope = [lerp(r.slope[0], s0 / sw, W), lerp(r.slope[1], s1 / sw, W)];
    }
    for (const pad of pads) delete pad.blends;
    // 既存道路を交差点の手前で切る
    const out = [];
    for (const R of exs) {
      const spans = cutsEx.get(R);
      if (!spans) { out.push(R); continue; }
      for (const [a, b] of minus(R.L, spans)) if (b - a > 0.5) out.push(Object.assign({}, R, { rows: slice(R.rows, a, b) }));
    }
    roads.forEach((R) => { delete R.bb; });
    return { pads, exs: out };
  }

  /* 1 つの交差点（近い点のまとまり g）を作る */
  function junction(g, surfZ) {
    const C = { x: g.reduce((a, p) => a + p.x, 0) / g.length, y: g.reduce((a, p) => a + p.y, 0) / g.length };
    const rho = Math.max(1, ...g.map((p) => Math.hypot(p.x - C.x, p.y - C.y) + 0.5));
    if (rho > 25) return null; // 道路が重なって並ぶ所など。交差点として扱わない
    const roads = [...new Set(g.flatMap((p) => p.mem.map((m) => m.R)))];
    // 枝（中心線が円を出る所）
    let arms = [];
    for (const R of roads) for (const e of exits(R, C, rho)) {
      const r = rowAt(R.rows, e.s), u = { x: r.c * e.dir, y: r.sn * e.dir };
      arms.push({ R, plan: R.plan, dir: e.dir, sE: e.s, E: { x: e.x, y: e.y }, u, n: { x: -u.y, y: u.x }, w: R.W, ang: Math.atan2(e.y - C.y, e.x - C.x) });
    }
    if (arms.length < 3) return null;
    arms.sort((a, b) => a.ang - b.ang);
    const N = arms.length;
    // 交差点の高さ: 計画道路が通るならその路面（最も広い計画道路）、既存道路だけなら枝の高さの平均で水平
    const main = arms.filter((a) => a.plan).map((a) => a.R).sort((a, b) => b.W - a.W)[0] || null;
    let zFlat = 0;
    if (!main) zFlat = arms.reduce((a, m) => a + rowAt(m.R.rows, m.sE).z, 0) / N;
    const mainNear = main ? main.rows.filter((r) => Math.hypot(r.x - C.x, r.y - C.y) < rho + 60) : null;
    const padZ = (x, y) => {
      if (!main) return zFlat;
      let b = mainNear[0], bd = Infinity;
      for (const r of mainNear) { const d = (r.x - x) ** 2 + (r.y - y) ** 2; if (d < bd) { bd = d; b = r; } }
      const r = rowAt(main.rows, b.s + (x - b.x) * b.c + (y - b.y) * b.sn), d = -(x - r.x) * r.sn + (y - r.y) * r.c;
      return surfZ(main, r, Math.max(-main.W, Math.min(main.W, d)));
    };
    // 隅（隣り合う枝の間）: 左の枝の左端線と右の枝の右端線を円弧でつなぐ
    const corners = arms.map((A, k) => {
      const B = arms[(k + 1) % N];
      let al = Math.atan2(cross(A.u.x, A.u.y, B.u.x, B.u.y), A.u.x * B.u.x + A.u.y * B.u.y);
      if (al <= 0) al += 2 * Math.PI;
      const La = { x: A.E.x + A.n.x * A.w, y: A.E.y + A.n.y * A.w }, Rb = { x: B.E.x - B.n.x * B.w, y: B.E.y - B.n.y * B.w };
      const straight = { A, B, fillet: false, ta: 0, tb: 0, pts: [La, Rb] };
      if (al > (160 * Math.PI) / 180) return straight;
      const den = cross(A.u.x, A.u.y, B.u.x, B.u.y);
      if (Math.abs(den) < 1e-6) return straight;
      const dx = Rb.x - La.x, dy = Rb.y - La.y, a = cross(dx, dy, B.u.x, B.u.y) / den, b = cross(dx, dy, A.u.x, A.u.y) / den;
      const rr = Math.min(cornerRadius(A, B), (al < Math.PI / 4 ? 3 : 12) * Math.tan(al / 2)), T = rr / Math.tan(al / 2); // 鋭角の隅は小さく丸めるだけ
      if (a + T < 0.2 || b + T < 0.2) {
        const p = { x: La.x + A.u.x * Math.max(a, 0), y: La.y + A.u.y * Math.max(a, 0) }, q = { x: Rb.x + B.u.x * Math.max(b, 0), y: Rb.y + B.u.y * Math.max(b, 0) };
        return { A, B, fillet: false, ta: Math.max(a, 0), tb: Math.max(b, 0), pts: [p, q] };
      }
      const ta = a + T, tb = b + T, Ta = { x: La.x + A.u.x * ta, y: La.y + A.u.y * ta }, O = { x: Ta.x + A.n.x * rr, y: Ta.y + A.n.y * rr };
      const Tb = { x: Rb.x + B.u.x * tb, y: Rb.y + B.u.y * tb };
      const th0 = Math.atan2(Ta.y - O.y, Ta.x - O.x);
      let sw = Math.atan2(Tb.y - O.y, Tb.x - O.x) - th0;
      while (sw > Math.PI) sw -= 2 * Math.PI;
      while (sw < -Math.PI) sw += 2 * Math.PI;
      const n = Math.max(2, Math.ceil((Math.abs(sw) * rr) / 0.8)), pts = [];
      for (let i = 0; i <= n; i++) { const th = th0 + (sw * i) / n; pts.push({ x: O.x + rr * Math.cos(th), y: O.y + rr * Math.sin(th) }); }
      return { A, B, fillet: true, ta, tb, pts, O, rr, P: { x: La.x + A.u.x * a, y: La.y + A.u.y * a } };
    });
    // 枝の切る位置（隅切りの接点より外）
    arms.forEach((A, k) => {
      const left = corners[k], right = corners[(k - 1 + N) % N];
      A.tL = left.ta; A.tR = right.tb; A.filletL = left.fillet; A.filletR = right.fillet;
      A.set = Math.max(A.tL, A.tR, 0) + 0.3;
      A.sCut = A.sE + A.dir * A.set;
    });
    // 既存道路は切る位置で交差点の高さ・横断勾配に一致するようにすりつける（build でまとめて行う）
    const blends = [];
    for (const A of arms) {
      if (A.plan) continue;
      const rc = rowAt(A.R.rows, A.sCut), z0 = padZ(rc.x, rc.y), pl = at(rc, A.w), pr = at(rc, -A.w);
      blends.push({ R: A.R, sCut: A.sCut, dir: A.dir, inner: A.set + rho, z0, sl: [(padZ(pl.x, pl.y) - z0) / A.w, (padZ(pr.x, pr.y) - z0) / A.w], B: Math.max(12, Math.abs(rc.z - z0) / 0.06) });
    }
    // 舗装面: 枝の付け根の三角形・隅の三角形と隅切りの部分・交差点の中の既存道路の帯を重ねる（計画道路の中は計画道路の舗装）。
    // 1 枚の多角形にしないのは、道路がずれて集まる所でも自己交差しないようにするため。辺は 1.5m 以下に分け、高さは交差点の高さ
    const dz = (A) => (A.plan ? 0.01 : 0.04), dzP = main ? 0.01 : 0.04, V = (p) => ({ x: p.x, y: p.y, z: padZ(p.x, p.y) + dzP });
    const dense = (poly) => {
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        out.push(V(a));
        const m = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 1.5);
        for (let j = 1; j < m; j++) out.push(V({ x: lerp(a.x, b.x, j / m), y: lerp(a.y, b.y, j / m) }));
      }
      return out;
    };
    const pieces = [];
    arms.forEach((A, k) => {
      const B = arms[(k + 1) % N], c = corners[k];
      const La0 = { x: A.E.x + A.n.x * A.w, y: A.E.y + A.n.y * A.w }, Rb0 = { x: B.E.x - B.n.x * B.w, y: B.E.y - B.n.y * B.w };
      pieces.push(dense([C, { x: A.E.x - A.n.x * A.w, y: A.E.y - A.n.y * A.w }, La0])); // 枝の付け根
      // 隅: 2 本の道路の端線の交点 P までの三角形と、P と隅切りの円弧の間（三角形に分けて、道路がずれて集まる所でも自己交差させない）
      if (c.fillet) pieces.push(dense([C, La0, c.P]), dense([C, c.P, Rb0]), dense([c.P, ...c.pts]));
      else pieces.push(dense([C, La0, c.pts[0]]), dense([C, c.pts[0], c.pts[1]]), dense([C, c.pts[1], Rb0]));
    });
    // 交差点の中の既存道路の帯（切った所）
    const strips = (R, spans) => {
      for (const [a, b] of spans) {
        const n = Math.max(1, Math.ceil((b - a) / 1.5)), ss = Array.from({ length: n + 1 }, (_, i) => lerp(a, b, i / n));
        const rs = ss.map((q) => rowAt(R.rows, q));
        pieces.push([...rs.map((r) => V(at(r, -R.W))), ...rs.reverse().map((r) => V(at(r, R.W)))]);
      }
    };
    // 既存道路を切る区間・計画道路の区画線と歩道を途切れさせる区間
    const byRoad = new Map();
    arms.forEach((A) => { if (!byRoad.has(A.R)) byRoad.set(A.R, []); byRoad.get(A.R).push(A); });
    // 主な交差点（2 車線以上の既存道路か、他の計画道路と交わる）: 計画道路の区画線を切り、横断歩道・停止線を引く。
    // 狭い道路が接するだけの所は計画道路の外側線だけを切り、狭い道路に停止線を引く
    const major = byRoad.size > 0 && ([...byRoad.keys()].filter((R) => R.plan).length > 1 || arms.some((A) => !A.plan && A.w * 2 >= 5.5));
    const cuts = [], plans = [];
    for (const [R, as] of byRoad) {
      if (!R.plan) { const sp = innerSpans(as, R.L, (A) => A.sCut); cuts.push([R, sp]); strips(R, sp); continue; }
      const marks = major ? innerSpans(as, R.L, (A) => A.sCut + A.dir * (XGAP + XW + 0.2)) : [], walk = {};
      const rC = rowAt(R.rows, nearest(R, C).s), sideOf = (A) => Math.sign(-(A.E.x - rC.x) * rC.sn + (A.E.y - rC.y) * rC.c);
      for (const side of [1, -1]) { // 中心線の左（+1）・右（−1）の歩道・外側線
        const fil = (A) => (A.dir * side > 0 ? A.filletL : A.filletR), tan = (A) => (A.dir * side > 0 ? A.tL : A.tR);
        if (!as.some(fil) && !arms.some((A) => A.R !== R && sideOf(A) === side)) { walk[side] = []; continue; }
        walk[side] = innerSpans(as, R.L, (A) => (fil(A) ? A.sE + A.dir * Math.max(0, tan(A)) : A.sE));
      }
      plans.push({ R, marks, walk });
    }
    // 隅の歩道（計画道路の歩道を隅切りの円弧に沿って回す）
    const walks = [];
    for (const c of corners) {
      if (!c.fillet) continue;
      const sw = Math.max(c.A.plan ? c.A.R.sw : 0, c.B.plan ? c.B.R.sw : 0);
      if (!(sw > 0)) continue;
      const k = Math.max(0, (c.rr - sw) / c.rr);
      walks.push({ sw, curb: c.pts.map((p) => ({ x: p.x, y: p.y, z: padZ(p.x, p.y) })), back: c.pts.map((p) => { const x = c.O.x + (p.x - c.O.x) * k, y = c.O.y + (p.y - c.O.y) * k; return { x, y, z: padZ(p.x, p.y) }; }) });
    }
    // 横断歩道・停止線（計画道路が関わる交差点）。左側通行: 交差点へ向かう車線は枝の向きの右側（d < 0）
    const lines = [];
    if (main) for (const A of arms) {
      if (A.plan && !major) continue;
      const s = (t) => A.sCut + A.dir * t, row = (d0, d1) => (A.dir > 0 ? [d0, d1] : [-d1, -d0]);
      const half = A.plan ? (A.R.cw > 0 ? A.R.cw / 2 : A.w * 0.9) : A.w * 0.9;
      if (A.plan || A.w * 2 >= 5.5) {
        lines.push({ R: A.R, kind: 'zebra', s0: Math.min(s(XGAP), s(XGAP + XW)), s1: Math.max(s(XGAP), s(XGAP + XW)), d: row(-half, half), dz: dz(A) });
        const st = s(XGAP + XW + STOP);
        lines.push({ R: A.R, kind: 'stop', s0: Math.min(st, st + A.dir * 0.45), s1: Math.max(st, st + A.dir * 0.45), d: row(-half, 0), dz: dz(A) });
      } else {
        const st = s(1.0);
        lines.push({ R: A.R, kind: 'stop', s0: Math.min(st, st + A.dir * 0.3), s1: Math.max(st, st + A.dir * 0.3), d: row(-half, half), dz: dz(A) });
      }
    }
    return { C, pieces, plan: !!main, padZ, plans, walks, lines, cuts, blends, arms: arms.length };
  }

  /* 点が多角形の中か */
  function inPoly(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  /* 2 つの交差点の舗装面が重なるか（頂点が相手の中にあるか） */
  function padsOverlap(A, B) {
    if (!overlap(padBox(A), padBox(B))) return false;
    for (const a of A.pieces) for (const b of B.pieces) if (overlap(bbox(a), bbox(b)) && (a.some((p) => inPoly(b, p.x, p.y)) || b.some((p) => inPoly(a, p.x, p.y)))) return true;
    return false;
  }
  const padBox = (J) => J.box || (J.box = bbox(J.pieces.flat()));
  const inPad = (J, x, y) => J.pieces.some((q) => inPoly(q, x, y));
  const padDist = (J, x, y) => Math.min(...J.pieces.map((q) => polyDist(q, x, y)));
  /* 点から多角形の辺までの距離 */
  function polyDist(ring, x, y) {
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - a.x - vx * t, y - a.y - vy * t));
    }
    return best;
  }

  const api = { build, rowAt, slice, minus, inGaps, inPoly, polyDist, padBox, inPad, padDist, crossings, exits, innerSpans };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.V3DJunction = api;
})(typeof self !== 'undefined' ? self : this);
