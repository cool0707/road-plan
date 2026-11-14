/* Road Plan — 交通量の予測: 画面（地図の色分け・右パネル・データ表・データの取得と取り込み）
 * 計算は js/traffic.js。ここでは既存道路・計画道路をネットワークに渡し、結果を描く。
 * 値の区別: 実データ（実測・常時観測・センサス実測・自治体調査）＝実線 / 推定（センサスの非観測区間・属性からの推定・準用）＝破線 /
 *           予測（配分計算の結果）＝中央に白い点線。表では「実」「推」「予」の印を付ける */
'use strict';

const TrafficUI = (() => {
  const T = Traffic;
  const st = { on: false, view: 'base', color: 'vc', net: null, sig: '', res: null, resSig: '', runMs: 0, sel: null, dock: false, showCensus: false, drawSig: '', timer: 0, censusIndex: null, censusTiles: new Map(), focus: null };
  const DIFF = [{ max: -0.3, color: '#184f95', name: '30% 以上の減少' }, { max: -0.05, color: '#5598e7', name: '5〜30% の減少' }, { max: 0.05, color: '#a3a29b', name: 'ほぼ変化なし（±5%）' }, { max: 0.3, color: '#e2571f', name: '5〜30% の増加' }, { max: Infinity, color: '#a11d17', name: '30% 以上の増加' }];
  const PLAN_COLOR = '#6250d6';
  const VIEWS = { base: '現況データ', before: '整備なし', after: '整備あり', diff: '差' };
  const n0 = (v) => (v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString('ja-JP'));
  const nr = (v) => (v == null || !isFinite(v) ? '—' : n0(v >= 10000 ? Math.round(v / 100) * 100 : v >= 1000 ? Math.round(v / 10) * 10 : v)); // 予測・推定は丸めて表示
  const pct = (a, b) => (b > 0 ? `${a >= b ? '+' : '−'}${fmt(Math.abs((a / b - 1) * 100), 1)}%` : '—');
  const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  const compass = (az) => COMPASS[Math.round((((az % 360) + 360) % 360) / 45) % 8] + '行き';
  const azOf = (dx, dy) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

  /* ───────── 状態 ───────── */
  function tr() {
    if (!project.traffic) project.traffic = { set: {}, obs: [], edits: {} };
    const t = project.traffic; t.set = t.set || {}; t.obs = t.obs || []; t.edits = t.edits || {};
    return t;
  }
  const setting = () => Object.assign({}, T.DEFAULTS, tr().set);
  const period = () => setting().period;
  const unit = () => T.PERIODS[period()].unit;
  /* 観測データは書き換えず、変更のたびに新しい配列・新しい要素にする（Undo は配列の参照を持つ） */
  function setObs(id, patch) { const t = tr(); t.obs = t.obs.map((o) => (o.id === id ? Object.assign({}, o, typeof patch === 'function' ? patch(o) : patch) : o)); }
  const obsById = (id) => tr().obs.find((o) => o.id === id);

  /* ───────── ネットワーク ───────── */
  function signature() {
    const t = tr(), s = setting();
    return [project.roads.map((r) => [r.id, JSON.stringify(r.ips), r.lanes, r.cls, r.V, r.visible, r.tv, r.tcross, r.name].join()).join(';'), project.existing.length, project.origin && project.origin.lat, JSON.stringify(t.edits), s.area, s.crossPlanned, s.scope, s.motorway, s.alpha, s.beta].join('|');
  }
  let exRef = null, obsRef = null;
  function ensureNet() {
    if (st.net && ui.dragging) return st.net; // IP のドラッグ中は作り直さない
    const sig = signature(), t = tr();
    if (st.net && st.sig === sig && exRef === project.existing && obsRef === t.obs) return st.net;
    const net = makeNet(null);
    st.net = net; st.sig = sig; exRef = project.existing; obsRef = t.obs; st.res = null; st.drawSig = '';
    return net;
  }
  /* 既存道路と計画道路からネットワークを作る。only（計画道路の id の Set）を渡すと、その計画道路だけを入れる */
  function makeNet(only) {
    const t = tr(), roads = [], s0 = setting(), minRank = { all: 0.5, main: 1, arterial: 2 }[s0.scope] || 1, extra = [];
    const withMw = !!s0.motorway || project.roads.some((r) => r.visible !== false && T.planKind(r) === 'mw'); // 高速道路は、含める設定か計画道路が自動車専用のときだけ
    for (const ex of project.existing) {
      const kind = T.kindOf(ex.cls, ex.width); if (kind === 'sv' || (kind === 'mw' && !withMw)) continue; // 敷地内通路・農道は対象外
      if (T.KIND_RANK[kind] < minRank) { // 対象外の細い道路: 域内の発生量の計算にだけ延長を使う
        if (T.KIND_RANK[kind] <= 2) { const xy = ex.pts.map((p) => P.toXY(p)); let len = 0; for (let i = 1; i < xy.length; i++) len += Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y); const m = xy[xy.length >> 1]; extra.push({ x: m.x, y: m.y, len }); }
        continue;
      }
      roads.push({ id: ex.id, xy: ex.pts.map((p) => P.toXY(p)), kind, lanes: ex.lanes || 0, speed: ex.speed, speedEst: ex.speedEst, oneway: ex.oneway ? 1 : 0, name: ex.name, width: ex.width, sep: !!ex.sep });
    }
    for (const r of project.roads) {
      if (r.visible === false || (only && !only.has(r.id))) continue;
      const sm = calc(r).samples; if (sm.length < 2) continue;
      const xy = []; sm.forEach((p, i) => { const l = xy[xy.length - 1]; if (!l || i === sm.length - 1 || Math.hypot(p.x - l.x, p.y - l.y) >= 8) xy.push({ x: p.x, y: p.y }); });
      roads.push({ id: r.id, xy, kind: T.planKind(r), lanes: r.lanes, speed: r.V, oneway: 0, name: r.name, width: Rules.carriage(r), planned: true, cross: r.tcross !== false, tv: r.tv || 0 });
    }
    const s = setting(), net = T.buildNetwork(roads, { crossPlanned: s.crossPlanned });
    const obs = t.obs.map((o) => Object.assign({}, o, {
      p: o.pt ? P.toXY(o.pt) : null, av: o.az == null ? null : { x: Math.sin((o.az * Math.PI) / 180), y: Math.cos((o.az * Math.PI) / 180) },
      ls: o.lines ? o.lines.map((l) => { const a = []; for (let i = 0; i < l.length; i += 2) a.push(P.toXY([l[i], l[i + 1]])); return a; }) : null,
    }));
    T.prepare(net, obs, { area: +s.area || 0, edits: t.edits, alpha: s.alpha, beta: s.beta });
    net.edges.forEach((e) => { e.ll = e.pts.map((p) => P.toLL(p[0], p[1])); });
    net.byKey = new Map(net.edges.map((e, i) => [e.key, i]));
    net.obsInfo = new Map(obs.map((o) => [o.id, { unmatched: !!o.unmatched, dirUnknown: !!o.dirUnknown, edgeKey: o.edgeKey }]));
    T.baseVolumes(net, s.period);
    net.extraLocal = extra;
    return net;
  }
  /* 計画検討（費用便益分析など）用: 日交通量で整備なし・ありを計算する。画面の表示中のネットワーク・結果には触れない。
   * only = 整備する計画道路の id の配列（省略で表示中のすべて）。戻り値 { net, res } */
  function forecastDay(only) {
    const net = makeNet(only ? new Set(only) : null);
    if (!net.edges.length) return { net, res: null };
    return { net, res: T.run(net, Object.assign(setting(), { period: 'day', extraLocal: net.extraLocal })) };
  }
  /* forecastDay の結果が古くなったかを見るための署名 */
  const daySig = () => signature() + '#' + JSON.stringify(Object.assign(setting(), { period: 'day' })) + '#' + project.existing.length + '#' + tr().obs.length;
  const runSig = () => st.sig + '#' + JSON.stringify(setting());
  const stale = () => !st.res || st.resSig !== runSig();
  function compute() {
    const net = ensureNet();
    if (!net.edges.length) { st.res = null; return; }
    const t0 = performance.now();
    st.res = T.run(net, Object.assign(setting(), { extraLocal: net.extraLocal })); st.resSig = runSig(); st.runMs = performance.now() - t0; st.drawSig = '';
    if (st.res.failed && (st.view !== 'base')) st.view = 'base';
  }
  /* 設定やデータが変わったら計算し直す。重いネットワークではボタンを押したときだけ */
  function schedule(force) {
    clearTimeout(st.timer);
    if (!st.on || ui.dragging) return;
    ensureNet();
    if (!stale()) return;
    if (!force && st.runMs > 1500) return;
    st.timer = setTimeout(() => { if (!st.on) return; const el = st.runMs > 400 ? toast('交通量を計算中…', 'busy') : null; setTimeout(() => { try { compute(); } finally { if (el) el.remove(); } render(); renderPanels(); }, el ? 30 : 0); }, force ? 0 : 250);
  }

  /* ───────── 地図 ───────── */
  let pane = null, renderer = null, group = null, gSel = null, gObs = null, tip = null;
  function initMap() {
    if (pane) return;
    pane = map.createPane('traffic'); pane.style.zIndex = 380;
    renderer = L.canvas({ pane: 'traffic', tolerance: 6 });
    group = L.featureGroup().addTo(map); gSel = L.layerGroup().addTo(map); gObs = L.layerGroup().addTo(map);
    tip = L.tooltip({ sticky: true, direction: 'top', offset: [0, -6], className: 'tr-tip', pane: 'labels' });
    group.on('mouseover', (e) => { const i = e.layer._ei; if (i == null) return; tip.setLatLng(e.latlng).setContent(edgeTip(i)); map.openTooltip(tip); });
    group.on('mousemove', (e) => { if (e.layer._ei != null) tip.setLatLng(e.latlng); });
    group.on('mouseout', () => map.closeTooltip(tip));
    group.on('click', (e) => {
      const i = e.layer._ei; if (i == null || (ui.tool !== 'tobs' && ui.tool !== 'select')) return; // 作図・計測などのツール中は地図のクリックとして扱う
      L.DomEvent.stopPropagation(e);
      if (ui.tool === 'tobs') return addObsAt(e.latlng, i);
      st.sel = st.net.edges[i].key; st.at = e.latlng; render(); renderPanels();
    });
  }
  /* リンク e の表示値: 両方向の交通量・方向別の混雑度の大きい方・値の種別 */
  function edgeView(i, view) {
    const net = st.net, e = net.edges[i], r = st.res, g = r && !r.failed ? r.g : null;
    const capOf = (d) => (g ? g.cap[2 * i + d] : (e.cap12 * T.periodScale(period(), e.fac)) / (e.oneway ? 1 : 2));
    const okd = (d) => !(d === 0 ? e.oneway < 0 : e.oneway > 0);
    const pack = (va, vb, kind) => ({ v: [va, vb], vol: (va || 0) + (vb || 0), vc: Math.max(okd(0) ? (va || 0) / capOf(0) : 0, okd(1) ? (vb || 0) / capOf(1) : 0), kind, cap: [capOf(0), capOf(1)] });
    if (view === 'base') {
      if (e.planned) return null;
      const order = { real: 2, est: 1, attr: 0 }, k = Math.min(order[e.bst[0]] ?? 0, order[e.bst[1]] ?? 0);
      return pack(e.base[0], e.base[1], k === 2 ? 'real' : 'est');
    }
    if (!g) return null;
    const c = view === 'before' ? r.before : r.after;
    if (view === 'before' && e.planned) return null;
    return pack(c.x[2 * i], c.x[2 * i + 1], 'pred');
  }
  function render() {
    if (!st.on) { if (group) { group.clearLayers(); gSel.clearLayers(); gObs.clearLayers(); } return; }
    initMap();
    const net = ensureNet(), r = st.res && !st.res.failed ? st.res : null;
    if (st.view !== 'base' && !r) st.view = 'base';
    const sig = [st.sig, st.resSig, !!r, st.view, st.color, period(), obsRef && obsRef.length, map.getZoom() >= 15].join('#');
    if (sig !== st.drawSig) {
      st.drawSig = sig; group.clearLayers(); gObs.clearLayers();
      let vmax = 1;
      net.edges.forEach((e, i) => { for (const v of ['base', 'before', 'after']) { const q = edgeView(i, v); if (q) vmax = Math.max(vmax, q.vol); } });
      st.vmax = vmax;
      const order = net.edges.map((_, i) => i).sort((a, b) => T.KIND_RANK[net.edges[a].kind] - T.KIND_RANK[net.edges[b].kind]); // 幹線を上に
      for (const i of order) {
        const e = net.edges[i];
        let color, w, dash = null, kind, op = 1;
        if (st.view === 'diff') {
          const b = edgeView(i, 'before'), a = edgeView(i, 'after'); if (!a) continue;
          if (e.planned) { color = PLAN_COLOR; w = 2 + 8 * Math.sqrt(a.vol / vmax); }
          else { const d = a.vol - b.vol, rel = Math.abs(d) < vmax * 0.004 ? 0 : d / Math.max(b.vol, 1); color = DIFF.find((c) => rel < c.max).color; w = 1.5 + 9 * Math.sqrt(Math.abs(d) / vmax); if (rel === 0) op = 0.7; }
          kind = 'pred';
        } else {
          const q = edgeView(i, st.view); if (!q) continue;
          color = st.color === 'vc' ? T.congestionOf(q.vc).color : volColor(q.vol / vmax);
          w = 1.5 + 8 * Math.sqrt(q.vol / vmax); kind = q.kind;
          if (kind === 'est') { dash = `${Math.max(6, w * 2)} ${Math.max(5, w * 1.4)}`; op = 0.9; }
        }
        const base = { renderer, pane: 'traffic', smoothFactor: 0.5, lineJoin: 'round' };
        if (w >= 3.5 && !dash) L.polyline(e.ll, { ...base, color: '#fff', weight: w + 2, opacity: 0.9, interactive: false, lineCap: 'butt' }).addTo(group);
        const pl = L.polyline(e.ll, { ...base, color, weight: w, opacity: op, dashArray: dash, lineCap: dash ? 'butt' : 'round' }).addTo(group); pl._ei = i;
        if (kind === 'pred' && w >= 3) L.polyline(e.ll, { ...base, color: '#fff', weight: Math.max(1, w * 0.22), opacity: 0.95, dashArray: '1 7', lineCap: 'round', interactive: false }).addTo(group);
      }
      drawObs(net);
    }
    gSel.clearLayers();
    const si = st.sel != null ? net.byKey.get(st.sel) : null;
    if (si != null) { L.polyline(net.edges[si].ll, { pane: 'traffic', renderer, color: '#0b0b0b', weight: 14, opacity: 0.22, interactive: false }).addTo(gSel); arrows(net.edges[si]); }
  }
  const SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const volColor = (f) => SEQ[Math.min(SEQ.length - 1, Math.floor(Math.sqrt(Math.max(0, f)) * SEQ.length))];
  /* 選択中のリンクの両端に方向（A・B）を示す */
  function arrows(e) {
    const mk = (s, txt) => { const q = T.pointAt(e, s); label(P.toLL(q.x, q.y), txt, 'tr-dir', [10, 10]).addTo(gSel); };
    const az = azOf(e.pts[e.pts.length - 1][0] - e.pts[0][0], e.pts[e.pts.length - 1][1] - e.pts[0][1]);
    if (e.len > 30) { mk(e.len * 0.8, '→ ' + compass(az)); mk(e.len * 0.2, '← ' + compass(az + 180)); }
  }
  /* 観測地点の印: 実測 ●、常時観測 ■、自治体等 ◆。道路に割り当てられないものは中抜き */
  function drawObs(net) {
    for (const o of tr().obs) {
      if (!o.pt) continue;
      const info = net.obsInfo.get(o.id) || {}, cls = `tr-ob ${o.src}${o.off ? ' off' : ''}${info.unmatched ? ' un' : ''}${st.focus === o.id ? ' sel' : ''}`;
      L.marker(o.pt, { icon: L.divIcon({ className: cls, iconSize: [14, 14] }), title: `${T.SOURCES[o.src].short}: ${o.name || ''}${info.unmatched ? '（近くに道路がありません）' : ''}`, draggable: o.src === 'field', bubblingMouseEvents: false })
        .on('click', () => { st.dock = true; st.focus = o.id; if (info.edgeKey) st.sel = info.edgeKey; st.drawSig = ''; render(); renderPanels(); })
        .on('dragend', (ev) => { const ll = ev.target.getLatLng(); setObs(o.id, { pt: [+ll.lat.toFixed(6), +ll.lng.toFixed(6)] }); commit(); })
        .addTo(gObs);
    }
  }
  const stMark = (k, conv) => `<i class="tr-st ${k}" title="${{ real: '実データ（観測値）', est: '推定値（センサスの非観測区間・隣の区間の値の準用・両方向の値の等分）', attr: '推定値（道路種別・車線数・沿道状況から）', pred: '予測値（配分計算）' }[k]}${conv ? '・別の時間帯の値から換算' : ''}">${{ real: '実', est: '推', attr: '推', pred: '予' }[k]}${conv ? '換' : ''}</i>`;
  function edgeTip(i) {
    const e = st.net.edges[i], b = edgeView(i, 'base'), x0 = edgeView(i, 'before'), x1 = edgeView(i, 'after');
    const row = (name, q, mark) => (q ? `<tr><td>${name}</td><td>${mark}</td><td>${q.kind === 'real' ? n0(q.vol) : nr(q.vol)}</td><td>${fmt(q.vc, 2)}</td></tr>` : '');
    return `<b>${esc(e.name || T.KIND_JA[e.kind])}</b>${e.planned ? '（計画道路）' : ''}<span class="mu">${e.lanesEff}車線・${T.PERIODS[period()].short}</span>
      <table><tr><th></th><th></th><th>両方向 ${unit()}</th><th>混雑度</th></tr>${b ? row('現況', b, stMark(e.bst.includes('attr') ? 'attr' : b.kind)) : ''}${row('整備なし', x0, stMark('pred'))}${row('整備あり', x1, stMark('pred'))}</table>`;
  }

  /* ───────── 右パネル ───────── */
  const seg = (key, val, opts) => `<div class="tr-seg">${opts.map(([v, t, dis]) => `<button data-act="tr-set" data-k="${key}" data-v="${v}" class="${String(v) === String(val) ? 'on' : ''}"${dis ? ' disabled' : ''}>${t}</button>`).join('')}</div>`;
  function panel() {
    const net = ensureNet(), s = setting(), r = st.res && !st.res.failed ? st.res : null, t = tr();
    const head = `<div class="tr-head"><b>交通量の予測</b><span class="muted">${net.edges.length ? `リンク ${n0(net.edges.length)}・交差点 ${n0(net.nodes.length)}` : ''}</span><button class="ibtn" data-act="traffic" title="交通量の表示を閉じる">✕</button></div>`;
    if (!net.edges.length) return head + `<div class="note">既存道路がまだありません。左パネルの <b>OSM から取得</b> または <b>地理院から取得</b> で、計画道路のまわりの道路（迂回路になりうる範囲まで）を読み込んでください。</div>`;
    let h = head;
    if (stale() && st.runMs > 1500) h += `<div class="tr-stale"><span>設定・データが変わりました</span><button class="btn accent" data-act="tr-run">予測を計算</button></div>`;
    h += sec('表示', `${seg('view', st.view, [['base', '現況データ'], ['before', '整備なし', !r], ['after', '整備あり', !r], ['diff', '差', !r || !r.hasPlan]])}
      <div class="row one" style="margin-top:6px">${sel('時間帯', 'tr.period', s.period, Object.entries(T.PERIODS).map(([k, p]) => [k, p.name]))}</div>
      ${st.view === 'diff' ? '' : `<div class="row one">${sel('色分け', 'tr.color', st.color, [['vc', '混雑度（交通量 ÷ 交通容量）'], ['vol', '交通量']])}</div>`}${legend()}`);
    if (st.sel != null && net.byKey.has(st.sel)) h += linkCard(net.byKey.get(st.sel));
    if (st.res && st.res.warn.length) h += `<div class="tr-warn">${st.res.warn.map(esc).join('<br>')}</div>`;
    if (r) h += resultSec(r);
    h += dataSec(t, net) + methodSec(s);
    return h + `<div class="note">予測は、読み込んだ範囲の道路だけで作る簡易な需要予測です（需要固定。誘発交通・公共交通への転換・信号制御は扱いません）。交通容量と換算係数は令和3年度 全国道路・街路交通情勢調査の全国集計から求めた値で、事業評価には交通量調査と道路管理者の基準による検討が別途必要です。</div>`;
  }
  function legend() {
    const sw = (c, t) => `<span><i style="background:${c}"></i>${t}</span>`;
    const bins = st.view === 'diff' ? DIFF.map((c) => sw(c.color, c.name)).join('') + sw(PLAN_COLOR, '計画道路') : st.color === 'vc' ? T.CONGESTION.map((c) => sw(c.color, '混雑度 ' + c.name)).join('') : `<span><i class="ramp" style="background:linear-gradient(90deg,${SEQ.join(',')})"></i>交通量 少 → 多（最大 ${nr(st.vmax)} ${unit()}）</span>`;
    return `<div class="tr-legend">${bins}</div><div class="tr-legend ln"><span><i class="l-real"></i>実データ</span><span><i class="l-est"></i>推定</span><span><i class="l-pred"></i>予測（配分計算）</span><span class="muted">太さ = ${st.view === 'diff' ? '増減の大きさ' : '交通量'}</span></div>`;
  }
  function linkCard(i) {
    const net = st.net, e = net.edges[i], ed = tr().edits[e.key] || {}, r = st.res && !st.res.failed ? st.res : null, g = r && r.g;
    const az = azOf(e.pts[e.pts.length - 1][0] - e.pts[0][0], e.pts[e.pts.length - 1][1] - e.pts[0][1]), dn = [compass(az), compass(az + 180)];
    const cap = (d) => (g ? g.cap[2 * i + d] : (e.cap12 * T.periodScale(period(), e.fac)) / (e.oneway ? 1 : 2)), okd = (d) => !(d === 0 ? e.oneway < 0 : e.oneway > 0);
    const udName = (d) => { const c = e.ob; if (!c || !c.o.ud || c.unknown) return ''; return (c.sign > 0) === (d === 0) ? '・下り' : '・上り'; };
    let rows = '';
    for (let d = 0; d < 2; d++) {
      if (!okd(d)) continue;
      const b = e.planned ? null : e.base[d], x0 = r && !e.planned ? r.before.x[2 * i + d] : null, x1 = r ? r.after.x[2 * i + d] : null, c = cap(d);
      const piv = e.bst[d] === 'real' && x0 != null && r.hasPlan ? Math.max(0, b * (r.params.growth || 1) + (x1 - x0)) : null;
      rows += `<tr><th colspan="5">${dn[d]}${udName(d)}</th></tr>
        ${b != null ? `<tr><td>現況</td><td>${stMark(e.bst[d], e.bconv[d])}</td><td>${e.bst[d] === 'real' && !e.bconv[d] ? n0(b) : nr(b)}</td><td>${fmt(b / c, 2)}</td><td></td></tr>` : ''}
        ${x0 != null ? `<tr><td>整備なし</td><td>${stMark('pred')}</td><td>${nr(x0)}</td><td>${fmt(x0 / c, 2)}</td><td></td></tr>` : ''}
        ${x1 != null ? `<tr><td>整備あり</td><td>${stMark('pred')}</td><td>${nr(x1)}</td><td>${fmt(x1 / c, 2)}</td><td class="${x0 != null && x1 < x0 ? 'dn' : 'up'}">${x0 != null ? pct(x1, x0) : ''}</td></tr>` : ''}
        ${piv != null ? `<tr title="実測値に、配分計算の差（整備あり − 整備なし）を足した値"><td>実測＋差</td><td>${stMark('pred')}</td><td>${nr(piv)}</td><td>${fmt(piv / c, 2)}</td><td></td></tr>` : ''}`;
    }
    const src = { edit: '手入力', census: 'センサス', data: '道路データ', guess: '種別・幅員から推定', model: '全国の中央値', near: '近くのセンサス区間', set: '既定値', density: '道路密度から推定' };
    const cands = e.cands.map((c, k) => {
      const o = c.o, sides = c.sign > 0 ? [o.a, o.b] : [o.b, o.a], f = e.fac, val = (sd) => { const v = T.valueOf(sd, period(), f) || (T.hasData(o.both) ? (() => { const q = T.valueOf(o.both, period(), f); return q && { v: q.v / (e.oneway ? 1 : 2), conv: true }; })() : null); return v ? nr(v.v) + (v.conv ? '<sup>換</sup>' : '') : '—'; };
      return `<div class="tr-cand${k === 0 ? ' on' : ''}"><span class="tr-src ${o.src}${o.est ? ' est' : ''}">${T.SOURCES[o.src].short}${o.est ? '推定' : ''}</span><div><b>${esc(o.name || '')}</b>${c.how === 'spread' ? '（隣の区間の値を準用）' : ''}<span class="muted">${fmtDate(o.date)}　${dn[0]} ${val(sides[0])} ／ ${dn[1]} ${val(sides[1])}</span></div>
        ${k === 0 ? `<span class="muted small">採用中${o.pin ? '（固定）' : ''}</span>` : `<button class="btn xs" data-act="tr-pin" data-id="${o.id}" title="このデータを優先して使う">採用</button>`}${o.pin ? `<button class="btn xs" data-act="tr-unpin" data-id="${o.id}">固定を解除</button>` : ''}</div>`;
    }).join('');
    return sec(`${esc(e.name || T.KIND_JA[e.kind])}${e.planned ? '（計画道路）' : ''}`, `
      <table class="els tr-tbl"><tr><th>${T.PERIODS[period()].short}</th><th></th><th>${unit()}</th><th>混雑度</th><th>増減</th></tr>${rows}</table>
      ${kv([['種別・延長', `${T.KIND_JA[e.kind]}・${fmt(e.len, 0)} m${e.oneway ? '・一方通行' : ''}`], ['交通容量（方向別）', `${nr(cap(okd(0) ? 0 : 1))} ${unit()}<span class="muted">（${src[e.capSrc]}）</span>`],
      ['自由走行速度', `${fmt(e.v0[0], 0)}${e.v0[0] !== e.v0[1] ? ' / ' + fmt(e.v0[1], 0) : ''} km/h`], r && g ? ['所要時間 整備なし → あり', `${fmt(Math.max(r.before.t[2 * i], r.before.t[2 * i + 1]) * 60, 0)} → ${fmt(Math.max(r.after.t[2 * i], r.after.t[2 * i + 1]) * 60, 0)} 秒`] : null])}
      ${e.planned ? '' : `<div class="row" style="margin-top:8px"><label class="fld" title="両方向の合計。空欄で自動（${src[e.laneSrc]}: ${e.lanesEff}）"><span class="lb">車線数</span><input data-key="tr.edit.lanes" data-step="1" data-dec="0" value="${ed.lanes || ''}" placeholder="${e.lanesEff}（${src[e.laneSrc]}）" inputmode="decimal"></label>
        <label class="fld" title="沿道状況（地区の属性）。交通容量・換算係数・データの無い区間の交通量の推定に使います"><span class="lb">沿道</span><select data-key="tr.edit.area"><option value="">自動: ${T.AREAS[e.area]}（${src[e.areaSrc]}）</option>${Object.entries(T.AREAS).map(([k, v]) => `<option value="${k}"${+ed.area === +k ? ' selected' : ''}>${v}</option>`).join('')}</select></label></div>
      <div class="lgroup tr-sub"><span>この区間のデータ（精度の高い順）</span></div>${cands || '<div class="muted small">観測データはありません。道路種別・車線数・沿道状況から推定しています。</div>'}
      <div class="row one" style="margin-top:8px"><button class="btn" data-act="tr-measure" title="この区間に観測地点を置き、下の表で方向別の台数を入力します">この区間の実測値を入力</button></div>`}`,
      `<button class="ibtn" data-act="tr-desel" title="選択を解除">✕</button>`);
  }
  function resultSec(r) {
    const b = r.sum.before, a = r.sum.after, hp = r.hasPlan, pu = unit().replace('台/', '');
    const row = (name, vb, va, d, better) => `<tr><td>${name}</td><td>${vb}</td>${hp ? `<td>${va}</td><td class="${better == null ? '' : better ? 'dn' : 'up'}">${d}</td>` : ''}</tr>`;
    let h = `<table class="els tr-tbl"><tr><th>${stMark('pred')} ${T.PERIODS[r.period].short}</th><th>整備なし</th>${hp ? '<th>整備あり</th><th>増減</th>' : ''}</tr>
      ${row(`総走行時間 [台時/${pu}]`, nr(b.vht), nr(a.vht), pct(a.vht, b.vht), a.vht <= b.vht)}
      ${row(`損失時間 [台時/${pu}]`, nr(b.lost), nr(a.lost), pct(a.lost, b.lost), a.lost <= b.lost)}
      ${row('平均旅行速度 [km/h]', fmt(b.speed, 1), fmt(a.speed, 1), pct(a.speed, b.speed), a.speed >= b.speed)}
      ${row(`総走行台キロ [台km/${pu}]`, nr(b.vkt), nr(a.vkt), pct(a.vkt, b.vkt), null)}
      ${row('混雑度 1.0 以上の延長 [km]', fmt(b.cong / 1000, 2), fmt(a.cong / 1000, 2), `${a.cong <= b.cong ? '−' : '+'}${fmt(Math.abs(a.cong - b.cong) / 1000, 2)}`, a.cong <= b.cong)}
      ${row('混雑度 1.25 以上の延長 [km]', fmt(b.cong2 / 1000, 2), fmt(a.cong2 / 1000, 2), `${a.cong2 <= b.cong2 ? '−' : '+'}${fmt(Math.abs(a.cong2 - b.cong2) / 1000, 2)}`, a.cong2 <= b.cong2)}</table>`;
    if (!hp) h += `<div class="muted small" style="margin-top:6px">計画道路を描くと、整備あり・なしの比較が出ます。</div>`;
    else {
      h += `<div class="lgroup tr-sub"><span>計画道路の交通量（両方向）</span></div>` + project.roads.filter((x) => r.plan[x.id]).map((x) => { const p = r.plan[x.id]; return `<div class="tr-plan"><span class="dot" style="background:${PLAN_COLOR}"></span><b>${esc(x.name)}</b><span>${stMark('pred')} 最大 ${nr(p.max)}・平均 ${nr(p.sum / p.len)} ${unit()}　混雑度 ${fmt(p.vc, 2)}</span>
        <label class="fld" title="計画道路の自由走行速度。空欄で自動（沿道状況の中央値と設計速度から）"><span class="lb">旅行速度</span><input data-key="tr.road.${x.id}.tv" data-step="5" data-dec="0" value="${x.tv || ''}" placeholder="自動" inputmode="decimal"><span class="un">km/h</span></label>
        <label class="chk" title="オフにすると、途中で横切る道路とは立体交差（接続なし）として扱います"><input type="checkbox" data-key="tr.road.${x.id}.tcross"${x.tcross !== false ? ' checked' : ''}>途中で横切る道路と平面交差でつなぐ</label></div>`; }).join('');
      /* 緩和・増加の大きい区間（道路名ごとに 1 つ） */
      const net = st.net, list = [];
      net.edges.forEach((e, i) => { if (e.planned) return; const x0 = r.before.x[2 * i] + r.before.x[2 * i + 1], x1 = r.after.x[2 * i] + r.after.x[2 * i + 1]; list.push({ i, e, x0, x1, d: x1 - x0, c0: Math.max(r.before.x[2 * i] / r.g.cap[2 * i], r.before.x[2 * i + 1] / r.g.cap[2 * i + 1]), c1: Math.max(r.after.x[2 * i] / r.g.cap[2 * i], r.after.x[2 * i + 1] / r.g.cap[2 * i + 1]) }); });
      const top = (cmp, n) => { const seen = new Set(), out = []; for (const q of list.slice().sort(cmp)) { const k = q.e.name || q.e.key; if (seen.has(k)) continue; seen.add(k); out.push(q); if (out.length >= n) break; } return out; };
      const item = (q) => `<div class="tr-rank" data-act="tr-goto" data-k="${q.e.key}"><b>${esc(q.e.name || T.KIND_JA[q.e.kind])}</b><span>${nr(q.x0)} → ${nr(q.x1)}</span><span class="${q.d < 0 ? 'dn' : 'up'}">${pct(q.x1, q.x0)}</span><span class="muted">混雑度 ${fmt(q.c0, 2)} → ${fmt(q.c1, 2)}</span></div>`;
      const dec = top((x, y) => x.d - y.d, 6).filter((q) => q.d < -st.vmax * 0.004), incr = top((x, y) => y.d - x.d, 4).filter((q) => q.d > st.vmax * 0.004);
      h += `<div class="lgroup tr-sub"><span>交通量が減る区間</span></div>${dec.map(item).join('') || '<div class="muted small">目立った減少はありません。</div>'}`;
      if (incr.length) h += `<div class="lgroup tr-sub"><span>交通量が増える区間</span></div>${incr.map(item).join('')}`;
    }
    if (r.fit) h += `<div class="lgroup tr-sub"><span>現況の再現性（観測値 と 配分値）</span></div>${scatter(r)}<div class="muted small">${r.fit.realOnly ? '実データ' : '観測・推定データ'} ${r.fit.n} 件（区間・地点の方向別。区間内は延長で平均）。相関係数 ${r.fit.r == null ? '—' : fmt(r.fit.r, 3)}・RMSE ${r.fit.rmse == null ? '—' : fmt(r.fit.rmse * 100, 1) + '%'}。点が斜めの線に近いほど、現況を再現できています。</div>`;
    return sec('予測結果', h, `<span class="muted small">${T.ASSIGN_METHODS[r.assign].name.replace(/（.*/, '')}・ゾーン ${r.zones.length}</span>`);
  }
  function scatter(r) {
    const W = 276, H = 190, pad = { l: 44, r: 8, t: 8, b: 30 }, pts = r.fit.pts, mx = Math.max(1, ...pts.map((p) => Math.max(p.obs, p.mod))) * 1.05;
    const X = (v) => pad.l + (v / mx) * (W - pad.l - pad.r), Y = (v) => H - pad.b - (v / mx) * (H - pad.t - pad.b);
    const step = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000].find((d) => mx / d <= 5) || 200000;
    let o = '';
    for (let v = 0; v <= mx; v += step) o += `<line x1="${X(v)}" x2="${X(v)}" y1="${pad.t}" y2="${H - pad.b}" class="g"/><line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${X(v)}" y="${H - pad.b + 12}" text-anchor="middle">${n0(v)}</text><text x="${pad.l - 5}" y="${Y(v) + 3}" text-anchor="end">${n0(v)}</text>`;
    o += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(mx)}" y2="${Y(mx)}" class="d"/><text x="${(pad.l + W - pad.r) / 2}" y="${H - 3}" text-anchor="middle">観測値 [${unit()}]</text><text transform="translate(9 ${(pad.t + H - pad.b) / 2}) rotate(-90)" text-anchor="middle">配分値</text>`;
    pts.forEach((p) => { const e = st.net.edges[p.a >> 1]; o += `<circle cx="${X(p.obs)}" cy="${Y(p.mod)}" r="4" data-act="tr-goto" data-k="${e.key}"><title>${esc(e.name || T.KIND_JA[e.kind])}: 観測 ${n0(p.obs)} / 配分 ${n0(p.mod)}</title></circle>`; });
    return `<svg class="tr-scatter" viewBox="0 0 ${W} ${H}">${o}</svg>`;
  }
  const fmtDate = (d) => { const s = String(d || '').replace(/\D/g, ''); return s.length >= 6 ? `${s.slice(0, 4)}/${s.slice(4, 6)}${s.length >= 8 && s.slice(6, 8) !== '00' ? '/' + s.slice(6, 8) : ''}` : s ? s : '日付なし'; };
  function dataSec(t, net) {
    const cnt = {}; t.obs.forEach((o) => { const k = o.src + (o.est ? '-est' : ''); cnt[k] = (cnt[k] || 0) + 1; });
    let nReal = 0, nEst = 0, nAttr = 0; net.edges.forEach((e) => { if (e.planned) return; const k = e.bst.includes('attr') ? 'attr' : e.bst.includes('est') ? 'est' : 'real'; if (k === 'real') nReal += e.len; else if (k === 'est') nEst += e.len; else nAttr += e.len; });
    const tot = nReal + nEst + nAttr || 1, chip = (k, est, n) => (n ? `<span class="tr-src ${k}${est ? ' est' : ''}">${T.SOURCES[k].short}${est ? '推定' : ''} ${n}</span>` : '');
    return sec('交通量データ', `<div class="tr-cover" title="読み込んだ道路の延長のうち、実データ／推定値（センサス非観測区間・準用）／属性からの推定 の割合"><i class="real" style="width:${(nReal / tot) * 100}%"></i><i class="est" style="width:${(nEst / tot) * 100}%"></i><i class="attr" style="width:${(nAttr / tot) * 100}%"></i></div>
      <div class="muted small" style="margin-bottom:8px">延長の ${fmt((nReal / tot) * 100, 0)}% に実データ、${fmt((nEst / tot) * 100, 0)}% に推定値（センサス非観測区間など）、残り ${fmt((nAttr / tot) * 100, 0)}% は道路種別・車線数・沿道状況からの推定です。</div>
      <div class="tr-chips">${chip('field', 0, cnt.field)}${chip('jartic', 0, cnt.jartic)}${chip('local', 0, cnt.local)}${chip('census', 0, cnt.census)}${chip('census', 1, cnt['census-est'])}${t.obs.length ? '' : '<span class="muted small">まだデータがありません</span>'}</div>
      <div class="row"><button class="btn accent" data-act="tr-census" title="表示範囲の道路交通センサス（令和3年度 一般交通量調査）の区間別交通量を読み込みます">センサスを取得</button><button class="btn" data-act="tr-jartic" title="国土交通省 交通量API（直轄国道の常時観測）の 1 時間値を表示範囲で取得します">常時観測を取得</button></div>
      <div class="row"><button class="btn${ui.tool === 'tobs' ? ' on' : ''}" data-act="tr-add" title="地図の道路をクリックして観測地点を置き、実測値を入力します">観測地点を追加</button><button class="btn" data-act="tr-import" title="自治体の交通量調査などの CSV・GeoJSON、交通量API の応答ファイルを取り込みます">ファイルを取り込む</button></div>
      <div class="row"><button class="btn" data-act="tr-dock">${st.dock ? 'データ表を閉じる' : 'データ表を開く'}</button><button class="btn" data-act="tr-template" title="取り込み用 CSV の見本をダウンロード">CSV の見本</button></div>
      <div class="muted small">同じ区間に複数のデータがあるときは、実測 → 常時観測 → 自治体等の調査・センサス実測（新しい方）→ センサス推定値 → 属性からの推定 の順に使います。区間をクリックすると候補を選び直せます。</div>
      ${cnt.census || cnt['census-est'] ? '<div class="muted small tr-credit">出典: 国土交通省「令和3年度 全国道路・街路交通情勢調査 一般交通量調査」を加工して作成</div>' : ''}
      ${cnt.jartic ? '<div class="muted small tr-credit">国土交通省 交通量API機能による交通量（参考値）を加工して作成。このサービスは交通量API機能を使用していますが、サービスの内容は国土交通省によって保証されたものではありません。</div>' : ''}`);
  }
  function methodSec(s) {
    const o = (obj) => Object.entries(obj).map(([k, v]) => [k, v.name]);
    return sec('予測の方法', `<div class="row one">${sel('OD の推定', 'tr.od', s.od, o(T.OD_METHODS))}</div><div class="muted small tr-mnote">${T.OD_METHODS[s.od].note}</div>
      <div class="row one">${sel('配分', 'tr.assign', s.assign, o(T.ASSIGN_METHODS))}</div><div class="muted small tr-mnote">${T.ASSIGN_METHODS[s.assign].note}</div>
      <div class="row one">${sel('対象道路', 'tr.scope', s.scope, [['main', '一般道以上（生活道路を除く）'], ['arterial', '幹線のみ（幹線市町村道以上）'], ['all', 'すべて（生活道路を含む）']])}</div>
      <div class="row one">${sel('沿道状況', 'tr.area', s.area, [[0, '自動（センサス区間・道路密度から）'], ...Object.entries(T.AREAS)])}</div>
      <label class="chk" title="高速道路・都市高速を一般道と同じネットワークに入れます（料金・出入口の向きは考慮しません）。計画道路が第1種・第2種のときは自動で含めます"><input type="checkbox" data-key="tr.motorway"${s.motorway ? ' checked' : ''}>高速道路も含める</label>
      <div class="row">${num('伸び率', 'tr.growth', s.growth, { step: 0.05, dec: 2, title: '将来交通量の倍率。現況の OD 表に掛けて、整備なし・ありの両方を将来時点で比べます（1.00 = 現況）' })}${num('域内発生', 'tr.internal', s.internal, { step: 0.1, dec: 1, title: '読み込み範囲の中で発生・集中する交通（生活道路の延長×沿道状況の原単位）の倍率。0 で通過交通のみ' })}</div>
      <details class="tr-adv"><summary>詳細なパラメータ</summary>
      <div class="row">${num('BPR α', 'tr.alpha', s.alpha, { step: 0.05, dec: 2, title: 'リンク所要時間 t = t0 (1 + α (交通量/容量)^β)。既定は土木学会「道路交通需要予測の理論と適用」の一般道の値' })}${num('BPR β', 'tr.beta', s.beta, { step: 0.1, dec: 2 })}</div>
      <div class="row">${num('分割回数', 'tr.splits', s.splits, { step: 1, dec: 0, title: '分割配分法の分割回数' })}${num('ロジット θ', 'tr.theta', s.theta, { step: 0.1, dec: 2, title: '確率的配分の分散パラメータ [1/分]。大きいほど最短経路に集中' })}</div>
      <div class="row">${num('距離抵抗 γ', 'tr.gamma', s.gamma, { step: 0.1, dec: 2, title: '重力モデルの抵抗 f = 所要時間^(−γ)' })}${num('転換率 κ', 'tr.kappa', s.kappa, { step: 0.5, dec: 1, title: '転換率 P = 1/(1+時間比^κ)' })}</div></details>
      <div class="row one" style="margin-top:6px"><button class="btn" data-act="tr-export" title="リンクごとの現況・整備なし・整備ありの交通量と混雑度を CSV で保存">予測結果を CSV で保存</button></div>`);
  }

  /* ───────── データ表（地図の下） ───────── */
  const FIELDS = ['name', 'date', 'a', 'b', 'lg'];
  function dirLabels(o, info) {
    if (o.ud) return ['下り', '上り'];
    if (o.az == null) return ['A 方向', 'B 方向'];
    return [compass(o.az), compass(o.az + 180)];
  }
  function renderDock() {
    const el = $('#vdock'), on = st.on && st.dock;
    if (el.hidden === on) { el.hidden = !on; $('#stage').classList.toggle('dock-on', on); map.invalidateSize({ pan: false }); }
    if (!on) { if (st.on) el.innerHTML = ''; return; }
    const act = document.activeElement, keep = act && act.dataset && act.dataset.tcell ? act.dataset.tcell : null, scroll = el.querySelector('.tr-scroll') ? el.querySelector('.tr-scroll').scrollTop : 0;
    const net = ensureNet(), t = tr(), per = period(), pts = t.obs.filter((o) => o.src !== 'census'), cen = t.obs.filter((o) => o.src === 'census');
    const cell = (o, f, v, ph, ro) => `<input class="cell${f === 'name' ? ' txt' : ''}${ph ? ' conv' : ''}" data-tcell="${o.id}|${f}" value="${esc(v ?? '')}" placeholder="${esc(ph || '')}" ${ro ? 'readonly tabindex="-1"' : ''} ${f === 'name' || f === 'date' ? '' : 'inputmode="decimal"'} title="${ph ? '別の時間帯の値から換算した値です。入力するとこの時間帯の実測値になります' : ''}">`;
    const rowOf = (o) => {
      const info = net.obsInfo.get(o.id) || {}, lb = dirLabels(o), ro = o.src === 'census', e = info.edgeKey != null && net.byKey.has(info.edgeKey) ? net.edges[net.byKey.get(info.edgeKey)] : null, f = e ? e.fac : T.factors('P', 2, o.meta);
      const val = (sd) => { const side = o[sd] || {}; if (side[per] != null && side[per] !== '') return [side[per], '']; const q = T.valueOf(side, per, f); if (q) return q.conv ? ['', nr(q.v)] : [Math.round(q.v), '']; const w = T.valueOf(o.both, per, f); return w ? ['', nr(w.v / 2)] : ['', '']; }; // 両方向の合計しか無いときは半分ずつ
      const [va, pa] = val('a'), [vb, pb] = val('b'), lg = (o.a && o.a.lg) ?? (o.meta && o.meta.lg) ?? '';
      const status = o.off ? '<span class="muted">不使用</span>' : ro ? (o.meta && o.meta.oriented === 0 ? '<span class="tr-bad" title="区間の向きが分からないため、上下の合計を半分ずつ使います">向き不明</span>' : '') : info.unmatched ? '<span class="tr-bad" title="40m 以内に道路がありません。既存道路を読み込むか、地点を道路の上に動かしてください">道路なし</span>' : info.dirUnknown ? '<span class="tr-bad" title="上り・下りの向きが分からないため、道路の向きで仮に割り当てています。違う場合は ⇄ で入れ替えてください">向き仮</span>' : '<span class="muted">割当済</span>';
      return `<tr class="${st.focus === o.id ? 'sel' : ''}${o.off ? ' off' : ''}" data-oid="${o.id}"><td><input type="checkbox" data-tchk="${o.id}"${o.off ? '' : ' checked'} title="このデータを使う"></td><td><span class="tr-src ${o.src}${o.est ? ' est' : ''}">${T.SOURCES[o.src].short}${o.est ? '推定' : ''}</span></td>
        <td>${cell(o, 'name', o.name, '', ro)}</td><td>${cell(o, 'date', ro ? fmtDate(o.date) : o.date, ro ? '' : '2026-04-15', ro)}</td>
        <td class="dl">${lb[0]}</td><td>${cell(o, 'a', va, pa, ro)}</td><td class="dl">${lb[1]}</td><td>${cell(o, 'b', vb, pb, ro)}</td><td>${cell(o, 'lg', lg === '' ? '' : fmt(+lg, 1), '', ro)}</td>
        <td>${status}</td><td class="ops">${ro ? '' : `<button class="ibtn xs" data-act="tr-flip" data-id="${o.id}" title="2 つの方向の値を入れ替える">⇄</button>`}<button class="ibtn xs" data-act="tr-goto-obs" data-id="${o.id}" title="地図で表示">${ic('target')}</button>${ro ? '' : `<button class="ibtn xs" data-act="tr-del" data-id="${o.id}" title="削除">${ic('trash')}</button>`}</td></tr>`;
    };
    el.innerHTML = `<div class="vd-head"><b>交通量データ</b><label class="tr-per">入力する時間帯 <select data-key="tr.period">${Object.entries(T.PERIODS).map(([k, p]) => `<option value="${k}"${k === per ? ' selected' : ''}>${p.name}</option>`).join('')}</select></label>
      <span class="muted small vd-hint">台数は方向別（${unit()}）。<kbd>Enter</kbd> で下のセルへ。Excel からの貼り付けもできます。薄い数字は別の時間帯からの換算値</span>
      <button class="btn${ui.tool === 'tobs' ? ' on' : ''}" data-act="tr-add">観測地点を追加</button><button class="btn" data-act="tr-import">取り込む</button><button class="btn" data-act="tr-export-obs" title="表の内容を CSV で保存">CSV で保存</button><button class="ibtn" data-act="tr-dock" title="閉じる">✕</button></div>
      <div class="tr-scroll"><table class="els vtbl tr-data"><thead><tr><th title="使う">使</th><th>種別</th><th>地点名</th><th>調査日</th><th colspan="2">方向 1 [台]</th><th colspan="2">方向 2 [台]</th><th>大型車 %</th><th>状態</th><th></th></tr></thead><tbody>
      ${pts.map(rowOf).join('') || `<tr><td colspan="11" class="muted" style="text-align:left;padding:10px">実測・取り込みのデータはまだありません。<b>観測地点を追加</b> を押して地図の道路をクリックすると、ここに行が増えます。</td></tr>`}
      ${cen.length ? `<tr class="grp"><td colspan="11"><button class="btn xs" data-act="tr-cen-toggle">${st.showCensus ? '▾' : '▸'} 道路交通センサスの区間 ${cen.length} 件（実測 ${cen.filter((o) => !o.est).length}・推定値 ${cen.filter((o) => o.est).length}）</button>${st.showCensus ? '<span class="muted small">　値は変更できません。違う値を使うときは区間をクリックして「この区間の実測値を入力」</span>' : ''}</td></tr>` : ''}
      ${st.showCensus ? cen.map(rowOf).join('') : ''}</tbody></table></div>`;
    el.querySelector('.tr-scroll').scrollTop = scroll;
    if (keep) { const c = el.querySelector(`[data-tcell="${CSS.escape(keep)}"]`); if (c) c.focus(); }
  }
  function setCell(id, f, raw) {
    const per = period(), v = raw.trim();
    setObs(id, (o) => {
      if (f === 'name') return { name: v };
      if (f === 'date') return { date: v };
      const numv = v === '' ? null : parseFloat(v.replace(/[,，\s]/g, ''));
      if (v !== '' && !(numv >= 0)) return {};
      if (f === 'lg') return { a: Object.assign({}, o.a, { lg: numv }), b: Object.assign({}, o.b, { lg: numv }) };
      const side = Object.assign({}, o[f]); if (numv == null) delete side[per]; else side[per] = numv;
      if (side.hr) delete side.hr; // 手で直したら 1 時間ごとの値は捨てる
      return { [f]: side };
    });
  }
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.tcell) { const [id, f] = t.dataset.tcell.split('|'); setCell(id, f, t.value); commit(); }
    else if (t.dataset && t.dataset.tchk) { setObs(t.dataset.tchk, { off: !t.checked }); commit(); }
    else if (t.id === 'fileTraffic') { [...t.files].forEach(importFile); t.value = ''; }
  }, true);
  document.addEventListener('keydown', (e) => { // Enter・↑↓ で上下のセルへ
    const t = e.target; if (!t.dataset || !t.dataset.tcell) return;
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.stopPropagation(); e.preventDefault();
    const [, f] = t.dataset.tcell.split('|'), cells = [...document.querySelectorAll(`#vdock [data-tcell$="|${f}"]:not([readonly])`)], i = cells.indexOf(t), nx = cells[i + (e.key === 'ArrowUp' ? -1 : 1)];
    if (nx) { const key = nx.dataset.tcell; t.blur(); setTimeout(() => { const c = document.querySelector(`[data-tcell="${CSS.escape(key)}"]`); if (c) { c.focus(); c.select(); } }, 0); } else t.blur();
  }, true);
  document.addEventListener('paste', (e) => { // 表計算ソフトからの貼り付け: 選んだセルを左上として行・列に流し込む
    const t = e.target; if (!t.dataset || !t.dataset.tcell) return;
    const text = (e.clipboardData || window.clipboardData).getData('text'); if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const [id, f] = t.dataset.tcell.split('|'), ids = tr().obs.filter((o) => o.src !== 'census').map((o) => o.id), r0 = ids.indexOf(id), c0 = FIELDS.indexOf(f);
    text.replace(/\r/g, '').split('\n').filter((l) => l !== '').forEach((line, r) => { const oid = ids[r0 + r]; if (!oid) return; line.split('\t').forEach((v, c) => { const ff = FIELDS[c0 + c]; if (ff) setCell(oid, ff, v); }); });
    commit(); toast('貼り付けました');
  }, true);
  document.addEventListener('focusin', (e) => { const t = e.target; if (t.dataset && t.dataset.tcell) { const id = t.dataset.tcell.split('|')[0]; if (st.focus !== id) { st.focus = id; const info = st.net && st.net.obsInfo.get(id); document.querySelectorAll('#vdock tr.sel').forEach((x) => x.classList.remove('sel')); const row = t.closest('tr'); if (row) row.classList.add('sel'); if (info && info.edgeKey) { st.sel = info.edgeKey; render(); } } } });

  /* ───────── データの追加・取得・取り込み ───────── */
  function addObsAt(latlng, ei) {
    const net = ensureNet(), q = P.toXY(latlng);
    if (ei == null) { let best = null; net.edges.forEach((e, i) => { if (e.planned) return; const n = T.nearestOnEdge(e, q.x, q.y); if (n.d < 40 && (!best || n.d < best.d)) best = { i, d: n.d }; }); if (!best) return toast('道路の上をクリックしてください（40m 以内に道路がありません）', 'err'); ei = best.i; }
    const e = net.edges[ei]; if (e.planned) return toast('計画道路には観測地点を置けません', 'err');
    const n = T.nearestOnEdge(e, q.x, q.y), ll = P.toLL(n.x, n.y), az = Math.round(azOf(n.dx, n.dy));
    const cnt = tr().obs.filter((o) => o.src === 'field').length + 1, id = 'f-' + uid();
    tr().obs = tr().obs.concat([{ id, src: 'field', name: `${e.name || '地点'} ${cnt}`.trim(), date: new Date().toISOString().slice(0, 10), pt: [+ll.lat.toFixed(6), +ll.lng.toFixed(6)], az, a: {}, b: {} }]);
    st.dock = true; st.focus = id; st.sel = e.key; setTool('select'); commit();
    setTimeout(() => { const c = document.querySelector(`[data-tcell="${id}|a"]`); if (c) c.focus(); }, 50);
    toast('観測地点を追加しました。下の表に方向別の台数を入力してください');
  }
  /* 道路交通センサス（同梱データ）: 表示範囲の区間を読み込む */
  async function fetchCensus() {
    let b = map.getBounds().pad(0.05);
    for (const ex of project.existing) { const bb = ex.bbox; if (bb && bb.every(Number.isFinite) && bb[0] <= bb[2]) { b.extend([bb[0], bb[1]]); b.extend([bb[2], bb[3]]); } } // 読み込んである既存道路の範囲まで（壊れた範囲は無視）
    if (b.getNorth() - b.getSouth() > 1 || b.getEast() - b.getWest() > 1) b = map.getBounds().pad(0.05); // 既存道路が広がりすぎているときは表示範囲だけ
    const res = await busy('道路交通センサス（R3）の区間データを読み込み中…', async () => {
      if (!st.censusIndex) { const r = await fetch('data/census-r3/index.json'); if (!r.ok) throw new Error('同梱データがありません'); st.censusIndex = await r.json(); st.censusIndex.set = new Set(st.censusIndex.tiles); }
      const ix = st.censusIndex, n = 2 ** ix.z, tx = (lng) => Math.floor(((lng + 180) / 360) * n), ty = (lat) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
      const secs = new Map(); let miss = 0, have = 0;
      for (let x = tx(b.getWest()); x <= tx(b.getEast()); x++) for (let y = ty(b.getNorth()); y <= ty(b.getSouth()); y++) {
        const k = `${x}/${y}`; if (!ix.set.has(k)) { miss++; continue; } have++;
        if (!st.censusTiles.has(k)) { const r = await fetch(`data/census-r3/${ix.z}/${k}.json`); st.censusTiles.set(k, r.ok ? (await r.json()).s : []); }
        for (const s of st.censusTiles.get(k)) secs.set(s[0], s);
      }
      const list = [];
      for (const s of secs.values()) { const o = censusObs(s); if (o && o.lines.some((l) => { for (let i = 0; i < l.length; i += 2) if (b.contains([l[i], l[i + 1]])) return true; return false; })) list.push(o); }
      return { list, miss: ix.kens && ix.kens.length >= 47 ? 0 : miss, have, full: !!(ix.kens && ix.kens.length >= 47) };
    }).catch((e) => ({ err: e }));
    if (res.err) return toast('センサスのデータを読み込めませんでした: ' + res.err.message, 'err');
    if (!res.list.length) return toast(res.have || res.full ? 'この範囲にセンサスの対象区間（都道府県道以上）はありません' : 'この範囲のセンサスデータは同梱されていません（README の「交通量データ」を参照）', 'err');
    const ids = new Set(res.list.map((o) => o.id)), old = new Map(tr().obs.map((o) => [o.id, o]));
    res.list.forEach((o) => { const p = old.get(o.id); if (p) { o.off = p.off; o.pin = p.pin; } });
    tr().obs = tr().obs.filter((o) => !ids.has(o.id)).concat(res.list);
    commit();
    toast(`センサス ${res.list.length} 区間を読み込みました（実測 ${res.list.filter((o) => !o.est).length}・推定値 ${res.list.filter((o) => o.est).length}）${res.miss ? '。表示範囲の一部は同梱データの範囲外です' : ''}`);
  }
  function censusObs(s) {
    const [id, type, name, lanes, area, oriented, date, fa, sa, la, da, fb, sb, lb, db, dn, pk, konz, spd, limit, oneway, pka, pkb, enc] = s;
    const side = (sm, lg, day, p, flag) => { if (sm == null && day == null) return {}; const d12 = sm != null ? sm + (lg || 0) : null, o = {}; if (d12 != null) o.d12 = d12; if (day != null) o.day = day; if (p && flag) { o.am = p[0]; o.pm = p[1]; } if (d12 > 0 && lg != null) o.lg = +((lg / d12) * 100).toFixed(1); return o; };
    const lines = enc.map((l) => { let la0 = 0, lo0 = 0; const out = []; for (let i = 0; i < l.length; i += 2) { la0 += l[i]; lo0 += l[i + 1]; out.push(la0 / 1e5, lo0 / 1e5); } return out; });
    const a = side(sa, la, da, pka, fa), b = side(sb, lb, db, pkb, fb), t12 = (a.d12 || 0) + (b.d12 || 0);
    if (!T.hasData(a) && !T.hasData(b)) return null;
    const o = { id: 'cen-' + id, src: 'census', est: !fa && !fb, name: `${name}（${id}）`, date, lines, ud: true, a, b, meta: { type, lanes, area, oriented, dn, pk, konz, t12, spd, limit, oneway, flags: [fa, fb] } };
    if (!oriented) { const sum = (k) => (a[k] != null || b[k] != null ? (a[k] || 0) + (b[k] || 0) : null); o.both = {}; for (const k of ['d12', 'day']) { const v = sum(k); if (v != null) o.both[k] = v; } o.a = {}; o.b = {}; }
    return o;
  }
  /* 国交省 交通量API（常時観測）。ブラウザから直接読めないサーバー設定の場合は、URL を開いて保存したファイルを取り込む */
  function jarticUrl(type, day) {
    const b = map.getBounds().pad(0.1), d = day.replace(/-/g, '');
    const q = `道路種別=${type} AND 時間コード>=${d}0000 AND 時間コード<=${d}2300 AND BBOX(ジオメトリ,${b.getWest().toFixed(4)},${b.getSouth().toFixed(4)},${b.getEast().toFixed(4)},${b.getNorth().toFixed(4)},'EPSG:4326')`;
    return 'https://api.jartic-open-traffic.org/geoserver?service=WFS&version=2.0.0&request=GetFeature&typeNames=t_travospublic_measure_1h&srsName=EPSG:4326&outputFormat=application/json&exceptions=application/json&cql_filter=' + encodeURIComponent(q);
  }
  function lastWeekday() { const d = new Date(Date.now() - 3 * 864e5); while (d.getDay() === 0 || d.getDay() === 6 || d.getDay() === 1 || d.getDay() === 5) d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); } // 直近の火〜木
  function showJartic() {
    const day = st.jday || lastWeekday();
    $('#modal .modal-card').innerHTML = `<h2>常時観測データ（国土交通省 交通量API）</h2>
      <p>全国の直轄国道など約 2,600 か所で機械観測している方向別（上り・下り）の 1 時間交通量です。表示範囲・指定日の 24 時間分を取得します（過去 3 か月まで）。</p>
      <div class="row"><label class="fld"><span class="lb">観測日</span><input type="date" id="trJday" value="${day}" style="text-align:left"></label><button class="btn accent" data-act="tr-jartic-go">取得する</button></div>
      <div id="trJmsg" class="muted small"></div>
      <div class="foot"><span class="muted small">利用には <a href="https://www.jartic-open-traffic.org/" target="_blank" rel="noopener">交通量API 利用規約</a> への同意が必要です。値は参考値です。</span><button class="btn" data-act="close-modal">閉じる</button></div>`;
    $('#modal').hidden = false;
  }
  async function goJartic() {
    const day = $('#trJday').value; if (!day) return; st.jday = day;
    const msg = $('#trJmsg'), urls = [3, 1].map((t) => jarticUrl(t, day));
    msg.textContent = '取得中…';
    try {
      const feats = [];
      for (const u of urls) { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); feats.push(...(j.features || [])); }
      const n = importJartic(feats);
      $('#modal').hidden = true; toast(n ? `常時観測 ${n} 地点を読み込みました` : 'この範囲・日付の常時観測データはありません', n ? undefined : 'err');
    } catch (e) {
      msg.innerHTML = `ブラウザから直接は取得できませんでした（API 側がほかのサイトからの読み出しを許可していないため）。次の手順で取り込めます。
        <ol><li>リンクを開く（新しいタブに JSON が表示されます）: <a href="${esc(urls[0])}" target="_blank" rel="noopener">一般国道</a> ・ <a href="${esc(urls[1])}" target="_blank" rel="noopener">高速道路</a></li>
        <li>表示された内容を <kbd>Ctrl</kbd>+<kbd>S</kbd> でファイルに保存</li><li><button class="btn" data-act="tr-import">保存したファイルを取り込む</button>（地図へのドラッグ＆ドロップでも可）</li></ol>`;
    }
  }
  /* 交通量API の応答（GeoJSON）→ 観測地点ごとに、平日の 1 時間ごとの平均台数（上り・下り） */
  function importJartic(feats) {
    const pts = new Map();
    for (const f of feats) {
      const p = f.properties || {}, code = p['常時観測点コード'], c = f.geometry && f.geometry.coordinates && (Array.isArray(f.geometry.coordinates[0]) ? f.geometry.coordinates[0] : f.geometry.coordinates);
      if (code == null || !c) continue;
      const ymd = String(p['観測年月日']), hh = Math.floor((+p['時間帯'] || 0) / 100), wd = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)).getDay();
      const o = pts.get(code) || { code, ll: [c[1], c[0]], days: new Map(), type: p['道路種別'] }; pts.set(code, o);
      const k = ymd + (wd === 0 || wd === 6 ? 'h' : ''), d = o.days.get(k) || { up: new Array(24).fill(null), dn: new Array(24).fill(null), n: new Array(24).fill(0), lu: 0, ld: 0, tu: 0, td: 0 }; o.days.set(k, d);
      const val = (pre) => { if (p[pre + '・欠測'] === '1') return null; const s = p[pre + '・小型交通量'], l = p[pre + '・大型交通量'], x = p[pre + '・車種判別不能交通量']; if (s == null && l == null) return null; return [(+s || 0) + (+l || 0) + (+x || 0), +l || 0]; };
      const u = val('上り'), dd = val('下り');
      if (u) { d.up[hh] = (d.up[hh] || 0) + u[0]; d.lu += u[1]; d.tu += u[0]; } if (dd) { d.dn[hh] = (d.dn[hh] || 0) + dd[0]; d.ld += dd[1]; d.td += dd[0]; }
    }
    const list = [];
    for (const o of pts.values()) {
      const wk = [...o.days.entries()].filter(([k]) => !k.endsWith('h')), use = (wk.length ? wk : [...o.days.entries()]).map(([, d]) => d), dates = [...o.days.keys()].map((k) => k.slice(0, 8)).sort();
      const avg = (key) => { const hr = new Array(24).fill(null); for (let h = 0; h < 24; h++) { const v = use.map((d) => d[key][h]).filter((x) => x != null); if (v.length) hr[h] = Math.round(v.reduce((a, b) => a + b, 0) / v.length); } return hr; };
      const side = (key, lk, tk) => { const hr = avg(key), s = {}; if (hr.every((v) => v != null)) s.hr = hr; else if (hr.slice(7, 19).every((v) => v != null)) { s.d12 = hr.slice(7, 19).reduce((a, b) => a + b, 0); s.am = Math.max(hr[7], hr[8]); s.pm = Math.max(hr[17], hr[18]); } else return null; const l = use.reduce((a, d) => a + d[lk], 0), t = use.reduce((a, d) => a + d[tk], 0); if (t > 0) s.lg = +((l / t) * 100).toFixed(1); return s; };
      const a = side('dn', 'ld', 'td'), b = side('up', 'lu', 'tu'); if (!a && !b) continue;
      list.push({ id: 'jar-' + o.code, src: 'jartic', name: `常時観測点 ${o.code}`, date: dates[dates.length - 1], pt: [+o.ll[0].toFixed(6), +o.ll[1].toFixed(6)], az: null, ud: true, a: a || {}, b: b || {}, note: `${dates[0]}〜${dates[dates.length - 1]} の${wk.length ? '平日' : ''} ${use.length} 日平均` });
    }
    if (list.length) { const ids = new Set(list.map((o) => o.id)); tr().obs = tr().obs.filter((o) => !ids.has(o.id)).concat(list); st.dock = true; commit(); }
    return list.length;
  }
  /* CSV（自治体の交通量調査など）。見出しの語で列を判定する */
  const CSV_HEAD = ['地点名', '緯度', '経度', '方位', '調査日', '時間帯', '方向1台数', '方向2台数', '大型車混入率', '備考'];
  const PER_KEY = (s) => (/24|日交通|day/i.test(s) ? 'day' : /夜/.test(s) ? 'night' : /12|昼/.test(s) ? 'd12' : /朝|am/i.test(s) ? 'am' : /夕|pm/i.test(s) ? 'pm' : /ピーク|peak/i.test(s) ? 'peak' : null);
  function splitCsv(text) {
    const rows = []; let cur = [''], q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur[cur.length - 1] += '"'; i++; } else q = false; } else cur[cur.length - 1] += c; }
      else if (c === '"') q = true; else if (c === ',' || c === '\t') cur.push(''); else if (c === '\n') { rows.push(cur); cur = ['']; } else if (c !== '\r') cur[cur.length - 1] += c;
    }
    if (cur.length > 1 || cur[0] !== '') rows.push(cur);
    return rows;
  }
  function importCsv(text, fname) {
    const rows = splitCsv(text.replace(/^﻿/, '')); if (rows.length < 2) return 0;
    const head = rows[0].map((h) => h.trim()), find = (re) => head.findIndex((h) => re.test(h));
    const ci = { name: find(/地点|名称|箇所|name/i), lat: find(/緯度|lat/i), lng: find(/経度|lon|lng/i), az: find(/方位|bearing|azimuth/i), date: find(/調査日|観測日|年月日|date/i), per: find(/^時間帯$|period/i), lg: find(/大型/), note: find(/備考|note/i) };
    if (ci.lat < 0 || ci.lng < 0) { toast('緯度・経度の列が見つかりません（「CSV の見本」の形式にしてください）', 'err'); return 0; }
    const cols = []; // 台数の列: 方向（a/b/both）と時間帯
    head.forEach((h, i) => {
      if (Object.values(ci).includes(i)) return;
      const dir = /方向\s*1|A方向|下り|^a[_\s]/i.test(h) ? 'a' : /方向\s*2|B方向|上り|^b[_\s]/i.test(h) ? 'b' : /合計|断面|両方向|上下計|total|交通量|台数/i.test(h) ? 'both' : null;
      if (dir) cols.push({ i, dir, per: PER_KEY(h) });
    });
    const list = [];
    rows.slice(1).forEach((r, k) => {
      const lat = parseFloat(r[ci.lat]), lng = parseFloat(r[ci.lng]); if (!isFinite(lat) || !isFinite(lng)) return;
      const rowPer = ci.per >= 0 ? PER_KEY(r[ci.per] || '') : null, o = { id: 'l-' + uid(), src: 'local', name: (ci.name >= 0 && r[ci.name]) || `${fname} ${k + 1}`, date: ci.date >= 0 ? r[ci.date] : '', pt: [lat, lng], az: ci.az >= 0 && r[ci.az] !== '' && isFinite(parseFloat(r[ci.az])) ? parseFloat(r[ci.az]) : null, a: {}, b: {}, note: ci.note >= 0 ? r[ci.note] : '' };
      cols.forEach((c) => { const v = parseFloat(String(r[c.i] || '').replace(/[,，\s]/g, '')); if (!(v >= 0)) return; const per = c.per || rowPer || 'day'; if (c.dir === 'both') (o.both || (o.both = {}))[per] = v; else o[c.dir][per] = v; });
      if (ci.lg >= 0 && isFinite(parseFloat(r[ci.lg]))) { o.a.lg = o.b.lg = parseFloat(r[ci.lg]); }
      if (T.hasData(o.a) || T.hasData(o.b) || T.hasData(o.both)) list.push(o);
    });
    if (list.length) { tr().obs = tr().obs.concat(list); st.dock = true; commit(); }
    return list.length;
  }
  function importFile(file) {
    const fr = new FileReader();
    fr.onload = () => {
      let text = new TextDecoder('utf-8').decode(fr.result);
      if (text.includes('�')) { try { text = new TextDecoder('shift_jis').decode(fr.result); } catch (e) { /* UTF-8 のまま */ } }
      let n = 0, kind = 'データ';
      try {
        if (/^\s*[{[]/.test(text)) {
          const j = JSON.parse(text), feats = j.features || (Array.isArray(j) ? j : []);
          if (feats.some((f) => f.properties && f.properties['常時観測点コード'] != null)) { n = importJartic(feats); kind = '常時観測'; }
          else { // 点の GeoJSON: 属性名は CSV の見出しと同じ
            const keys = [...new Set(feats.flatMap((f) => Object.keys(f.properties || {})))], q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const csv = [['緯度', '経度', ...keys].join(',')].concat(feats.filter((f) => f.geometry && f.geometry.type === 'Point').map((f) => [f.geometry.coordinates[1], f.geometry.coordinates[0], ...keys.map((k) => q(f.properties[k]))].join(','))).join('\n');
            n = importCsv(csv, file.name);
          }
        } else n = importCsv(text, file.name.replace(/\.\w+$/, ''));
      } catch (e) { return toast('読み込めませんでした: ' + e.message, 'err'); }
      if (n) { if (!st.on) toggle(true); toast(`${kind} ${n} 地点を取り込みました（${file.name}）`); } else toast('取り込めるデータがありませんでした: ' + file.name, 'err');
    };
    fr.readAsArrayBuffer(file);
  }
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  function exportObs() {
    const per = period(), rows = [CSV_HEAD.concat(['種別']).join(',')];
    for (const o of tr().obs) { if (!o.pt) continue; const v = (sd) => (o[sd] && o[sd][per] != null ? o[sd][per] : (T.valueOf(o[sd], per, T.factors('P', 2)) || {}).v ?? ''); rows.push([q(o.name), o.pt[0], o.pt[1], o.az ?? '', q(o.date), T.PERIODS[per].short, v('a') === '' ? '' : Math.round(v('a')), v('b') === '' ? '' : Math.round(v('b')), (o.a && o.a.lg) ?? '', q(o.note || ''), T.SOURCES[o.src].short].join(',')); }
    download(project.name + '_交通量データ.csv', '﻿' + rows.join('\r\n'), 'text/csv');
  }
  function exportResult() {
    const net = ensureNet(), r = st.res && !st.res.failed ? st.res : null, per = period(), rows = [['路線名', '種別', '計画道路', '延長m', '車線数', '沿道状況', '方向', '緯度', '経度', `交通容量(${unit()})`, '現況', '現況の種別', '現況は換算値', '整備なし(予測)', '整備あり(予測)', '増減', '混雑度_現況', '混雑度_整備なし', '混雑度_整備あり'].join(',')];
    const kindJa = { real: '実データ', est: '推定', attr: '属性から推定' };
    net.edges.forEach((e, i) => {
      const az = azOf(e.pts[e.pts.length - 1][0] - e.pts[0][0], e.pts[e.pts.length - 1][1] - e.pts[0][1]), ll = P.toLL(e.mid[0], e.mid[1]);
      for (let d = 0; d < 2; d++) {
        if (d === 0 ? e.oneway < 0 : e.oneway > 0) continue;
        const cap = r ? r.g.cap[2 * i + d] : (e.cap12 * T.periodScale(per, e.fac)) / (e.oneway ? 1 : 2), b = e.planned ? null : e.base[d], x0 = r && !e.planned ? r.before.x[2 * i + d] : null, x1 = r ? r.after.x[2 * i + d] : null, f = (v) => (v == null ? '' : Math.round(v)), c = (v) => (v == null ? '' : (v / cap).toFixed(2));
        rows.push([q(e.name), T.KIND_JA[e.kind], e.planned ? '○' : '', e.len.toFixed(0), e.lanesEff, q(T.AREAS[e.area]), compass(az + d * 180), ll.lat.toFixed(6), ll.lng.toFixed(6), f(cap), f(b), b == null ? '' : kindJa[e.bst[d]], e.bconv[d] ? '○' : '', f(x0), f(x1), x0 != null && x1 != null ? f(x1 - x0) : '', c(b), c(x0), c(x1)].join(','));
      }
    });
    download(`${project.name}_交通量予測_${T.PERIODS[per].short}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
  }
  const template = () => download('交通量データ_見本.csv', '﻿' + [CSV_HEAD.join(','), '○○交差点 北側,35.681200,139.767100,0,2026-04-15,昼間12時間,5230,4980,12.5,方位は方向1の進行方位（北=0・東=90）', '△△橋,35.684000,139.770000,90,2026-04-15,24時間,8100,7900,,時間帯は 24時間／昼間12時間／朝ピーク／夕ピーク／ピーク'].join('\r\n'), 'text/csv');

  /* ───────── 操作 ───────── */
  function toggle(on) {
    st.on = on == null ? !st.on : on;
    if (st.on && typeof StudyUI !== 'undefined' && StudyUI.isOn()) StudyUI.toggle(false); // 計画検討の画面とは同時に開かない
    document.body.classList.toggle('traffic-on', st.on);
    if (!st.on) { if (ui.tool === 'tobs') setTool('select'); st.sel = null; }
    else { ui.sel = null; st.drawSig = ''; if (!tr().obs.length && !project.existing.length) toast('まず左パネルで既存道路を読み込み、「センサスを取得」で交通量データを読み込みます'); }
    renderExisting(); refresh(); schedule(true); setTimeout(() => map.invalidateSize({ pan: false }), 0);
  }
  function setValue(key, raw) {
    const t = tr(), k = key.slice(3), v = parseFloat(raw);
    if (k === 'color') { st.color = raw; st.drawSig = ''; render(); return renderPanels(); }
    if (k.startsWith('edit.')) {
      const net = ensureNet(), e = st.sel != null && net.byKey.has(st.sel) ? net.edges[net.byKey.get(st.sel)] : null; if (!e) return;
      const f = k.slice(5), ed = Object.assign({}, t.edits[e.key]); if (raw === '' || !(v > 0)) delete ed[f]; else ed[f] = f === 'lanes' ? Math.max(1, Math.min(12, Math.round(v))) : v;
      t.edits = Object.assign({}, t.edits); if (Object.keys(ed).length) t.edits[e.key] = ed; else delete t.edits[e.key];
      return commit();
    }
    if (k.startsWith('road.')) { const [, id, f] = k.split('.'), r = roadById(id); if (!r) return; if (f === 'tv') { if (v > 0) r.tv = Math.min(120, v); else delete r.tv; } else r.tcross = !!raw; return commit(); }
    const numeric = { growth: [0.1, 5], internal: [0, 10], alpha: [0, 5], beta: [1, 10], splits: [2, 20], theta: [0.01, 10], gamma: [0, 5], kappa: [1, 20] };
    t.set = Object.assign({}, t.set);
    if (numeric[k]) { if (!isFinite(v)) return renderPanels(); t.set[k] = Math.max(numeric[k][0], Math.min(numeric[k][1], v)); }
    else if (k === 'area') t.set.area = +raw || 0;
    else if (k === 'motorway') t.set.motorway = !!raw;
    else t.set[k] = raw;
    if (k === 'period' && st.net) { T.baseVolumes(st.net, raw); st.drawSig = ''; }
    save(); render(); renderPanels(); schedule();
  }
  function act(a, el) {
    const id = el && el.dataset.id;
    switch (a) {
      case 'traffic': return toggle();
      case 'tr-set': if (el.dataset.k === 'view') { st.view = el.dataset.v; st.drawSig = ''; render(); renderPanels(); } return true;
      case 'tr-run': schedule(true); return true;
      case 'tr-desel': st.sel = null; render(); renderPanels(); return true;
      case 'tr-goto': { const net = ensureNet(), i = net.byKey.get(el.dataset.k); if (i != null) { st.sel = el.dataset.k; map.fitBounds(L.latLngBounds(net.edges[i].ll).pad(1.5), { maxZoom: 17 }); render(); renderPanels(); } return true; }
      case 'tr-goto-obs': { const o = obsById(id); if (!o) return true; st.focus = id; const info = st.net && st.net.obsInfo.get(id); if (info && info.edgeKey) st.sel = info.edgeKey; if (o.pt) map.setView(o.pt, Math.max(map.getZoom(), 16)); else if (o.lines) map.fitBounds(L.latLngBounds(o.lines.flatMap((l) => { const p = []; for (let i = 0; i < l.length; i += 2) p.push([l[i], l[i + 1]]); return p; })).pad(0.5), { maxZoom: 17 }); st.drawSig = ''; render(); renderPanels(); return true; }
      case 'tr-pin': tr().obs = tr().obs.map((o) => { const e = st.net.edges[st.net.byKey.get(st.sel)]; return o.id === id ? Object.assign({}, o, { pin: true }) : e && e.cands.some((c) => c.o.id === o.id) && o.pin ? Object.assign({}, o, { pin: false }) : o; }); commit(); return true;
      case 'tr-unpin': setObs(id, { pin: false }); commit(); return true;
      case 'tr-measure': { const net = ensureNet(), i = net.byKey.get(st.sel); if (i != null) { const e = net.edges[i], ll = st.at && T.nearestOnEdge(e, P.toXY(st.at).x, P.toXY(st.at).y).d < 30 ? st.at : P.toLL(e.mid[0], e.mid[1]); addObsAt(ll, i); } return true; }
      case 'tr-add': setTool(ui.tool === 'tobs' ? 'select' : 'tobs'); return true;
      case 'tr-dock': st.dock = !st.dock; renderPanels(); return true;
      case 'tr-cen-toggle': st.showCensus = !st.showCensus; renderDock(); return true;
      case 'tr-flip': setObs(id, (o) => ({ a: o.b, b: o.a })); commit(); return true;
      case 'tr-del': tr().obs = tr().obs.filter((o) => o.id !== id); if (st.focus === id) st.focus = null; commit(); return true;
      case 'tr-census': fetchCensus(); return true;
      case 'tr-jartic': showJartic(); return true;
      case 'tr-jartic-go': goJartic(); return true;
      case 'tr-import': $('#fileTraffic').click(); return true;
      case 'tr-template': template(); return true;
      case 'tr-export-obs': exportObs(); return true;
      case 'tr-export': if (!st.on) toggle(true); if (stale()) compute(); exportResult(); return true;
    }
    return false;
  }
  /* 地図クリック: 観測地点の追加。何もないところをクリックしたら選択解除 */
  function mapClick(e) {
    if (!st.on) return false;
    if (ui.tool === 'tobs') { addObsAt(e.latlng, null); return true; }
    if (ui.tool === 'select' && st.sel != null) { st.sel = null; render(); renderPanels(); }
    return false;
  }
  /* 地図へのファイルのドラッグ＆ドロップ（CSV・GeoJSON） */
  addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  addEventListener('drop', (e) => { const fs = e.dataTransfer && [...e.dataTransfer.files].filter((f) => /\.(csv|tsv|txt|json|geojson)$/i.test(f.name)); if (fs && fs.length) { e.preventDefault(); fs.forEach(importFile); } });

  /* PDF 用: 予測結果の 1 ページ（計算済みで計画道路があるときだけ） */
  function report(tbl) {
    const r = st.res && !st.res.failed && !stale() ? st.res : null; if (!r || !r.hasPlan) return '';
    const b = r.sum.before, a = r.sum.after, u = unit(), pu = u.replace('台/', ''), net = st.net, list = [];
    net.edges.forEach((e, i) => { if (e.planned) return; const x0 = r.before.x[2 * i] + r.before.x[2 * i + 1], x1 = r.after.x[2 * i] + r.after.x[2 * i + 1]; list.push({ e, x0, x1, c0: Math.max(r.before.x[2 * i] / r.g.cap[2 * i], r.before.x[2 * i + 1] / r.g.cap[2 * i + 1]), c1: Math.max(r.after.x[2 * i] / r.g.cap[2 * i], r.after.x[2 * i + 1] / r.g.cap[2 * i + 1]) }); });
    const seen = new Set(), top = list.sort((x, y) => x.x1 - x.x0 - (y.x1 - y.x0)).filter((q) => { const k = q.e.name || q.e.key; if (seen.has(k) || q.x1 >= q.x0) return false; seen.add(k); return true; }).slice(0, 12);
    const kind = (e) => ({ real: '実データ', est: '推定', attr: '属性から推定' }[e.bst.includes('attr') ? 'attr' : e.bst.includes('est') ? 'est' : 'real']);
    const cnt = {}; tr().obs.forEach((o) => { if (!o.off) { const k = T.SOURCES[o.src].short + (o.est ? '（推定値）' : ''); cnt[k] = (cnt[k] || 0) + 1; } });
    return `<div class="pg txt"><h1>交通量の予測（整備あり・なしの比較）<span>${T.PERIODS[r.period].name}</span></h1>
      <p class="sm">OD の推定: ${T.OD_METHODS[r.od].name} ／ 配分: ${T.ASSIGN_METHODS[r.assign].name} ／ 伸び率 ${fmt(r.params.growth, 2)} ／ リンク ${n0(r.nEdges)}・ゾーン ${r.zones.length}${r.fit ? ` ／ 現況の再現性: 相関係数 ${fmt(r.fit.r, 3)}・RMSE ${fmt(r.fit.rmse * 100, 1)}%（${r.fit.n} 件）` : ''}<br>使用データ: ${Object.entries(cnt).map(([k, v]) => `${k} ${v} 件`).join('・') || 'なし（道路種別・車線数・沿道状況からの推定のみ）'}</p>
      <h2>全体の指標（予測値）</h2>
      ${tbl(['指標', '整備なし', '整備あり', '増減'], [[`総走行時間 [台時/${pu}]`, nr(b.vht), nr(a.vht), pct(a.vht, b.vht)], [`損失時間 [台時/${pu}]`, nr(b.lost), nr(a.lost), pct(a.lost, b.lost)], ['平均旅行速度 [km/h]', fmt(b.speed, 1), fmt(a.speed, 1), pct(a.speed, b.speed)], [`総走行台キロ [台km/${pu}]`, nr(b.vkt), nr(a.vkt), pct(a.vkt, b.vkt)], ['混雑度 1.0 以上の延長 [km]', fmt(b.cong / 1000, 2), fmt(a.cong / 1000, 2), ''], ['混雑度 1.25 以上の延長 [km]', fmt(b.cong2 / 1000, 2), fmt(a.cong2 / 1000, 2), '']])}
      <h2>計画道路の交通量（予測値・両方向）</h2>
      ${tbl(['計画道路', `最大 [${u}]`, `平均 [${u}]`, '混雑度（最大）'], project.roads.filter((x) => r.plan[x.id]).map((x) => { const p = r.plan[x.id]; return [esc(x.name), nr(p.max), nr(p.sum / p.len), fmt(p.vc, 2)]; }))}
      <h2>交通量が減る主な区間（両方向）</h2>
      ${tbl(['路線', '種別', `現況 [${u}]`, '現況の種別', '整備なし（予測）', '整備あり（予測）', '増減', '混雑度 なし → あり'], top.map((q) => [esc(q.e.name || '—'), T.KIND_JA[q.e.kind], nr(q.e.base[0] + q.e.base[1]), kind(q.e), nr(q.x0), nr(q.x1), pct(q.x1, q.x0), `${fmt(q.c0, 2)} → ${fmt(q.c1, 2)}`]))}
      <p class="sm">現況は観測データ（実データ）または推定値、整備なし・整備ありは配分計算による予測値です。読み込んだ範囲の道路だけで作る簡易な需要予測（需要固定）で、交通容量・換算係数は令和3年度 全国道路・街路交通情勢調査（国土交通省）の全国集計を加工した値を使っています。</p></div>`;
  }

  return { st, toggle, panel, render, renderDock, setValue, act, mapClick, schedule, report, forecastDay, daySig, setting, isOn: () => st.on, reset() { st.net = null; st.res = null; st.sel = null; st.drawSig = ''; st.sig = ''; }, importCsv, importJartic, censusObs };
})();
