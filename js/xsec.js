/* Road Plan — 断面図（地図上に引いた線に沿った地盤と計画道路の断面）
 * 計算部分（XSecCore）は 3D ビューと同じ考え方: 計画高（縦断計画がなければ現況地盤の 60m 移動平均）・片勾配・
 * 路肩（歩道）端から 盛土 1:1.5 ／ 切土 1:1.0 ののり面、盛土高 8m 超は橋梁。 */
(function (root) {
  'use strict';
  const Geom = root.Geom || (typeof require !== 'undefined' ? require('./geom.js') : null);
  const Rules = root.Rules || (typeof require !== 'undefined' ? require('./rules.js') : null);
  const SLOPE_MAX = 30, SLOPE_FADE = 15, FILL = Rules.FILL_SLOPE, CUT = Rules.CUT_SLOPE, BRIDGE_H = 8, DECK = 1.6;

  /* 計画道路の中心線上の点（測点）。要素の境目も入れる */
  function stationsOf(al) {
    const L = al.length, ds = Math.min(2.5, Math.max(0.5, L / 900)), ss = [];
    for (let s = 0; s < L; s += ds) ss.push(s);
    ss.push(L);
    al.elements.forEach((e) => ss.push(e.s0));
    ss.sort((a, b) => a - b);
    const S = [];
    for (const s of ss) if (!S.length || s - S[S.length - 1] > 1e-3) S.push(s);
    return S.map((s) => { const p = Geom.poseAt(al, s); return { s, x: p.x, y: p.y, c: Math.cos(p.th), sn: Math.sin(p.th), k: p.k || 0 }; });
  }

  /* 道路の横断モデル。rows は stationsOf の結果に現況地盤高 g（null 可）を入れたもの */
  function buildModel(road, al, rows) {
    const pf = Geom.computeProfile(road.vips, al.length);
    const valid = rows.map((r) => r.g).filter((h) => h != null), mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
    rows.forEach((r) => { if (r.g == null) r.g = mean; });
    if (pf) rows.forEach((r) => { r.z = Geom.profileAt(pf, r.s).z; });
    else {
      let j0 = 0, j1 = 0, sum = 0;
      rows.forEach((r) => {
        while (j1 < rows.length && rows[j1].s <= r.s + 30) sum += rows[j1++].g;
        while (rows[j0].s < r.s - 30) sum -= rows[j0++].g;
        r.z = sum / (j1 - j0);
      });
    }
    const high = rows.filter((r) => r.z - r.g > BRIDGE_H).map((r) => r.s);
    let h = 0;
    rows.forEach((r) => { while (h < high.length - 1 && high[h] < r.s - 10) h++; r.bridge = high.length > 0 && Math.abs(high[h] - r.s) <= 10; });
    rows.forEach((r) => {
      let c = null;
      for (const cv of al.curves) if (cv && !cv.none && cv.sTS != null && r.s >= cv.sTS - 1e-6 && r.s <= cv.sST + 1e-6) { c = cv; break; }
      let inner = -0.02, outer = -0.02;
      if (c && Math.abs(r.k) > 1e-9) {
        const se = Rules.superelevation(road, c.ip, c.R), e = se.e, t = Math.min(1, Math.abs(r.k) * c.R);
        if (!se.crown) { inner = -(0.02 + (e - 0.02) * t); outer = -0.02 + (e + 0.02) * t; }
      }
      r.slope = r.k > 0 ? [inner, outer] : [outer, inner]; // [左, 右]: 外向きの勾配
    });
    const cw = road.lanes * road.laneW, W = cw / 2 + road.shoulderW, sw = road.sidewalkW || 0;
    return { road, al, pf, rows, L: al.length, W, sw, E: W + sw };
  }
  /* 横断位置 d（左が正）の路面高 */
  function surfZ(M, r, d) {
    const a = Math.abs(d), sl = r.slope[d >= 0 ? 0 : 1];
    if (a <= M.W) return r.z + sl * a;
    return r.z + sl * M.W + (M.sw > 0 ? 0.15 : 0);
  }
  /* 点 (x,y) に最も近い測点 */
  function nearestRow(M, x, y, reach) {
    let best = -1, bd = reach * reach;
    const rows = M.rows;
    for (let q = 0; q < rows.length; q++) { const dx = x - rows[q].x, dy = y - rows[q].y, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = q; } }
    return best;
  }

  /* 折れ線 line（[{x,y}]）を刻んだ点列。step [m] */
  function densify(line, step) {
    const out = [];
    let d = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1], l = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(l / step));
      for (let k = i ? 1 : 0; k <= n; k++) out.push({ d: d + (l * k) / n, x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, seg: i });
      d += l;
    }
    return out;
  }

  /* 断面の各点に計画の高さを入れる。pts は densify の点に現況地盤高 g を入れたもの。
   * kind: 'road'（車道・路肩）/ 'walk'（歩道）/ 'fill' / 'cut' / null（地盤のまま）。橋梁は deck に桁上面の高さ */
  function section(pts, models) {
    pts.forEach((p) => { p.z = p.g; p.kind = null; p.deck = null; p.ref = null; });
    for (let mi = 0; mi < models.length; mi++) {
      const M = models[mi], reach = M.E + SLOPE_MAX + SLOPE_FADE, rows = M.rows;
      for (const p of pts) {
        const best = nearestRow(M, p.x, p.y, reach);
        if (best < 0) continue;
        const r = rows[best], vx = p.x - r.x, vy = p.y - r.y, along = vx * r.c + vy * r.sn, d = -vx * r.sn + vy * r.c;
        const over = (best === 0 && along < 0) || (best === rows.length - 1 && along > 0) ? Math.abs(along) : 0;
        const dd = Math.max(-M.E, Math.min(M.E, d)), top = surfZ(M, r, dd);
        const lat = Math.max(0, Math.abs(d) - M.E), u = over > 0 ? Math.hypot(lat, over) : lat;
        if (r.bridge) { if (u <= 1e-6) { p.deck = top; p.ref = { m: mi, s: r.s, d }; } continue; }
        if (u <= 1e-6) { p.z = top; p.kind = Math.abs(d) > M.W ? 'walk' : 'road'; p.ref = { m: mi, s: r.s, d }; continue; }
        const w = u <= SLOPE_MAX ? 1 : Math.max(0, 1 - (u - SLOPE_MAX) / SLOPE_FADE);
        if (p.z < top) { const f = p.z + (top - u / FILL - p.z) * w; if (f > p.z + 1e-6) { p.z = f; p.kind = 'fill'; p.ref = { m: mi, s: r.s, d }; } }
        else { const c = p.z + (top + u / CUT - p.z) * w; if (c < p.z - 1e-6) { p.z = c; p.kind = 'cut'; p.ref = { m: mi, s: r.s, d }; } }
      }
    }
    return pts;
  }

  /* 線分 ab と cd の交点（a からの比率 t, c からの比率 u） */
  function segX(a, b, c, d) {
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den, u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
  }
  /* 断面線 line と折れ線 poly の交差: [{d（断面線上の距離）, k（poly の線分番号）, ang（交差角 0〜90°）}] */
  function crossings(line, poly) {
    const out = [];
    let d0 = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1], l = Math.hypot(b.x - a.x, b.y - a.y);
      for (let k = 0; k < poly.length - 1; k++) {
        const x = segX(a, b, poly[k], poly[k + 1]);
        if (!x) continue;
        const t1 = Math.atan2(b.y - a.y, b.x - a.x), t2 = Math.atan2(poly[k + 1].y - poly[k].y, poly[k + 1].x - poly[k].x);
        const dd = d0 + x.t * l;
        if (out.some((o) => Math.abs(o.d - dd) < 0.05)) continue;
        out.push({ d: dd, k, w: x.u, x: a.x + (b.x - a.x) * x.t, y: a.y + (b.y - a.y) * x.t, ang: Rules.foldAngle(t1 - t2) });
      }
      d0 += l;
    }
    return out.sort((p, q) => p.d - q.d);
  }
  const interp = (pts, d, key) => {
    if (!pts.length) return null;
    if (d <= pts[0].d) return pts[0][key];
    for (let i = 1; i < pts.length; i++) if (pts[i].d >= d) {
      const a = pts[i - 1], b = pts[i], va = a[key], vb = b[key];
      if (va == null || vb == null) return va ?? vb;
      const t = b.d - a.d > 1e-9 ? (d - a.d) / (b.d - a.d) : 0;
      return va + (vb - va) * t;
    }
    return pts[pts.length - 1][key];
  };

  const XSecCore = { stationsOf, buildModel, surfZ, densify, section, crossings, interp, SLOPE_MAX, SLOPE_FADE, DECK };
  if (typeof module !== 'undefined' && module.exports) { module.exports = XSecCore; return; }
  root.XSecCore = XSecCore;

  /* ───────── ここから画面（ブラウザのみ） ───────── */
  const xs = root.xsState = { pts: [], draw: null, data: null, eq: false, seq: 0, key: null, timer: 0, models: new Map(), loading: false };
  const XC = { line: '#d6246e', fill: '#f5b642', cut: '#a1887f' };

  /* 地理院 標高タイルの双一次補間（なければ app.js の elevation に任せる） */
  async function demPx(kind, z, px, py) {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256), data = await demTile(kind, z, tx, ty);
    if (!data) return null;
    const i = ((py - ty * 256) * 256 + (px - tx * 256)) * 4, v = data[i] * 65536 + data[i + 1] * 256 + data[i + 2];
    if (v === 8388608 || data[i + 3] === 0) return null;
    return (v < 8388608 ? v : v - 16777216) * 0.01;
  }
  async function groundAt(ll) {
    for (const [kind, z] of [['dem5a_png', 15], ['dem_png', 14]]) {
      const n = 2 ** z * 256, r = (ll.lat * Math.PI) / 180;
      const fx = ((ll.lng + 180) / 360) * n - 0.5, fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const v = await Promise.all([demPx(kind, z, x0, y0), demPx(kind, z, x0 + 1, y0), demPx(kind, z, x0, y0 + 1), demPx(kind, z, x0 + 1, y0 + 1)]);
      if (v.every((h) => h != null)) return (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty;
    }
    return elevation(ll);
  }

  root.xsecGround = groundAt; // 計画検討（土工量）でも同じ地盤高を使う
  const roadKey = (r) => JSON.stringify([r.ips, r.vips, r.lanes, r.laneW, r.shoulderW, r.sidewalkW, r.V, r.cls]);
  async function modelOf(road) {
    const key = roadKey(road), c = xs.models.get(road.id);
    if (c && c.key === key) return c.model;
    const al = calc(road);
    if (!(al.length > 0.5)) return null;
    const rows = stationsOf(al), g = await Promise.all(rows.map((r) => groundAt(P.toLL(r.x, r.y))));
    rows.forEach((r, i) => { r.g = g[i]; });
    const model = buildModel(road, al, rows);
    xs.models.set(road.id, { key, model });
    return model;
  }

  const sig = () => JSON.stringify([xs.pts, project.roads.filter((r) => r.visible !== false).map(roadKey), project.existingVisible ? project.existing.length : 0]);
  function scheduleCompute() {
    clearTimeout(xs.timer);
    xs.timer = setTimeout(computeSection, 150);
  }
  async function computeSection() {
    if (xs.pts.length < 2) return;
    const key = sig();
    if (key === xs.key) return;
    const seq = ++xs.seq, line = xs.pts.map((p) => P.toXY(p));
    let Ls = 0;
    for (let i = 1; i < line.length; i++) Ls += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
    if (Ls < 1) return;
    const step = Math.min(3, Math.max(0.1, Ls / 700)), pts = densify(line, step);
    // 断面線の近くを通る計画道路だけ
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of line) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const near = project.roads.filter((r) => {
      if (r.visible === false) return false;
      const al = calc(r), m = Rules.totalWidth(r) / 2 + SLOPE_MAX + SLOPE_FADE + 5;
      return al.samples.some((q) => q.x > x0 - m && q.x < x1 + m && q.y > y0 - m && q.y < y1 + m);
    });
    xs.loading = true; if (!xs.data) renderDock();
    let models, g;
    try {
      [models, g] = await Promise.all([Promise.all(near.map(modelOf)), Promise.all(pts.map((p) => groundAt(P.toLL(p.x, p.y))))]);
    } finally { if (seq === xs.seq) xs.loading = false; }
    if (seq !== xs.seq) return;
    pts.forEach((p, i) => { p.g = g[i]; p.ll = P.toLL(p.x, p.y); }); // 原点未設定（計画道路なし）でも地図を動かしてずれないよう緯度経度を持つ
    const ok = pts.filter((p) => p.g != null);
    if (ok.length < 2) { xs.data = null; xs.key = key; toast('この場所の標高データを取得できませんでした（地理院 標高タイル）', 'err'); return renderDock(); }
    // 海・欠測は前後から補間
    pts.forEach((p) => { if (p.g == null) p.g = interp(ok, p.d, 'g'); });
    models = models.filter(Boolean);
    section(pts, models);
    // 交差する道路
    const cross = [];
    models.forEach((M, mi) => {
      for (const c of crossings(line, M.al.samples)) {
        const pr = Geom.project(M.al, M.al.samples, c.x, c.y);
        const r = M.rows[Math.max(0, M.rows.findIndex((q) => q.s >= pr.s))] || M.rows[M.rows.length - 1];
        cross.push({ type: 'plan', d: c.d, ang: c.ang, name: M.road.name, s: pr.s, z: M.pf ? Geom.profileAt(M.pf, pr.s).z : r.z, auto: !M.pf, g: interp(pts, c.d, 'g'), bridge: r.bridge, slope: r.slope, mi });
      }
    });
    if (project.existingVisible) for (const e of project.existing) {
      const xy = e.pts.map((q) => P.toXY(q));
      if (xy.every((q) => q.x < x0 - 1) || xy.every((q) => q.x > x1 + 1) || xy.every((q) => q.y < y0 - 1) || xy.every((q) => q.y > y1 + 1)) continue;
      for (const c of crossings(line, xy)) cross.push({ type: 'ex', d: c.d, ang: c.ang, name: e.name || e.clsJa || '既存道路', width: e.width, g: interp(pts, c.d, 'g') });
    }
    const verts = [];
    let acc = 0;
    for (let i = 1; i < line.length - 1; i++) { acc += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y); verts.push(acc); }
    xs.data = { pts, Ls, cross: cross.sort((a, b) => a.d - b.d), verts, models: models.map((M) => ({ name: M.road.name, E: M.E })) };
    xs.key = key;
    renderDock();
  }

  /* ───── 地図上の操作 ───── */
  root.xsecActive = () => xs.pts.length >= 2 || !!xs.draw;
  root.xsecStart = () => { xs.draw = { pts: [], cursor: null }; };
  root.xsecStop = () => { xs.draw = null; };
  root.xsecClear = () => { xs.pts = []; xs.draw = null; xs.data = null; xs.key = null; xs.seq++; gHover.clearLayers(); if (ui.tool === 'xsec') setTool('select'); else { renderMap(); renderDock(); } };
  root.xsecClick = (e) => {
    const k = xs.draw; if (!k) return;
    const ll = e.latlng, last = k.pts[k.pts.length - 1];
    if (last && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) < 5) return;
    if (!k.pts.length) { xs.pts = []; xs.data = null; xs.key = null; }
    k.pts.push([ll.lat, ll.lng]);
    renderMap(); renderDock();
  };
  root.xsecMove = (e) => { if (!xs.draw || !xs.draw.pts.length) return; xs.draw.cursor = [e.latlng.lat, e.latlng.lng]; gPreview.clearLayers(); drawDrawing(); };
  root.xsecBack = () => { if (!xs.draw) return; xs.draw.pts.pop(); if (!xs.draw.pts.length) xs.draw.cursor = null; renderMap(); };
  root.xsecFinish = () => {
    const k = xs.draw;
    if (!k || k.pts.length < 2) return;
    xs.pts = k.pts.slice(); xs.draw = { pts: [], cursor: null }; xs.key = null;
    renderMap(); renderDock(); computeSection();
  };
  function drawDrawing() {
    const k = xs.draw, pts = k.pts.slice();
    if (k.cursor && pts.length) pts.push(k.cursor);
    if (pts.length >= 2) {
      L.polyline(pts, { pane: 'design', color: XC.line, weight: 2.5, dashArray: '6 5', interactive: false }).addTo(gPreview);
      let d = 0; for (let i = 1; i < pts.length; i++) d += map.distance(pts[i - 1], pts[i]);
      label(L.latLng(pts[pts.length - 1]), `${fmt(d, 1)} m`, 'ms', [-10, 28]).addTo(gPreview);
    }
    k.pts.forEach((p) => L.circleMarker(p, { pane: 'design', radius: 4, color: XC.line, weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(gPreview));
  }
  /* renderMap から呼ばれる */
  root.xsecRender = () => {
    if (xs.draw) drawDrawing();
    if (xs.pts.length < 2) return;
    L.polyline(xs.pts, { pane: 'design', color: '#fff', weight: 6, opacity: 0.85, interactive: false }).addTo(gMisc);
    L.polyline(xs.pts, { pane: 'design', color: XC.line, weight: 2.5, interactive: false }).addTo(gMisc);
    label(L.latLng(xs.pts[0]), 'A', 'xs-end', [-6, 22]).addTo(gMisc);
    label(L.latLng(xs.pts[xs.pts.length - 1]), 'B', 'xs-end', [-6, 22]).addTo(gMisc);
  };
  /* renderHandles から呼ばれる: 頂点をドラッグして断面線を動かす */
  root.xsecHandles = () => {
    if (xs.pts.length < 2 || (xs.draw && xs.draw.pts.length) || !(ui.tool === 'select' || ui.tool === 'xsec')) return;
    xs.pts.forEach((p, i) => {
      const m = L.marker(p, { draggable: true, icon: L.divIcon({ className: 'xs-h', iconSize: [11, 11] }), zIndexOffset: 900, bubblingMouseEvents: false, title: '断面線の点（ドラッグで移動）' });
      m.on('dragstart', () => { ui.dragging = true; });
      m.on('drag', () => { const ll = m.getLatLng(); xs.pts[i] = [ll.lat, ll.lng]; gMisc.clearLayers(); root.xsecRender(); });
      m.on('dragend', () => { ui.dragging = false; renderMap(); scheduleCompute(); });
      m.addTo(gHandles);
    });
  };

  /* ───── 断面図（地図下部の帯） ───── */
  root.xsecDockHtml = (W, H) => {
    scheduleIfChanged();
    const d = xs.data, drawing = xs.draw && xs.pts.length < 2;
    const head = `<div class="vd-head"><b>断面図</b>${d ? `<span class="muted">A → B ・ 延長 ${fmt(d.Ls, 1)} m</span>` : ''}
      <span class="lg"><i class="l-plan"></i>計画 <i class="l-gnd"></i>現況地盤 <i class="l-fill"></i>盛土 <i class="l-cut"></i>切土</span>
      <span class="muted small vd-hint">${drawing ? '地図をクリックして断面線を引き、<kbd>ダブルクリック</kbd>/<kbd>Enter</kbd> で確定' : '地図の ◆ をドラッグで断面線を移動 ・ 図にカーソルを置くと地図に位置を表示'}${xs.loading ? ' ・ 標高を取得中…' : ''}</span>
      ${d ? `<label class="chk"><input type="checkbox" data-xs="eq"${xs.eq ? ' checked' : ''}> 縦横同縮尺</label><button class="btn" data-act="xs-csv" title="距離・地盤高・計画高の表を CSV で保存">CSV</button>` : ''}
      <button class="ibtn" data-act="xs-close" title="断面図を閉じる（断面線を消す）">✕</button></div>`;
    if (!d) return head + `<div class="xs-empty muted">${xs.loading ? '地理院 標高タイルから地盤高を取得中…' : drawing ? '断面を見たい所に地図上で線を引いてください（道路を横切る線なら横断図、道路に沿う線なら縦断の断面になります）' : ''}</div>`;
    return head + chartSvg(d, W, H);
  };
  function scheduleIfChanged() { if (xs.pts.length >= 2 && !ui.dragging && sig() !== xs.key) scheduleCompute(); }

  function chartSvg(D, W, H) {
    const pad = { l: 56, r: 18, t: 40, b: 26 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b, P2 = D.pts;
    let lo = Infinity, hi = -Infinity;
    for (const p of P2) { lo = Math.min(lo, p.g, p.z); hi = Math.max(hi, p.g, p.z, p.deck ?? -Infinity); if (p.deck != null) lo = Math.min(lo, p.deck - DECK); }
    const span = Math.max(hi - lo, 2); lo -= span * 0.12; hi += span * 0.15;
    let sx = pw / D.Ls, sy = ph / (hi - lo);
    if (xs.eq) { const s = Math.min(sx, sy); sx = sy = s; const mid = (hi + lo) / 2, half = ph / s / 2; lo = mid - half; hi = mid + half; }
    const X = (d) => pad.l + d * sx, Y = (z) => pad.t + (hi - z) * sy, f = (v) => v.toFixed(1);
    const pl = (a) => a.map((p, i) => `${i ? 'L' : 'M'}${f(p[0])},${f(p[1])}`).join('');
    let out = `<defs><clipPath id="xsclip"><rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}"/></clipPath></defs>`;
    // 格子
    const zStep = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => (hi - lo) / s * 24 <= ph) || 1000;
    for (let z = Math.ceil(lo / zStep) * zStep; z <= hi; z += zStep) out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${f(Y(z))}" y2="${f(Y(z))}" class="g"/><text x="${pad.l - 6}" y="${f(Y(z) + 3)}" class="ax" text-anchor="end">${fmt(z, zStep < 1 ? 1 : 0)}</text>`;
    const dStep = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find((s) => s * sx >= 56) || 5000;
    for (let d = 0; d <= D.Ls + 1e-6; d += dStep) out += `<line x1="${f(X(d))}" x2="${f(X(d))}" y1="${pad.t}" y2="${pad.t + ph}" class="g"/><text x="${f(X(d))}" y="${H - pad.b + 14}" class="ax" text-anchor="middle">${fmt(d, dStep < 1 ? 1 : 0)}</text>`;
    out += `<text x="${pad.l - 6}" y="${H - pad.b + 14}" class="ax" text-anchor="end">m</text>`;
    D.verts.forEach((d) => { out += `<line x1="${f(X(d))}" x2="${f(X(d))}" y1="${pad.t}" y2="${pad.t + ph}" class="vt"/>`; });
    let body = '';
    // 現況地盤（塗り）
    const gnd = P2.map((p) => [X(p.d), Y(p.g)]), bottom = f(pad.t + ph);
    body += `<path d="${pl(gnd)}L${f(gnd[gnd.length - 1][0])},${bottom}L${f(gnd[0][0])},${bottom}Z" class="gnd-f"/>`;
    // 切土・盛土
    const runs = (test) => { const rs = []; let cur = null; P2.forEach((p, i) => { if (test(p)) { if (!cur) rs.push((cur = [])); cur.push(i); } else cur = null; }); return rs; };
    for (const [kind, cls] of [['fill', 'fill'], ['cut', 'cut']]) for (const r of runs((p) => p.kind && Math.abs(p.z - p.g) > 1e-3 && (kind === 'fill' ? p.z > p.g : p.z < p.g))) {
      const a = Math.max(0, r[0] - 1), b = Math.min(P2.length - 1, r[r.length - 1] + 1), idx = [];
      for (let i = a; i <= b; i++) idx.push(i);
      body += `<path d="${pl(idx.map((i) => [X(P2[i].d), Y(P2[i].z)]))}${pl(idx.slice().reverse().map((i) => [X(P2[i].d), Y(P2[i].g)])).replace(/^M/, 'L')}Z" class="${cls}"/>`;
    }
    body += `<path d="${pl(gnd)}" class="gnd"/>`;
    // 計画（のり面＋路面）
    for (const r of runs((p) => p.kind)) {
      const a = Math.max(0, r[0] - 1), b = Math.min(P2.length - 1, r[r.length - 1] + 1), seg = [];
      for (let i = a; i <= b; i++) seg.push([X(P2[i].d), Y(P2[i].z)]);
      body += `<path d="${pl(seg)}" class="slope"/>`;
    }
    for (const [k, cls] of [['road', 'pave'], ['walk', 'walk']]) for (const r of runs((p) => p.kind === k)) body += `<path d="${pl(r.map((i) => [X(P2[i].d), Y(P2[i].z)]))}" class="${cls}"/>`;
    // 橋梁（桁）
    for (const r of runs((p) => p.deck != null)) {
      const top = r.map((i) => [X(P2[i].d), Y(P2[i].deck)]), bot = r.slice().reverse().map((i) => [X(P2[i].d), Y(P2[i].deck - DECK)]);
      body += `<path d="${pl(top)}${pl(bot).replace(/^M/, 'L')}Z" class="deck"/><path d="${pl(top)}" class="pave"/>`;
    }
    out += `<g clip-path="url(#xsclip)">${body}</g>`;
    // 交差する道路の注記
    let lane = 0;
    D.cross.forEach((c) => {
      const x = f(X(c.d)), y0 = c.type === 'plan' ? Y(c.z) : Y(c.g), row = lane++ % 2, ty = 13 + row * 13;
      out += `<line x1="${x}" x2="${x}" y1="${ty + 3}" y2="${f(y0 - 4)}" class="${c.type === 'plan' ? 'cl' : 'cle'}"/>`;
      let t;
      if (c.type === 'plan') {
        const dz = c.z - c.g;
        t = `${esc(c.name)} ${station(c.s)} ・ 計画高 ${fmt(c.z, 2)}${c.auto ? '（地盤沿い）' : ''} ・ 地盤 ${fmt(c.g, 2)} ・ ${dz >= 0 ? '盛' : '切'} ${fmt(Math.abs(dz), 2)} m${c.bridge ? ' ・ 橋梁' : ''}${c.ang < 80 ? ` ・ 交差角 ${fmt(c.ang, 0)}°` : ''}`;
      } else t = `既存: ${esc(c.name)}（約 ${fmt(c.width, 1)} m） ・ 地盤 ${fmt(c.g, 2)}`;
      const anc = X(c.d) < pad.l + 120 ? 'start' : X(c.d) > W - pad.r - 120 ? 'end' : 'middle';
      out += `<text x="${x}" y="${ty}" class="${c.type === 'plan' ? 'xl' : 'xle'}" text-anchor="${anc}">${t}</text>`;
    });
    out += `<text x="${pad.l + 2}" y="${pad.t + ph - 5}" class="ab">A</text><text x="${f(X(D.Ls) - 2)}" y="${pad.t + ph - 5}" class="ab" text-anchor="end">B</text>`;
    const ex = sy / sx;
    out += `<text x="${W - pad.r}" y="${pad.t - 3}" class="ax" text-anchor="end">${xs.eq ? '縦横同縮尺' : `縦 ×${ex >= 10 ? fmt(ex, 0) : fmt(ex, 1)}`}</text>`;
    out += `<g class="cur" visibility="hidden"><line y1="${pad.t}" y2="${pad.t + ph}"/><circle r="3.5"/><text y="${pad.t + 12}" class="ax"></text></g>`;
    const data = { w: W, h: H, pl: pad.l, pt: pad.t, sx, sy, hi, ls: D.Ls };
    return `<svg class="xchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" ${Object.entries(data).map(([k, v]) => `data-${k}="${v}"`).join(' ')}>${out}</svg>`;
  }

  /* ホバー: 距離・地盤高・計画高を表示し、地図に位置を出す */
  document.addEventListener('pointermove', (e) => {
    const svg = e.target.closest && e.target.closest('svg.xchart');
    if (!svg || !xs.data) return;
    const d = Object.fromEntries(Object.entries(svg.dataset).map(([k, v]) => [k, +v])), rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) * d.w) / rect.width, dist = Math.min(d.ls, Math.max(0, (vx - d.pl) / d.sx));
    const pts = xs.data.pts, g = interp(pts, dist, 'g'), z = interp(pts, dist, 'z');
    let near = pts[0]; for (const p of pts) if (Math.abs(p.d - dist) < Math.abs(near.d - dist)) near = p;
    const cur = svg.querySelector('.cur'), tx = cur.querySelector('text'), x = d.pl + dist * d.sx;
    cur.setAttribute('visibility', 'visible');
    cur.querySelector('line').setAttribute('x1', x); cur.querySelector('line').setAttribute('x2', x);
    const zz = near.deck != null ? near.deck : z, c = cur.querySelector('circle');
    c.setAttribute('cx', x); c.setAttribute('cy', d.pt + (d.hi - zz) * d.sy);
    tx.setAttribute('x', x + (x > d.w - 300 ? -6 : 6)); tx.setAttribute('text-anchor', x > d.w - 300 ? 'end' : 'start');
    let t = `A から ${fmt(dist, 2)} m ・ 地盤 ${fmt(g, 2)} m`;
    if (near.deck != null) t += ` ・ 橋面 ${fmt(near.deck, 2)} m（桁下 ${fmt(near.deck - DECK - g, 1)} m）`;
    else if (near.kind) t += ` ・ 計画 ${fmt(z, 2)} m ・ ${z >= g ? '盛' : '切'} ${fmt(Math.abs(z - g), 2)} m` + (near.kind === 'fill' ? '（盛土のり面 1:1.5）' : near.kind === 'cut' ? '（切土のり面 1:1.0）' : near.kind === 'walk' ? '（歩道）' : '（路面）');
    tx.textContent = t;
    gHover.clearLayers();
    L.circleMarker(near.ll, { radius: 6, color: XC.line, weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false, pane: 'labels' }).addTo(gHover);
  });
  document.addEventListener('pointerleave', (e) => { if (e.target.matches && e.target.matches('svg.xchart')) { gHover.clearLayers(); const c = e.target.querySelector('.cur'); if (c) c.setAttribute('visibility', 'hidden'); } }, true);
  document.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.xs === 'eq') { xs.eq = e.target.checked; renderDock(); } });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'xs-close') { e.stopPropagation(); root.xsecClear(); }
    else if (b.dataset.act === 'xs-csv' && xs.data) {
      e.stopPropagation();
      const rows = [['A からの距離 m', '緯度', '経度', '地盤高 m', '計画高 m', '切盛高 m', '区分']];
      const KJ = { road: '路面', walk: '歩道', fill: '盛土', cut: '切土' };
      for (const p of xs.data.pts) {
        const ll = p.ll, z = p.deck != null ? p.deck : p.kind ? p.z : null;
        rows.push([fmt(p.d, 2), ll.lat.toFixed(7), ll.lng.toFixed(7), fmt(p.g, 2), z == null ? '' : fmt(z, 2), z == null ? '' : fmt(z - p.g, 2), p.deck != null ? '橋梁' : KJ[p.kind] || '']);
      }
      const blob = new Blob(['﻿' + rows.map((r) => r.join(',')).join('\r\n')], { type: 'text/csv' }), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `${project.name || 'road-plan'}_断面.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  }, true);
})(typeof self !== 'undefined' ? self : this);
