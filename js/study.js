/* Road Plan — 計画検討の計算（DOM に依存しない純粋な計算。ブラウザでは Study、node（テスト）では module.exports）
 *
 *  1. 土工          横断ごとの切土・盛土断面積（平均断面法で土量）、のり面積、のり尻・のり肩までの幅（用地幅）、橋梁区間、土量配分
 *  2. 用地・支障物件  用地の帯（のり尻＋余裕幅）にかかる建物、水域の横断
 *  3. 交差          途中で横切る道路との交差角・高低差（平面交差／立体交差の成立）・交差点間隔
 *  4. 区分・車線数   計画交通量から決まる級（道路構造令 第3条）と車線数（同 第5条の設計基準交通量）
 *  5. 概算事業費     数量 × 単価
 *  6. 費用便益分析   国土交通省 道路局・都市局「費用便益分析マニュアル」（令和7年8月）の走行時間短縮・走行経費減少・交通事故減少便益と B/C
 *  7. 沿道騒音       ASJ RTN-Model の 2 車種分類のパワーレベル式による道路端の等価騒音レベル（回折・地表面効果などの補正なし）
 *
 * のり面勾配・橋梁の扱いは断面図・3D ビューと同じ（XSecCore.buildModel: 盛土 1:1.5・切土 1:1.0・盛土高 8m 超は橋梁）。 */
