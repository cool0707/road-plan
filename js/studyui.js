/* Road Plan — 計画検討の画面（土工量・用地・支障物件・交差・区分と車線数・概算事業費・費用便益分析・沿道騒音・災害リスク・比較表）
 * 計算は js/study.js。ここでは地盤高（地理院 標高タイル）・建物と水域（地理院 最適化ベクトルタイル）・ハザードマップのタイルを取得し、
 * 交通量の予測（js/traffic.js）の結果と合わせて、右パネル・地図・比較表・PDF に出す。 */
'use strict';

const StudyUI = (() => {
  const S = Study;
  const st = { on: false, seq: 0, drawSig: '', A: new Map(), busy: new Set(), timer: 0, dock: false, tr: null, hz: new Map(), hzBusy: false, hzLayers: new Map(), exXY: null };
  const DEF = { margin: 1, C: 0.9, rate: 4, years: 5, maint: 3000, small: 20, residual: false, alt: false, night: 10 };
  const n0 = (v) => (v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString('ja-JP'));
  const yen = (v) => (v == null || !isFinite(v) ? '—' : Math.abs(v) >= 1e8 ? fmt(v / 1e8, 2) + ' 億円' : n0(v / 1e4) + ' 万円');
  const LV = { error: '不適合', warn: '要確認', info: '参考', ok: '適合' };
  const XTYPE = { grade: ['平面交差', '#0f9d8f', '平面'], over: ['立体（上を越える）', '#6250d6', '立体・上'], under: ['立体（下をくぐる）', '#6250d6', '立体・下'], sepex: ['立体（相手が高架・トンネル）', '#6250d6', '立体'], conflict: ['高さが合わない', '#f24822', '不成立'], ext: ['延伸で接続', '#757575', '延伸'] };

  /* ───────── 設定 ───────── */
  function sd() { if (!project.study) project.study = {}; const s = project.study; s.set = s.set || {}; s.cost = s.cost || {}; s.hz = s.hz || {}; return s; }
  const setting = () => Object.assign({}, DEF, sd().set);
  const roads = () => project.roads.filter((r) => r.visible !== false && r.ips.length >= 2);
  const curRoad = () => { const r = selRoad(); return r && r.visible !== false ? r : roads()[0] || null; };
  /* 道路の種類の既定: 第1・2種は自動車専用道路、第3・4種は上位の級を都道府県道、それ以外を市町村道とみなす */
  const kindOf = (r) => r.rkind || (+r.cls[0] <= 2 ? 'mot' : +r.cls[2] <= 2 ? 'pref' : 'city');
  const terrainOf = (r) => (r.terrain === 'mount' ? 'mount' : 'flat');

  /* ───────── 解析（地盤・土工・用地・建物・水域） ───────── */
  const geoKey = (r) => { const s = setting(); return JSON.stringify([r.ips, r.vips, r.lanes, r.laneW, r.shoulderW, r.sidewalkW, r.V, r.cls, s.margin, s.C]); };
  const fresh = (r) => { const a = st.A.get(r.id); return a && a.key === geoKey(r) ? a : null; };
  async function loadCity(edges) {
    if (typeof V3DCity === 'undefined') await loadScript('js/v3d-city.js');
    /* まず道路全体の範囲を一度に読む。長い道路でタイルが多すぎるときは、約 400m ごとに区切って読む（タイルは V3DCity が覚えている） */
    const get = (part) => { const b = L.latLngBounds(part.flatMap((e) => [P.toLL(e.l[0], e.l[1]), P.toLL(e.r[0], e.r[1])])).pad(0.05); return V3DCity.load({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, (lat, lng) => P.toXY({ lat, lng })).catch(() => null); };
    const whole = await get(edges);
    if (whole && whole.ok) return whole;
    const out = { buildings: [], water: [], ok: false, measured: 0 }, seen = new Set(), CH = 40;
    for (let i = 0; i < edges.length - 1; i += CH) {
      const c = await get(edges.slice(i, i + CH + 1));
      if (!c || !c.ok) continue;
      out.ok = true;
      for (const bl of c.buildings) { const p = bl.parts[0].outer[0], k = Math.round(p[0]) + ',' + Math.round(p[1]) + ',' + Math.round(bl.area); if (seen.has(k)) continue; seen.add(k); out.buildings.push(bl); }
      for (const w of c.water) { const k = 'w' + Math.round(w[0][0][0]) + ',' + Math.round(w[0][0][1]) + ',' + w[0].length; if (seen.has(k)) continue; seen.add(k); out.water.push(w); }
    }
    return out.ok ? out : null;
  }
  async function analyze(road) {
    const key = geoKey(road);
    if (fresh(road) || st.busy.has(road.id)) return;
    const al = calc(road); if (!(al.length > 1)) return;
    st.busy.add(road.id); renderPanels();
    try {
      const s = setting(), rows = S.stations(al), gc = await Promise.all(rows.map((r) => xsecGround(P.toLL(r.x, r.y))));
      const noDem = !gc.some((g) => g != null);
      rows.forEach((r, i) => { r.g = gc[i]; });
      const M = XSecCore.buildModel(road, al, rows), off = S.offsets(M.E);
      const lat = noDem ? null : await Promise.all(M.rows.map((r) => (r.bridge ? null : Promise.all(off.map((d) => xsecGround(P.toLL(r.x - r.sn * d, r.y + r.c * d)))).then((g) => g.map((h) => (h == null ? r.g : h))))));
      if (geoKey(road) !== key) return; // 取得中に線形・設定が変わった
      const ew = S.earthwork(M, off, lat, { C: s.C, margin: s.margin }), edges = S.rowEdges(M, ew);
      const A = { key, v: ++st.seq, M, al, ew, edges, noDem, hits: null, water: null, cityOk: false };
      st.A.set(road.id, A); render(); renderPanels(); // 土工までを先に出す
      const city = await loadCity(edges).catch(() => null);
      if (geoKey(road) !== key || st.A.get(road.id) !== A) return;
      if (city) {
        A.cityOk = true;
        A.hits = S.hitBuildings(city.buildings, edges);
        A.hits.list.forEach((h) => { h.ll = city.buildings[h.i].parts.map((p) => p.outer.map((q) => P.toLL(q[0], q[1]))); });
        A.water = S.waterCross(al.samples, city.water, (x) => S.bridgeAt(M.rows, x));
      }
    } catch (e) { console.error(e); toast('計画検討の計算に失敗しました: ' + e.message, 'err'); }
    finally { st.busy.delete(road.id); render(); renderPanels(); if (st.on) schedule(); }
  }
  /* 設定や線形が変わったら計算し直す */
  function schedule() {
    clearTimeout(st.timer);
    if (!st.on || ui.dragging) return;
    for (const id of st.A.keys()) if (!roadById(id)) { st.A.delete(id); st.hz.delete(id); } // 削除された道路の結果は捨てる
    const todo = roads().filter((r) => !fresh(r) && !st.busy.has(r.id));
    if (!todo.length) return;
    const cur = curRoad(), r = todo.includes(cur) ? cur : todo[0]; // 選択中の道路から
    st.timer = setTimeout(() => { if (st.on && !ui.dragging) analyze(r); }, 350);
  }

  /* ───────── 交差（既存道路・他の計画道路） ───────── */
  function crossOf(road, A) {
    if (!st.exXY || st.exXY.ref !== project.existing || st.exXY.o !== (project.origin && project.origin.lat)) {
      st.exXY = { ref: project.existing, o: project.origin && project.origin.lat, list: project.existing.filter((e) => Traffic.kindOf(e.cls, e.width) !== 'sv').map((e) => ({ name: e.name || e.clsJa || '', width: e.width, sep: !!e.sep, xy: e.pts.map((p) => P.toXY(p)) })) };
    }
    const others = roads().filter((r) => r !== road), k = JSON.stringify([others.map((r) => [r.ips, r.vips]), road.conn]);
    if (A.x && A.x.ref === st.exXY && A.x.k === k) return A.x;
    const list = S.crossingList(A.M, A.al, road, st.exXY.list.concat(others.map((r) => ({ name: r.name, width: Rules.carriage(r), planned: true, xy: calc(r).samples }))));
    return (A.x = { ref: st.exXY, k, list, gaps: S.spacing(list) });
  }

  /* ───────── 交通量の予測（日交通量）と便益 ───────── */
  const trStale = () => !st.tr || st.tr.sig !== TrafficUI.daySig() + '#' + setting().small + '#' + setting().alt;
  function runTraffic() {
    if (!project.existing.length) return toast('既存道路がありません。左パネルで計画道路のまわりの道路（迂回路になりうる範囲まで）を読み込んでください', 'err');
    const el = toast('交通量の予測（日交通量）から便益を計算中…', 'busy');
    setTimeout(() => {
      try {
        const s = setting(), pack = ({ net, res }) => {
          if (!res || res.failed) return { ok: false, warn: res ? res.warn : ['既存道路がありません'] };
          const lg = {}; net.edges.forEach((e) => { if (!e.planned) return; const q = lg[e.rid] || (lg[e.rid] = { s: 0, l: 0 }); q.s += ((e.fac && e.fac.lg) || 10) * e.len; q.l += e.len; });
          return { ok: true, ben: S.benefits(net, res, { small: s.small / 100 }), plan: res.plan, fit: res.fit, warn: res.warn, hasPlan: res.hasPlan, lg: Object.fromEntries(Object.entries(lg).map(([k, q]) => [k, q.s / q.l / 100])) };
        };
        const tr = { sig: TrafficUI.daySig() + '#' + s.small + '#' + s.alt, all: pack(TrafficUI.forecastDay()), alt: new Map() };
        if (s.alt && roads().length > 1) for (const r of roads()) tr.alt.set(r.id, pack(TrafficUI.forecastDay([r.id])));
        st.tr = tr;
        if (!tr.all.ok) toast('交通量を予測できませんでした: ' + tr.all.warn.join(' / '), 'err');
      } catch (e) { console.error(e); toast('交通量の予測に失敗しました: ' + e.message, 'err'); }
      finally { el.remove(); renderPanels(); }
    }, 30);
  }
  /* その道路の予測結果（比較案として 1 路線ずつ評価する設定なら、その路線だけを整備した場合） */
  const trOf = (r) => { if (!st.tr) return null; const s = setting(); return s.alt && st.tr.alt.has(r.id) ? st.tr.alt.get(r.id) : st.tr.all; };
  /* 計画交通量 [台/日・両方向]: 入力値があればそれ、無ければ交通量の予測（区間最大） */
  function planQ(r) {
    if (r.qplan > 0) return { q: r.qplan, src: '入力値' };
    const t = trOf(r), p = t && t.ok && t.plan[r.id];
    return p && p.max > 0 ? { q: Math.round(p.max / 100) * 100, src: '交通量の予測・区間最大' + (trStale() ? '・更新前' : '') } : { q: 0, src: '' };
  }
  const planOf = (r) => Object.assign(planQ(r), { kind: kindOf(r), terrain: terrainOf(r), manyX: !!r.manyX, center: !!r.center });

  /* ───────── 数量・事業費・B/C・騒音 ───────── */
  function costOf(r, A) {
    const ew = A.ew, L = A.al.length, earthL = Math.max(0, L - ew.bridgeLen);
    return S.cost({ cutV: ew.cutV, fillV: ew.fillV, borrow: ew.borrow, surplus: ew.surplus, slopeA: ew.slopeFill + ew.slopeCut, paveA: (Rules.carriage(r) + 2 * r.shoulderW) * earthL, walkA: 2 * (r.sidewalkW || 0) * earthL,
      bridgeA: Rules.totalWidth(r) * ew.bridgeLen, len: earthL, rowA: ew.rowA, compA: A.hits ? A.hits.floor : 0 }, sd().cost);
  }
  /* B/C。比較案の設定ならその道路だけ、そうでなければ表示中の計画道路すべてを一体の事業として評価する */
  function bcOf(r) {
    const s = setting(), t = trOf(r), alt = s.alt && roads().length > 1, list = alt ? [r] : roads();
    if (!t || !t.ok || !t.hasPlan) return null;
    if (!list.every(fresh)) return { wait: true };
    let works = 0, land = 0, km = 0;
    for (const x of list) { const c = costOf(x, fresh(x)); works += c.works + c.survey; land += c.land + c.comp; km += fresh(x).al.length / 1000; }
    const o = { benefit: t.ben, works, land, years: s.years, maint: s.maint * 1000 * km, rate: s.rate / 100, horizon: 50, residual: !!s.residual };
    return { o, r: S.bcr(o), r1: S.bcr(Object.assign({}, o, { rate: 0.01 })), r2: S.bcr(Object.assign({}, o, { rate: 0.02 })), sens: S.sensitivity(o), alt, n: list.length, t };
  }
  function noiseOf(r) {
    const p = planQ(r); if (!(p.q > 0)) return null;
    const t = trOf(r), heavy = r.nheavy >= 0 && r.nheavy !== '' && r.nheavy != null ? r.nheavy / 100 : (t && t.ok && t.lg[r.id]) || 0.1, steady = r.nsteady != null ? !!r.nsteady : r.cls[0] !== '4';
    const o = { q: p.q, heavy, V: r.tv || r.V, steady, night: setting().night / 100, road: r }, k = kindOf(r), trunk = k !== 'city' || r.lanes >= 4;
    const std = trunk ? S.NOISE_STD.trunk : S.NOISE_STD.bc;
    return { o, at: S.noise(o), std, trunk, dist: Object.fromEntries(Object.entries(S.NOISE_STD).map(([key, v]) => [key, S.noiseDistance(o, v.day, v.night)])) };
  }
  function reviewOf(r, A) {
    const X = crossOf(r, A), out = S.review(r, A.al, { ew: A.noDem ? null : A.ew, hits: A.hits, water: A.water, cross: X.list, gaps: X.gaps }, planOf(r)), nz = noiseOf(r);
    if (nz) {
      const over = nz.at.day > nz.std.day + 0.05 || nz.at.night > nz.std.night + 0.05, d = `道路端（官民境界）で 昼 ${fmt(nz.at.day, 1)}dB・夜 ${fmt(nz.at.night, 1)}dB（計画交通量 ${n0(nz.o.q)} 台/日・大型車 ${fmt(nz.o.heavy * 100, 0)}%・${nz.o.V}km/h・${nz.o.steady ? '定常走行' : '非定常走行'}）。環境基準: ${nz.std.name} 昼 ${nz.std.day}dB・夜 ${nz.std.night}dB`;
      out.push(over ? { level: 'warn', cat: '沿道騒音', title: `道路端の騒音が環境基準を超える見込み`, detail: `${d}。基準以下になるのは道路端から約 ${nz.dist[nz.trunk ? 'trunk' : 'bc'] == null ? '300m 超' : fmt(nz.dist[nz.trunk ? 'trunk' : 'bc'], 0) + 'm'}。遮音壁・低騒音舗装・環境施設帯（植樹帯）・速度の見直しを検討する`, ref: '騒音に係る環境基準／ASJ RTN-Model による概略値' }
        : { level: 'ok', cat: '沿道騒音', title: '道路端の騒音は環境基準以下の見込み', detail: d, ref: '騒音に係る環境基準／ASJ RTN-Model による概略値' });
    }
    const hz = st.hz.get(r.id);
    if (hz && hz.key === A.key) hz.rows.forEach((h) => { if (h.len > 1) out.push({ level: 'warn', cat: '災害リスク', title: `${h.name} を約 ${n0(h.len)}m 通過`, detail: `${h.detail ? h.detail + '。' : ''}${h.kind === 'flood' ? '路面高を想定浸水深より上げる・排水施設の強化・冠水時の通行規制と迂回路を検討する' : 'のり面・斜面対策、区域を避ける線形、防護施設を検討する（特別警戒区域では開発行為が規制される）'}`, ref: 'ハザードマップポータルサイト（国土交通省）' }); });
    return out;
  }

  /* ───────── 災害リスク（ハザードマップポータルサイトのタイル） ───────── */
  const HZ_URL = 'https://disaportaldata.gsi.go.jp/raster/';
  const HZ = {
    flood: { name: '洪水浸水想定区域（想定最大規模）', path: '01_flood_l2_shinsuishin_data', kind: 'flood' },
    hightide: { name: '高潮浸水想定区域', path: '03_hightide_l2_shinsuishin_data', kind: 'flood' },
    tsunami: { name: '津波浸水想定', path: '04_tsunami_newlegend_data', kind: 'flood' },
    doseki: { name: '土砂災害警戒区域（土石流）', path: '05_dosekiryukeikaikuiki', kind: 'sabo' },
    kyukei: { name: '土砂災害警戒区域（急傾斜地の崩壊）', path: '05_kyukeishakeikaikuiki', kind: 'sabo' },
    jisuberi: { name: '土砂災害警戒区域（地すべり）', path: '05_jisuberikeikaikuiki', kind: 'sabo' },
  };
  /* 浸水深の凡例の色（ハザードマップポータルサイトの標準の配色） */
  const DEPTH = [[247, 245, 169, '0.5m 未満'], [255, 216, 192, '0.5〜3m'], [255, 183, 183, '3〜5m'], [255, 145, 145, '5〜10m'], [242, 133, 201, '10〜20m'], [220, 122, 220, '20m 以上']];
  const hzTiles = new Map();
  function hzTile(id, z, x, y) { // 戻り値: 画素（RGBA）/ null（その場所に区域なし）/ 'err'（取得できない）
    const key = `${id}/${z}/${x}/${y}`;
    if (!hzTiles.has(key)) hzTiles.set(key, fetch(`${HZ_URL}${HZ[id].path}/${z}/${x}/${y}.png`).then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) return 'err';
      const bmp = await createImageBitmap(await r.blob()), c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, 256, 256);
      return g.getImageData(0, 0, 256, 256).data;
    }).catch(() => { hzTiles.delete(key); return 'err'; }));
    return hzTiles.get(key);
  }
  async function hazard(road) {
    const A = fresh(road); if (!A || st.hzBusy) return;
    st.hzBusy = true; renderPanels();
    try {
      const z = 16, n = 2 ** z, step = Math.max(2, Math.min(5, A.al.length / 400)), pts = [];
      for (let s = 0; s <= A.al.length + 1e-6; s += step) { const p = Geom.poseAt(A.al, Math.min(s, A.al.length)), ll = P.toLL(p.x, p.y), r = (ll.lat * Math.PI) / 180; pts.push({ s: p.s, fx: ((ll.lng + 180) / 360) * n, fy: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n }); }
      const rows = [];
      let fail = 0;
      for (const [id, h] of Object.entries(HZ)) {
        let len = 0, err = false, worst = -1, special = 0;
        for (const p of pts) {
          const d = await hzTile(id, z, Math.floor(p.fx), Math.floor(p.fy));
          if (d === 'err') { err = true; break; }
          if (!d) continue;
          const i = (Math.min(255, Math.floor((p.fy % 1) * 256)) * 256 + Math.min(255, Math.floor((p.fx % 1) * 256))) * 4;
          if (d[i + 3] < 40) continue;
          len += step;
          if (h.kind === 'flood') { let best = -1, bd = 60 * 60; DEPTH.forEach((c, k) => { const q = (c[0] - d[i]) ** 2 + (c[1] - d[i + 1]) ** 2 + (c[2] - d[i + 2]) ** 2; if (q < bd) { bd = q; best = k; } }); worst = Math.max(worst, best); }
          else if (d[i] > 180 && d[i + 1] < 120) special += step; // 赤系 = 特別警戒区域
        }
        if (err) { fail++; continue; }
        rows.push({ id, name: h.name, kind: h.kind, len: Math.min(len, A.al.length), detail: len > 0 ? (h.kind === 'flood' ? (worst >= 0 ? `想定浸水深は最大 ${DEPTH[worst][3]}` : '') : special > 0 ? `うち特別警戒区域 約 ${n0(special)}m` : '') : '' });
      }
      st.hz.set(road.id, { key: A.key, rows, fail });
      if (fail) toast(`ハザードマップのタイルを ${fail === Object.keys(HZ).length ? '' : '一部 '}取得できませんでした（通信環境・提供元の状況による）`, 'err');
    } finally { st.hzBusy = false; renderPanels(); }
  }
  function syncHazardLayers() {
    const want = st.on ? sd().hz : {};
    for (const id of Object.keys(HZ)) {
      const on = !!want[id], cur = st.hzLayers.get(id);
      if (on && !cur) st.hzLayers.set(id, L.tileLayer(`${HZ_URL}${HZ[id].path}/{z}/{x}/{y}.png`, { pane: 'hazard', opacity: 0.65, maxNativeZoom: 17, maxZoom: 22, minZoom: 5, attribution: '<a href="https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/opendata.html" target="_blank" rel="noopener">ハザードマップポータルサイト</a>' }).addTo(map));
      else if (!on && cur) { map.removeLayer(cur); st.hzLayers.delete(id); }
    }
  }

  /* ───────── 地図 ───────── */
  let group = null;
  function initMap() {
    if (group) return;
    map.createPane('hazard').style.zIndex = 320; map.getPane('hazard').style.pointerEvents = 'none';
    map.createPane('study').style.zIndex = 410;
    group = L.layerGroup().addTo(map);
  }
  function render() {
    if (!st.on) { if (group) group.clearLayers(); syncHazardLayersSafe(); st.drawSig = ''; return; }
    initMap(); syncHazardLayers();
    const base = { pane: 'study', interactive: false }, cur = curRoad();
    /* 地図の移動・拡大のたびに作り直さない（解析結果・選択・交差する道路が変わったときだけ） */
    const sig = (cur ? cur.id : '') + '|' + roads().map((r) => { const A = fresh(r); return A ? `${r.id}:${A.v}:${A.hits ? 1 : 0}:${JSON.stringify(r.conn)}` : ''; }).join(';') + '|' + project.existing.length;
    if (sig === st.drawSig) return;
    st.drawSig = sig; group.clearLayers();
    for (const r of roads()) {
      const A = fresh(r); if (!A) continue;
      const M = A.M, rows = M.rows, ew = A.ew, pt = (q, d) => P.toLL(q.x - q.sn * d, q.y + q.c * d), on = r === cur;
      /* のり面（盛土＝黄・切土＝茶）: 道路端からのり尻・のり肩まで */
      for (const [sgn, kk, wk] of [[1, 'kl', 'wl'], [-1, 'kr', 'wr']]) {
        let run = null;
        const flush = () => { if (run && run.a.length > 1) L.polygon([...run.a, ...run.b.reverse()], { ...base, stroke: false, fillColor: run.kind === 'fill' ? '#f5b642' : '#a1887f', fillOpacity: on ? 0.55 : 0.3 }).addTo(group); run = null; };
        rows.forEach((q, i) => {
          const e = ew.rows[i], kind = e.bridge ? '' : e[kk];
          if (!kind) return flush();
          if (run && run.kind !== kind) flush();
          if (!run) run = { kind, a: [], b: [] };
          run.a.push(pt(q, sgn * M.E)); run.b.push(pt(q, sgn * e[wk]));
        });
        flush();
      }
      /* 用地の境界 */
      L.polyline(A.edges.map((e) => P.toLL(e.l[0], e.l[1])), { ...base, color: '#b3261e', weight: on ? 1.5 : 1, dashArray: '6 4', opacity: on ? 0.9 : 0.5 }).addTo(group);
      L.polyline(A.edges.map((e) => P.toLL(e.r[0], e.r[1])), { ...base, color: '#b3261e', weight: on ? 1.5 : 1, dashArray: '6 4', opacity: on ? 0.9 : 0.5 }).addTo(group);
      const seg = (s0, s1) => A.al.samples.filter((p) => p.s >= s0 - 1e-6 && p.s <= s1 + 1e-6).map((p) => P.toLL(p.x, p.y));
      ew.bridges.forEach((b) => { const ll = seg(b.s0, b.s1); if (ll.length > 1) { L.polyline(ll, { ...base, color: '#1e1e1e', weight: 7, opacity: 0.55, lineCap: 'butt' }).addTo(group); if (on) label(ll[ll.length >> 1], `橋梁 ${fmt(b.s1 - b.s0, 0)}m`, 'sd-lb', [-20, -8]).addTo(group); } });
      (A.water || []).forEach((w) => { if (w.bridged) return; const ll = seg(w.s0, w.s1); if (ll.length > 1) L.polyline(ll, { ...base, color: '#0d6efd', weight: 8, opacity: 0.6 }).addTo(group); });
      if (A.hits) A.hits.list.forEach((h) => h.ll.forEach((ring) => L.polygon(ring, { ...base, color: '#f24822', weight: 1.5, fillColor: '#f24822', fillOpacity: on ? 0.45 : 0.25 }).addTo(group)));
      if (on) crossOf(r, A).list.forEach((x) => {
        const p = Geom.poseAt(A.al, x.s), t = XTYPE[x.type];
        L.circleMarker(P.toLL(p.x, p.y), { pane: 'study', radius: 6, color: '#fff', weight: 2, fillColor: t[1], fillOpacity: 1 }).bindTooltip(`${esc(x.name || '既存道路')}｜${t[0]}・${station(x.s)}`, { direction: 'top', offset: [0, -6] }).addTo(group);
      });
    }
  }
  function syncHazardLayersSafe() { if (group) syncHazardLayers(); }

  /* ───────── 右パネル ───────── */
  const massSvg = (ew, L) => {
    const W = 276, H = 64, vs = ew.mass.map((m) => m.v), lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), sp = hi - lo || 1, X = (s) => (s / L) * W, Y = (v) => 6 + (1 - (v - lo) / sp) * (H - 12);
    return `<svg class="sd-mass" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" class="z"/><polyline points="${ew.mass.map((m) => `${fmt(X(m.s), 1)},${fmt(Y(m.v), 1)}`).join(' ')}"/></svg>
      <div class="muted small sd-cap">土積図（起点からの累計: 切土 × C − 盛土。上がる区間は切土、下がる区間は盛土。終点の値が過不足）</div>`;
  };
  function panel() {
    const all = roads(), r = curRoad();
    const head = `<div class="tr-head"><b>計画検討</b><span class="muted">${r ? esc(r.name) : ''}</span><button class="ibtn" data-act="study" title="計画検討を閉じる">✕</button></div>`;
    if (!r) return head + `<div class="note">計画道路がまだありません。下のツールバーの <b>道路を描く</b>（<kbd>P</kbd>）で作成すると、土工量・用地・交差・事業費・費用便益などの検討結果がここに出ます。</div>`;
    const A = fresh(r), s = setting(), loading = st.busy.has(r.id) || !A;
    let h = head;
    if (all.length > 1) h += `<div class="sd-pick"><div class="row one">${sel('路線', 'sd.road', r.id, all.map((x) => [x.id, x.name]))}</div></div>`;
    if (!A) return h + `<div class="note">${st.busy.has(r.id) ? '地理院 標高タイルから地盤高を取得して、土工量・用地幅を計算中…' : '計算の準備中…'}</div>`;
    const ew = A.ew, X = crossOf(r, A), items = reviewOf(r, A), lv = (l) => items.filter((x) => x.level === l), c = costOf(r, A), pq = planQ(r), al = A.al;
    const item = (x) => `<div class="ci lv-${x.level}"${x.s != null ? ` data-act="sd-goto" data-s="${x.s}" style="cursor:pointer"` : ''}><span class="mk"></span><div><b>${esc(x.title)}</b><span class="dt">${esc(x.detail)}</span>${x.ref ? `<div class="rf">${esc(x.cat)} ・ ${esc(x.ref)}</div>` : ''}</div></div>`;
    const pill = (l, t) => `<span class="pill lv-${l}"><i></i>${t} ${lv(l).length}</span>`;
    h += `<div class="chk-sum">${pill('error', '不適合')}${pill('warn', '要確認')}${pill('info', '参考')}${pill('ok', '適合')}${loading || (!A.cityOk && st.busy.has(r.id)) ? '<span class="muted small">建物・水域を取得中…</span>' : ''}</div>`
      + lv('error').map(item).join('') + lv('warn').map(item).join('')
      + `<details class="okgrp"${lv('error').length + lv('warn').length ? '' : ' open'}><summary>参考・適合の項目（${lv('info').length + lv('ok').length}）</summary>${lv('info').map(item).join('')}${lv('ok').map(item).join('')}</details>`;

    /* 土工・用地 */
    h += sec('土工・用地', (A.noDem ? '<div class="tr-warn" style="margin:0 -12px 8px">標高データを取得できないため、土工量・用地幅は計算できません（幅員ぶんの用地だけを数えています）。</div>' : !A.M.pf ? '<div class="tr-warn" style="margin:0 -12px 8px">縦断計画（計画高）がまだ無いため、現況地盤をならした高さ（前後 60m の平均）を仮の計画高として計算しています。「デザイン」の縦断計画で計画高を決めると、その高さで計算し直します。</div>' : '')
      + kv([['切土（地山）', `${n0(ew.cutV)} m³`], ['盛土（締固め後）', `${n0(ew.fillV)} m³`], ['切土から盛土へ流用', `${n0(ew.reuse)} m³`], ['不足土（購入土）', `${n0(ew.borrow)} m³`], ['残土', `${n0(ew.surplus)} m³`],
        ['のり面積 盛土', `${n0(ew.slopeFill)} m²`], ['のり面積 切土', `${n0(ew.slopeCut)} m²`], ['最大盛土高（中心）', `${fmt(ew.maxFill ? ew.maxFill.d : 0, 1)} m`], ['最大切土高（中心）', `${fmt(ew.maxCut ? ew.maxCut.d : 0, 1)} m`],
        ['橋梁', ew.bridges.length ? `${ew.bridges.length} か所・${n0(ew.bridgeLen)} m` : 'なし'], ['用地面積', `${n0(ew.rowA)} m²`], ['用地幅（最大）', `${fmt(ew.maxW, 1)} m`],
        ['用地にかかる建物', A.hits ? `${A.hits.n} 棟・${n0(A.hits.area)} m²` : A.cityOk || st.busy.has(r.id) ? '取得中…' : '取得できません'],
        A.water ? ['水域の横断', A.water.length ? `${A.water.length} か所・${n0(A.water.reduce((a, w) => a + w.len, 0))} m` : 'なし'] : null])
      + (ew.cutV + ew.fillV > 1 ? massSvg(ew, al.length) : '')
      + `<div class="row" style="margin-top:8px">${num('土量変化率 C', 'sd.set.C', s.C, { step: 0.05, dec: 2, title: '締固め後の土量 ÷ 地山の土量。切土を盛土に流用するときの目減り（砂質土 0.85〜0.95、粘性土 0.85〜0.95、礫質土 0.85〜1.0、岩 1.0〜1.4 が目安）' })}${num('用地の余裕', 'sd.set.margin', s.margin, { unit: 'm', step: 0.5, dec: 1, title: 'のり尻・のり肩（平地では道路端）の外側に取る用地の余裕幅（側溝・保護路肩・管理用地）' })}</div>
      <div class="muted small">横断ごと（約 ${fmt(al.length / (A.M.rows.length - 1), 1)}m ピッチ）に、現況地盤（地理院 標高タイル）と 盛土 1:1.5／切土 1:1.0 ののり面で切土・盛土の断面積を求め、平均断面法で土量にします。舗装厚・すき取り・小段・擁壁は含みません。地図の <i class="sd-key fill"></i>盛土 <i class="sd-key cut"></i>切土 <i class="sd-key row"></i>用地境界 <i class="sd-key hit"></i>かかる建物。</div>`);

    /* 交差・接続 */
    const xrows = X.list.map((x) => `<tr data-act="sd-goto" data-s="${x.s}" style="cursor:pointer"><td>${fmt(x.s, 0)}</td><td class="nm" title="${esc(x.name)}">${esc(x.name || '（名称なし）')}${x.end ? '（端点）' : ''}</td><td>${fmt(x.ang, 0)}°</td><td>${x.auto || x.end ? '—' : (x.dz >= 0 ? '+' : '−') + fmt(Math.abs(x.dz), 1)}</td><td title="${XTYPE[x.type][0]}"><span class="sd-x" style="background:${XTYPE[x.type][1]}"></span>${XTYPE[x.type][2]}</td></tr>`).join('');
    h += sec('交差・接続', X.list.length ? `<table class="els sd-xt"><tr><th title="追加距離 [m]">測点</th><th>交差する道路</th><th title="交差角">角度</th><th title="計画高 − 交差する道路の路面高（現況地盤高で近似）[m]">高低差</th><th>形</th></tr>${xrows}</table>
      <div class="muted small" style="margin-top:6px">高低差 ±${S.GRADE_TOL}m 以内を平面交差、桁下 ${S.CLEAR}m（建築限界）＋桁高 約${XSecCore.DECK}m 以上を立体交差として判定し、その間は「不成立」（高さが合わない）とします。${A.M.pf ? '' : '縦断計画が無いため、高低差は判定していません。'}行をクリックすると地図で表示します。</div>` : '<div class="muted small">途中で横切る道路・接続している道路はありません（既存道路を読み込むと判定します）。</div>');

    /* 計画交通量・区分・車線数 */
    const type = +r.cls[0], kinds = Object.entries(S.ROAD_KINDS).filter(([k]) => (type <= 2) === (k === 'exp' || k === 'mot')), ln = pq.q > 0 ? S.lanesFor(r.cls, terrainOf(r), pq.q, r.manyX) : null, needG = pq.q > 0 ? S.classFor(type, kindOf(r), terrainOf(r), pq.q, r.center) : null;
    h += sec('計画交通量・区分・車線数', `<div class="row one">${sel('道路の種類', 'sd.r.rkind', kindOf(r), kinds)}</div>
      <div class="row">${type === 2 ? `<label class="chk" title="第2種: 大都市の都心部の自動車専用道路は第2級"><input type="checkbox" data-key="sd.r.center"${r.center ? ' checked' : ''}>大都市の都心部</label>` : type === 4 ? `<label class="chk" title="交差点の多い第4種の道路は、設計基準交通量に 0.8（2 車線）・0.6（多車線の 1 車線当たり）を乗じる（道路構造令 第5条）"><input type="checkbox" data-key="sd.r.manyX"${r.manyX ? ' checked' : ''}>交差点が多い</label>` : sel('地形', 'sd.r.terrain', terrainOf(r), Object.entries(S.TERRAINS))}
        <label class="fld" title="計画交通量（年平均日交通量・両方向）。空欄にすると、交通量の予測（日交通量）の計画道路の区間最大を使います"><span class="lb">計画交通量</span><input data-key="sd.r.qplan" data-step="500" data-dec="0" value="${r.qplan > 0 ? r.qplan : ''}" placeholder="${pq.q > 0 && !(r.qplan > 0) ? n0(pq.q) : '予測から'}" inputmode="decimal"><span class="un">台/日</span></label></div>
      ${pq.q > 0 ? kv([['計画交通量', `${n0(pq.q)} 台/日<span class="muted">（${pq.src}）</span>`], ['該当する級（第3条）', needG == null ? '—（種と道路の種類が合わない）' : `第${type}種第${needG}級<span class="muted">（設定: ${Rules.CLASSES[r.cls].name}）</span>`],
        ['必要な車線数（第5条）', ln ? (ln.single ? '1 車線道路' : ln.lanes == null ? '表に値なし' : `${ln.lanes} 車線<span class="muted">（設定: ${r.lanes} 車線）</span>`) : '—'],
        ln && !ln.single ? ['設計基準交通量', `${ln.two ? '2 車線 ' + n0(ln.two) : ''}${ln.two && ln.per ? '・' : ''}${ln.per ? '1 車線当たり ' + n0(ln.per) : ''} 台/日`] : null])
    : `<div class="muted small">計画交通量を入力するか、下の「費用便益分析」で交通量の予測を計算すると、該当する級と必要な車線数を判定します。</div>`}`);

    /* 概算事業費 */
    const u = Object.assign({}, S.COST_DEFAULTS, sd().cost), edited = Object.keys(sd().cost).length > 0;
    h += sec('概算事業費', `<div class="sd-total"><span>概算事業費</span><b>${yen(c.total)}</b><span class="muted">${fmt(c.total / 1e8 / Math.max(0.001, al.length / 1000), 1)} 億円/km</span></div>
      <table class="els sd-ct"><tr><th>項目</th><th>数量</th><th>金額</th></tr>${c.items.filter((i) => i.qty > 0.5).map((i) => `<tr><td>${i.name.replace(/（.*/, '')}</td><td>${n0(i.qty)} ${i.unit.replace('円/', '')}</td><td>${yen(i.amount)}</td></tr>`).join('')}
        <tr><td>諸経費（直接工事費の ${fmt(u.misc, 0)}%）</td><td></td><td>${yen(c.misc)}</td></tr><tr><td>測量設計費（工事費の ${fmt(u.survey, 0)}%）</td><td></td><td>${yen(c.survey)}</td></tr>
        <tr class="sum"><td>工事費＋測量設計費</td><td></td><td>${yen(c.works + c.survey)}</td></tr><tr class="sum"><td>用地費＋補償費</td><td></td><td>${yen(c.land + c.comp)}</td></tr></table>
      <details class="tr-adv"${edited ? ' open' : ''}><summary>単価を変更する${edited ? '（変更あり）' : ''}</summary>
        ${S.COST_ITEMS.map(([k, name, un]) => `<div class="row one">${num(name.replace(/（.*/, ''), 'sd.cost.' + k, u[k], { unit: un, step: k === 'bridge' ? 10000 : k === 'comp' || k === 'drain' || k === 'land' ? 1000 : 100, dec: 0, title: name })}</div>`).join('')}
        <div class="row">${num('諸経費', 'sd.cost.misc', u.misc, { unit: '%', step: 1, dec: 0, title: '共通仮設費・現場管理費・一般管理費など。直接工事費に対する割合' })}${num('測量設計', 'sd.cost.survey', u.survey, { unit: '%', step: 1, dec: 0, title: '測量・調査・設計費。工事費に対する割合' })}</div>
        <div class="row one"><button class="btn" data-act="sd-cost-reset"${edited ? '' : ' disabled'}>単価を既定値に戻す</button></div></details>
      <div class="muted small">単価は桁を見るための仮の値です（消費税を含まない額として扱います）。地域の実績単価・用地単価（地価）に必ず置き換えてください。建物の補償は「延床面積の見込み（建築面積 × 階数）× 単価」です。中央帯・交差点改良・擁壁・トンネル・支障物件の移設は含みません。</div>`);

    /* 費用便益分析 */
    const t = trOf(r), bc = bcOf(r), stale = trStale();
    let bh = '';
    if (!st.tr) bh = `<div class="muted small" style="margin-bottom:8px">交通量の予測（日交通量・整備なし／あり）から、走行時間短縮・走行経費減少・交通事故減少の 3 便益と B/C を計算します。先に上部バーの <b>交通量</b> でデータ（センサスなど）を読み込み、現況の再現性を確認しておいてください。</div>`;
    else if (!t.ok) bh = `<div class="tr-warn" style="margin:0 -12px 8px">${t.warn.map(esc).join('<br>')}</div>`;
    else if (bc && bc.wait) bh = '<div class="muted small" style="margin-bottom:8px">他の計画道路の土工・事業費を計算中…</div>';
    else if (bc) {
      const q = bc.r, mark = q.bc >= 1 ? 'ok' : 'ng';
      bh = `<div class="sd-total ${mark}"><span>B/C（割引率 ${fmt(s.rate, 0)}%）</span><b>${q.bc == null ? '—' : fmt(q.bc, 2)}</b><span class="muted">${bc.alt ? 'この路線だけを整備' : bc.n > 1 ? `計画道路 ${bc.n} 路線を一体で評価` : ''}</span></div>
        <table class="els sd-ct"><tr><th>現在価値（${S.BC.price}）</th><th>年額</th><th>50 年</th></tr>
          <tr><td>走行時間短縮便益</td><td>${yen(bc.o.benefit.time)}</td><td>${yen(q.Bt)}</td></tr><tr><td>走行経費減少便益</td><td>${yen(bc.o.benefit.run)}</td><td>${yen(q.Br)}</td></tr><tr><td>交通事故減少便益</td><td>${yen(bc.o.benefit.acc)}</td><td>${yen(q.Ba)}</td></tr>
          <tr class="sum"><td>総便益 B</td><td></td><td>${yen(q.B)}</td></tr>
          <tr><td>事業費（${q.years} 年で均等）</td><td></td><td>${yen(q.Cc)}</td></tr><tr><td>維持管理費</td><td>${yen(bc.o.maint)}</td><td>${yen(q.Cm)}</td></tr>${q.residual ? `<tr><td>用地の残存価値（控除）</td><td></td><td>−${yen(q.residual)}</td></tr>` : ''}
          <tr class="sum"><td>総費用 C</td><td></td><td>${yen(q.C)}</td></tr></table>
        ${kv([['純現在価値 B − C', yen(q.npv)], ['経済的内部収益率 EIRR', q.eirr == null ? '—（便益が費用を下回る）' : q.eirr === Infinity ? '100% 超' : fmt(q.eirr * 100, 1) + ' %'], ['参考: 割引率 2%／1% の B/C', `${fmt(bc.r2.bc, 2)} ／ ${fmt(bc.r1.bc, 2)}`]])}
        <table class="els sd-ct" style="margin-top:8px"><tr><th>感度分析（B/C）</th><th>不利</th><th>有利</th></tr>${bc.sens.map((x) => `<tr><td>${x.name} ${x.note}</td><td>${fmt(x.lo, 2)}</td><td>${fmt(x.hi, 2)}</td></tr>`).join('')}</table>
        ${t.fit ? `<div class="muted small" style="margin-top:6px">交通量の予測の現況再現性: 相関係数 ${t.fit.r == null ? '—' : fmt(t.fit.r, 3)}・RMSE ${t.fit.rmse == null ? '—' : fmt(t.fit.rmse * 100, 1) + '%'}（${t.fit.n} 件）</div>` : ''}`;
    } else bh = '<div class="muted small" style="margin-bottom:8px">計画道路に交通が乗らないため、便益を計算できません（端点が既存道路に接続されているか確認してください）。</div>';
    h += sec('費用便益分析（B/C）', bh + `<div class="row one"><button class="btn wide${!st.tr || stale ? ' accent' : ''}" data-act="sd-traffic">${!st.tr ? '交通量の予測から便益を計算' : stale ? '交通量の予測をやり直す（道路・データ・設定が変わりました）' : '交通量の予測をやり直す'}</button></div>
      <div class="row">${num('事業期間', 'sd.set.years', s.years, { unit: '年', step: 1, dec: 0, title: '評価時点から供用開始までの年数。事業費をこの期間に均等に配分します' })}${num('割引率', 'sd.set.rate', s.rate, { unit: '%', step: 1, dec: 1, title: '社会的割引率。マニュアルは 4%（比較のための参考値として 1%・2%）' })}</div>
      <div class="row">${num('維持管理', 'sd.set.maint', s.maint, { unit: '千円/km/年', step: 500, dec: 0, title: '道路維持管理に要する費用（点検・補修・巡回・清掃・除雪など）。既存路線の実績で置き換えてください' })}${num('小型貨物', 'sd.set.small', s.small, { unit: '%', step: 5, dec: 0, title: '小型車（大型車以外）に占める小型貨物車の割合。残りを乗用車類、大型車を普通貨物車として時間価値・走行経費の原単位を当てます（大型車混入率は交通量の予測の値）' })}</div>
      <label class="chk" title="事業費のうち用地費の検討期間後の残存価値を、現在価値化して費用から控除する（マニュアル 3-(5)）"><input type="checkbox" data-key="sd.set.residual"${s.residual ? ' checked' : ''}>用地の残存価値を費用から控除</label>
      ${all.length > 1 ? `<label class="chk" title="オン: 計画道路を互いに代わりになる比較案として、1 路線ずつ単独で整備した場合の交通量・便益を求めます。オフ: 表示中の計画道路すべてを一体の事業として評価します"><input type="checkbox" data-key="sd.set.alt"${s.alt ? ' checked' : ''}>計画道路を比較案として 1 路線ずつ評価</label>` : ''}
      <div class="muted small">${S.BC.source}の算定式・原単位（${S.BC.price}）による計算です。便益は供用開始から 50 年間同じ額が続くとし（交通量の伸びは「交通量」画面の伸び率で設定）、交通事故は中央帯の有無を考慮しない式を使います。読み込んだ範囲の道路だけの簡易な予測に基づくので、事業評価には道路管理者の交通量推計が別途必要です。</div>`);

    /* 沿道騒音 */
    const nz = noiseOf(r);
    h += sec('沿道騒音', nz ? `<table class="els sd-ct"><tr><th>道路端（官民境界）</th><th>昼 6〜22時</th><th>夜 22〜6時</th></tr>
        <tr><td>予測 LAeq</td><td class="${nz.at.day > nz.std.day ? 'bad' : ''}">${fmt(nz.at.day, 1)} dB</td><td class="${nz.at.night > nz.std.night ? 'bad' : ''}">${fmt(nz.at.night, 1)} dB</td></tr>
        ${Object.values(S.NOISE_STD).map((v) => `<tr><td>${v === nz.std ? '<b>' : ''}環境基準: ${v.name}${v === nz.std ? '</b>' : ''}</td><td>${v.day} dB</td><td>${v.night} dB</td></tr>`).join('')}</table>
      ${kv(Object.entries(S.NOISE_STD).map(([k, v]) => [`${v.day}/${v.night}dB 以下になる距離`, nz.dist[k] == null ? '300 m 超' : nz.dist[k] <= 0 ? '道路端で満たす' : `道路端から 約 ${fmt(nz.dist[k], 0)} m`]))}
      <div class="row" style="margin-top:8px"><label class="fld" title="大型車混入率。空欄で自動（交通量の予測の値、無ければ 10%）"><span class="lb">大型車</span><input data-key="sd.r.nheavy" data-step="1" data-dec="0" value="${r.nheavy >= 0 && r.nheavy !== '' && r.nheavy != null ? r.nheavy : ''}" placeholder="${fmt(nz.o.heavy * 100, 0)}" inputmode="decimal"><span class="un">%</span></label>${num('夜間の割合', 'sd.set.night', s.night, { unit: '%', step: 1, dec: 0, title: '日交通量のうち 22〜6 時（8 時間）に通る割合' })}</div>
      <div class="row one">${sel('走行状態', 'sd.r.nsteady', nz.o.steady ? '1' : '0', [['1', '定常走行（信号の影響がない区間）'], ['0', '非定常走行（信号交差点のある一般道）']])}</div>
      <div class="muted small">ASJ RTN-Model（日本音響学会）の 2 車種分類のパワーレベル式（定常 45.8／53.2 + 30 log V、非定常 82.3／88.8 + 10 log V）と、無限長の直線道路の伝搬（距離 2 倍で −3dB）による概略値です。走行速度は ${nz.o.V}km/h。回折（遮音壁・のり肩）・地表面効果・反射・建物による減衰、高架・掘割の構造は考慮していません。環境影響評価には所定の予測手法が必要です。</div>`
      : '<div class="muted small">計画交通量を入力するか、交通量の予測を計算すると、道路端の等価騒音レベル（昼・夜）と環境基準との比較が出ます。</div>');

    /* 災害リスク */
    const hz = st.hz.get(r.id), hzOk = hz && hz.key === A.key;
    h += sec('災害リスク（ハザードマップ）', `${Object.entries(HZ).map(([id, v]) => { const row = hzOk && hz.rows.find((x) => x.id === id); return `<label class="chk sd-hz" title="地図に重ねて表示"><input type="checkbox" data-key="sd.hz.${id}"${sd().hz[id] ? ' checked' : ''}><span>${v.name}</span><b class="${row && row.len > 1 ? 'bad' : ''}">${row ? (row.len > 1 ? `${n0(row.len)} m` : 'なし') : hzOk ? '取得不可' : ''}</b></label>${row && row.detail ? `<div class="muted small sd-hzd">${esc(row.detail)}</div>` : ''}`; }).join('')}
      <div class="row one" style="margin-top:6px"><button class="btn wide" data-act="sd-hazard"${st.hzBusy ? ' disabled' : ''}>${st.hzBusy ? '取得中…' : hzOk ? '通過延長を調べ直す' : '中心線が区域を通過する延長を調べる'}</button></div>
      <div class="muted small">国土交通省 ハザードマップポータルサイトのオープンデータ（タイル）を重ね、中心線が区域に入る延長を数えます。チェックを入れると地図に表示します。区域の指定・公表状況は地域によって異なるので、自治体のハザードマップ・土砂災害警戒区域等の告示で確認してください。</div>`);

    h += `<div class="sec"><div class="row"><button class="btn" data-act="sd-dock">${st.dock ? '比較表を閉じる' : '比較表を開く'}</button><button class="btn" data-act="sd-export" title="数量・事業費・交差・検討項目を CSV で保存">CSV で保存</button></div></div>`;
    return h + `<div class="note">地形（地理院 標高タイル）・建物外形（地理院 最適化ベクトルタイル）・読み込んだ既存道路をもとにした概略の検討です。住民合意・景観・文化財・法規制区域（用途地域・保安林・農用地など）のように機械的に計算できない項目は含みません。</div>`;
  }

  /* ───────── 比較表（地図の下） ───────── */
  function compare() {
    const list = roads(), cols = list.map((r) => {
      const A = fresh(r), al = calc(r), res = checksOf(r), pf = Geom.computeProfile(r.vips, al.length), Rs = al.curves.filter((c) => c && !c.none).map((c) => c.R);
      const o = { r, A, al, ne: res.filter((x) => x.level === 'error').length, nw: res.filter((x) => x.level === 'warn').length, Rmin: Rs.length ? Math.min(...Rs) : null, gmax: pf ? Math.max(...pf.grades.map((g) => Math.abs(g))) * 100 : null, pq: planQ(r) };
      if (A) { o.c = costOf(r, A); o.X = crossOf(r, A); o.rv = reviewOf(r, A); o.nz = noiseOf(r); }
      const s = setting(); if (s.alt || list.length === 1) { const b = bcOf(r); if (b && b.r) o.bc = b; }
      return o;
    });
    const row = (name, f, unit = '') => [name + (unit ? ` [${unit}]` : ''), ...cols.map((o) => { try { const v = f(o); return v == null ? '—' : v; } catch (e) { return '—'; } })];
    const need = (o) => (o.A ? o : null);
    const rows = [
      row('延長', (o) => fmt(o.al.length, 0), 'm'), row('区分・設計速度', (o) => `${Rules.CLASSES[o.r.cls].name}・${o.r.V}km/h`), row('車線・全幅', (o) => `${o.r.lanes} 車線・${fmt(Rules.totalWidth(o.r), 2)}m`),
      row('最小曲線半径', (o) => (o.Rmin == null ? '—' : fmt(o.Rmin, 0)), 'm'), row('最急縦断勾配', (o) => (o.gmax == null ? '縦断計画なし' : fmt(o.gmax, 2)), '%'),
      row('照査（不適合／要確認）', (o) => `${o.ne} ／ ${o.nw}`), row('検討項目（不適合／要確認）', (o) => need(o) && `${o.rv.filter((x) => x.level === 'error').length} ／ ${o.rv.filter((x) => x.level === 'warn').length}`),
      row('切土', (o) => need(o) && n0(o.A.ew.cutV), 'm³'), row('盛土', (o) => need(o) && n0(o.A.ew.fillV), 'm³'), row('不足土／残土', (o) => need(o) && `${n0(o.A.ew.borrow)} ／ ${n0(o.A.ew.surplus)}`, 'm³'),
      row('橋梁延長', (o) => need(o) && n0(o.A.ew.bridgeLen), 'm'), row('用地面積', (o) => need(o) && n0(o.A.ew.rowA), 'm²'), row('用地にかかる建物', (o) => need(o) && (o.A.hits ? `${o.A.hits.n} 棟` : '—')),
      row('平面交差／立体交差', (o) => need(o) && `${o.X.list.filter((x) => x.type === 'grade').length} ／ ${o.X.list.filter((x) => ['over', 'under', 'sepex'].includes(x.type)).length}`), row('高さが合わない交差', (o) => need(o) && o.X.list.filter((x) => x.type === 'conflict').length),
      row('概算事業費', (o) => need(o) && yen(o.c.total)), row('うち用地費・補償費', (o) => need(o) && yen(o.c.land + o.c.comp)),
      row('計画交通量', (o) => (o.pq.q > 0 ? n0(o.pq.q) : '—'), '台/日'), row('道路端の騒音 昼／夜', (o) => o.nz && `${fmt(o.nz.at.day, 0)} ／ ${fmt(o.nz.at.night, 0)}`, 'dB'),
    ];
    if (cols.some((o) => o.bc)) rows.push(row('総便益 B（現在価値）', (o) => o.bc && yen(o.bc.r.B)), row('総費用 C（現在価値）', (o) => o.bc && yen(o.bc.r.C)), row('B/C', (o) => o.bc && fmt(o.bc.r.bc, 2)), row('純現在価値 B − C', (o) => o.bc && yen(o.bc.r.npv)));
    return { head: ['項目', ...list.map((r) => r.name)], rows, pending: cols.some((o) => !o.A) };
  }
  function renderDock() {
    const el = $('#vdock'), on = st.on && st.dock;
    if (el.hidden === on) { el.hidden = !on; $('#stage').classList.toggle('dock-on', on); map.invalidateSize({ pan: false }); }
    if (!on) { if (st.on) el.innerHTML = ''; return; }
    const t = compare(), cur = curRoad(), list = roads(), s = setting();
    el.innerHTML = `<div class="vd-head"><b>比較表</b><span class="muted small vd-hint">計画道路どうしを同じ項目で比べます${list.length > 1 && !s.alt ? '（B/C を路線ごとに出すには、右パネルの「計画道路を比較案として 1 路線ずつ評価」をオン）' : ''}${t.pending ? ' ・ 計算中の路線があります' : ''}</span>
      <button class="btn" data-act="sd-export-cmp" title="比較表を CSV で保存">CSV で保存</button><button class="ibtn" data-act="sd-dock" title="閉じる">✕</button></div>
      <div class="tr-scroll">${list.length ? `<table class="els vtbl sd-cmp"><thead><tr>${t.head.map((c, i) => `<th${i && list[i - 1] === cur ? ' class="cur"' : ''}>${i ? `<button data-act="sd-pick" data-id="${list[i - 1].id}">${esc(c)}</button>` : c}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr>${r.map((c, i) => `<td${i && list[i - 1] === cur ? ' class="cur"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="xs-empty muted">計画道路がありません</div>'}</div>`;
  }

  /* ───────── 書き出し ───────── */
  const q = (v) => `"${String(v ?? '').replace(/<[^>]+>/g, '').replace(/"/g, '""')}"`;
  function exportCsv(cmpOnly) {
    const t = compare(), rows = [t.head.map(q).join(','), ...t.rows.map((r) => r.map(q).join(','))];
    if (!cmpOnly) for (const r of roads()) {
      const A = fresh(r); if (!A) continue;
      const c = costOf(r, A), X = crossOf(r, A);
      rows.push('', q(r.name), ['[概算事業費]', '数量', '単位', '単価(円)', '金額(円)'].join(','), ...c.items.map((i) => [q(i.name), Math.round(i.qty), q(i.unit.replace('円/', '')), i.price, Math.round(i.amount)].join(',')),
        ['諸経費', '', '', '', Math.round(c.misc)].join(','), ['測量設計費', '', '', '', Math.round(c.survey)].join(','), ['合計', '', '', '', Math.round(c.total)].join(','),
        ['[交差・接続]', '測点(m)', '交差角(°)', '計画高(m)', '交差道路の路面高(m)', '高低差(m)', '形', '交差道路の幅員(m)'].join(','), ...X.list.map((x) => [q(x.name), fmt(x.s, 1), fmt(x.ang, 1), fmt(x.z, 2), fmt(x.g, 2), x.auto ? '' : fmt(x.dz, 2), XTYPE[x.type][0], fmt(x.width, 1)].join(',')),
        ['[土工（測点ごと）]', '測点(m)', '切盛高(m) +盛/-切', '切土断面積(m2)', '盛土断面積(m2)', '左の幅(m)', '右の幅(m)', '橋梁'].join(','), ...A.ew.rows.map((e) => ['', fmt(e.s, 1), fmt(e.h, 2), fmt(e.cut, 2), fmt(e.fill, 2), fmt(e.wl, 2), fmt(e.wr, 2), e.bridge ? '○' : ''].join(',')),
        ['[検討項目]', '判定', '項目', '内容', '根拠'].join(','), ...reviewOf(r, A).map((x) => ['', LV[x.level], q(x.title), q(x.detail), q(x.ref)].join(',')));
    }
    download(`${project.name}_${cmpOnly ? '比較表' : '計画検討'}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
  }
  /* PDF 用: 計画検討のページ（計算済みの道路だけ） */
  function report(tbl) {
    const list = roads().filter(fresh); if (!list.length) return '';
    const t = compare();
    let h = `<div class="pg txt"><h1>計画検討<span>比較表</span></h1>${tbl(t.head.map(esc), t.rows)}
      <p class="sm">土工量は現況地盤（地理院 標高タイル）と 盛土 1:1.5／切土 1:1.0 ののり面による平均断面法の概算、用地は のり尻・のり肩＋余裕幅 ${fmt(setting().margin, 1)}m、建物は国土地理院 最適化ベクトルタイルの外形、概算事業費は画面で設定した単価（仮の値を含む）による。</p></div>`;
    for (const r of list) {
      const A = fresh(r), c = costOf(r, A), X = crossOf(r, A), items = reviewOf(r, A), bc = bcOf(r), ew = A.ew;
      h += `<div class="pg txt"><h1>${esc(r.name)} 計画検討</h1>
        <h2>土工・用地</h2>${tbl(['切土 (m³)', '盛土 (m³)', '流用 (m³)', '不足土 (m³)', '残土 (m³)', '橋梁', '用地面積 (m²)', '用地にかかる建物'], [[n0(ew.cutV), n0(ew.fillV), n0(ew.reuse), n0(ew.borrow), n0(ew.surplus), ew.bridges.length ? `${ew.bridges.length} か所・${n0(ew.bridgeLen)} m` : 'なし', n0(ew.rowA), A.hits ? `${A.hits.n} 棟・${n0(A.hits.area)} m²` : '—']])}
        <h2>概算事業費（${yen(c.total)}）</h2>${tbl(['項目', '数量', '単位', '単価 (円)', '金額'], c.items.filter((i) => i.qty > 0.5).map((i) => [esc(i.name), n0(i.qty), i.unit.replace('円/', ''), n0(i.price), yen(i.amount)]).concat([['諸経費', '', '', '', yen(c.misc)], ['測量設計費', '', '', '', yen(c.survey)]]))}
        ${X.list.length ? `<h2>交差・接続</h2>${tbl(['測点 (m)', '交差する道路', '交差角', '高低差 (m)', '形'], X.list.map((x) => [fmt(x.s, 1), esc(x.name || '—') + (x.end ? '（端点）' : ''), fmt(x.ang, 1) + '°', x.auto || x.end ? '—' : fmt(x.dz, 2), XTYPE[x.type][0]]))}` : ''}
        ${bc && bc.r ? `<h2>費用便益分析（${bc.alt ? 'この路線だけを整備' : bc.n > 1 ? `計画道路 ${bc.n} 路線を一体で評価` : '整備あり・なし'}）</h2>${tbl(['走行時間短縮便益', '走行経費減少便益', '交通事故減少便益', '総便益 B', '事業費', '維持管理費', '総費用 C', 'B/C', 'B − C', 'EIRR'], [[yen(bc.r.Bt), yen(bc.r.Br), yen(bc.r.Ba), yen(bc.r.B), yen(bc.r.Cc), yen(bc.r.Cm), yen(bc.r.C), fmt(bc.r.bc, 2), yen(bc.r.npv), bc.r.eirr == null ? '—' : bc.r.eirr === Infinity ? '100% 超' : fmt(bc.r.eirr * 100, 1) + '%']])}
          <p class="sm">${S.BC.source}（${S.BC.price}）。割引率 ${fmt(setting().rate, 1)}%・検討年数 50 年・事業期間 ${bc.r.years} 年。感度分析: ${bc.sens.map((x) => `${x.name} ${x.note} → ${fmt(x.lo, 2)}〜${fmt(x.hi, 2)}`).join('、')}。読み込んだ範囲の道路だけで作る簡易な交通量予測に基づく。</p>` : ''}
        <h2>検討項目（不適合 ${items.filter((x) => x.level === 'error').length}・要確認 ${items.filter((x) => x.level === 'warn').length}）</h2>
        ${tbl(['判定', '項目', '内容', '根拠'], ['error', 'warn', 'info', 'ok'].flatMap((l) => items.filter((x) => x.level === l)).map((x) => [`<span class="lv ${x.level}">${LV[x.level]}</span>`, esc(x.title), esc(x.detail), esc(x.ref)]))}</div>`;
    }
    return h;
  }

  /* ───────── 操作 ───────── */
  function toggle(on) {
    st.on = on == null ? !st.on : on;
    if (st.on && TrafficUI.isOn()) TrafficUI.toggle(false); // 交通量の画面とは同時に開かない
    document.body.classList.toggle('study-on', st.on);
    if (st.on && ui.tool !== 'select') setTool('select');
    render(); renderPanels(); schedule(); setTimeout(() => map.invalidateSize({ pan: false }), 0);
  }
  function setValue(key, raw) {
    const k = key.slice(3), v = parseFloat(raw), r = curRoad(), s = sd();
    if (k === 'road') return select({ type: 'road', id: raw });
    if (k.startsWith('set.')) {
      const f = k.slice(4), lim = { margin: [0, 20], C: [0.5, 1.5], rate: [0, 20], years: [1, 40], maint: [0, 1e6], small: [0, 100], night: [0, 60] };
      s.set = Object.assign({}, s.set);
      if (lim[f]) { if (!isFinite(v)) return renderPanels(); s.set[f] = Math.max(lim[f][0], Math.min(lim[f][1], v)); } else s.set[f] = !!raw;
      save(); render(); renderPanels(); return schedule();
    }
    if (k.startsWith('cost.')) { if (isFinite(v) && v >= 0) { s.cost = Object.assign({}, s.cost, { [k.slice(5)]: v }); save(); } return renderPanels(); }
    if (k.startsWith('hz.')) { s.hz = Object.assign({}, s.hz, { [k.slice(3)]: !!raw }); save(); initMap(); syncHazardLayers(); return renderPanels(); }
    if (k.startsWith('r.') && r) {
      const f = k.slice(2);
      if (f === 'qplan') { if (v > 0) r.qplan = Math.round(v); else delete r.qplan; }
      else if (f === 'nheavy') { if (raw === '' || !isFinite(v)) delete r.nheavy; else r.nheavy = Math.max(0, Math.min(80, v)); }
      else if (f === 'nsteady') r.nsteady = raw === '1';
      else if (f === 'rkind') r.rkind = raw;
      else if (f === 'terrain') r.terrain = raw === 'mount' ? 'mount' : 'flat';
      else r[f] = !!raw; // manyX, center
      return commit();
    }
  }
  function act(a, el) {
    switch (a) {
      case 'study': return toggle();
      case 'sd-traffic': return runTraffic();
      case 'sd-hazard': { const r = curRoad(); if (r) hazard(r); return; }
      case 'sd-dock': st.dock = !st.dock; return renderPanels();
      case 'sd-export': $('#exportMenu').hidden = true; if (!roads().length) return toast('書き出す計画道路がありません', 'err'); if (!roads().every(fresh)) { if (!st.on) toggle(true); return toast('計画検討の計算中です。計算が終わってから、もう一度「CSV で保存」を選んでください'); } return exportCsv(false);
      case 'sd-export-cmp': return exportCsv(true);
      case 'sd-cost-reset': sd().cost = {}; save(); return renderPanels();
      case 'sd-pick': return select({ type: 'road', id: el.dataset.id });
      case 'sd-goto': { const r = curRoad(), A = r && fresh(r); if (!A) return; const p = Geom.poseAt(A.al, +el.dataset.s), ll = P.toLL(p.x, p.y); map.setView(ll, Math.max(map.getZoom(), 17)); gHover.clearLayers(); L.circleMarker(ll, { radius: 9, color: '#f24822', weight: 3, fill: false, interactive: false, pane: 'labels' }).addTo(gHover); return; }
    }
  }

  return { st, toggle, panel, render, renderDock, setValue, act, schedule, report, isOn: () => st.on, dockOn: () => st.on && st.dock, reset() { st.A.clear(); st.tr = null; st.hz.clear(); st.exXY = null; st.drawSig = ''; } };
})();
