/* Road Plan — 交通量の予測エンジン（DOM に依存しない純粋な計算。ブラウザと Node の両方で動く）
 *
 * 流れ
 *  1. buildNetwork  既存道路・計画道路の折れ線から、交差点をノード・交差点間をリンクとするネットワークを作る
 *  2. prepare       観測データ（実測・常時観測・センサス・取り込み）を精度の高い順にリンクへ割り当て、
 *                   データの無いリンクは道路種別・車線数・沿道状況（地区の属性）から交通量を推定する
 *  3. run           域外との出入口（コードン）の方向別交通量を発生・集中交通量として OD 表を推定し、
 *                   計画道路なし／ありのネットワークに配分して前後を比較する
 *
 * 交通量の単位は選んだ時間帯あたりの台数（方向別）、時間は分、長さは m。 */
(function (root) {
  'use strict';

  /* ───────── 定義 ───────── */
  const PERIODS = {
    day: { name: '日交通量（24時間）', short: '24時間', unit: '台/日' },
    d12: { name: '昼間12時間（7〜19時）', short: '昼間12時間', unit: '台/12h' },
    peak: { name: 'ピーク時（朝夕の大きい方の1時間）', short: 'ピーク時', unit: '台/時' },
    am: { name: '朝ピーク時（7・8時台の1時間）', short: '朝ピーク', unit: '台/時' },
    pm: { name: '夕ピーク時（17・18時台の1時間）', short: '夕ピーク', unit: '台/時' },
    night: { name: '夜間12時間（19〜7時）', short: '夜間12時間', unit: '台/12h' },
  };
  const AREAS = { 1: '人口集中地区（DID）・商業地域', 2: '人口集中地区（DID）', 3: 'その他市街部', 4: '平地部', 5: '山地部' };
  /* データの種別。rank が大きいほど優先（同順位は調査日の新しい方） */
  const SOURCES = {
    field: { name: '実測（現地観測）', short: '実測', rank: 100 },
    jartic: { name: '常時観測（国交省 交通量API）', short: '常時観測', rank: 80 },
    local: { name: '自治体等の調査（取り込み）', short: '自治体等', rank: 60 },
    census: { name: '道路交通センサス R3', short: 'センサス', rank: 60 },
  };
  const EST_RANK = 30, SPREAD_PENALTY = 15; // センサスの非観測区間（推定値） / 隣の区間の値を準用するときの減点
  const OD_METHODS = {
    entropy: { name: 'リンク観測交通量で補正（OD 逆推定）', note: '重力モデルの OD 表を、観測のある全リンクの方向別交通量に合うよう繰り返し補正する（エントロピー最大化）。観測が多いほど精度が上がる' },
    gravity: { name: '重力モデル（発生・集中の二重制約）', note: '出入口の流入＝発生、流出＝集中として、所要時間の抵抗つきで OD 表を作る（フレーター法と同じ収束計算）' },
    prop: { name: '比例配分（距離抵抗なし）', note: '発生量を集中量の比で単純に配る。OD の手がかりが無いときの最も単純な方法' },
  };
  const ASSIGN_METHODS = {
    ue: { name: '利用者均衡配分（Frank–Wolfe）', note: 'どの利用者も経路を変えても所要時間が短くならない状態（Wardrop 第1原則）。費用便益分析で標準' },
    inc: { name: '分割配分法', note: 'OD 表を何回かに分けて最短経路に流し、その都度 混雑による所要時間を更新する。実務で長く使われてきた方法' },
    sue: { name: '確率的配分（ロジット・Dial 法）', note: '最短でない経路にも所要時間の差に応じて流す。並行路線が多い市街地向け' },
    aon: { name: '最短経路配分（All-or-Nothing）', note: '混雑を考えず、全量を自由走行時の最短経路に流す。容量に余裕がある地域の概算用' },
    div: { name: '転換率法（時間比）', note: '計画道路を使う経路と使わない経路の所要時間比から、転換率 P=1/(1+比^6) で計画道路へ移る量を決める簡便法' },
  };
  const DEFAULTS = { period: 'day', od: 'entropy', assign: 'ue', area: 0, alpha: 0.48, beta: 2.82, splits: 5, theta: 0.5, gamma: 0.8, kappa: 6, growth: 1, internal: 1, maxZones: 70, crossPlanned: true };

  let M = (typeof TRAFFIC_MODEL !== 'undefined' && TRAFFIC_MODEL) || null;
  if (!M && typeof require === 'function') { try { M = require('./trafficmodel.js'); } catch (e) { M = null; } }
  const model = (m) => { if (m) M = m; return M; };

  /* 道路種別の正規化: mw 高速 / tr 国道 / pr 主要地方道級 / se 一般都道府県道級 / te 幹線市町村道 / un 一般道 / re 生活道路 / sv 通路 */
  const KIND_RANK = { mw: 6, tr: 5, pr: 4, se: 3, te: 2, un: 1, re: 0.5, sv: 0 };
  const KIND_JA = { mw: '高速道路', tr: '国道', pr: '主要地方道級', se: '都道府県道級', te: '幹線市町村道', un: '一般道', re: '生活道路', sv: '通路' };
  const OSM_KIND = { motorway: 'mw', trunk: 'tr', primary: 'pr', secondary: 'se', tertiary: 'te', unclassified: 'un', residential: 're', living_street: 're', service: 'sv', track: 'sv', road: 'un' };
  function kindOf(cls, width) {
    const c = String(cls || '').replace(/_link$/, '');
    if (OSM_KIND[c]) return OSM_KIND[c];
    if (/高速/.test(c)) return 'mw';
    if (/国道/.test(c)) return 'tr';
    if (/都道府県/.test(c)) return 'pr';
    return width >= 13 ? 'se' : width >= 5.5 ? 'un' : 're';
  }
  function planKind(road) { // 計画道路: 道路構造令の種級と車線数から
    const c = String(road.cls || '');
    if (c[0] === '1' || c[0] === '2') return 'mw';
    if (road.lanes >= 4 || c === '3-1' || c === '3-2' || c === '4-1') return 'pr';
    if (c === '3-3' || c === '4-2') return 'se';
    if (c === '3-4' || c === '4-3') return 'te';
    return 're';
  }
  const groupOf = (kind) => (kind === 'mw' ? 'H' : kind === 'tr' ? 'N' : kind === 'pr' || kind === 'se' ? 'P' : 'L');
  const laneCat = (n) => (n <= 1 ? 1 : n <= 3 ? 2 : n <= 5 ? 4 : 6);
  const pickLane = (tbl, g, area, lanes) => { // 表に無い組み合わせは近い車線数区分で代用
    const c = laneCat(lanes);
    for (const k of [c, 2, 4, 6, 1]) { const v = tbl && tbl[`${g}${area}${k}`]; if (v) return v; }
    return null;
  };
  const LOCAL_VOL = { te: 0.45, un: 0.2 }; // 幹線市町村道・一般道の交通量は都道府県道（2車線）の何割か
  const LOCAL_DAY = [1500, 800, 500, 200, 60]; // 生活道路の日交通量（両方向）の目安 [台/日]: 沿道状況 1〜5
  const LOCAL_CAP = { te: 0.8, un: 0.6, re: 0.45, sv: 0.3 };
  const LOCAL_V0 = { te: [20, 22, 28, 35, 35], un: [18, 20, 25, 30, 30], re: [15, 17, 20, 25, 25], sv: [10, 10, 12, 15, 15] };
  const GEN_RATE = [2.0, 1.0, 0.6, 0.2, 0.05]; // 域内の発生集中 [トリップエンド/日/生活道路 1m]: 沿道状況 1〜5

  /* 換算係数（昼夜率・ピーク率など）: 道路種別グループ×沿道状況の全国中央値 */
  function factors(group, area, own) {
    const g = group === 'L' ? 'P' : group, k = `${g}${area || 2}`, m = M || {};
    const f = { dn: (m.dn && m.dn[k]) || 1.3, pk: (m.pk && m.pk[k]) || 10, am: (m.am && m.am[k]) || 0.095, pm: (m.pm && m.pm[k]) || 0.095, lg: (m.lg && m.lg[k]) || 10 };
    if (own) { if (own.dn > 1) f.dn = own.dn; if (own.pk > 0) { const r = own.pk / f.pk; f.pk = own.pk; f.am *= r; f.pm *= r; } }
    return f;
  }
  /* 1 方向の入力値 side = {day,d12,night,peak,am,pm,hr[24]} から、時間帯 period の値を求める。
   * 戻り値 { v, conv }: conv = 別の時間帯の値から換算した（その時間帯の実測ではない） */
  const HKEYS = ['day', 'd12', 'night', 'peak', 'am', 'pm'];
  function fromHourly(hr) {
    if (!hr || hr.length !== 24 || hr.some((v) => !(v >= 0))) return null;
    const sum = (a, b) => { let s = 0; for (let i = a; i <= b; i++) s += hr[i]; return s; };
    const day = sum(0, 23), d12 = sum(7, 18), am = Math.max(hr[7], hr[8]), pm = Math.max(hr[17], hr[18]);
    return { day, d12, night: day - d12, am, pm, peak: Math.max(am, pm) };
  }
  function valueOf(side, period, f) {
    if (!side) return null;
    const h = fromHourly(side.hr);
    if (h) return { v: h[period], conv: false };
    if (side[period] >= 0 && side[period] !== '' && side[period] != null) return { v: +side[period], conv: false };
    const has = (k) => side[k] != null && side[k] !== '' && +side[k] >= 0;
    if (period === 'peak' && (has('am') || has('pm'))) return { v: Math.max(+side.am || 0, +side.pm || 0), conv: !(has('am') && has('pm')) };
    if (period === 'night' && has('day') && has('d12')) return { v: Math.max(0, side.day - side.d12), conv: false };
    if (period === 'day' && has('night') && has('d12')) return { v: +side.d12 + +side.night, conv: false };
    let d12 = null;
    if (has('d12')) d12 = +side.d12;
    else if (has('day')) d12 = side.day / f.dn;
    else if (has('night')) d12 = side.night / Math.max(0.05, f.dn - 1);
    else if (has('am')) d12 = side.am / f.am;
    else if (has('pm')) d12 = side.pm / f.pm;
    else if (has('peak')) d12 = side.peak / Math.max(f.am, f.pm);
    if (d12 == null) return null;
    const v = period === 'd12' ? d12 : period === 'day' ? d12 * f.dn : period === 'night' ? d12 * (f.dn - 1) : period === 'am' ? d12 * f.am : period === 'pm' ? d12 * f.pm : d12 * Math.max(f.am, f.pm);
    return { v, conv: true };
  }
  const hasData = (side) => !!side && (HKEYS.some((k) => side[k] != null && side[k] !== '' && +side[k] >= 0) || !!fromHourly(side.hr));
  /* 12 時間あたりの量（容量・発生量）を時間帯 period の量にする倍率 */
  const periodScale = (period, f) => (period === 'd12' ? 1 : period === 'day' ? f.dn : period === 'night' ? f.dn - 1 : period === 'am' ? f.am : period === 'pm' ? f.pm : Math.max(f.am, f.pm));

  /* ───────── ネットワーク ───────── */
  const hyp = Math.hypot;
  function segGrid(cell) {
    const m = new Map();
    return {
      add(x0, y0, x1, y1, v) {
        const i0 = Math.floor(Math.min(x0, x1) / cell), i1 = Math.floor(Math.max(x0, x1) / cell), j0 = Math.floor(Math.min(y0, y1) / cell), j1 = Math.floor(Math.max(y0, y1) / cell);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i + ',' + j, a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }
      },
      near(x, y, r, fn) { // 半径 r に掛かるセルの要素を重複なしで列挙
        const i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell), j0 = Math.floor((y - r) / cell), j1 = Math.floor((y + r) / cell), seen = new Set();
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = m.get(i + ',' + j); if (a) for (const v of a) if (!seen.has(v)) { seen.add(v); fn(v); } }
      },
    };
  }
  const projSeg = (px, py, ax, ay, bx, by) => { const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0; return { t, x: ax + vx * t, y: ay + vy * t, d: hyp(px - ax - vx * t, py - ay - vy * t) }; };

  /* roads: [{ id, xy:[{x,y}], kind, lanes, speed, oneway(0/1/-1), name, width, planned, cross }]
   * 戻り値 net: { nodes:[{x,y,deg}], edges:[{a,b,pts,len,kind,lanes,oneway,planned,rid,name,speed,key,mid}] } */
  function buildNetwork(roads, opt = {}) {
    const P = roads.map((r) => r.xy.map((p) => [p.x, p.y])).map((p) => p.filter((q, i) => i === 0 || hyp(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) > 0.01));
    const ok = (ri) => P[ri].length >= 2;
    const grid = segGrid(40), ins = roads.map(() => []);
    P.forEach((p, ri) => { if (ok(ri)) for (let s = 0; s < p.length - 1; s++) grid.add(p[s][0], p[s][1], p[s + 1][0], p[s + 1][1], ri * 1e6 + s); });
    /* 端点が他の道路の途中に載っているとき（T字・計画道路の接続）は、相手の線にも頂点を入れてつなぐ */
    P.forEach((p, ri) => {
      if (!ok(ri)) return;
      const tol = roads[ri].planned ? 6 : 2.5;
      for (const end of [0, p.length - 1]) {
        const e = p[end]; let best = null;
        grid.near(e[0], e[1], tol, (v) => {
          const rj = Math.floor(v / 1e6), s = v % 1e6;
          if (rj === ri && Math.abs(s - (end === 0 ? 0 : p.length - 2)) <= 1) return;
          const q = P[rj], pr = projSeg(e[0], e[1], q[s][0], q[s][1], q[s + 1][0], q[s + 1][1]);
          if (pr.d <= tol && (!best || pr.d < best.d)) best = { rj, s, t: pr.t, x: pr.x, y: pr.y, d: pr.d };
        });
        if (!best) continue;
        const q = P[best.rj], a = q[best.s], b = q[best.s + 1], da = hyp(best.x - a[0], best.y - a[1]), db = hyp(best.x - b[0], best.y - b[1]);
        if (da < 0.6) { e[0] = a[0]; e[1] = a[1]; } else if (db < 0.6) { e[0] = b[0]; e[1] = b[1]; } else { e[0] = best.x; e[1] = best.y; ins[best.rj].push({ s: best.s, t: best.t, x: best.x, y: best.y }); }
      }
    });
    /* 計画道路が途中で横切る道路とは平面交差としてつなぐ（高速道路・立体交差の指定がある道路を除く） */
    if (opt.crossPlanned !== false) P.forEach((p, ri) => {
      const r = roads[ri];
      if (!ok(ri) || !r.planned || r.cross === false) return;
      for (let s = 0; s < p.length - 1; s++) {
        const ax = p[s][0], ay = p[s][1], bx = p[s + 1][0], by = p[s + 1][1], mx = (ax + bx) / 2, my = (ay + by) / 2, rad = hyp(bx - ax, by - ay) / 2 + 1;
        grid.near(mx, my, rad, (v) => {
          const rj = Math.floor(v / 1e6), t = v % 1e6, o = roads[rj];
          if (rj === ri || o.sep || (o.kind === 'mw' && r.kind !== 'mw') || (o.planned && rj < ri)) return;
          const q = P[rj], cx = q[t][0], cy = q[t][1], dx = q[t + 1][0], dy = q[t + 1][1];
          const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx); if (Math.abs(d) < 1e-9) return;
          const u = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d, w = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
          if (u <= 0 || u >= 1 || w <= 0 || w >= 1) return;
          const x = ax + (bx - ax) * u, y = ay + (by - ay) * u;
          ins[ri].push({ s, t: u, x, y }); ins[rj].push({ s: t, t: w, x, y });
        });
      }
    });
    ins.forEach((list, ri) => {
      if (!list.length) return;
      list.sort((a, b) => b.s - a.s || b.t - a.t);
      for (const i of list) { const p = P[ri], a = p[i.s], b = p[i.s + 1]; if (hyp(i.x - a[0], i.y - a[1]) > 0.3 && hyp(i.x - b[0], i.y - b[1]) > 0.3) p.splice(i.s + 1, 0, [i.x, i.y]); }
    });
    /* 頂点をまとめる（0.6m 以内は同じ点） */
    const cl = new Map(), cpt = [], TOL = 0.6;
    const cid = (x, y) => {
      const i = Math.floor(x / TOL), j = Math.floor(y / TOL);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const a = cl.get((i + di) + ',' + (j + dj)); if (a) for (const c of a) if (hyp(cpt[c][0] - x, cpt[c][1] - y) <= TOL) return c; }
      const c = cpt.length; cpt.push([x, y]); const k = i + ',' + j, a = cl.get(k); if (a) a.push(c); else cl.set(k, [c]); return c;
    };
    const C = P.map((p, ri) => (ok(ri) ? p.map((q) => cid(q[0], q[1])) : [])), cnt = new Int32Array(cpt.length), isNode = new Uint8Array(cpt.length);
    C.forEach((c) => { c.forEach((k, i) => { cnt[k]++; if (i === 0 || i === c.length - 1) isNode[k] = 1; }); });
    for (let k = 0; k < cnt.length; k++) if (cnt[k] >= 2) isNode[k] = 1;
    /* 折れ線をノードで切ってリンクにする */
    let edges = [];
    C.forEach((c, ri) => {
      if (c.length < 2) return;
      const r = roads[ri]; let st = 0;
      for (let i = 1; i < c.length; i++) {
        if (!isNode[c[i]]) continue;
        const pts = P[ri].slice(st, i + 1).map((q) => [q[0], q[1]]);
        pts[0] = cpt[c[st]].slice(); pts[pts.length - 1] = cpt[c[i]].slice();
        let len = 0; for (let k = 1; k < pts.length; k++) len += hyp(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        if (c[st] !== c[i] || len > 1) edges.push({ a: c[st], b: c[i], pts, len, kind: r.kind, lanes: r.lanes || 0, oneway: r.oneway || 0, planned: !!r.planned, rid: r.id, name: r.name || '', speed: r.speed || 0, speedEst: !!r.speedEst, width: r.width || 0, tv: r.tv || 0 });
        st = i;
      }
    });
    /* 次数 2 のノード（道路データの区切り）をまたいで、同じ属性のリンクを 1 本にまとめる */
    const inc = new Map(); const push = (n, e) => { const a = inc.get(n); if (a) a.push(e); else inc.set(n, [e]); };
    edges.forEach((e) => { push(e.a, e); push(e.b, e); });
    const rev = (e) => { e.pts.reverse(); const t = e.a; e.a = e.b; e.b = t; e.oneway = -e.oneway; };
    for (const [n, list] of inc) {
      if (list.length !== 2 || list[0] === list[1]) continue;
      const [e1, e2] = list;
      if (e1.dead || e2.dead || e1.kind !== e2.kind || e1.planned !== e2.planned || (e1.planned && e1.rid !== e2.rid) || e1.lanes !== e2.lanes) continue;
      if (e1.b !== n) rev(e1); if (e2.a !== n) rev(e2);
      if (e1.oneway !== e2.oneway || e1.a === e2.b) { continue; }
      const L = e1.len + e2.len;
      e1.speed = (e1.speed * e1.len + e2.speed * e2.len) / L; e1.speedEst = e1.speedEst || e2.speedEst; e1.width = (e1.width * e1.len + e2.width * e2.len) / L;
      e1.pts = e1.pts.concat(e2.pts.slice(1)); e1.len = L; e1.b = e2.b; e1.name = e1.name || e2.name; e2.dead = true;
      const far = inc.get(e2.b); far[far.indexOf(e2)] = e1; isNode[n] = 0;
    }
    edges = edges.filter((e) => !e.dead);
    const nid = new Int32Array(cpt.length).fill(-1), nodes = [];
    const node = (c) => { if (nid[c] < 0) { nid[c] = nodes.length; nodes.push({ x: cpt[c][0], y: cpt[c][1], deg: 0 }); } return nid[c]; };
    edges.forEach((e) => {
      e.a = node(e.a); e.b = node(e.b); nodes[e.a].deg++; nodes[e.b].deg++;
      const m = pointAt(e, e.len / 2); e.mid = [m.x, m.y]; e.key = Math.round(m.x) + ',' + Math.round(m.y);
    });
    return { nodes, edges };
  }
  /* リンク上の距離 s の位置と進行方向（a→b） */
  function pointAt(e, s) {
    const p = e.pts; let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const l = hyp(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      if (acc + l >= s || i === p.length - 1) { const t = l ? Math.max(0, Math.min(1, (s - acc) / l)) : 0; return { x: p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, y: p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t, dx: l ? (p[i][0] - p[i - 1][0]) / l : 1, dy: l ? (p[i][1] - p[i - 1][1]) / l : 0 }; }
      acc += l;
    }
    return { x: p[0][0], y: p[0][1], dx: 1, dy: 0 };
  }
  function nearestOnEdge(e, x, y) {
    let best = null; const p = e.pts;
    for (let i = 1; i < p.length; i++) { const pr = projSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]); if (!best || pr.d < best.d) { const l = hyp(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]) || 1; best = { d: pr.d, x: pr.x, y: pr.y, dx: (p[i][0] - p[i - 1][0]) / l, dy: (p[i][1] - p[i - 1][1]) / l }; } }
    return best;
  }

  /* ───────── 観測データの割り当てと現況交通量 ─────────
   * obs: [{ id, src, est, date, off, pin, p:{x,y}（地点）| ls:[[{x,y}]]（区間。向きは a 方向）, av:{x,y}（a 方向の単位ベクトル）, ud（a=下り,b=上り）,
   *         a:{...}, b:{...}, both:{...}, meta:{type,lanes,area,dn,pk,konz,spd:[朝夕b,朝夕a,昼間b,昼間a],oriented} }]
   * 各リンクに e.cands（候補。優先順）, e.ob（採用した候補）, e.area, e.lanesEff, e.cap12, e.v0[2] を付ける */
  const rankOf = (c) => (c.o.pin ? 1000 : 0) + (c.o.est ? EST_RANK : (SOURCES[c.o.src] || SOURCES.local).rank) - (c.how === 'spread' ? SPREAD_PENALTY : 0);
  const dateNum = (d) => +String(d || '').replace(/\D/g, '').slice(0, 8).padEnd(8, '0') || 0;
  function prepare(net, obsList, opt = {}) {
    const E = net.edges, obs = (obsList || []).filter((o) => !o.off);
    E.forEach((e) => { e.cands = []; e.ob = null; });
    const egrid = segGrid(60);
    E.forEach((e, ei) => { for (let i = 1; i < e.pts.length; i++) egrid.add(e.pts[i - 1][0], e.pts[i - 1][1], e.pts[i][0], e.pts[i][1], ei); });
    /* 区間データ（センサス）: リンクの 20・50・80% の点が、区間の線の近くをほぼ平行に通っていれば割り当てる */
    const lgrid = segGrid(100), lseg = [];
    obs.forEach((o, oi) => { if (o.ls) o.ls.forEach((l) => { for (let i = 1; i < l.length; i++) { lgrid.add(l[i - 1].x, l[i - 1].y, l[i].x, l[i].y, lseg.length); lseg.push([oi, l[i - 1].x, l[i - 1].y, l[i].x, l[i].y]); } }); });
    const linesNear = (x, y, dx, dy, tol, filter) => { // 近くを通る区間ごとに、最も近い線分
      const best = new Map();
      lgrid.near(x, y, tol, (si) => {
        const s = lseg[si], o = obs[s[0]]; if (filter && !filter(o)) return;
        const pr = projSeg(x, y, s[1], s[2], s[3], s[4]); if (pr.d > tol) return;
        const l = hyp(s[3] - s[1], s[4] - s[2]) || 1, ux = (s[3] - s[1]) / l, uy = (s[4] - s[2]) / l, cos = dx == null ? 1 : ux * dx + uy * dy;
        if (Math.abs(cos) < 0.8) return;
        const b = best.get(s[0]); if (!b || pr.d < b.d) best.set(s[0], { d: pr.d, oi: s[0], sign: cos >= 0 ? 1 : -1, ux, uy });
      });
      return [...best.values()].sort((a, b) => a.d - b.d);
    };
    if (lseg.length) E.forEach((e) => {
      if (e.planned || KIND_RANK[e.kind] < 1) return;
      const tol = e.kind === 'mw' ? 30 : KIND_RANK[e.kind] >= 3 ? 22 : 12, hi = e.kind === 'mw';
      const filter = (o) => { const t = o.meta && o.meta.type; return !t || (t <= 2) === hi || e.kind === 'tr'; };
      const votes = new Map();
      for (const f of [0.2, 0.5, 0.8]) { const q = pointAt(e, e.len * f); for (const m of linesNear(q.x, q.y, q.dx, q.dy, tol, filter)) { const v = votes.get(m.oi) || { n: 0, s: 0 }; v.n++; v.s += m.sign; votes.set(m.oi, v); } }
      for (const [oi, v] of votes) if (v.n >= 2 || e.len < 40) e.cands.push({ o: obs[oi], sign: v.s >= 0 ? 1 : -1, how: 'direct' });
    });
    /* 地点データ（実測・常時観測・取り込み）: 最も近いリンクに割り当て、同じ道路の隣の区間へも準用する */
    obs.forEach((o) => {
      if (!o.p) return;
      let best = null;
      egrid.near(o.p.x, o.p.y, 40, (ei) => { const e = E[ei]; if (e.planned) return; const n = nearestOnEdge(e, o.p.x, o.p.y), d = n.d - Math.min(8, KIND_RANK[e.kind] * 2); if (n.d <= 40 && (!best || d < best.dd)) best = { ei, dd: d, n }; });
      if (!best) { o.unmatched = true; return; }
      o.unmatched = false;
      const e = E[best.ei]; let av = o.av, unknown = false;
      if (!av && o.ud) { const m = linesNear(o.p.x, o.p.y, null, null, 45, (c) => !c.meta || c.meta.oriented !== 0)[0]; if (m) av = { x: m.ux, y: m.uy }; } // 上り下りの向きはセンサスの区間の向きから
      if (!av) { av = { x: best.n.dx, y: best.n.dy }; unknown = true; }
      const sign = av.x * best.n.dx + av.y * best.n.dy >= 0 ? 1 : -1;
      o.dirUnknown = unknown; o.edgeKey = e.key;
      e.cands.push({ o, sign, how: 'direct', unknown });
      spread(net, e, sign, o);
    });
    E.forEach((e) => {
      e.cands.sort((x, y) => rankOf(y) - rankOf(x) || dateNum(y.o.date) - dateNum(x.o.date));
      e.ob = e.cands[0] || null;
    });
    attributes(net, opt);
    return net;
  }
  /* 地点データを同じ道路の隣のリンクへ準用: 直進方向へ、同格以上の道路との交差点に出るまで（最長 1.5km） */
  function spread(net, e0, sign0, o) {
    const inc = net.inc || (net.inc = incidence(net));
    for (const startAtB of [true, false]) {
      let e = e0, n = startAtB ? e.b : e.a, sign = sign0, dist = 0;
      for (let step = 0; step < 40 && dist < 1500; step++) {
        const dirOut = e.b === n ? endDir(e, true) : endDir(e, false); // n に入っていく向き
        let next = null, block = false;
        for (const f of inc[n]) {
          if (f === e) continue;
          const fd = f.a === n ? endDir(f, false, true) : endDir(f, true, true); // n から出ていく向き
          const cos = dirOut.x * fd.x + dirOut.y * fd.y;
          if (cos > 0.87 && f.kind === e.kind && !f.planned && (!next || cos > next.cos)) next = { f, cos };
          else if (KIND_RANK[f.kind] >= KIND_RANK[e.kind] && !f.planned) block = true;
        }
        if (!next || block) break;
        const f = next.f, same = (e.b === n) === (f.a === n); // 進行方向が a→b のまま続くか
        sign = same ? sign : -sign; e = f; n = f.a === n ? f.b : f.a; dist += f.len;
        f.cands.push({ o, sign, how: 'spread' });
      }
    }
  }
  const incidence = (net) => { const inc = net.nodes.map(() => []); net.edges.forEach((e) => { inc[e.a].push(e); if (e.b !== e.a) inc[e.b].push(e); }); return inc; };
  function endDir(e, atB, outward) { // 端点での向き。outward=true はノードから離れる向き
    const p = e.pts, n = p.length, a = atB ? p[n - 2] : p[1], b = atB ? p[n - 1] : p[0], l = hyp(b[0] - a[0], b[1] - a[1]) || 1;
    const s = outward ? -1 : 1; return { x: (s * (b[0] - a[0])) / l, y: (s * (b[1] - a[1])) / l };
  }

  /* リンクの属性（沿道状況・車線数・交通容量・自由走行速度） */
  function attributes(net, opt) {
    const E = net.edges, edits = opt.edits || {};
    /* 沿道状況: センサス区間の値 → 近く（600m）のセンサス区間 → 指定値 → 道路密度から推定 */
    const cg = new Map(), CELL = 300;
    E.forEach((e) => { const k = Math.floor(e.mid[0] / CELL) + ',' + Math.floor(e.mid[1] / CELL), c = cg.get(k) || { len: 0, areas: [] }; cg.set(k, c); if (!e.planned) c.len += e.len; const a = e.ob && e.ob.o.meta && e.ob.o.meta.area; if (a) c.areas.push(a); });
    const around = (e, r, fn) => { const i = Math.floor(e.mid[0] / CELL), j = Math.floor(e.mid[1] / CELL); for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) { const c = cg.get((i + di) + ',' + (j + dj)); if (c) fn(c); } };
    E.forEach((e) => {
      const ed = edits[e.key] || {}, m = e.ob && e.ob.o.meta;
      let area = ed.area || (m && m.area) || 0, areaSrc = ed.area ? 'edit' : area ? 'census' : '';
      if (!area) { const cntA = [0, 0, 0, 0, 0, 0]; around(e, 2, (c) => c.areas.forEach((a) => cntA[a]++)); const mx = Math.max(...cntA); if (mx > 0) { area = cntA.indexOf(mx); areaSrc = 'near'; } }
      if (!area && opt.area) { area = opt.area; areaSrc = 'set'; }
      if (!area) { let len = 0; around(e, 1, (c) => { len += c.len; }); const d = len / 1000 / ((CELL * 3) ** 2 / 1e6); area = d >= 18 ? 2 : d >= 9 ? 3 : d >= 3 ? 4 : 5; areaSrc = 'density'; }
      e.area = area; e.areaSrc = areaSrc;
      const g = groupOf(e.kind); e.group = g;
      /* 車線数（両方向の合計） */
      let lanes = ed.lanes || 0, laneSrc = 'edit';
      const half = !!(e.oneway && m && !m.oneway); // 上下線が別々の線で描かれた道路の片側（センサスの値は両方向の合計）
      if (!lanes && m && m.lanes > 0) { lanes = half ? Math.max(1, Math.round(m.lanes / 2)) : m.lanes; laneSrc = 'census'; }
      if (!lanes && e.lanes > 0) { lanes = e.lanes; laneSrc = 'data'; }
      if (!lanes) { lanes = e.kind === 'mw' ? 4 : e.kind === 're' || e.kind === 'sv' ? (e.width >= 5.5 ? 2 : 1) : e.width >= 13 ? 4 : e.width > 0 && e.width < 5.5 ? 1 : 2; if (e.oneway) lanes = Math.max(1, Math.round(lanes / 2)); laneSrc = 'guess'; }
      e.lanesEff = lanes; e.laneSrc = laneSrc;
      /* 交通容量 [台/12h, 両方向]: センサス区間は 交通量÷混雑度、それ以外は全国の中央値（道路種別×沿道状況×車線数） */
      const eff = e.oneway ? lanes * 2 : lanes; // 表は両方向の車線数で引く
      let cap = ed.cap12 || 0, capSrc = 'edit';
      if (!cap && m && m.konz > 0 && m.t12 > 0 && !ed.lanes) { cap = m.t12 / m.konz / (half ? 2 : 1); capSrc = 'census'; }
      if (!cap) {
        const gg = g === 'L' ? 'P' : g, per = pickLane(M && M.cap12, gg, area, e.kind === 're' && eff <= 1 ? 1 : Math.max(eff, g === 'L' ? 2 : 1)) || 4000;
        cap = per * lanes * (g === 'L' ? LOCAL_CAP[e.kind] || 0.5 : 1); capSrc = 'model';
      }
      e.cap12 = cap; e.capSrc = capSrc;
      /* 自由走行速度 [km/h]（a→b, b→a）: センサスの昼間非混雑時旅行速度 → 種別×沿道状況の中央値。規制速度は超えない */
      let v = g === 'L' ? LOCAL_V0[e.kind][area - 1] : (M && M.v0 && M.v0[`${g}${area}`]) || (g === 'H' ? 80 : 30);
      if (e.kind === 'se') v *= 0.95;
      if (e.planned) v = e.tv > 0 ? e.tv : Math.min(e.speed || 60, Math.max(v * 1.15, (e.speed || 40) * 0.6));
      else if (e.speed > 0 && !e.speedEst) v = Math.min(v, e.speed);
      let va = v, vb = v;
      if (m && m.spd && !e.planned) { const sa = e.ob.sign > 0 ? m.spd[3] : m.spd[2], sb = e.ob.sign > 0 ? m.spd[2] : m.spd[3]; if (sa > 3) va = sa; if (sb > 3) vb = sb; }
      if (ed.v0 > 0) va = vb = ed.v0;
      e.v0 = [Math.max(3, va), Math.max(3, vb)]; e.closed = !!ed.closed;
    });
  }

  /* 現況交通量（時間帯 period・方向別）: 採用した観測値。無ければ属性から推定し、近くの観測値との比で補正する。
   * e.base = [a→b, b→a], e.bst = ['real'|'est'|'attr', ...], e.bconv = [換算したか, ...] */
  function baseVolumes(net, period) {
    const E = net.edges, ratio = { H: [], N: [], P: [], L: [] };
    const attrDay = (e) => { // 属性からの日交通量（両方向の合計。一方通行はその 1 方向）
      const g = e.group, eff = e.oneway ? e.lanesEff * 2 : e.lanesEff;
      if (g !== 'L') return (pickLane(M && M.vol24, g, e.area, eff) || 3000) * e.lanesEff;
      const ow = e.oneway ? 0.5 : 1;
      if (LOCAL_VOL[e.kind]) return (pickLane(M && M.vol24, 'P', e.area, 2) || 3000) * 2 * LOCAL_VOL[e.kind] * ow;
      return LOCAL_DAY[e.area - 1] * (e.kind === 'sv' ? 0.3 : 1) * ow;
    };
    E.forEach((e) => {
      e.base = [null, null]; e.bst = [null, null]; e.bconv = [false, false]; e.fac = factors(e.group, e.area, e.ob && e.ob.o.meta);
      if (e.planned || !e.ob) return;
      const c = e.ob, o = c.o, st = o.est || c.how === 'spread' ? 'est' : 'real';
      const sides = c.sign > 0 ? [o.a, o.b] : [o.b, o.a];
      for (let d = 0; d < 2; d++) {
        if ((d === 0 && e.oneway < 0) || (d === 1 && e.oneway > 0)) { e.base[d] = 0; e.bst[d] = st; continue; }
        let r = valueOf(sides[d], period, e.fac), split = false;
        if (!r && hasData(o.both)) { r = valueOf(o.both, period, e.fac); if (r) { r = { v: e.oneway ? r.v : r.v / 2, conv: r.conv }; split = !e.oneway; } }
        if (!r) continue;
        e.base[d] = r.v; e.bst[d] = split || c.unknown ? 'est' : st; e.bconv[d] = r.conv;
      }
      if (st === 'real' && e.base[0] != null && e.base[1] != null) { const dayF = periodScale(period, e.fac) / e.fac.dn, a = attrDay(e) * dayF; if (a > 0) ratio[e.group].push((e.base[0] + e.base[1]) / a); }
    });
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
    const all = med([].concat(ratio.H, ratio.N, ratio.P, ratio.L));
    const k = {}; for (const g of 'HNPL') { const m = ratio[g].length >= 2 ? med(ratio[g]) : all; k[g] = m == null ? 1 : Math.max(0.3, Math.min(3, m)); }
    net.attrCalib = k;
    E.forEach((e) => {
      if (e.planned) return;
      const two = attrDay(e) * k[e.group] * (periodScale(period, e.fac) / e.fac.dn);
      for (let d = 0; d < 2; d++) {
        if (e.base[d] != null) continue;
        const blocked = (d === 0 && e.oneway < 0) || (d === 1 && e.oneway > 0), other = e.base[1 - d];
        e.base[d] = blocked ? 0 : e.oneway ? two : other != null && e.bst[1 - d] !== 'attr' ? other : two / 2; e.bst[d] = 'attr'; e.bconv[d] = false;
      }
    });
  }

  /* ───────── 配分計算 ───────── */
  function graphOf(net, period) {
    const E = net.edges, nN = net.nodes.length, nA = E.length * 2;
    const g = { nN, nA, tail: new Int32Array(nA), head: new Int32Array(nA), t0: new Float64Array(nA), cap: new Float64Array(nA), len: new Float64Array(nA), ok: new Uint8Array(nA), planned: new Uint8Array(nA), on: new Uint8Array(nA) };
    E.forEach((e, i) => {
      const sc = periodScale(period, e.fac || factors(e.group, e.area)), cap = Math.max(1, (e.cap12 * sc) / (e.oneway ? 1 : 2));
      for (let d = 0; d < 2; d++) {
        const a = 2 * i + d; g.tail[a] = d ? e.b : e.a; g.head[a] = d ? e.a : e.b; g.len[a] = e.len; g.cap[a] = cap;
        g.t0[a] = (e.len / 1000 / e.v0[d]) * 60; g.planned[a] = e.planned ? 1 : 0;
        g.ok[a] = !e.closed && (d ? e.oneway <= 0 : e.oneway >= 0) ? 1 : 0;
      }
    });
    const csr = (key) => { const st = new Int32Array(nN + 1); for (let a = 0; a < nA; a++) st[key[a] + 1]++; for (let n = 0; n < nN; n++) st[n + 1] += st[n]; const pos = st.slice(0, nN), arr = new Int32Array(nA); for (let a = 0; a < nA; a++) arr[pos[key[a]]++] = a; return [st, arr]; };
    [g.outS, g.outA] = csr(g.tail); [g.inS, g.inA] = csr(g.head);
    g.dist = new Float64Array(nN); g.pred = new Int32Array(nN); g.order = new Int32Array(nN); g.hn = new Int32Array(nA + nN + 8); g.hd = new Float64Array(nA + nN + 8); g.load = new Float64Array(nN);
    return g;
  }
  const setCase = (g, withPlanned) => { for (let a = 0; a < g.nA; a++) g.on[a] = g.ok[a] && (withPlanned || !g.planned[a]) ? 1 : 0; };
  /* 最短経路（Dijkstra）。g.dist, g.pred（その節点に入る arc）, g.order（確定順）を埋め、確定した節点数を返す */
  function sssp(g, src, cost) {
    const { dist, pred, order, hn, hd, outS, outA, head, on } = g;
    dist.fill(Infinity); pred.fill(-1); dist[src] = 0;
    let hs = 0, no = 0;
    const pushH = (n, d) => { let i = hs++; while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hd[i] = hd[p]; hn[i] = hn[p]; i = p; } hd[i] = d; hn[i] = n; };
    pushH(src, 0);
    while (hs > 0) {
      const n = hn[0], d = hd[0]; hs--;
      if (hs > 0) { const ld = hd[hs], ln = hn[hs]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hs) break; if (c + 1 < hs && hd[c + 1] < hd[c]) c++; if (hd[c] >= ld) break; hd[i] = hd[c]; hn[i] = hn[c]; i = c; } hd[i] = ld; hn[i] = ln; }
      if (d > dist[n]) continue;
      order[no++] = n;
      for (let k = outS[n]; k < outS[n + 1]; k++) { const a = outA[k]; if (!on[a]) continue; const nd = d + cost[a], m = head[a]; if (nd < dist[m]) { dist[m] = nd; pred[m] = a; pushH(m, nd); } }
    }
    return no;
  }
  /* 全量を最短経路に流す。x に加算。od は Z×Z、zones は節点番号 */
  function aon(g, od, zones, cost, x, scale = 1) {
    const Z = zones.length, { load, pred, order, tail, dist } = g;
    for (let i = 0; i < Z; i++) {
      let any = false; for (let j = 0; j < Z; j++) if (od[i * Z + j] > 0) { any = true; break; }
      if (!any) continue;
      const no = sssp(g, zones[i], cost);
      load.fill(0);
      for (let j = 0; j < Z; j++) { const d = od[i * Z + j]; if (d > 0 && isFinite(dist[zones[j]])) load[zones[j]] += d * scale; }
      for (let k = no - 1; k > 0; k--) { const n = order[k], l = load[n]; if (l > 0) { const a = pred[n]; x[a] += l; load[tail[a]] += l; } }
    }
    return x;
  }
  /* Dial の確率配分（ロジット型）。起点ごとに「起点から遠ざかる arc」だけを使う */
  function dial(g, od, zones, cost, x, theta) {
    const Z = zones.length, { dist, order, tail, head, inS, inA, on } = g, W = new Float64Array(g.nA), nw = new Float64Array(g.nN), flow = new Float64Array(g.nN);
    for (let i = 0; i < Z; i++) {
      let any = false; for (let j = 0; j < Z; j++) if (od[i * Z + j] > 0) { any = true; break; }
      if (!any) continue;
      const no = sssp(g, zones[i], cost); nw.fill(0); flow.fill(0); nw[zones[i]] = 1;
      for (let k = 1; k < no; k++) { // 起点に近い順
        const n = order[k]; let s = 0;
        for (let q = inS[n]; q < inS[n + 1]; q++) { const a = inA[q], t = tail[a]; W[a] = 0; if (!on[a] || !(dist[t] < dist[n])) continue; W[a] = Math.exp(theta * (dist[n] - dist[t] - cost[a])) * nw[t]; s += W[a]; }
        nw[n] = s;
      }
      for (let j = 0; j < Z; j++) { const d = od[i * Z + j]; if (d > 0 && isFinite(dist[zones[j]])) flow[zones[j]] += d; }
      for (let k = no - 1; k > 0; k--) { // 遠い順に戻す
        const n = order[k], f = flow[n]; if (!(f > 0) || !(nw[n] > 0)) continue;
        for (let q = inS[n]; q < inS[n + 1]; q++) { const a = inA[q]; if (W[a] > 0) { const v = (f * W[a]) / nw[n]; x[a] += v; flow[tail[a]] += v; } }
      }
    }
    return x;
  }
  /* リンク所要時間（BPR 関数）: t = t0 (1 + α (x/C)^β) */
  function bpr(g, x, P, out) { const t = out || new Float64Array(g.nA); for (let a = 0; a < g.nA; a++) t[a] = g.t0[a] * (1 + P.alpha * Math.pow(Math.max(0, x[a]) / g.cap[a], P.beta)); return t; }
  /* 1 ケース（計画道路なし／あり）の配分。戻り値 { x, t, iters, gap } */
  function assign(g, od, zones, method, P, light) {
    const nA = g.nA; let x = new Float64Array(nA), iters = 1, gap = null;
    if (method === 'aon') aon(g, od, zones, g.t0, x);
    else if (method === 'inc') { const n = Math.max(2, Math.round(P.splits || 5)); for (let k = 0; k < n; k++) aon(g, od, zones, bpr(g, x, P), x, 1 / n); iters = n; }
    else if (method === 'sue') {
      const K = light ? 6 : 16;
      for (let k = 1; k <= K; k++) { const y = dial(g, od, zones, bpr(g, x, P), new Float64Array(nA), P.theta || 0.5); for (let a = 0; a < nA; a++) x[a] += (y[a] - x[a]) / k; }
      iters = K;
    } else { // 利用者均衡（Frank–Wolfe 法）
      aon(g, od, zones, g.t0, x);
      const maxIt = light ? 8 : 40, t = new Float64Array(nA);
      for (iters = 1; iters <= maxIt; iters++) {
        bpr(g, x, P, t);
        const y = aon(g, od, zones, t, new Float64Array(nA));
        let sx = 0, sy = 0; for (let a = 0; a < nA; a++) { sx += x[a] * t[a]; sy += y[a] * t[a]; }
        gap = sx > 0 ? (sx - sy) / sx : 0;
        if (gap < 0.002) break;
        let lo = 0, hi = 1; // Σ (y−x)·t(x+λ(y−x)) = 0 となる λ を二分法で
        for (let it = 0; it < 18; it++) {
          const lam = (lo + hi) / 2; let s = 0;
          for (let a = 0; a < nA; a++) { const d = y[a] - x[a]; if (d !== 0) s += d * g.t0[a] * (1 + P.alpha * Math.pow((x[a] + lam * d) / g.cap[a], P.beta)); }
          if (s > 0) hi = lam; else lo = lam;
        }
        const lam = (lo + hi) / 2; for (let a = 0; a < nA; a++) x[a] += lam * (y[a] - x[a]);
      }
    }
    return { x, t: bpr(g, x, P), iters, gap };
  }

  /* ───────── ゾーン（域外との出入口＋域内） ───────── */
  function buildZones(net, period, opt) {
    const N = net.nodes, E = net.edges, inc = net.inc || (net.inc = incidence(net)), zones = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    N.forEach((n) => { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); });
    const margin = Math.max(60, 0.04 * Math.min(x1 - x0, y1 - y0));
    /* 出入口: 行き止まりの端点のうち、幹線（一般道以上）の端、または読み込み範囲の縁にあるもの */
    N.forEach((n, ni) => {
      const es = inc[ni].filter((e) => !e.closed);
      if (es.length !== 1 || es[0].planned || es[0].a === es[0].b) return;
      const e = es[0], edge = Math.min(n.x - x0, x1 - n.x, n.y - y0, y1 - n.y) <= margin;
      if (KIND_RANK[e.kind] < 1 && !edge) return;
      if (KIND_RANK[e.kind] < 0.5) return;
      const atA = e.a === ni, vin = atA ? e.base[0] : e.base[1], vout = atA ? e.base[1] : e.base[0]; // 域内へ入る向き／出る向き
      zones.push({ node: ni, ext: true, O: vin || 0, D: vout || 0, st: [atA ? e.bst[0] : e.bst[1], atA ? e.bst[1] : e.bst[0]], edge: e, name: e.name || KIND_JA[e.kind] });
    });
    zones.sort((a, b) => b.O + b.D - (a.O + a.D));
    const maxZ = opt.maxZones || DEFAULTS.maxZones, nExt = Math.min(zones.length, Math.max(4, Math.round(maxZ * 0.7)));
    zones.length = nExt;
    /* 域内ゾーン: 格子ごとに生活道路の延長×沿道状況の原単位で発生・集中量を置く */
    const scaleI = opt.internal == null ? 1 : opt.internal;
    if (scaleI > 0) {
      const size = Math.max(200, Math.min(600, Math.sqrt((x1 - x0) * (y1 - y0)) / 7)), cells = new Map(), used = new Set(zones.map((z) => z.node));
      E.forEach((e) => {
        if (e.planned || e.closed || KIND_RANK[e.kind] > 2 || e.kind === 'sv') return;
        const k = Math.floor(e.mid[0] / size) + ',' + Math.floor(e.mid[1] / size), c = cells.get(k) || { te: 0, cx: (Math.floor(e.mid[0] / size) + 0.5) * size, cy: (Math.floor(e.mid[1] / size) + 0.5) * size, nodes: new Set() };
        cells.set(k, c);
        const f = e.fac || factors(e.group, e.area);
        c.te += e.len * GEN_RATE[e.area - 1] * (periodScale(period, f) / f.dn); c.nodes.add(e.a); c.nodes.add(e.b);
      });
      const list = [...cells.values()].filter((c) => c.te * scaleI >= 2).sort((a, b) => b.te - a.te).slice(0, Math.max(0, maxZ - zones.length));
      for (const c of list) {
        let best = -1, bd = Infinity;
        for (const n of c.nodes) { if (used.has(n) || N[n].deg < 2) continue; const d = hyp(N[n].x - c.cx, N[n].y - c.cy); if (d < bd) { bd = d; best = n; } }
        if (best < 0) continue;
        used.add(best); zones.push({ node: best, ext: false, O: (c.te * scaleI) / 2, D: (c.te * scaleI) / 2, name: '域内' });
      }
    }
    return zones;
  }

  /* 発生 O・集中 D と抵抗 f から OD 表（二重制約。Furness 法＝フレーター法の収束計算） */
  function furness(O, D, F, Z) {
    const T = new Float64Array(Z * Z), a = new Float64Array(Z).fill(1), b = new Float64Array(Z).fill(1);
    for (let it = 0; it < 60; it++) {
      for (let i = 0; i < Z; i++) { let s = 0; for (let j = 0; j < Z; j++) s += b[j] * D[j] * F[i * Z + j]; a[i] = s > 0 ? 1 / s : 0; }
      let err = 0;
      for (let j = 0; j < Z; j++) { let s = 0; for (let i = 0; i < Z; i++) s += a[i] * O[i] * F[i * Z + j]; const nb = s > 0 ? 1 / s : 0; err = Math.max(err, Math.abs(nb - b[j]) / (nb || 1)); b[j] = nb; }
      if (err < 1e-4) break;
    }
    for (let i = 0; i < Z; i++) for (let j = 0; j < Z; j++) T[i * Z + j] = a[i] * O[i] * b[j] * D[j] * F[i * Z + j];
    return T;
  }

  /* ───────── 予測の実行 ───────── */
  function run(net, options = {}) {
    const P = Object.assign({}, DEFAULTS, options), period = P.period, E = net.edges, warn = [];
    baseVolumes(net, period);
    const g = graphOf(net, period), zones = buildZones(net, period, P), Z = zones.length, zn = zones.map((z) => z.node);
    const res = { period, od: P.od, assign: P.assign, params: P, zones, warn, nEdges: E.length, nNodes: net.nodes.length };
    const hasPlan = E.some((e) => e.planned);
    if (Z < 2) { warn.push('域外との出入口（行き止まりの幹線）が 2 か所以上必要です。既存道路をもう少し広い範囲で読み込んでください'); return Object.assign(res, { failed: true }); }
    /* 発生・集中の総量を合わせる */
    const O = zones.map((z) => z.O), D = zones.map((z) => z.D), so = O.reduce((a, b) => a + b, 0), sd = D.reduce((a, b) => a + b, 0);
    if (!(so > 0) || !(sd > 0)) { warn.push('出入口の交通量が 0 です'); return Object.assign(res, { failed: true }); }
    const tot = (so + sd) / 2; for (let i = 0; i < Z; i++) { O[i] *= tot / so; D[i] *= tot / sd; }
    /* 抵抗: 計画道路なしの自由走行時間 */
    setCase(g, false);
    const F = new Float64Array(Z * Z), C0 = new Float64Array(Z * Z), gamma = P.od === 'prop' ? 0 : P.gamma;
    for (let i = 0; i < Z; i++) {
      sssp(g, zn[i], g.t0);
      for (let j = 0; j < Z; j++) {
        if (i === j) continue;
        const c = g.dist[zn[j]]; C0[i * Z + j] = c; if (!isFinite(c)) continue;
        const ni = net.nodes[zn[i]], nj = net.nodes[zn[j]], near = zones[i].ext && zones[j].ext && hyp(ni.x - nj.x, ni.y - nj.y) < 250; // 隣り合う出入口どうし（折り返し）は起こりにくい
        F[i * Z + j] = Math.pow(Math.max(0.5, c), -gamma) * (near ? 0.05 : 1);
      }
    }
    let od = furness(O, D, F, Z);
    /* 観測のある arc（補正と再現性の確認に使う） */
    const obsArc = [];
    E.forEach((e, i) => { if (e.planned || !e.ob || e.ob.how !== 'direct') return; for (let d = 0; d < 2; d++) if (e.bst[d] && e.bst[d] !== 'attr' && e.base[d] != null && g.ok[2 * i + d]) obsArc.push({ a: 2 * i + d, v: e.base[d], real: e.bst[d] === 'real' }); });
    if (P.od === 'entropy' && obsArc.length) {
      const idx = new Int32Array(g.nA).fill(-1); obsArc.forEach((o, k) => { idx[o.a] = k; });
      const method = P.assign === 'div' ? 'inc' : P.assign;
      for (let outer = 0; outer < 3; outer++) {
        const t = method === 'aon' ? g.t0 : assign(g, od, zn, method, P, true).t, pairs = obsArc.map(() => []);
        for (let i = 0; i < Z; i++) {
          sssp(g, zn[i], t);
          for (let j = 0; j < Z; j++) { if (i === j || !(od[i * Z + j] > 0)) continue; let n = zn[j], a; while ((a = g.pred[n]) >= 0) { if (idx[a] >= 0) pairs[idx[a]].push(i * Z + j); n = g.tail[a]; } }
        }
        for (let sweep = 0; sweep < 12; sweep++) for (let k = 0; k < obsArc.length; k++) {
          const pr = pairs[k]; if (!pr.length) continue;
          let m = 0; for (const q of pr) m += od[q];
          if (!(m > 0)) continue;
          const f = Math.max(0.2, Math.min(5, Math.pow(obsArc[k].v / m, obsArc[k].real ? 0.7 : 0.35)));
          for (const q of pr) od[q] *= f;
        }
      }
    }
    if (P.growth > 0 && P.growth !== 1) od = od.map((v) => v * P.growth);
    /* 計画道路なし／あり */
    let before, after;
    if (P.assign === 'div') {
      const pre = assign(g, od, zn, 'inc', P), tA = pre.t, x0 = aon(g, od, zn, tA, new Float64Array(g.nA)), x1 = new Float64Array(g.nA);
      const predA = new Int32Array(g.nN), distA = new Float64Array(g.nN); let diverted = 0;
      for (let i = 0; i < Z; i++) {
        setCase(g, false); sssp(g, zn[i], tA); predA.set(g.pred); distA.set(g.dist);
        setCase(g, true); sssp(g, zn[i], tA);
        for (let j = 0; j < Z; j++) {
          const d = od[i * Z + j]; if (!(d > 0) || !isFinite(distA[zn[j]])) continue;
          const ta = distA[zn[j]], tb = g.dist[zn[j]], p = hasPlan && tb < ta - 1e-9 ? 1 / (1 + Math.pow(tb / ta, P.kappa)) : 0;
          let n = zn[j], a; while ((a = predA[n]) >= 0) { x1[a] += d * (1 - p); n = g.tail[a]; }
          if (p > 0) { n = zn[j]; while ((a = g.pred[n]) >= 0) { x1[a] += d * p; n = g.tail[a]; } diverted += d * p; }
        }
      }
      before = { x: x0, t: bpr(g, x0, P), iters: 1, gap: null }; after = { x: x1, t: bpr(g, x1, P), iters: 1, gap: null }; res.diverted = diverted;
    } else {
      setCase(g, false); before = assign(g, od, zn, P.assign, P);
      if (hasPlan) { setCase(g, true); after = assign(g, od, zn, P.assign, P); } else after = before;
    }
    /* 現況再現性（実測のある方向別リンク: 観測値 と 計画道路なしの配分値） */
    const real = obsArc.filter((o) => o.real), pts = (real.length >= 3 ? real : obsArc).map((o) => ({ obs: o.v, mod: before.x[o.a] / (P.growth || 1), a: o.a }));
    if (pts.length) {
      const n = pts.length, mo = pts.reduce((s, p) => s + p.obs, 0) / n, mm = pts.reduce((s, p) => s + p.mod, 0) / n;
      let sxy = 0, sxx = 0, syy = 0, se = 0; pts.forEach((p) => { sxy += (p.obs - mo) * (p.mod - mm); sxx += (p.obs - mo) ** 2; syy += (p.mod - mm) ** 2; se += (p.obs - p.mod) ** 2; });
      res.fit = { n, r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null, rmse: mo > 0 ? Math.sqrt(se / n) / mo : null, pts, realOnly: real.length >= 3 };
    }
    /* 集計 */
    const tally = (c) => {
      let vkt = 0, vht = 0, lost = 0, cong = 0, cong2 = 0, len = 0;
      E.forEach((e, i) => {
        let mx = 0;
        for (let d = 0; d < 2; d++) { const a = 2 * i + d, x = c.x[a]; if (!g.ok[a]) continue; vkt += (x * e.len) / 1000; vht += (x * c.t[a]) / 60; lost += (x * (c.t[a] - g.t0[a])) / 60; mx = Math.max(mx, x / g.cap[a]); }
        if (c === before && e.planned) return;
        len += e.len; if (mx >= 1) cong += e.len; if (mx >= 1.25) cong2 += e.len;
      });
      return { vkt, vht, lost, speed: vht > 0 ? vkt / vht : 0, cong, cong2, len };
    };
    res.before = before; res.after = after; res.g = g; res.trips = od.reduce((a, b) => a + b, 0);
    res.sum = { before: tally(before), after: tally(after) };
    res.hasPlan = hasPlan;
    res.plan = {}; // 計画道路ごとの交通量（両方向の合計: 区間最大・延長加重平均）
    E.forEach((e, i) => { if (!e.planned) return; const v = after.x[2 * i] + after.x[2 * i + 1], p = res.plan[e.rid] || (res.plan[e.rid] = { max: 0, sum: 0, len: 0, vc: 0 }); p.max = Math.max(p.max, v); p.sum += v * e.len; p.len += e.len; p.vc = Math.max(p.vc, after.x[2 * i] / g.cap[2 * i], after.x[2 * i + 1] / g.cap[2 * i + 1]); });
    if (hasPlan && !Object.values(res.plan).some((p) => p.max > 0)) warn.push('計画道路に交通が乗りませんでした。端点が既存道路に接続されているか、既存の経路より所要時間が短くなるかを確認してください');
    if (P.od === 'entropy' && !obsArc.length) warn.push('観測データが無いため、OD 表は属性からの推定値だけで作っています');
    return res;
  }

  /* 混雑度の区分（道路交通センサスの解釈） */
  const CONGESTION = [
    { max: 0.75, color: '#2e9f6b', name: '0.75 未満（円滑）' },
    { max: 1.0, color: '#b9a400', name: '0.75〜1.0（ほぼ円滑）' },
    { max: 1.25, color: '#f08a24', name: '1.0〜1.25（ピーク時に混雑）' },
    { max: 1.75, color: '#e0352b', name: '1.25〜1.75（ピーク時間帯を中心に混雑）' },
    { max: Infinity, color: '#8b1a6b', name: '1.75 以上（慢性的に混雑）' },
  ];
  const congestionOf = (vc) => CONGESTION.find((c) => vc < c.max) || CONGESTION[CONGESTION.length - 1];

  const T = { PERIODS, AREAS, SOURCES, OD_METHODS, ASSIGN_METHODS, DEFAULTS, KIND_JA, KIND_RANK, CONGESTION, congestionOf, model, kindOf, planKind, groupOf, factors, valueOf, hasData, fromHourly, periodScale, buildNetwork, pointAt, nearestOnEdge, prepare, baseVolumes, graphOf, setCase, sssp, aon, dial, bpr, assign, buildZones, furness, run, rankOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = T;
  else root.Traffic = T;
})(typeof self !== 'undefined' ? self : this);