(function (root) {
  'use strict';
  const Geom = root.Geom || (typeof require !== 'undefined' ? require('./geom.js') : null);
  const Rules = root.Rules || (typeof require !== 'undefined' ? require('./rules.js') : null);
  const XS = () => root.XSecCore || require('./xsec.js');
  const FILL = Rules.FILL_SLOPE, CUT = Rules.CUT_SLOPE;
  const REACH = 45, LAT = 2.5;       // のり面を探す範囲（道路端から）と横断方向の地盤の刻み [m]
  const CLEAR = 4.5, GRADE_TOL = 1.0; // 車道の建築限界の高さ（12条・普通道路）／平面交差とみなす高低差 [m]
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const n0 = (v) => Math.round(v).toLocaleString('ja-JP');

  /* ───────── 1. 土工 ───────── */
  /* 土工計算の測点（等間隔。既定は 10m、短い道路は 40 分割まで細かく） */
  function stations(al, pitch) {
    const L = al.length, p = pitch || Math.min(10, Math.max(2, L / 40)), n = Math.max(1, Math.round(L / p)), out = [];
    for (let i = 0; i <= n; i++) { const s = (L * i) / n, q = Geom.poseAt(al, s); out.push({ s, x: q.x, y: q.y, c: Math.cos(q.th), sn: Math.sin(q.th), k: q.k || 0 }); }
    return out;
  }
  /* 横断方向の地盤を読む位置（中心からの距離。左が正）。E = 道路端までの幅 */
  function offsets(E) { const n = Math.ceil((E + REACH) / LAT), o = []; for (let i = -n; i <= n; i++) o.push(i * LAT); return o; }

  /* 1 断面の切土・盛土。M = XSecCore.buildModel の結果、r = その測点、off・gs = 横断位置と地盤高。
   * 戻り値 { fill, cut（断面積 m²）, wl, wr（中心からのり尻・のり肩までの幅）, kl, kr（'fill'|'cut'|''）, ll, lr（のり面の斜面長）, open（範囲内で地山に取り付かない） } */
  function crossSection(M, r, off, gs) {
    const X = XS(), E = M.E;
    const G = (d) => { const t = (d - off[0]) / LAT, i = Math.max(0, Math.min(off.length - 2, Math.floor(t))), f = Math.max(0, Math.min(1, t - i)); return gs[i] + (gs[i + 1] - gs[i]) * f; };
    let fill = 0, cut = 0;
    const n = Math.max(2, Math.ceil((2 * E) / 0.5)), h = (2 * E) / n;
    for (let i = 0; i < n; i++) { const d = -E + (i + 0.5) * h, dz = X.surfZ(M, r, d) - G(d); if (dz > 0) fill += dz * h; else cut -= dz * h; }
    const side = (sgn) => {
      const d0 = sgn * E, top = X.surfZ(M, r, d0), dz0 = top - G(d0);
      if (Math.abs(dz0) < 0.05) return { w: E, kind: '', len: 0, a: 0, open: false };
      const isFill = dz0 > 0, sl = isFill ? FILL : CUT, kind = isFill ? 'fill' : 'cut', k = Math.sqrt(1 + 1 / (sl * sl));
      const gap = (u) => (isFill ? top - u / sl - G(d0 + sgn * u) : G(d0 + sgn * u) - (top + u / sl)); // のり面と地盤の高さの差（正の間はのり面が続く）
      const du = LAT / 2;
      let u0 = 0, g0 = Math.abs(dz0), a = 0;
      for (let u = du; u <= REACH + 1e-9; u += du) {
        const g = gap(u);
        if (g <= 0) { const t = g0 / (g0 - g), ue = u0 + du * t; return { w: E + ue, kind, len: ue * k, a: a + (g0 * du * t) / 2, open: false }; }
        a += ((g0 + g) / 2) * du; u0 = u; g0 = g;
      }
      return { w: E + REACH, kind, len: REACH * k, a, open: true };
    };
    const Ls = side(1), Rs = side(-1);
    if (Ls.kind === 'fill') fill += Ls.a; else cut += Ls.a;
    if (Rs.kind === 'fill') fill += Rs.a; else cut += Rs.a;
    return { fill, cut, wl: Ls.w, wr: Rs.w, kl: Ls.kind, kr: Rs.kind, ll: Ls.len, lr: Rs.len, open: Ls.open || Rs.open };
  }

  /* 道路全体の土工。lat[i] = 測点 i の横断方向の地盤高（offsets の位置。無い測点は道路幅だけ）。
   * opt.C = 土量変化率（締固め後の土量 ÷ 地山の土量）、opt.margin = 用地の余裕幅（のり尻・のり肩の外側）[m] */
  function earthwork(M, off, lat, opt = {}) {
    const C = opt.C > 0 ? opt.C : 0.9, margin = opt.margin >= 0 ? +opt.margin : 1, R = M.rows, n = R.length;
    const rows = R.map((r, i) => {
      const o = { s: r.s, h: r.z - r.g, bridge: !!r.bridge, fill: 0, cut: 0, wl: M.E, wr: M.E, kl: '', kr: '', ll: 0, lr: 0, open: false };
      return r.bridge || !lat || !lat[i] ? o : Object.assign(o, crossSection(M, r, off, lat[i]));
    });
    const rep = rows.map((r, i) => ((i > 0 ? r.s - rows[i - 1].s : 0) + (i < n - 1 ? rows[i + 1].s - r.s : 0)) / 2); // その測点が代表する延長
    const T = { rows, C, margin, cutV: 0, fillV: 0, slopeFill: 0, slopeCut: 0, rowA: 0, bridgeLen: 0, bridges: [], openLen: 0, maxW: 0, maxCut: null, maxFill: null, mass: [{ s: 0, v: 0 }] };
    for (let i = 0; i < n - 1; i++) {
      const a = rows[i], b = rows[i + 1], ds = b.s - a.s, lf = (q) => (q.kl === 'fill' ? q.ll : 0) + (q.kr === 'fill' ? q.lr : 0), lc = (q) => (q.kl === 'cut' ? q.ll : 0) + (q.kr === 'cut' ? q.lr : 0);
      const cv = ((a.cut + b.cut) / 2) * ds, fv = ((a.fill + b.fill) / 2) * ds; // 平均断面法
      T.cutV += cv; T.fillV += fv;
      T.slopeFill += ((lf(a) + lf(b)) / 2) * ds; T.slopeCut += ((lc(a) + lc(b)) / 2) * ds;
      T.rowA += ((a.wl + a.wr + b.wl + b.wr) / 2 + 2 * margin) * ds;
      T.mass.push({ s: b.s, v: T.mass[i].v + cv * C - fv });
    }
    rows.forEach((r, i) => {
      T.maxW = Math.max(T.maxW, r.wl + r.wr + 2 * margin);
      if (r.open) T.openLen += rep[i];
      if (r.bridge) {
        T.bridgeLen += rep[i];
        const s0 = Math.max(0, r.s - (i > 0 ? (r.s - rows[i - 1].s) / 2 : 0)), s1 = Math.min(M.L, r.s + (i < n - 1 ? (rows[i + 1].s - r.s) / 2 : 0)), last = T.bridges[T.bridges.length - 1];
        if (last && Math.abs(last.s1 - s0) < 1e-6) { last.s1 = s1; last.h = Math.max(last.h, r.h); } else T.bridges.push({ s0, s1, h: r.h });
        return;
      }
      if (r.h < 0 && (!T.maxCut || -r.h > T.maxCut.d)) T.maxCut = { d: -r.h, s: r.s };
      if (r.h > 0 && (!T.maxFill || r.h > T.maxFill.d)) T.maxFill = { d: r.h, s: r.s };
    });
    return Object.assign(T, balance(T.cutV, T.fillV, C));
  }
  /* 土量配分: 切土（地山）を締め固めて盛土に流用。reuse = 流用する盛土量、borrow = 不足土（購入土・締固め後）、surplus = 残土（地山） */
  function balance(cutV, fillV, C) {
    return { reuse: Math.min(cutV * C, fillV), borrow: Math.max(0, fillV - cutV * C), surplus: Math.max(0, cutV - fillV / C) };
  }

  /* ───────── 2. 用地・支障物件 ───────── */
  /* 用地の帯: 測点ごとの左右の境界（のり尻・のり肩＋余裕幅） */
  function rowEdges(M, ew) {
    return M.rows.map((r, i) => { const wl = ew.rows[i].wl + ew.margin, wr = ew.rows[i].wr + ew.margin; return { s: r.s, l: [r.x - r.sn * wl, r.y + r.c * wl], r: [r.x + r.sn * wr, r.y - r.c * wr] }; });
  }
  const inRing = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const segHit = (a, b, c, d) => (orient(c, d, a) > 0) !== (orient(c, d, b) > 0) && (orient(a, b, c) > 0) !== (orient(a, b, d) > 0);
  /* 2 つの多角形（[[x,y]...]）が重なるか: 頂点が相手の中にあるか、辺が交わる */
  function ringsHit(A, B) {
    if (A.some((p) => inRing(B, p[0], p[1])) || B.some((p) => inRing(A, p[0], p[1]))) return true;
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (segHit(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    return false;
  }
  const bboxOf = (ring) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of ring) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } return [x0, y0, x1, y1]; };
  /* 建物の階数の見込み: 実測の高さがあれば 3.2m/階、無ければ地理院の建物種別（3102 堅ろう・3103 高層）から */
  const floorsOf = (b) => (b.h > 0 ? Math.max(1, Math.round(b.h / 3.2)) : b.code === 3103 ? 10 : b.code === 3102 ? 4 : b.code === 3111 || b.code === 3112 ? 1 : 2);
  /* 用地の帯にかかる建物。buildings = V3DCity.load の buildings（[{ code, parts:[{outer}], area, h? }]）。
   * 戻り値 { n, area（建築面積の計）, floor（延床面積の見込みの計）, list:[{ i, s（測点）, area, floors, measured }] } */
  function hitBuildings(buildings, edges) {
    const quads = [];
    for (let i = 0; i < edges.length - 1; i++) { const q = [edges[i].l, edges[i + 1].l, edges[i + 1].r, edges[i].r]; quads.push({ q, bb: bboxOf(q), s: (edges[i].s + edges[i + 1].s) / 2 }); }
    const out = { n: 0, area: 0, floor: 0, list: [] };
    if (!quads.length) return out;
    const all = bboxOf(quads.flatMap((k) => k.q));
    buildings.forEach((b, i) => {
      let s = null;
      for (const part of b.parts) {
        const bb = bboxOf(part.outer);
        if (bb[0] > all[2] || bb[2] < all[0] || bb[1] > all[3] || bb[3] < all[1]) continue;
        for (const k of quads) { if (bb[0] > k.bb[2] || bb[2] < k.bb[0] || bb[1] > k.bb[3] || bb[3] < k.bb[1]) continue; if (ringsHit(part.outer, k.q)) { s = k.s; break; } }
        if (s != null) break;
      }
      if (s == null) return;
      const floors = floorsOf(b);
      out.n++; out.area += b.area; out.floor += b.area * floors;
      out.list.push({ i, s, area: b.area, floors, measured: b.h > 0 });
    });
    out.list.sort((a, b) => a.s - b.s);
    return out;
  }
  /* 中心線が水域（河川・水面）を横切る区間。pts = [{s,x,y}]、waters = [[ring...]...]（1 つの水域 = 外周と穴の輪）。
   * bridgeAt(s) = その測点が橋梁か。戻り値 [{ s0, s1, len, bridged }] */
  function waterCross(pts, waters, bridgeAt) {
    const boxes = waters.map((w) => bboxOf(w.flat()));
    const wet = (p) => waters.some((w, i) => { const b = boxes[i]; if (p.x < b[0] || p.x > b[2] || p.y < b[1] || p.y > b[3]) return false; let c = 0; for (const r of w) if (inRing(r, p.x, p.y)) c++; return c % 2 === 1; });
    const out = [];
    let cur = null;
    pts.forEach((p, i) => {
      if (wet(p)) { if (!cur) cur = { s0: i > 0 ? (pts[i - 1].s + p.s) / 2 : p.s, s1: p.s, bridged: true }; cur.s1 = i < pts.length - 1 ? (p.s + pts[i + 1].s) / 2 : p.s; if (!bridgeAt(p.s)) cur.bridged = false; }
      else if (cur) { out.push(cur); cur = null; }
    });
    if (cur) out.push(cur);
    return out.map((c) => Object.assign(c, { len: c.s1 - c.s0 })).filter((c) => c.len >= 1);
  }

  /* ───────── 3. 交差 ───────── */
  const rowAt = (rows, s, key) => { if (s <= rows[0].s) return rows[0][key]; for (let i = 1; i < rows.length; i++) if (rows[i].s >= s) { const a = rows[i - 1], b = rows[i], t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0; return a[key] + (b[key] - a[key]) * t; } return rows[rows.length - 1][key]; };
  const bridgeAt = (rows, s) => { let best = rows[0]; for (const r of rows) if (Math.abs(r.s - s) < Math.abs(best.s - s)) best = r; return !!best.bridge; };
  /* 高低差 dz（計画高 − 交差する道路の路面高）から交差の形を決める。
   * grade 平面交差 / over 計画道路が上を越える / under 下をくぐる / conflict どちらも成立しない / sepex 既存側が高架・トンネル */
  function crossType(dz, sep) {
    if (sep) return 'sepex';
    if (Math.abs(dz) <= GRADE_TOL) return 'grade';
    const need = CLEAR + XS().DECK;
    return dz >= need ? 'over' : dz <= -need ? 'under' : 'conflict';
  }
  /* 計画道路が途中で横切る道路の一覧。others = [{ name, xy:[{x,y}], width, sep, planned }]。
   * 交差する道路の路面高は現況地盤高（中心線上）で近似する。縦断計画が無いとき（M.pf なし）は高低差を判定しない。
   * 戻り値 [{ s, name, width, ang（交差角）, z, g, dz, type, major（交差道路の幅員 5.5m 以上）, end（'start'|'end'：端点の接続） }] */
  function crossingList(M, al, road, others) {
    const X = XS(), line = al.samples, out = [], L = al.length;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of line) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const at = (s) => { const z = rowAt(M.rows, s, 'z'), g = rowAt(M.rows, s, 'g'); return { z, g, dz: z - g }; };
    [['start', 0], ['end', L]].forEach(([k, s]) => {
      const c = road.conn && road.conn[k]; if (!c) return;
      const dir = k === 'start' ? al.dirs[0] : al.dirs[al.dirs.length - 1], h = at(s);
      out.push(Object.assign({ s, name: c.name || '既存道路', width: c.width || 0, ang: Rules.foldAngle(dir - c.bearing), end: k, tangent: c.mode === 'tangent', type: c.mode === 'tangent' ? 'ext' : 'grade', major: (c.width || 0) >= 5.5 }, h));
    });
    for (const o of others) {
      const xy = o.xy;
      if (xy.every((q) => q.x < x0 - 1) || xy.every((q) => q.x > x1 + 1) || xy.every((q) => q.y < y0 - 1) || xy.every((q) => q.y > y1 + 1)) continue;
      for (const c of X.crossings(line, xy)) {
        if (c.ang < 10) continue; // ほぼ並行（現道に沿う区間）は交差としない
        const s = Geom.project(al, line, c.x, c.y).s;
        if (out.some((q) => q.end && Math.abs(q.s - s) < 6)) continue; // 端点の接続先と同じ交差点
        if (o.planned && (s < 6 || s > L - 6)) continue; // 端点で他の計画道路に触れているだけ（起終点を共有する比較案・分岐）
        const same = out.find((q) => !q.end && Math.abs(q.s - s) < 3);
        if (same) { if ((o.width || 0) > same.width) { same.width = o.width; same.major = same.width >= 5.5; } if (!same.name && o.name) same.name = o.name; continue; } // データの継ぎ目で 2 本に分かれた同じ道路
        const h = at(s);
        out.push(Object.assign({ s, name: o.name || '', width: o.width || 0, ang: c.ang, planned: !!o.planned, type: M.pf ? crossType(h.dz, o.sep) : o.sep ? 'sepex' : 'grade', auto: !M.pf, bridge: bridgeAt(M.rows, s), major: (o.width || 0) >= 5.5 }, h));
      }
    }
    return out.sort((a, b) => a.s - b.s);
  }
  /* 平面交差の間隔 [{ s0, s1, gap }]（端点の T 字・十字接続を含む。延伸での接続は交差点としない） */
  function spacing(list) {
    const g = list.filter((c) => c.type === 'grade'), out = [];
    for (let i = 1; i < g.length; i++) out.push({ s0: g[i - 1].s, s1: g[i].s, gap: g[i].s - g[i - 1].s });
    return out;
  }

  /* ───────── 4. 区分・車線数（道路構造令 第3条・第5条） ───────── */
  const ROAD_KINDS = { exp: '高速自動車国道', mot: '自動車専用道路（高速自動車国道以外）', nat: '一般国道', pref: '都道府県道', city: '市町村道' };
  const TERRAINS = { flat: '平地部', mount: '山地部' };
  /* 第3条第2項の表。列は計画交通量 [台/日] の大きい順 */
  const CLS1 = { bins: [30000, 20000, 10000], exp: { flat: [1, 2, 2, 3], mount: [2, 3, 3, 4] }, mot: { flat: [2, 2, 3, 3], mount: [3, 3, 4, 4] } };
  const CLS3 = { bins: [20000, 4000, 1500, 500], nat: { flat: [1, 2, 3, 3, 3], mount: [2, 3, 4, 4, 4] }, pref: { flat: [2, 2, 3, 3, 3], mount: [3, 3, 4, 4, 4] }, city: { flat: [2, 2, 3, 4, 5], mount: [3, 3, 4, 4, 5] } };
  const CLS4 = { bins: [10000, 4000, 500], nat: [1, 2, 2, 2], pref: [1, 2, 3, 3], city: [1, 2, 3, 4] };
  const LOWEST = { 1: 4, 2: 2, 3: 5, 4: 4 };
  /* 種（1〜4。地方部・都市部と自動車専用かどうかで決まる）・道路の種類・地形・計画交通量から該当する級。
   * 種と道路の種類が合わない（第1・2種なのに一般国道など）ときは null。center = 大都市の都心部（第2種） */
  function classFor(type, kind, terrain, q, center) {
    const col = (bins) => { let i = 0; while (i < bins.length && q < bins[i]) i++; return i; };
    const special = kind === 'exp' || kind === 'mot', t = terrain === 'mount' ? 'mount' : 'flat';
    type = +type;
    if ((type <= 2) !== special || !ROAD_KINDS[kind]) return null;
    if (type === 1) return CLS1[kind][t][col(CLS1.bins)];
    if (type === 2) return kind === 'mot' && center ? 2 : 1;
    if (type === 3) return CLS3[kind][t][col(CLS3.bins)];
    return CLS4[kind][col(CLS4.bins)];
  }
  /* 第5条の設計基準交通量 [台/日]: [平地部, 山地部]。DSV2 = 2 車線道路（第2項）、DSV1 = 4 車線以上の 1 車線当たり（第3項）。null は表に値がない */
  const DSV2 = { '1-2': [14000, null], '1-3': [14000, 10000], '1-4': [13000, 9000], '3-2': [9000, null], '3-3': [8000, 6000], '3-4': [8000, 6000], '4-1': [12000, 12000], '4-2': [10000, 10000], '4-3': [9000, 9000] };
  const DSV1 = { '1-1': [12000, null], '1-2': [12000, 9000], '1-3': [11000, 8000], '1-4': [11000, 8000], '2-1': [18000, 18000], '2-2': [17000, 17000], '3-1': [11000, null], '3-2': [9000, 7000], '3-3': [8000, 6000], '3-4': [null, 5000], '4-1': [12000, 12000], '4-2': [10000, 10000], '4-3': [10000, 10000] };
  /* 計画交通量 q から必要な車線数。manyX = 交差点の多い第4種の道路（2 車線は ×0.8、多車線の 1 車線当たりは ×0.6）。
   * 戻り値 { lanes（null = 決められない）, two（2 車線の設計基準交通量）, per（1 車線当たり）, single（1 車線道路の級） } */
  function lanesFor(cls, terrain, q, manyX) {
    const c = Rules.CLASSES[cls], ti = terrain === 'mount' ? 1 : 0, k4 = cls[0] === '4' && manyX;
    if (!c) return null;
    if (c.single) return { lanes: 1, single: true, two: null, per: null };
    let two = DSV2[cls] ? DSV2[cls][ti] : null, per = DSV1[cls] ? DSV1[cls][ti] : null;
    if (k4) { if (two) two *= 0.8; if (per) per *= 0.6; }
    if (two && q <= two) return { lanes: 2, two, per };
    if (!per) return { lanes: null, two, per };
    const n = Math.ceil(q / per - 1e-9);
    return { lanes: Math.max(4, n + (n % 2)), two, per }; // 4 以上・2 の倍数
  }
  /* 中央帯の最低幅員 [m]（第6条第4項。規定値）と、設置が必要か（第6条第1項: 第1種・第2種・第3種第1級は往復分離） */
  const MEDIAN = { '1-1': 4.5, '1-2': 4.5, '1-3': 3.0, '1-4': 3.0, '2-1': 2.25, '2-2': 1.75 };
  const medianOf = (cls) => ({ w: MEDIAN[cls] || (cls[0] === '3' ? 1.75 : 1.0), must: cls[0] === '1' || cls[0] === '2' || cls === '3-1' });

  /* ───────── 5. 概算事業費 ───────── */
  /* 単価は地域・時期・工法で大きく変わる。ここの値は桁を見るための仮の値で、画面で必ず見直す前提（消費税を含まない額として扱う） */
  const COST_ITEMS = [
    ['cut', '切土（掘削・運搬）', '円/m³', 1800], ['fill', '盛土（敷均し・締固め）', '円/m³', 2000], ['borrow', '不足土（購入土）', '円/m³', 3500], ['spoil', '残土処分', '円/m³', 3000],
    ['slope', 'のり面保護（植生工など）', '円/m²', 3500], ['pave', '車道・路肩の舗装（路盤とも）', '円/m²', 12000], ['walk', '歩道の舗装', '円/m²', 8000],
    ['bridge', '橋梁（橋面積あたり・上下部とも）', '円/m²', 650000], ['drain', '排水・防護柵・区画線など', '円/m', 90000],
    ['land', '用地費', '円/m²', 30000], ['comp', '建物の補償（延床面積あたり）', '円/m²', 250000],
  ];
  const COST_DEFAULTS = Object.assign({ misc: 30, survey: 10 }, Object.fromEntries(COST_ITEMS.map((c) => [c[0], c[3]]))); // misc 諸経費 [% 対直接工事費]、survey 測量設計費 [% 対工事費]
  /* 数量 q = { cutV, fillV, borrow, surplus, slopeA, paveA, walkA, bridgeA, len（橋梁を除く延長）, rowA, compA } と単価 → 概算事業費 [円] */
  function cost(q, unit) {
    const u = Object.assign({}, COST_DEFAULTS, unit), qty = { cut: q.cutV, fill: q.fillV, borrow: q.borrow, spoil: q.surplus, slope: q.slopeA, pave: q.paveA, walk: q.walkA, bridge: q.bridgeA, drain: q.len, land: q.rowA, comp: q.compA };
    const items = COST_ITEMS.map(([k, name, un]) => ({ key: k, name, unit: un, qty: qty[k] || 0, price: +u[k] || 0, amount: (qty[k] || 0) * (+u[k] || 0) }));
    const sum = (keys) => items.filter((i) => keys.includes(i.key)).reduce((a, i) => a + i.amount, 0);
    const direct = sum(['cut', 'fill', 'borrow', 'spoil', 'slope', 'pave', 'walk', 'bridge', 'drain']), misc = (direct * (+u.misc || 0)) / 100, works = direct + misc, survey = (works * (+u.survey || 0)) / 100;
    const land = sum(['land']), comp = sum(['comp']);
    return { items, direct, misc, works, survey, land, comp, total: works + survey + land + comp };
  }

  /* ───────── 6. 費用便益分析（費用便益分析マニュアル 令和7年8月・令和6年価格） ───────── */
  const BC = {
    source: '国土交通省 道路局・都市局「費用便益分析マニュアル」（令和7年8月）', price: '令和6年価格',
    alpha: { pc: 48.89, small: 52.07, large: 101.93 }, // 時間価値原単位 [円/分・台]: 乗用車類・小型貨物車・普通貨物車（表−1）
    /* 走行経費原単位 [円/台・km]（表−2）。設定速度の間は直線補間、範囲外は端の値 */
    run: {
      urban: { v0: 5, pc: [55.27, 38.62, 32.87, 29.86, 27.99, 26.70, 26.05, 25.74, 25.56, 25.50, 25.55, 25.71], small: [41.05, 34.76, 32.19, 30.61, 29.48, 28.61, 28.07, 27.73, 27.49, 27.36, 27.34, 27.43], large: [101.08, 80.59, 71.23, 64.94, 60.12, 56.24, 53.58, 51.68, 50.23, 49.24, 48.70, 48.63] },
      flat: { v0: 5, pc: [45.16, 31.07, 26.16, 23.57, 21.94, 20.80, 20.17, 19.78, 19.53, 19.40, 19.35, 19.40], small: [34.59, 29.56, 27.40, 26.02, 25.01, 24.22, 23.68, 23.31, 23.04, 22.87, 22.81, 22.84], large: [88.04, 72.20, 64.38, 58.85, 54.48, 50.88, 48.23, 46.21, 44.64, 43.50, 42.79, 42.53] },
      mount: { v0: 5, pc: [42.70, 29.23, 24.52, 22.04, 20.47, 19.37, 18.73, 18.34, 18.07, 17.91, 17.84, 17.87], small: [33.02, 28.29, 26.24, 24.91, 23.93, 23.16, 22.62, 22.24, 21.96, 21.78, 21.71, 21.73], large: [84.86, 70.16, 62.71, 57.37, 53.10, 49.57, 46.92, 44.88, 43.27, 42.09, 41.35, 41.04] },
      exp: { v0: 30, pc: [13.77, 13.16, 12.71, 12.37, 12.13, 11.99, 11.91, 11.91, 11.98, 12.11, 12.32, 12.60, 12.98], small: [19.00, 18.48, 18.07, 17.76, 17.55, 17.43, 17.40, 17.47, 17.62, 17.87, 18.22, 18.66, 19.20], large: [44.46, 41.87, 39.72, 37.99, 36.67, 35.77, 35.28, 35.21, 35.55, 36.31, 37.50, 39.13, 41.23] },
    },
    /* 交通事故損失額 AA = a·X1 + b·X2 [千円/年]（X1 走行台キロ [千台km/日]、X2 走行台箇所 [千台箇所/日]）。
     * 2 車線は表−3、4 車線以上は中央帯の有無を考慮しない表−4。did 人口集中地区 / urban その他市街部 / rural 非市街部 */
    acc: { did: { 2: [1850, 280], 4: [1110, 370] }, urban: { 2: [1130, 280], 4: [760, 310] }, rural: { 2: [1010, 350], 4: [640, 340] }, exp: [360, 0] },
  };
  /* 走行経費原単位 [円/台・km]: type = urban 市街地 / flat 平地 / mount 山地 / exp 高速・地域高規格、cls = pc / small / large、v = 速度 [km/h] */
  function runCost(type, cls, v) {
    const t = BC.run[type], a = t[cls], x = (v - t.v0) / 5;
    if (!(x > 0)) return a[0];
    if (x >= a.length - 1) return a[a.length - 1];
    const i = Math.floor(x); return a[i] + (a[i + 1] - a[i]) * (x - i);
  }
  /* 交通量の予測結果（日交通量）から年間の便益 [円/年]。net = Traffic のネットワーク（attributes 済み）、res = Traffic.run の結果。
   * opt.small = 小型車（大型車以外）に占める小型貨物車の割合 [0..1]、opt.large = 大型車混入率を一律に指定するとき [0..1]（無指定はリンクごとの値）
   * 戻り値 { time, run, acc（差 = 整備なし − 整備あり）, before:{time,run,acc}, after:{...} } */
  function benefits(net, res, opt = {}) {
    const E = net.edges, g = res.g, small = opt.small >= 0 ? +opt.small : 0.2;
    const inc = net.nodes.map(() => []); E.forEach((e) => { inc[e.a].push(e); if (e.b !== e.a) inc[e.b].push(e); });
    const widthOf = (e) => e.width || (e.lanesEff >= 2 ? 6 : 4);
    const dirAt = (e, n) => { const p = e.pts, a = e.a === n ? p[0] : p[p.length - 1], b = e.a === n ? p[1] : p[p.length - 2], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
    /* 主要交差点（交差道路の幅員 5.5m 以上）: その節点に、直進方向の続きではない幅員 5.5m 以上の道路がつながっている */
    const major = (e, n, withPlan) => { const d = dirAt(e, n); return inc[n].some((f) => { if (f === e || (f.planned && !withPlan) || widthOf(f) < 5.5) return false; const q = dirAt(f, n); return d[0] * q[0] + d[1] * q[1] > -0.87; }); };
    const tally = (c, withPlan) => {
      let time = 0, run = 0, acc = 0;
      const zOf = E.map((e) => (major(e, e.a, withPlan) ? 0.5 : 0) + (e.b !== e.a && major(e, e.b, withPlan) ? 0.5 : 0)); // 交差点は両側のリンクで半分ずつ数える（整備なしでは計画道路との交差点は無い）
      E.forEach((e, i) => {
        if (e.planned && !withPlan) return;
        const lg = opt.large >= 0 ? +opt.large : Math.max(0, Math.min(0.6, ((e.fac && e.fac.lg) || 10) / 100)), sh = { pc: (1 - lg) * (1 - small), small: (1 - lg) * small, large: lg };
        const type = e.kind === 'mw' ? 'exp' : e.area <= 3 ? 'urban' : e.area === 4 ? 'flat' : 'mount', km = e.len / 1000;
        let q = 0;
        for (let d = 0; d < 2; d++) {
          const a = 2 * i + d, x = c.x[a]; if (!g.ok[a] || !(x > 0)) continue;
          const t = c.t[a], v = t > 0 ? km / (t / 60) : 60;
          for (const k of ['pc', 'small', 'large']) { time += x * sh[k] * t * BC.alpha[k]; run += x * sh[k] * km * runCost(type, k, v); }
          q += x;
        }
        const eff = e.oneway ? e.lanesEff * 2 : e.lanesEff, f = e.kind === 'mw' ? BC.acc.exp : BC.acc[e.area <= 2 ? 'did' : e.area === 3 ? 'urban' : 'rural'][eff >= 4 ? 4 : 2];
        acc += (f[0] * (q / 1000) * km + f[1] * (q / 1000) * zOf[i]) * 1000;
      });
      return { time: time * 365, run: run * 365, acc };
    };
    const b = tally(res.before, false), a = tally(res.after, true);
    return { time: b.time - a.time, run: b.run - a.run, acc: b.acc - a.acc, before: b, after: a };
  }
  /* 現在価値と B/C。o = { benefit:{time,run,acc} [円/年], works（工事費・測量設計費）, land（用地費・補償費）[円], years（事業期間）, maint（維持管理費 [円/年]）,
   *   rate（社会的割引率。既定 0.04）, horizon（検討年数。既定 50）, residual（用地の残存価値を費用から控除するか） }
   * 基準年次 = 評価時点（0 年目）。事業費は事業期間に均等に配分し、供用開始（事業期間の翌年）から検討年数の間、便益と維持管理費が毎年同じ額で生じるとする */
  function bcr(o) {
    const n = Math.max(1, Math.round(o.years || 1)), H = o.horizon || 50, B0 = o.benefit, cap = (o.works || 0) + (o.land || 0);
    const pv = (i) => {
      const df = (t) => Math.pow(1 + i, -t);
      let ann = 0, con = 0;
      for (let t = 0; t < H; t++) ann += df(n + t);
      for (let k = 0; k < n; k++) con += df(k) / n;
      const res = o.residual ? (o.land || 0) * df(n + H) : 0;
      const Bt = B0.time * ann, Br = B0.run * ann, Ba = B0.acc * ann, Cc = cap * con, Cm = (o.maint || 0) * ann;
      return { Bt, Br, Ba, B: Bt + Br + Ba, Cc, Cm, residual: res, C: Cc + Cm - res };
    };
    const r = pv(o.rate == null ? 0.04 : o.rate), npv = (i) => { const q = pv(i); return q.B - q.C; };
    let eirr = null;
    if (npv(0.0001) > 0) { let lo = 0.0001, hi = 1; if (npv(hi) > 0) eirr = Infinity; else { for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (npv(m) > 0) lo = m; else hi = m; } eirr = (lo + hi) / 2; } }
    return Object.assign(r, { bc: r.C > 0 ? r.B / r.C : null, npv: r.B - r.C, eirr, years: n, horizon: H });
  }
  /* 感度分析（交通量・事業費・事業期間を ±10%）。交通量は便益を ±10% として代用する */
  function sensitivity(o) {
    const k = (f) => ({ time: o.benefit.time * f, run: o.benefit.run * f, acc: o.benefit.acc * f }), n = Math.max(1, Math.round(o.years || 1)), dn = Math.max(1, Math.round(n * 0.1));
    const v = (p) => bcr(Object.assign({}, o, p)).bc;
    return [
      { name: '交通量（便益）', lo: v({ benefit: k(0.9) }), hi: v({ benefit: k(1.1) }), note: '±10%' },
      { name: '事業費', lo: v({ works: o.works * 1.1, land: o.land * 1.1 }), hi: v({ works: o.works * 0.9, land: o.land * 0.9 }), note: '±10%' },
      { name: '事業期間', lo: v({ years: n + dn }), hi: v({ years: Math.max(1, n - dn) }), note: `±${dn} 年` },
    ];
  }

  /* ───────── 7. 沿道騒音 ───────── */
  /* A 特性音響パワーレベル [dB]（ASJ RTN-Model・2 車種分類）: 定常走行（40〜140km/h）a + 30 log V、非定常走行（10〜60km/h）a + 10 log V */
  function lwa(V, heavy, steady) {
    const v = steady ? Math.max(40, Math.min(140, V)) : Math.max(10, Math.min(60, V));
    return steady ? (heavy ? 53.2 : 45.8) + 30 * Math.log10(v) : (heavy ? 88.8 : 82.3) + 10 * Math.log10(v);
  }
  /* 無限長の直線道路の等価騒音レベル LAeq [dB]。1 台が一定速度 v で通過するときの単発騒音暴露レベル
   *   LAE = LWA − 8 − 20 log r を時間で積分 = LWA + 10 log(1 / (2 d v))（半自由空間・回折や地表面効果の補正なし）
   * に時間交通量 N [台/時] を掛ける。lanes = 受音点から各車線中心までの水平距離 [m] */
  function laeq(N, heavy, V, steady, lanes) {
    const v = V / 3.6, per = N / lanes.length;
    let e = 0;
    for (const d of lanes) for (const [h, share] of [[false, 1 - heavy], [true, heavy]]) e += (per * share / 3600) * Math.pow(10, lwa(V, h, steady) / 10) / (2 * Math.max(0.5, d) * v);
    return e > 0 ? 10 * Math.log10(e) : -Infinity;
  }
  /* 計画道路の道路端（官民境界）＋ dist [m] での昼（6〜22時）・夜（22〜6時）の LAeq。
   * o = { q（日交通量・両方向 [台/日]）, heavy（大型車混入率 0..1）, V（走行速度 km/h）, steady, night（22〜6時の交通量の割合 0..1）, road, dist } */
  function noise(o) {
    const r = o.road, c = [];
    for (let i = 0; i < r.lanes; i++) c.push((i + 0.5 - r.lanes / 2) * r.laneW);
    const x = Rules.totalWidth(r) / 2 + (o.dist || 0), lanes = c.map((p) => Math.abs(x - p)), nt = o.night >= 0 ? +o.night : 0.1;
    return { day: laeq((o.q * (1 - nt)) / 16, o.heavy, o.V, o.steady, lanes), night: laeq((o.q * nt) / 8, o.heavy, o.V, o.steady, lanes) };
  }
  /* 昼・夜とも基準（day/night dB）以下になる、道路端からの距離 [m]（0 = 道路端で満たす、null = 300m でも超える） */
  function noiseDistance(o, day, night) {
    const ok = (d) => { const n = noise(Object.assign({}, o, { dist: d })); return n.day <= day && n.night <= night; };
    if (ok(0)) return 0;
    if (!ok(300)) return null;
    let lo = 0, hi = 300;
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
    return hi;
  }
  /* 騒音に係る環境基準（道路に面する地域）[dB]: 昼 6〜22時／夜 22〜6時 */
  const NOISE_STD = { trunk: { name: '幹線交通を担う道路に近接する空間', day: 70, night: 65 }, bc: { name: 'B 地域（2 車線以上）・C 地域', day: 65, night: 60 }, a: { name: 'A 地域（2 車線以上）', day: 60, night: 55 } };

  /* ───────── 検討項目の一覧（照査と同じ形 { level, cat, title, detail, ref }） ─────────
   * A = { ew, hits, water, cross, gaps }（無いものは省略可）、plan = { q（計画交通量 台/日）, src, kind, terrain, manyX, center } */
  function review(road, al, A, plan) {
    const out = [], add = (level, cat, title, detail, ref, s) => out.push({ level, cat, title, detail: detail || '', ref: ref || '', s });
    const c = Rules.CLASSES[road.cls], t = Rules.T[road.V], sta = (s) => `測点 ${f1(s)}m`;
    A = A || {}; plan = plan || {};
    /* 区分・車線数 */
    if (plan.q > 0) {
      const type = +road.cls[0], grade = +road.cls[2], needG = classFor(type, plan.kind, plan.terrain, plan.q, plan.center), basis = `計画交通量 ${n0(plan.q)} 台/日（${plan.src || '入力値'}）・${ROAD_KINDS[plan.kind] || '道路の種類 未設定'}・${type === 2 ? (plan.center ? '大都市の都心部' : '大都市の都心部以外') : type === 4 ? '都市部' : TERRAINS[plan.terrain === 'mount' ? 'mount' : 'flat']}`;
      if (needG == null) add('warn', '道路の区分', `第${type}種と道路の種類が合わない`, `第1種・第2種は高速自動車国道・自動車専用道路、第3種・第4種はその他の道路（一般国道・都道府県道・市町村道）。${basis}`, '道路構造令 第3条');
      else if (grade === needG) add('ok', '道路の区分', `${c.name} は計画交通量に対応する級`, basis, '道路構造令 第3条');
      else if (grade < needG) add('info', '道路の区分', `${c.name} は該当する級（第${needG}級）より上位`, `${basis} に該当するのは 第${type}種第${needG}級。上位の規格で計画している`, '道路構造令 第3条');
      else if (grade === needG + 1 && needG !== LOWEST[type]) add('warn', '道路の区分', `${c.name} は該当する級（第${needG}級）の 1 級下`, `${basis}。地形の状況その他の特別の理由によりやむを得ない場合に限り、1 級下の級に区分できる`, '道路構造令 第3条');
      else add('error', '道路の区分', `${c.name} は計画交通量に対して級が低い`, `${basis} に該当するのは 第${type}種第${needG}級`, '道路構造令 第3条');
      const ln = lanesFor(road.cls, plan.terrain, plan.q, plan.manyX), k4 = road.cls[0] === '4' && plan.manyX ? '（交差点の多い第4種: 2 車線 ×0.8・1 車線当たり ×0.6）' : '';
      if (ln && ln.single) add(plan.q > 500 ? 'warn' : 'ok', '車線数', `${c.name} は 1 車線道路`, `計画交通量 ${n0(plan.q)} 台/日。第3種第5級・第4種第4級は車線を設けない道路（計画交通量 500 台/日未満の市町村道が該当）`, '道路構造令 第3条・第5条');
      else if (ln && ln.lanes == null) add('info', '車線数', '設計基準交通量の表に値がない', `${c.name}・${TERRAINS[plan.terrain === 'mount' ? 'mount' : 'flat']} は第5条の表に 1 車線当たりの設計基準交通量が定められていない。区分・地形を確認する`, '道路構造令 第5条');
      else if (ln) {
        const d = ln.lanes === 2 ? `2 車線道路の設計基準交通量 ${n0(ln.two)} 台/日 以下${k4}` : `${ln.two ? `2 車線道路の設計基準交通量 ${n0(ln.two)} 台/日を超えるため、` : ''}計画交通量 ÷ 1 車線当たりの設計基準交通量 ${n0(ln.per)} 台/日 = ${f1(plan.q / ln.per)} → 4 以上・2 の倍数${k4}`;
        if (road.lanes === ln.lanes) add('ok', '車線数', `${road.lanes} 車線は計画交通量に対応`, d, '道路構造令 第5条');
        else if (road.lanes < ln.lanes) add('error', '車線数', `車線数 ${road.lanes} が不足（必要 ${ln.lanes} 車線）`, d, '道路構造令 第5条');
        else add('info', '車線数', `車線数 ${road.lanes} は必要数（${ln.lanes} 車線）より多い`, d, '道路構造令 第5条');
      }
    }
    /* 幅員構成でこのアプリが扱っていないもの */
    const md = medianOf(road.cls);
    if (!c.single && (md.must || road.lanes >= 4)) add('info', '横断構成', md.must ? `中央帯（最低 ${md.w}m）で往復の方向別に分離する区分` : `4 車線以上: 必要に応じ中央帯（最低 ${md.w}m）で分離`, `このアプリの幅員構成（車線・路肩・歩道）に中央帯は含まれていない。全幅・用地幅・事業費に中央帯の幅を別途見込む${md.must ? '（第1種・第2種・第3種第1級は往復の方向別に分離する）' : '（安全かつ円滑な交通を確保するため必要がある場合）'}`, '道路構造令 第6条');
    if (road.cls === '4-1' || road.cls === '4-2') add('info', '横断構成', '植樹帯を設ける区分', '第4種第1級・第2級の道路には植樹帯を設ける（幅員は 1.5m を標準）。幅員構成に含まれていないので、全幅・用地幅に別途見込む', '道路構造令 第11条の4');
    const semi = road.cls[0] === '1' || road.cls[0] === '2' || road.cls === '3-1' || road.cls === '4-1', wR = semi ? 250 : 160;
    const tight = al.curves.filter((cv) => cv && !cv.none && cv.R < wR);
    if (tight.length) add('info', '曲線部の拡幅', `${tight.map((cv) => 'IP' + cv.ip).join('・')}: 車線の拡幅が必要な曲線半径`, `車道の曲線部は設計車両（${semi ? 'セミトレーラ連結車' : '普通自動車'}）と曲線半径に応じて車線を拡幅する（目安: R < ${wR}m。拡幅量は「解説と運用」の表による）。幅員構成・用地幅に見込む${road.cls[0] === '2' || road.cls[0] === '4' ? '。第2種・第4種はやむを得ない場合はこの限りでない' : ''}`, '道路構造令 第17条／解説と運用（目安）');
    /* 土工 */
    const ew = A.ew;
    if (ew) {
      if (ew.cutV + ew.fillV > 1) {
        const d = `切土 ${n0(ew.cutV)} m³（地山）・盛土 ${n0(ew.fillV)} m³（締固め後）・土量変化率 C=${ew.C}。流用 ${n0(ew.reuse)} m³`;
        if (ew.borrow > Math.max(100, ew.fillV * 0.1)) add('info', '土工', `盛土材が ${n0(ew.borrow)} m³ 不足`, `${d}。不足分は購入土・他工事からの搬入が必要。計画高を下げると切盛が均衡に近づく`, '平均断面法による概算');
        else if (ew.surplus > Math.max(100, ew.cutV * 0.1)) add('info', '土工', `残土が ${n0(ew.surplus)} m³ 発生`, `${d}。残土は処分地への搬出が必要。計画高を上げると切盛が均衡に近づく`, '平均断面法による概算');
        else add('ok', '土工', '切土と盛土がほぼ均衡', d, '平均断面法による概算');
      }
      if (ew.openLen > 1) add('warn', '土工', `のり面が地山に取り付かない区間 約${n0(ew.openLen)}m`, `道路端から ${REACH}m の範囲で 盛土 1:${f1(FILL)}／切土 1:${f1(CUT)} ののり面が現況地盤と交わらない（地山の横断勾配が急）。擁壁・補強土壁・橋梁・桟道や、中心線を山側・谷側へ振ることを検討する。土量・用地幅はこの区間で過小`, '道路土工指針（目安）');
      if (ew.maxCut && ew.maxCut.d > 20) add('info', '土工', `最大切土高 ${f1(ew.maxCut.d)}m（${sta(ew.maxCut.s)} 付近）`, '切土高が 20m を超える。長大のり面の安定・維持管理と、トンネルにした場合の比較を検討する', '道路土工－切土工・斜面安定工指針（目安）');
      ew.bridges.forEach((b) => add('info', '橋梁', `橋梁区間 ${sta(b.s0)}〜${f1(b.s1)}m（延長 約${n0(b.s1 - b.s0)}m）`, `盛土高が 8m を超えるため橋梁として扱う（最大 ${f1(b.h)}m）。橋長・支間・下部工位置は別途検討`, '概略の扱い', b.s0));
    }
    (A.water || []).forEach((w) => { if (!w.bridged) add('warn', '水域の横断', `${sta(w.s0)}〜${f1(w.s1)}m で水域を横断（約${n0(w.len)}m）`, '河川・水面の上が盛土・切土のままになっている。橋梁・函渠を計画し、河川は計画高水位・桁下余裕高を河川管理者と協議する', '河川管理施設等構造令（協議事項）', w.s0); else add('info', '水域の横断', `${sta(w.s0)}〜${f1(w.s1)}m で水域を橋梁で横断（約${n0(w.len)}m）`, '河川を渡る橋は、径間長・桁下高・橋脚位置について河川管理者との協議が必要', '河川管理施設等構造令（協議事項）', w.s0); });
    if (A.hits) {
      if (A.hits.n) add('warn', '支障物件', `用地にかかる建物 ${A.hits.n} 棟（建築面積 ${n0(A.hits.area)} m²）`, `用地の帯（のり尻・のり肩＋余裕幅 ${ew ? ew.margin : 1}m）に重なる建物（国土地理院 最適化ベクトルタイルの建物外形）。移転補償の対象になる。線形を振って棟数を減らせないか検討する`, '概略の判定');
      else add('ok', '支障物件', '用地にかかる建物なし', '国土地理院 最適化ベクトルタイルの建物外形による', '概略の判定');
    }
    /* 交差 */
    const cross = A.cross || [], need = CLEAR + XS().DECK;
    cross.forEach((x) => {
      if (x.end) return; // 端点の接続は照査（接続）で確認済み
      const nm = `${sta(x.s)}: ${x.name || '既存道路'}`, hd = `計画高 ${f1(x.z)}m・交差道路の路面（現況地盤）${f1(x.g)}m・高低差 ${x.dz >= 0 ? '+' : '−'}${f1(Math.abs(x.dz))}m`;
      if (x.type === 'conflict') add('error', '交差', `${nm} と高さが合わない`, `${hd}。平面交差にするには計画高か交差道路をすり付け（±${GRADE_TOL}m 以内）、立体交差にするには桁下 ${CLEAR}m（建築限界）＋桁高 約${XS().DECK}m = 高低差 ${f1(need)}m 以上が必要`, '道路構造令 第12条・第27条', x.s);
      else if (x.type === 'over') add('info', '交差', `${nm} を立体交差で越える`, `${hd}（桁下 約${f1(x.dz - XS().DECK)}m ≥ 建築限界 ${CLEAR}m）${x.bridge ? '' : '。この位置が盛土のままなら橋梁・函渠（ボックスカルバート）にする'}`, '道路構造令 第12条', x.s);
      else if (x.type === 'under') add('info', '交差', `${nm} の下をくぐる`, `${hd}。交差道路側に橋（跨道橋）が必要。計画道路の建築限界 ${CLEAR}m を確保する`, '道路構造令 第12条', x.s);
      else if (x.type === 'grade') {
        if (x.ang < 60) add('error', '交差', `${nm} との交差角 ${f1(x.ang)}° が 60° 未満`, '平面交差は直角またはそれに近い角度（75°以上、やむを得ない場合でも 60°以上）とする。線形を振るか立体交差にする', '道路構造令 第27条／解説と運用', x.s);
        else if (x.ang < 75) add('warn', '交差', `${nm} との交差角 ${f1(x.ang)}° が 75° 未満`, '平面交差は直角またはそれに近い角度（75°以上）が望ましい', '道路構造令 第27条／解説と運用', x.s);
      }
    });
    const nGrade = cross.filter((x) => x.type === 'grade').length;
    if (cross.length) add('info', '交差', `交差・接続 ${cross.length} か所（平面交差 ${nGrade}・立体交差 ${cross.filter((x) => x.type === 'over' || x.type === 'under' || x.type === 'sepex').length}）`, `うち交差道路の幅員 5.5m 以上の平面交差（主要交差点）${cross.filter((x) => x.type === 'grade' && x.major).length} か所${A.cross.some((x) => x.auto) ? '。縦断計画が無いため、高低差は判定していない' : ''}`, '概略の判定');
    (A.gaps || []).forEach((g) => { if (g.gap < t.sight) add('warn', '交差', `平面交差の間隔 ${f1(g.gap)}m（${sta(g.s0)}〜${f1(g.s1)}m）`, `設計速度 ${road.V}km/h の制動停止視距 ${t.sight}m より短い。右折車線・滞留長が取れず、交差点が互いに影響する。交差道路の集約・片方の立体化・出入り制限を検討する`, '解説と運用（目安）', g.s0); });
    return out;
  }

  const Study = { REACH, LAT, CLEAR, GRADE_TOL, stations, offsets, crossSection, earthwork, balance, rowEdges, inRing, ringsHit, hitBuildings, floorsOf, waterCross, crossType, crossingList, spacing, rowAt, bridgeAt, ROAD_KINDS, TERRAINS, classFor, lanesFor, medianOf, DSV1, DSV2, COST_ITEMS, COST_DEFAULTS, cost, BC, runCost, benefits, bcr, sensitivity, lwa, laeq, noise, noiseDistance, NOISE_STD, review };
  if (typeof module !== 'undefined' && module.exports) module.exports = Study;
  else root.Study = Study;
})(typeof self !== 'undefined' ? self : this);
