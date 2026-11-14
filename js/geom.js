/* 道路平面線形の幾何計算（IP法：直線 − クロソイド − 円曲線 − クロソイド − 直線）
 * 座標系: x=東, y=北 [m]。方向角 th は東から反時計回り [rad]。曲率は左カーブを正とする。 */
(function (root) {
  'use strict';

  const GX = [0, 0.5384693101056831, -0.5384693101056831, 0.906179845938664, -0.906179845938664];
  const GW = [0.5688888888888889, 0.47862867049936647, 0.47862867049936647, 0.23692688505618908, 0.23692688505618908];

  function wrap(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /* 曲率が距離に対して線形に変化する要素 e={x0,y0,th0,k0,k1,L} 上の、始点から s の位置の姿勢 */
  function evalSeg(e, s) {
    const dk = e.L > 0 ? (e.k1 - e.k0) / e.L : 0;
    const th = (u) => e.th0 + e.k0 * u + 0.5 * dk * u * u;
    if (Math.abs(e.k0) < 1e-13 && Math.abs(dk) < 1e-16) {
      return { x: e.x0 + Math.cos(e.th0) * s, y: e.y0 + Math.sin(e.th0) * s, th: e.th0, k: 0 };
    }
    const turn = Math.abs(e.k0 * s) + Math.abs(0.5 * dk * s * s);
    const n = Math.max(1, Math.ceil(turn / 0.25));
    const h = s / n;
    let x = e.x0, y = e.y0;
    for (let i = 0; i < n; i++) {
      const m = (i + 0.5) * h;
      for (let j = 0; j < 5; j++) {
        const t = th(m + GX[j] * h / 2), w = GW[j] * h / 2;
        x += w * Math.cos(t);
        y += w * Math.sin(t);
      }
    }
    return { x, y, th: th(s), k: e.k0 + dk * s };
  }

  /* クロソイド（曲率0→1/R、長さL）の移程量 p と k */
  function spiral(R, L) {
    if (!(L > 0)) return { tau: 0, p: 0, k: 0, X: 0, Y: 0 };
    const end = evalSeg({ x0: 0, y0: 0, th0: 0, k0: 0, k1: 1 / R, L }, L);
    const tau = L / (2 * R);
    return { tau, X: end.x, Y: end.y, p: end.y - R * (1 - Math.cos(tau)), k: end.x - R * Math.sin(tau) };
  }

  /* IP 1点分の曲線諸元。delta: 符号付き交角 [rad] */
  function curveAt(delta, R, A1, A2) {
    const ad = Math.abs(delta);
    if (!(R > 0) || ad < 1e-5) return { none: true, delta, T1: 0, T2: 0, R: 0, L1: 0, L2: 0, Lc: 0, CL: 0 };
    let L1 = A1 > 0 ? (A1 * A1) / R : 0, L2 = A2 > 0 ? (A2 * A2) / R : 0;
    let clamped = false;
    const tsum = (L1 + L2) / (2 * R);
    if (tsum > ad) { // 緩和曲線だけで交角を超える → 描画用に縮める（エラーとして報告）
      const f = ad / tsum;
      L1 *= f; L2 *= f; clamped = true;
    }
    const s1 = spiral(R, L1), s2 = spiral(R, L2);
    const sin = Math.sin(ad), cos = Math.cos(ad);
    const T1 = s1.k + ((R + s2.p) - (R + s1.p) * cos) / sin;
    const T2 = s2.k + ((R + s1.p) - (R + s2.p) * cos) / sin;
    const Lc = Math.max(0, R * (ad - s1.tau - s2.tau));
    return {
      delta, sgn: delta > 0 ? 1 : -1, R, A1: Math.sqrt(R * L1), A2: Math.sqrt(R * L2), L1, L2,
      tau1: s1.tau, tau2: s2.tau, p1: s1.p, p2: s2.p, k1: s1.k, k2: s2.k, T1, T2, Lc, CL: L1 + Lc + L2, clamped,
    };
  }

  /* ips: [{x,y,R,A1,A2}] → 線形 */
  function computeAlignment(ips) {
    const n = ips.length;
    const res = { elements: [], curves: new Array(n).fill(null), issues: [], points: [], length: 0, dirs: [], dists: [] };
    if (n < 2) return res;
    for (let i = 0; i < n - 1; i++) {
      const dx = ips[i + 1].x - ips[i].x, dy = ips[i + 1].y - ips[i].y;
      res.dirs.push(Math.atan2(dy, dx));
      res.dists.push(Math.hypot(dx, dy));
    }
    for (let i = 1; i < n - 1; i++) {
      const delta = wrap(res.dirs[i] - res.dirs[i - 1]);
      const c = curveAt(delta, ips[i].R, ips[i].A1, ips[i].A2);
      c.ip = i;
      res.curves[i] = c;
      if (c.none && Math.abs(delta) > 0.5 * Math.PI / 180) res.issues.push({ type: 'kink', ip: i, deg: Math.abs(delta) * 180 / Math.PI });
      if (c.clamped) res.issues.push({ type: 'clamp', ip: i });
    }
    const els = res.elements;
    let cur = { x: ips[0].x, y: ips[0].y }, s = 0;
    const push = (e) => { e.s0 = s; s += e.L; els.push(e); return evalSeg(e, e.L); };
    const pt = (name, pose, ip) => res.points.push({ name, s, x: pose.x, y: pose.y, th: pose.th, ip });
    pt('BP', { x: cur.x, y: cur.y, th: res.dirs[0] }, 0);
    for (let i = 1; i < n; i++) {
      const d = res.dirs[i - 1], c = i < n - 1 ? res.curves[i] : null;
      const tgt = c ? { x: ips[i].x - Math.cos(d) * c.T1, y: ips[i].y - Math.sin(d) * c.T1 } : { x: ips[i].x, y: ips[i].y };
      const avail = (tgt.x - cur.x) * Math.cos(d) + (tgt.y - cur.y) * Math.sin(d);
      if (avail < -1e-6) res.issues.push({ type: 'overlap', ip: i, amount: -avail });
      if (Math.abs(avail) > 1e-6) {
        push({ type: 'line', x0: cur.x, y0: cur.y, th0: avail >= 0 ? d : d + Math.PI, k0: 0, k1: 0, L: Math.abs(avail), bad: avail < 0, ip: i });
      }
      let pose = { x: tgt.x, y: tgt.y, th: d };
      if (c && !c.none) {
        const k = c.sgn / c.R;
        c.sTS = s;
        if (c.L1 > 1e-9) {
          pt(`KA${i}-1`, pose, i);
          pose = push({ type: 'clothoid', x0: pose.x, y0: pose.y, th0: pose.th, k0: 0, k1: k, L: c.L1, A: c.A1, R: c.R, ip: i, part: 'in' });
          pt(c.Lc > 1e-9 ? `KE${i}-1` : `KE${i}`, pose, i);
        } else pt(`BC${i}`, pose, i);
        if (c.Lc > 1e-9) {
          pose = push({ type: 'arc', x0: pose.x, y0: pose.y, th0: pose.th, k0: k, k1: k, L: c.Lc, R: c.R, ip: i });
          if (c.L2 > 1e-9) pt(`KE${i}-2`, pose, i);
        }
        if (c.L2 > 1e-9) {
          pose = push({ type: 'clothoid', x0: pose.x, y0: pose.y, th0: pose.th, k0: k, k1: 0, L: c.L2, A: c.A2, R: c.R, ip: i, part: 'out' });
          pt(`KA${i}-2`, pose, i);
        } else pt(`EC${i}`, pose, i);
        c.sST = s;
      }
      cur = { x: pose.x, y: pose.y };
    }
    pt('EP', { x: cur.x, y: cur.y, th: res.dirs[n - 2] }, n - 1);
    res.length = s;
    return res;
  }

  function sampleElement(e, maxStep) {
    const out = [];
    let step = e.L;
    if (e.type !== 'line') step = Math.min(maxStep || 5, Math.max(0.2, Math.sqrt(8 * e.R * 0.005)));
    const n = Math.max(1, Math.ceil(e.L / step));
    for (let i = 0; i <= n; i++) {
      const p = evalSeg(e, (e.L * i) / n);
      p.s = e.s0 + (e.L * i) / n;
      out.push(p);
    }
    return out;
  }

  function sample(al, maxStep) {
    const all = [], byEl = [];
    al.elements.forEach((e, i) => {
      const pts = sampleElement(e, maxStep);
      byEl.push(pts);
      for (let j = i === 0 ? 0 : 1; j < pts.length; j++) all.push(pts[j]);
    });
    return { all, byEl };
  }

  function poseAt(al, s) {
    const els = al.elements;
    if (!els.length) return null;
    s = Math.min(Math.max(s, 0), al.length);
    let e = els[els.length - 1];
    for (const c of els) if (s <= c.s0 + c.L) { e = c; break; }
    const p = evalSeg(e, Math.min(e.L, Math.max(0, s - e.s0)));
    p.s = s;
    return p;
  }

  /* 点 (x,y) に最も近い線形上の位置 */
  function project(al, pts, x, y) {
    if (!pts.length) return null;
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i].x - x) ** 2 + (pts[i].y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    let s = pts[best].s, p = pts[best];
    for (let it = 0; it < 4; it++) {
      const ds = (x - p.x) * Math.cos(p.th) + (y - p.y) * Math.sin(p.th);
      s = Math.min(al.length, Math.max(0, s + ds));
      p = poseAt(al, s);
      if (Math.abs(ds) < 1e-4) break;
    }
    const off = -(x - p.x) * Math.sin(p.th) + (y - p.y) * Math.cos(p.th);
    return { s, offset: off, dist: Math.hypot(x - p.x, y - p.y), pose: p };
  }

  /* ───── 折れ線（既存道路）の区間分割 ─────
   * 位置は u = 線分番号 + 線分内の比率（0 … n-1）で表す。 */
  function polyLen(xy) { let l = 0; for (let k = 1; k < xy.length; k++) l += Math.hypot(xy[k].x - xy[k - 1].x, xy[k].y - xy[k - 1].y); return l; }
  /* 区切り位置: 端点・屈曲点（偏角 bendDeg 以上）・他の折れ線との交差/接続点 */
  function polyBreaks(xy, others, opt) {
    const o = Object.assign({ bendDeg: 30, tol: 1.5, merge: 2 }, opt), n = xy.length, us = [0, n - 1];
    for (let k = 1; k < n - 1; k++) {
      const a = Math.atan2(xy[k].y - xy[k - 1].y, xy[k].x - xy[k - 1].x), b = Math.atan2(xy[k + 1].y - xy[k].y, xy[k + 1].x - xy[k].x);
      if (Math.abs(wrap(b - a)) * 180 / Math.PI >= o.bendDeg) us.push(k);
    }
    // 点 p に最も近い自線上の位置（距離 tol 以内）
    const onSelf = (p) => {
      let best = null;
      for (let i = 0; i < n - 1; i++) {
        const a = xy[i], b = xy[i + 1], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
        const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
        const d = Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
        if (d <= o.tol && (!best || d < best.d)) best = { d, u: i + t };
      }
      return best && best.u;
    };
    for (const q of others) {
      if (q.length < 2) continue;
      // 他線の端点・頂点が自線上にある（T 字・共有ノード）
      for (const p of q) { const u = onSelf(p); if (u != null) us.push(u); }
      // 線分どうしの交差
      for (let j = 0; j < q.length - 1; j++) {
        const c = q[j], d = q[j + 1];
        for (let i = 0; i < n - 1; i++) {
          const a = xy[i], b = xy[i + 1], rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-12) continue;
          const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den, w = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
          if (t >= 0 && t <= 1 && w >= 0 && w <= 1) us.push(i + t);
        }
      }
    }
    // 位置順に並べ、近接（merge m 以内）する区切りをまとめる。端点は必ず残す
    const L = polyLen(xy), at = (u) => polyLenTo(xy, u);
    const sorted = us.filter((u) => u >= 0 && u <= n - 1).sort((a, b) => a - b), out = [];
    for (const u of sorted) {
      const s = at(u);
      if (out.length && s - at(out[out.length - 1]) < o.merge) { if (u === n - 1) out[out.length - 1] = u; continue; }
      if (u !== n - 1 && L - s < o.merge && u !== 0) continue;
      out.push(u);
    }
    if (out[0] !== 0) out.unshift(0);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }
  function polyLenTo(xy, u) {
    let l = 0; const i = Math.min(Math.floor(u), xy.length - 2);
    for (let k = 1; k <= i; k++) l += Math.hypot(xy[k].x - xy[k - 1].x, xy[k].y - xy[k - 1].y);
    const t = u - i; if (t > 0) l += t * Math.hypot(xy[i + 1].x - xy[i].x, xy[i + 1].y - xy[i].y);
    return l;
  }
  /* 点 q に最も近い位置 u */
  function polyNearest(xy, q) {
    let best = { d: Infinity, u: 0 };
    for (let i = 0; i < xy.length - 1; i++) {
      const a = xy[i], b = xy[i + 1], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
      const t = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / l2)) : 0;
      const d = Math.hypot(q.x - a.x - vx * t, q.y - a.y - vy * t);
      if (d < best.d) best = { d, u: i + t };
    }
    return best.u;
  }
  /* 区切り breaks のうち u を含む区間 [u0, u1] */
  function pieceAt(breaks, u) {
    for (let k = 1; k < breaks.length; k++) if (u <= breaks[k] || k === breaks.length - 1) return [breaks[k - 1], breaks[k]];
    return [breaks[0], breaks[breaks.length - 1]];
  }
  /* 点列（[a, b] の配列）の u0 … u1 部分を線形補間で切り出す */
  function polySlice(pts, u0, u1) {
    const n = pts.length, ip = (u) => {
      const i = Math.min(Math.floor(u), n - 2), t = u - i, a = pts[i], b = pts[i + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    if (u1 <= u0) return [];
    const out = [ip(u0)];
    for (let k = Math.floor(u0) + 1; k < u1; k++) out.push(pts[k].slice());
    out.push(ip(u1));
    return out;
  }

  /* ───────── 縦断線形（VIP 法：勾配直線 + 2次放物線の縦断曲線） ─────────
   * vips: [{ s: 追加距離 m, z: 計画高 m, VCL: 縦断曲線長 m }]（先頭=BP・末尾=EP、s は length に合わせる）
   * 勾配 g は小数（0.05 = 5%）。縦断曲線は VIP を中心とする対称放物線。 */
  function computeProfile(vips, length) {
    if (!vips || vips.length < 2 || !(length > 0)) return null;
    const n = vips.length, pts = vips.map((v) => ({ s: +v.s || 0, z: +v.z || 0, VCL: Math.max(0, +v.VCL || 0) }));
    pts[0].s = 0; pts[n - 1].s = length; pts[0].VCL = 0; pts[n - 1].VCL = 0;
    for (let i = 1; i < n - 1; i++) pts[i].s = Math.min(length, Math.max(0, pts[i].s));
    const issues = [], grades = [];
    for (let i = 0; i < n - 1; i++) {
      const ds = pts[i + 1].s - pts[i].s;
      if (ds <= 1e-6) { issues.push({ type: 'order', i: i + 1 }); grades.push(0); } else grades.push((pts[i + 1].z - pts[i].z) / ds);
    }
    const curves = [];
    for (let i = 1; i < n - 1; i++) {
      const p = pts[i], g1 = grades[i - 1], g2 = grades[i], L = p.VCL, dg = g2 - g1;
      curves.push({ i, s: p.s, z: p.z, g1, g2, dg, L, bvc: p.s - L / 2, evc: p.s + L / 2, R: L > 0 && Math.abs(dg) > 1e-9 ? L / Math.abs(dg) : Infinity, crest: dg < 0 });
    }
    for (let i = 0; i < n - 1; i++) {
      const ds = pts[i + 1].s - pts[i].s, need = pts[i].VCL / 2 + pts[i + 1].VCL / 2;
      if (ds > 1e-6 && need > ds + 1e-6) issues.push({ type: 'overlap', i, amount: need - ds });
    }
    return { pts, grades, curves, issues, length };
  }
  /* 追加距離 s の計画高 z と勾配 g */
  function profileAt(pf, s) {
    const pts = pf.pts, n = pts.length;
    s = Math.min(Math.max(s, 0), pf.length);
    for (const c of pf.curves) {
      if (c.L > 0 && s >= c.bvc && s <= c.evc) {
        const u = s - c.bvc;
        return { z: c.z + c.g1 * (s - c.s) + (c.dg / (2 * c.L)) * u * u, g: c.g1 + (c.dg * u) / c.L, vc: c.i };
      }
    }
    let k = n - 2;
    for (let i = 0; i < n - 1; i++) if (s <= pts[i + 1].s) { k = i; break; }
    return { z: pts[k].z + pf.grades[k] * (s - pts[k].s), g: pf.grades[k], vc: null };
  }
  /* 区間 [s0, s1] の最大勾配（絶対値） */
  function maxGradeIn(pf, s0, s1) {
    // 縦断曲線内の勾配は両側の勾配の間で単調に変わるので、勾配直線部と区間両端だけを見ればよい
    let m = Math.max(Math.abs(profileAt(pf, s0).g), Math.abs(profileAt(pf, s1).g));
    const pts = pf.pts;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k].s + pts[k].VCL / 2, b = pts[k + 1].s - pts[k + 1].VCL / 2;
      if (b >= a && b >= s0 && a <= s1) m = Math.max(m, Math.abs(pf.grades[k]));
    }
    return m;
  }
  /* 点列 [{s, h}] の線形補間 */
  function interpProfile(pts, s) {
    if (!pts || !pts.length) return null;
    if (s <= pts[0].s) return pts[0].h;
    for (let i = 1; i < pts.length; i++) if (s <= pts[i].s) { const a = pts[i - 1], b = pts[i], t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0; return a.h + (b.h - a.h) * t; }
    return pts[pts.length - 1].h;
  }

  const G = { wrap, evalSeg, spiral, curveAt, computeAlignment, sampleElement, sample, poseAt, project, polyLen, polyLenTo, polyBreaks, polyNearest, pieceAt, polySlice, computeProfile, profileAt, maxGradeIn, interpProfile };
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
  else root.Geom = G;
})(typeof self !== 'undefined' ? self : this);
