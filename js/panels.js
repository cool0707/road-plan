/* Road Plan — パネル UI・入出力・起動 */
'use strict';

const ICON = {
  select: '<path d="M5 3l14 8-6 2-2 6z"/>',
  draw: '<path d="M4 20c0-7 5-6 8-9s2-7 8-7"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="4" r="1.6"/>',
  measure: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  roads: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a5 5 0 010 10h-2"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a5 5 0 000 10h2"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M6.5 6.8C3.7 8.7 2 12 2 12s4 7 10 7c1.7 0 3.2-.5 4.5-1.200M10 5.200c.6-.1 1.300-.2 2-.2 6 0 10 7 10 7s-.9 1.600-2.500 3.300"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.500 9.500a2.500 2.500 0 115 0c0 1.500-2.500 2-2.500 4"/><circle cx="12" cy="17" r=".6"/>',
  target: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24">${ICON[n]}</svg>`;

/* ── フォーム部品 ── */
const sec = (title, body, acts = '') => `<section class="sec"><h3><span>${title}</span><span class="acts">${acts}</span></h3>${body}</section>`;
const num = (label, key, val, o = {}) => `<label class="fld${o.ro ? ' ro' : ''}" title="${esc(o.title || '')}"><span class="lb"${o.ro ? '' : ' data-scrub'}>${label}</span><input ${o.ro ? 'readonly tabindex="-1"' : ''} data-key="${key}" data-step="${o.step ?? 1}" data-dec="${o.dec ?? 2}" value="${typeof val === 'string' ? esc(val) : fmt(val, o.dec ?? 2)}" inputmode="decimal"><span class="un">${o.unit || ''}</span></label>`;
const sel = (label, key, val, opts) => `<label class="fld"><span class="lb">${label}</span><select data-key="${key}">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
const kv = (pairs) => `<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

/* ───────── 左パネル ───────── */
function renderLeft() {
  const counts = (road) => { const c = { error: 0, warn: 0 }; checksOf(road).forEach((r) => { if (c[r.level] != null) c[r.level]++; }); return c; };
  const roads = project.roads.map((r) => {
    const c = counts(r), on = ui.sel && ui.sel.type === 'road' && ui.sel.id === r.id;
    const badge = c.error ? `<span class="badge error">${c.error}</span>` : c.warn ? `<span class="badge warn">${c.warn}</span>` : '<span class="badge ok">✓</span>';
    return `<div class="layer${on ? ' sel' : ''}" data-act="sel-road" data-id="${r.id}"><span class="dot" style="background:#3f4a5a"></span><span class="nm">${esc(r.name)}</span><span class="wd" title="車線数・全幅">${xsecShort(r)}</span>${badge}<button class="ibtn${r.visible === false ? ' off' : ''}" data-act="vis-road" data-id="${r.id}" title="表示切替">${ic(r.visible === false ? 'eyeoff' : 'eye')}</button></div>`;
  }).join('');
  const im = project.image;
  $('#left').innerHTML = `
    <div class="lgroup"><span>計画道路</span><button class="ibtn" data-act="tool-draw" title="道路を描く (P)">${ic('plus')}</button></div>
    ${roads || '<div class="empty">下のツールバーの <b>道路を描く</b> で地図上をクリックして作成します。</div>'}
    <div class="lgroup"><span>既存道路</span><span></span></div>
    <div class="layer${ui.sel && ui.sel.type === 'existing' ? ' sel' : ''}"><span class="dot" style="background:#0f9d8f"></span><span class="nm">${exCount()}</span>
      <button class="ibtn" data-act="clear-existing" title="既存道路をすべてクリア">${ic('trash')}</button>
      <button class="ibtn${project.existingVisible ? '' : ' off'}" data-act="vis-existing" title="表示切替">${ic(project.existingVisible ? 'eye' : 'eyeoff')}</button></div>
    <div class="sec" style="border:0;padding-top:4px">
      <div class="row"><button class="btn" data-act="fetch-osm" title="表示範囲の道路を OpenStreetMap (Overpass API) から取得">OSM から取得</button><button class="btn" data-act="fetch-gsi" title="表示範囲の道路中心線を国土地理院ベクトルタイルから取得">地理院から取得</button></div>
      <div class="row one"><label class="fld" title="既存道路の表示方法（幅員どおり: 幅員の値で帯状に描画）"><span class="lb">表示方法</span><select data-key="existingWidth"><option value="0"${project.existingWidth ? '' : ' selected'}>中心線</option><option value="1"${project.existingWidth ? ' selected' : ''}>幅員どおり</option></select></label></div>
      <div class="row one"><button class="btn" data-act="dedupe-existing" title="OSM と地理院など、ほぼ同じ位置に重なっている既存道路を 1 本にまとめる"${project.existing.length ? '' : ' disabled'}>重複を除去</button></div>
      <div class="muted small">表示中の範囲の道路を読み込み、接続先として吸着できます。取得時、既に読み込んだ道路と重なる線は自動で除外します。不要な道路はクリックして選択し <kbd>Delete</kbd> で削除できます（交差点・屈曲点で区切られた区間ごと。<kbd>Ctrl</kbd>+<kbd>Z</kbd> で元に戻せます）。</div>
    </div>
    <div class="lgroup" style="border-top:1px solid var(--line)"><span>下絵画像</span><button class="ibtn" data-act="add-image" title="地図画像・図面を読み込む">${ic('plus')}</button></div>
    ${im ? `<div class="layer${ui.sel && ui.sel.type === 'image' ? ' sel' : ''}" data-act="sel-image"><span class="dot" style="background:#7b61ff"></span><span class="nm">下絵${ui.imageUrl ? '' : '（画像データなし）'}</span><button class="ibtn${im.visible ? '' : ' off'}" data-act="vis-image" title="表示切替">${ic(im.visible ? 'eye' : 'eyeoff')}</button></div>` : '<div class="empty">図面や地図のスクリーンショットを重ねられます。</div>'}
    <div class="lgroup" style="border-top:1px solid var(--line)"><span>ベースマップ</span></div>
    <div class="base-list">${Object.entries(BASES).map(([k, b]) => `<label><input type="radio" name="base" data-key="base" value="${k}"${project.base === k ? ' checked' : ''}>${esc(b.name)}</label>`).join('')}</div>
    <div class="sec" style="border:0">
      <div class="row one">${num('不透明度', 'base.opacity', project.baseOpacity * 100, { unit: '%', step: 1, dec: 0 })}</div>
      <div class="row one"><label class="fld" title="Google Maps Platform の Map Tiles API キー（このブラウザにのみ保存）"><span class="lb">Google APIキー</span><input type="password" data-key="googleKey" value="${esc(project.googleKey)}" placeholder="未設定" style="text-align:left"></label></div>
    </div>`;
}

function exCount() {
  const n = project.existing.length;
  if (!n) return '未取得';
  const osm = project.existing.filter((e) => e.src === 'OSM').length, gsi = n - osm;
  return `${n} 本` + (osm && gsi ? `（OSM ${osm}・地理院 ${gsi}）` : osm ? '（OSM）' : '（地理院）');
}

/* ───────── 右パネル ───────── */
function renderRight() {
  const road = selRoad(), el = $('#right');
  const scroll = el.scrollTop;
  let tabs = '', body = '';
  if (road) {
    const res = checksOf(road), ne = res.filter((r) => r.level === 'error').length, nw = res.filter((r) => r.level === 'warn').length;
    const badge = ne ? `<span class="badge error">${ne}</span>` : nw ? `<span class="badge warn">${nw}</span>` : '<span class="badge ok">✓</span>';
    tabs = `<div class="tabs"><button class="tab${ui.tab === 'design' ? ' on' : ''}" data-act="tab-design">デザイン</button><button class="tab${ui.tab === 'check' ? ' on' : ''}" data-act="tab-check">照査 ${badge}</button></div>`;
    body = ui.tab === 'check' ? checkPanel(road, res) : roadPanel(road);
  } else if (ui.sel && ui.sel.type === 'existing') body = existingPanel();
  else if (ui.sel && ui.sel.type === 'image' && project.image) body = imagePanel();
  else body = emptyPanel();
  el.innerHTML = tabs + `<div>${body}</div>`;
  el.scrollTop = scroll;
}

function emptyPanel() {
  const d = project.defaults;
  return sec('はじめに', `<ol style="margin:0;padding-left:18px;line-height:1.8">
      <li>左の <b>OSM から取得</b> または <b>地理院から取得</b> で既存道路を読み込む</li>
      <li>下のツールバーの <b>道路を描く</b>（<kbd>P</kbd>）で IP をクリック</li>
      <li>既存道路の近くでは緑の丸に吸着して接続</li>
      <li>IP を選択して R・クロソイド A を調整</li>
      <li><b>照査</b> タブで法規適合を確認</li></ol>`)
    + widthSec(d, 'def', '次に描く道路の幅員・車線', `<div class="row one">${sel('区分', 'def.cls', d.cls, Object.entries(Rules.CLASSES).map(([k, c]) => [k, c.name]))}</div>
      <div class="row one">${sel('設計速度', 'def.V', d.V, Rules.SPEEDS.map((v) => [v, v + ' km/h']))}</div>`, '<div class="muted small">ここで決めた値で次の道路が描かれます。描いた後も道路を選択すれば右パネルの一番上で変更できます。</div>')
    + `<div class="note">線形の色: <span class="tag line"></span>直線 <span class="tag clothoid"></span>クロソイド <span class="tag arc"></span>円曲線</div>`;
}

const xsecShort = (r) => `${r.lanes}車線・${fmt(Rules.totalWidth(r), 1)}m`;

/* 幅員・車線数カード（道路パネル最上部／既定値） */
function widthSec(o, pre, title, head = '', foot = '') {
  const step = (d) => `<button class="stp" data-act="lanes-step" data-pre="${pre}" data-d="${d}" title="車線数を${d > 0 ? '増やす' : '減らす'}"${(d < 0 ? o.lanes <= 1 : o.lanes >= 8) ? ' disabled' : ''}>${d > 0 ? '＋' : '−'}</button>`;
  return `<section class="sec wsec"><h3><span>${title}</span><span class="wtot">全幅 <b>${fmt(Rules.totalWidth(o), 2)}</b> m</span></h3>${head}
    <div class="lanes-row"><span class="lb">車線数</span>${step(-1)}<b class="lnum">${o.lanes}</b>${step(1)}<span class="muted">車線（車道 ${fmt(Rules.carriage(o), 2)} m）</span></div>
    <div class="row three">${num('車線幅', pre + '.laneW', o.laneW, { unit: 'm', step: 0.25, title: '1 車線あたりの幅員' })}${num('路肩', pre + '.shoulderW', o.shoulderW, { unit: 'm', step: 0.25, title: '片側あたりの路肩幅員（両側に設置）' })}${num('歩道', pre + '.sidewalkW', o.sidewalkW, { unit: 'm', step: 0.5, title: '片側あたりの歩道幅員（両側に設置。0 でなし）' })}</div>
    ${xsecSvg(o)}${foot}</section>`;
}

function xsecSvg(road) {
  const parts = [], sw = road.sidewalkW, sh = road.shoulderW, lw = road.laneW, n = road.lanes;
  if (sw > 0) parts.push([sw, '#b8a48c', '歩道']);
  if (sh > 0) parts.push([sh, '#6b7686', '']);
  for (let i = 0; i < n; i++) parts.push([lw, '#3f4a5a', fmt(lw, 2)]);
  if (sh > 0) parts.push([sh, '#6b7686', '']);
  if (sw > 0) parts.push([sw, '#b8a48c', '歩道']);
  const tot = parts.reduce((a, p) => a + p[0], 0) || 1;
  let x = 0, out = '';
  parts.forEach(([w, c, t], i) => {
    const px = (w / tot) * 276;
    out += `<rect x="${x}" y="${c === '#b8a48c' ? 14 : 18}" width="${px}" height="${c === '#b8a48c' ? 16 : 12}" fill="${c}" stroke="#fff" stroke-width="${i ? 1 : 0}"/>`;
    if (t && px > 22) out += `<text x="${x + px / 2}" y="44" font-size="9" text-anchor="middle" fill="#757575">${t}</text>`;
    x += px;
  });
  return `<svg class="xsec" viewBox="0 0 276 54" preserveAspectRatio="none">${out}<text x="138" y="10" font-size="9" text-anchor="middle" fill="#1e1e1e">全幅 ${fmt(tot, 2)} m</text></svg>`;
}

function connBlock(road, key, label, al) {
  const c = road.conn[key];
  if (!c) return `<div class="row one"><div class="fld ro"><span class="lb">${label}</span><input readonly value="未接続（端点を既存道路へドラッグ）" style="text-align:left"></div></div>`;
  const dir = key === 'start' ? al.dirs[0] : al.dirs[al.dirs.length - 1];
  return `<div class="row one">${sel(label, `conn.${key}.mode`, c.mode, [['cross', '交差・T字接続'], ['tangent', '延伸（接線方向に拘束）']])}</div>
    <div class="row">${num('交差角', '', Rules.foldAngle(dir - c.bearing), { ro: true, unit: '°', dec: 1 })}${num('進入速度', `conn.${key}.speed`, c.speed, { unit: 'km/h', dec: 0, step: 10, title: c.speedEst ? '道路種別からの推定値。実際の規制速度に修正してください' : '既存道路の最高速度' })}</div>
    ${kv([['接続先', esc(c.name || '既存道路') + (c.isEnd ? '（端点）' : '')], ['既存幅員', `約 ${fmt(c.width, 1)} m`], ['既存道路の方位角', `${fmt(azimuth(c.bearing), 1)}° / ${fmt((azimuth(c.bearing) + 180) % 360, 1)}°`]])}<div style="height:8px"></div>`;
}

function groundSummary(road) {
  const pf = ui.profiles.get(road.id);
  if (!pf) return '';
  const hs = pf.pts.map((p) => p.h);
  return kv([['地盤高', `${fmt(Math.min(...hs), 1)} 〜 ${fmt(Math.max(...hs), 1)} m`], ['最大現況勾配（約20m区間）', `${fmt(pf.maxGrade, 1)} %（${station(pf.maxAt)} 付近）`]]);
}
const sgnPct = (g) => `${g >= 0 ? '+' : '−'}${fmt(Math.abs(g * 100), 2)}%`;
const cell = (key, val, step, dec, title = '') => `<input class="cell" data-key="${key}" data-step="${step}" data-dec="${dec}" value="${fmt(val, dec)}" inputmode="decimal" title="${esc(title)}">`;

/* 縦断計画（計画高）ブロック */
function vplanBlock(road) {
  const gr = ui.profiles.get(road.id), al = calc(road), t = Rules.T[road.V], vp = vplanOf(road);
  const groundBtn = gr ? '' : `<div class="row one"><button class="btn wide" data-act="profile" title="中心線に沿った地盤高を国土地理院の標高タイルから取得し、切土・盛土を確認">現況地盤の標高を取得（地理院 DEM）</button></div>`;
  if (!vp) {
    return (gr ? profileSvg(road, 276, 110, { small: true }) + groundSummary(road) + '<div style="height:8px"></div>' : '')
      + `<div class="muted small" style="margin-bottom:8px">新しい道路は盛土・切土で高さを変えるのが普通です。縦断変化点（VIP）の測点・計画高・縦断曲線長を決めて計画縦断を作ります。</div>
      <div class="row"><button class="btn accent" data-act="vplan-ground" title="地理院 DEM の地盤高を間引いた変化点で案を作成">現況地盤に沿う案</button><button class="btn" data-act="vplan-flat" title="起点と終点の地盤高を一定勾配で結ぶ">両端を結ぶ</button></div>`
      + groundBtn;
  }
  const pf = vp.pf, n = pf.pts.length;
  const rows = road.vips.map((v, i) => {
    const p = pf.pts[i], end = i === 0 || i === n - 1, c = end ? null : pf.curves[i - 1], nm = i === 0 ? 'BP' : i === n - 1 ? 'EP' : 'VIP' + i;
    const vcTitle = c && Math.abs(c.dg) > 0.0005 ? `${c.crest ? '凸形' : '凹形'} R=${isFinite(c.R) ? Math.round(c.R) : '—'}m（規定 R≥${c.crest ? t.vR : t.vRc}m・L≥${t.vL}m）` : '勾配差なし';
    return `<tr><td>${nm}</td><td>${end ? fmt(p.s, 1) : cell(`vip.${i}.s`, v.s, 1, 1, '追加距離 [m]')}</td><td>${cell(`vip.${i}.z`, v.z, 0.1, 2, '計画高 [m]')}</td>`
      + `<td>${end ? '<span class="muted">—</span>' : cell(`vip.${i}.VCL`, v.VCL, 5, 0, '縦断曲線長 [m] ・ ' + vcTitle)}</td>`
      + `<td class="${i < n - 1 && Math.abs(pf.grades[i]) * 100 > t.grade + 1e-9 ? 'bad' : ''}">${i < n - 1 ? sgnPct(pf.grades[i]) : ''}</td>`
      + `<td>${end ? '' : `<button class="ibtn xs" data-act="vip-del" data-i="${i}" title="この変化点を削除">${ic('trash')}</button>`}</td></tr>`;
  }).join('');
  const gmax = Math.max(...pf.grades.map((g) => Math.abs(g))) * 100, zs = pf.pts.map((p) => p.z);
  const endTxt = (k) => (vp.ends[k] == null ? null : `${vp.ends[k] >= 0 ? '+' : '−'}${fmt(Math.abs(vp.ends[k]), 2)} m`);
  return `<div class="vmini" data-act="vdock-open" title="クリックで縦断図を大きく表示">${profileSvg(road, 276, 110, { small: true })}</div>
    <table class="els vtbl"><tr><th>点</th><th>測点 m</th><th>計画高 m</th><th title="縦断曲線長">VCL m</th><th title="次の点までの勾配">勾配</th><th></th></tr>${rows}</table>
    <div class="row" style="margin-top:6px"><button class="btn" data-act="vip-add" title="最も長い区間の中央に変化点を追加（縦断図ではダブルクリックでも追加）">変化点を追加</button><button class="btn" data-act="vip-fit" title="勾配差に応じて、縦断曲線の半径・長さの規定を満たす曲線長に揃える">曲線長を推奨値に</button></div>
    ${gr && (road.conn.start || road.conn.end) ? `<div class="row one"><button class="btn" data-act="vip-ends" title="接続している端点の計画高を現況地盤高（既存道路の路面高の近似）に合わせる">接続端を地盤高に合わせる</button></div>` : ''}
    ${kv([['計画高', `${fmt(Math.min(...zs), 2)} 〜 ${fmt(Math.max(...zs), 2)} m`], ['最大縦断勾配', `${fmt(gmax, 2)} %（規定 ${t.grade}%・特例 ${t.gradeEx}%）`],
    vp.cut || vp.fill ? ['最大切土 / 盛土', `${fmt(vp.cut ? vp.cut.d : 0, 2)} / ${fmt(vp.fill ? vp.fill.d : 0, 2)} m`] : null,
    endTxt('start') ? ['起点 計画高−地盤高', endTxt('start')] : null, endTxt('end') ? ['終点 計画高−地盤高', endTxt('end')] : null])}
    <div style="height:8px"></div>${groundBtn}
    <div class="row"><button class="btn" data-act="vdock-toggle">${ui.vdock ? '縦断図を閉じる' : '縦断図を開く'}</button><button class="btn danger" data-act="vplan-del">縦断計画を削除</button></div>`;
}

/* 縦断図（SVG）。small: 右パネル用の簡易表示 */
function profileSvg(road, W, H, o = {}) {
  const al = calc(road), L = al.length, pf = Geom.computeProfile(road.vips, L), gr = ui.profiles.get(road.id), sm = !!o.small;
  if (!(L > 0) || (!pf && !gr)) return '';
  const pad = sm ? { l: 4, r: 4, t: 8, b: 6 } : { l: 52, r: 16, t: 18, b: 40 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  let rg = ui.vdrag && ui.vdrag.road === road.id ? ui.vdrag.range : null;
  if (!rg) {
    const zs = [];
    if (gr) gr.pts.forEach((p) => zs.push(p.h));
    if (pf) for (let k = 0; k <= 200; k++) zs.push(Geom.profileAt(pf, (L * k) / 200).z);
    let lo = Math.min(...zs), hi = Math.max(...zs);
    const span = Math.max(hi - lo, 2); lo -= span * 0.18; hi += span * 0.22;
    rg = { lo, hi };
  }
  const X = (s) => pad.l + (s / L) * pw, Y = (z) => pad.t + ((rg.hi - z) / (rg.hi - rg.lo)) * ph, f = (v) => v.toFixed(1);
  const pl = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${f(p[0])},${f(p[1])}`).join('');
  let out = '';
  // 格子
  if (!sm) {
    const zStep = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200].find((d) => ((rg.hi - rg.lo) / d) * 24 <= ph) || 500;
    for (let z = Math.ceil(rg.lo / zStep) * zStep; z <= rg.hi; z += zStep) out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${f(Y(z))}" y2="${f(Y(z))}" class="g"/><text x="${pad.l - 6}" y="${f(Y(z) + 3)}" class="ax" text-anchor="end">${fmt(z, zStep < 1 ? 1 : 0)}</text>`;
    const every = [1, 5, 10, 25, 50, 100].find((k) => (k * 20 * pw) / L >= 46) || 250;
    for (let k = 0; k * 20 <= L + 1e-6; k++) {
      const x = f(X(k * 20)), major = k % every === 0;
      if (!major && (20 * pw) / L < 6) continue;
      out += `<line x1="${x}" x2="${x}" y1="${pad.t}" y2="${H - pad.b}" class="${major ? 'g' : 'g2'}"/>`;
      if (major) out += `<text x="${x}" y="${H - pad.b + 13}" class="ax" text-anchor="middle">No.${k}</text>`;
    }
    // 平面線形の帯
    al.elements.forEach((e) => { out += `<rect x="${f(X(e.s0))}" y="${H - pad.b + 20}" width="${f(Math.max(0.5, (e.L / L) * pw))}" height="5" fill="${COLORS[e.type]}"/>`; });
    out += `<text x="${pad.l - 6}" y="${H - pad.b + 25}" class="ax" text-anchor="end">平面</text>`;
  }
  // 現況地盤
  if (gr) {
    const g = gr.pts.map((p) => [X(p.s), Y(p.h)]);
    out += `<path d="${pl(g)}L${f(g[g.length - 1][0])},${f(pad.t + ph)}L${f(g[0][0])},${f(pad.t + ph)}Z" class="gnd-f"/><path d="${pl(g)}" class="gnd"/>`;
  }
  if (pf) {
    // 切土・盛土
    if (gr) for (let k = 1; k < gr.pts.length; k++) {
      const a = gr.pts[k - 1], b = gr.pts[k], za = Geom.profileAt(pf, a.s).z, zb = Geom.profileAt(pf, b.s).z;
      out += `<path d="M${f(X(a.s))},${f(Y(za))}L${f(X(b.s))},${f(Y(zb))}L${f(X(b.s))},${f(Y(b.h))}L${f(X(a.s))},${f(Y(a.h))}Z" class="${za + zb - a.h - b.h >= 0 ? 'fill' : 'cut'}"/>`;
    }
    // 勾配線（接線）と計画線
    out += `<path d="${pl(pf.pts.map((p) => [X(p.s), Y(p.z)]))}" class="tan"/>`;
    const N = Math.max(50, Math.min(1500, Math.round(pw / 1.5))), plan = [];
    for (let k = 0; k <= N; k++) { const s = (L * k) / N; plan.push([X(s), Y(Geom.profileAt(pf, s).z)]); }
    out += `<path d="${pl(plan)}" class="plan"/>`;
    pf.curves.forEach((c) => { if (c.L > 0) [c.bvc, c.evc].forEach((s) => { out += `<line x1="${f(X(s))}" x2="${f(X(s))}" y1="${f(Y(Geom.profileAt(pf, s).z) - 5)}" y2="${f(Y(Geom.profileAt(pf, s).z) + 5)}" class="vc"/>`; }); });
    if (!sm) {
      pf.grades.forEach((g, k) => {
        const a = pf.pts[k], b = pf.pts[k + 1], xm = (X(a.s) + X(b.s)) / 2, ym = (Y(a.z) + Y(b.z)) / 2;
        if (X(b.s) - X(a.s) > 54) out += `<text x="${f(xm)}" y="${f(ym - 7)}" class="gl${Math.abs(g) * 100 > Rules.T[road.V].grade + 1e-9 ? ' bad' : ''}" text-anchor="middle">${sgnPct(g)}　${fmt(b.s - a.s, 1)}m</text>`;
      });
    }
    pf.pts.forEach((p, i) => {
      const x = X(p.s), y = Y(p.z), nm = i === 0 ? 'BP' : i === pf.pts.length - 1 ? 'EP' : 'VIP' + i;
      if (!sm) {
        const c = pf.curves[i - 1], anc = i === 0 ? 'start' : i === pf.pts.length - 1 ? 'end' : 'middle';
        out += `<text x="${f(x)}" y="${f(y - 12)}" class="vl" text-anchor="${anc}">${nm} ${fmt(p.z, 2)}</text>`;
        if (c && c.L > 0) out += `<text x="${f(x)}" y="${f(y + 18)}" class="vl2" text-anchor="middle">VCL ${fmt(c.L, 0)} R ${isFinite(c.R) ? Math.round(c.R) : '—'}</text>`;
      }
      out += `<circle cx="${f(x)}" cy="${f(y)}" r="${sm ? 3 : 5.5}" class="vh${i === 0 || i === pf.pts.length - 1 ? ' end' : ''}" data-vip="${i}"><title>${nm}（ドラッグで移動。Shift で高さのみ）</title></circle>`;
    });
  }
  if (!sm) out += `<g class="cur" visibility="hidden"><line y1="${pad.t}" y2="${H - pad.b}"/><text y="${pad.t + 10}" class="ax"></text></g>`;
  const d = { road: road.id, len: L, w: W, h: H, pl: pad.l, pw, pt: pad.t, ph, lo: rg.lo, hi: rg.hi };
  return `<svg class="vchart${sm ? ' sm' : ''}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" ${Object.entries(d).map(([k, v]) => `data-${k}="${v}"`).join(' ')}>${out}</svg>`;
}

/* 地図下部の縦断図 */
function renderDock() {
  const el = $('#vdock'), road = selRoad(), on = !!(ui.vdock && road && road.visible !== false && road.vips && road.vips.length >= 2);
  if (el.hidden === on) { el.hidden = !on; $('#stage').classList.toggle('dock-on', on); map.invalidateSize({ pan: false }); }
  if (!on) { el.innerHTML = ''; return; }
  const W = Math.max(320, el.clientWidth), H = Math.max(140, el.clientHeight - 32);
  el.innerHTML = `<div class="vd-head"><b>縦断図</b><span class="muted">${esc(road.name)}・延長 ${fmt(calc(road).length, 1)} m</span>
    <span class="lg"><i class="l-plan"></i>計画高 <i class="l-gnd"></i>現況地盤 <i class="l-fill"></i>盛土 <i class="l-cut"></i>切土</span>
    <span class="muted small vd-hint">● ドラッグで測点・計画高を変更（<kbd>Shift</kbd> 高さのみ）・ダブルクリックで変化点を追加</span>
    ${ui.profiles.get(road.id) ? '' : '<button class="btn" data-act="profile">現況地盤を取得</button>'}<button class="btn" data-act="vip-add">変化点を追加</button><button class="ibtn" data-act="vdock-toggle" title="閉じる">✕</button></div>`
    + profileSvg(road, W, H);
}
addEventListener('resize', () => renderDock());

function ipBlock(road, al) {
  const i = ui.sel.ip, ip = road.ips[i], n = road.ips.length, ll = P.toLL(ip.x, ip.y);
  const end = i === 0 || i === n - 1, name = i === 0 ? 'BP（起点）' : i === n - 1 ? 'EP（終点）' : 'IP' + i;
  let h = `<div class="row">${num('X', 'ip.x', ip.x, { unit: 'm', step: 0.5 })}${num('Y', 'ip.y', ip.y, { unit: 'm', step: 0.5 })}</div>`;
  if (!end) {
    const c = al.curves[i], t = Rules.T[road.V];
    h += `<div class="row">${num('R', 'ip.R', ip.R, { unit: 'm', step: 1, dec: 1, title: `曲線半径（最小 ${t.Rmin}m／特例 ${t.Rex}m）` })}${num('交角', '', deg(Math.abs(c.delta)), { ro: true, unit: c.delta > 0 ? '° 左' : '° 右', dec: 2 })}</div>
      <div class="row">${num('A1', 'ip.A1', ip.A1, { step: 1, dec: 1, title: '起点側クロソイドパラメータ（A² = R·L）' })}${num('L1', 'ip.L1', ip.R > 0 ? (ip.A1 * ip.A1) / ip.R : 0, { unit: 'm', step: 1, dec: 2, title: `起点側クロソイド長（緩和区間長 ${t.Ls}m 以上）` })}</div>
      <div class="row">${num('A2', 'ip.A2', ip.A2, { step: 1, dec: 1, title: '終点側クロソイドパラメータ' })}${num('L2', 'ip.L2', ip.R > 0 ? (ip.A2 * ip.A2) / ip.R : 0, { unit: 'm', step: 1, dec: 2, title: '終点側クロソイド長' })}</div>`;
    if (!c.none) {
      const sp = Rules.curveSpeed(road, c.R);
      h += kv([['接線長 TL1 / TL2', `${fmt(c.T1)} / ${fmt(c.T2)} m`], ['円曲線長 Lc', `${fmt(c.Lc)} m`], ['曲線長 CL（緩和含む）', `${fmt(c.CL)} m`],
        ['移程量 ΔR1 / ΔR2', `${fmt(c.p1, 3)} / ${fmt(c.p2, 3)} m`], ['接線角 τ1 / τ2', `${fmt(deg(c.tau1), 2)}° / ${fmt(deg(c.tau2), 2)}°`],
        ['必要片勾配', `${fmt(Math.max(0, sp.need) * 100, 1)} %`], ['走行可能速度（最大片勾配時）', `約 ${Math.floor(sp.vMax)} km/h`]]);
    }
    h += `<div class="row" style="margin-top:8px"><button class="btn" data-act="ip-recommend" title="設計速度に応じた推奨値（前後区間に収まる範囲）を設定">推奨値を適用</button><button class="btn danger" data-act="ip-delete">IP を削除</button></div>`;
  } else {
    h += kv([['緯度, 経度', `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`], ['接線方位角', fmt(azimuth(i === 0 ? al.dirs[0] : al.dirs[al.dirs.length - 1]), 1) + '°']]);
    if (n > 2) h += `<div class="row one" style="margin-top:8px"><button class="btn danger" data-act="ip-delete">この端点を削除</button></div>`;
  }
  return sec(name, h);
}

function roadPanel(road) {
  const al = calc(road), c = Rules.CLASSES[road.cls];
  const speedOpts = Rules.SPEEDS.map((v) => [v, `${v} km/h${c.V.includes(v) ? '' : c.Vex.includes(v) ? '（特例）' : '（規定外）'}`]);
  const els = al.elements.map((e, i) => `<tr data-el="${i}"><td><span class="tag ${e.type}"></span>${ELNAME[e.type]}</td><td>${fmt(e.s0, 1)}</td><td>${fmt(e.L, 2)}</td><td>${e.type === 'arc' ? 'R ' + fmt(e.R, 1) : e.type === 'clothoid' ? 'A ' + fmt(e.A, 1) : fmt(azimuth(e.th0), 1) + '°'}</td></tr>`).join('');
  return widthSec(road, 'road', '幅員・車線数')
    + (ui.sel.ip != null ? ipBlock(road, al) : '')
    + sec('道路', `<div class="row one"><label class="fld"><span class="lb">名称</span><input type="text" data-key="road.name" value="${esc(road.name)}"></label></div>
      <div class="row one">${sel('区分', 'road.cls', road.cls, Object.entries(Rules.CLASSES).map(([k, v]) => [k, v.name]))}</div>
      <div class="row one">${sel('設計速度', 'road.V', road.V, speedOpts)}</div>
      <label class="chk" title="建築基準法 第42条第1項第5号（位置指定道路）の基準もあわせて照査"><input type="checkbox" data-key="road.shitei"${road.shitei ? ' checked' : ''}>位置指定道路の基準も照査</label>`,
      `<button class="ibtn" data-act="zoom-road" title="全体を表示">${ic('target')}</button><button class="ibtn" data-act="del-road" title="道路を削除">${ic('trash')}</button>`)
    + sec('平面線形', kv([['延長', `${fmt(al.length)} m`], ['IP 数（曲線）', `${road.ips.length - 2 < 0 ? 0 : al.curves.filter((x) => x && !x.none).length}`], ['最小曲線半径', (() => { const r = al.curves.filter((x) => x && !x.none).map((x) => x.R); return r.length ? fmt(Math.min(...r), 1) + ' m' : '—'; })()]])
      + (els ? `<table class="els" style="margin-top:8px"><tr><th>要素</th><th>起点 m</th><th>長さ m</th><th>諸元</th></tr>${els}</table>` : ''))
    + sec('既存道路との接続', connBlock(road, 'start', '起点', al) + connBlock(road, 'end', '終点', al))
    + sec('縦断計画（計画高）', vplanBlock(road));
}

function checkPanel(road, res) {
  const lv = (l) => res.filter((r) => r.level === l);
  const item = (r) => `<div class="ci lv-${r.level}"${r.ip != null ? ` data-ip="${r.ip}"` : ''}><span class="mk"></span><div><b>${esc(r.title)}</b><span class="dt">${esc(r.detail)}</span>${r.ref ? `<div class="rf">${esc(r.cat)} ・ ${esc(r.ref)}</div>` : ''}</div></div>`;
  const pill = (l, t) => `<span class="pill lv-${l}"><i></i>${t} ${lv(l).length}</span>`;
  return `<div class="chk-sum">${pill('error', '不適合')}${pill('warn', '要確認')}${pill('info', '参考')}${pill('ok', '適合')}</div>`
    + lv('error').map(item).join('') + lv('warn').map(item).join('') + lv('info').map(item).join('')
    + `<details class="okgrp"><summary>適合項目（${lv('ok').length}）</summary>${lv('ok').map(item).join('')}</details>`
    + `<div class="note">道路構造令（本則の表）・建築基準法施行令および「道路構造令の解説と運用」の一般的な目安に基づく簡易照査です。道路管理者の条例・基準、特例値の適用条件、交差点詳細は別途確認してください。</div>`;
}

function existingPanel() {
  const ex = project.existing.find((e) => e.id === ui.sel.id);
  if (!ex) return emptyPanel();
  const info = existingInfo(ex, ui.sel.at), az = azimuth(info.bearing);
  return sec('既存道路', kv([['名称', esc(ex.name || '（名称なし）')], ['種別', esc(ex.clsJa) + (ex.cls !== ex.clsJa ? `（${esc(ex.cls)}）` : '')], ['延長', ui.sel.whole === false ? `選択区間 ${fmt(ui.sel.len, 1)} m ／ 全体 ${fmt(ui.sel.total, 1)} m` : fmt(info.length, 1) + ' m'],
    ['幅員', `約 ${fmt(ex.width, 1)} m`], ['幅員の根拠', esc(ex.widthNote)], ex.lanes ? ['車線数', ex.lanes] : null,
    ['速度', `${ex.speed} km/h${ex.speedEst ? '（種別から推定）' : '（最高速度）'}`], ['一方通行', ex.oneway ? 'あり' : 'なし'], ex.surface ? ['路面', esc(ex.surface)] : null,
    ['クリック位置の方位角', `${fmt(az, 1)}° / ${fmt((az + 180) % 360, 1)}°`], ['データ', esc(ex.src) + ' ' + esc(ex.id.replace(/^(osm|gsi)-/, ''))]]))
    + (ui.sel.whole === false
      ? `<div class="row" style="margin:8px 12px"><button class="btn danger" data-act="del-existing-piece" title="交差点・屈曲点で区切られた、青く表示中の区間だけを削除">この区間を削除 (Delete)</button><button class="btn" data-act="del-existing" title="交差点・屈曲点をまたいで、この道路全体を削除">道路全体を削除</button></div>`
      : `<div class="row one" style="margin:8px 12px"><button class="btn danger" data-act="del-existing">この既存道路を削除 (Delete)</button></div>`)
    + `<div class="note">幅員・速度はデータにタグが無い場合は推定値です。接続設計では現地測量値・道路台帳を確認してください。<br>この道路に接続するには <b>道路を描く</b> で線上をクリックします。</div>`;
}

function imagePanel() {
  const im = project.image;
  return sec('下絵画像', `<div class="row">${num('幅', 'img.w', im.w, { unit: 'm', step: 1 })}${num('回転', 'img.rot', im.rot, { unit: '°', step: 0.5 })}</div>
    <div class="row">${num('X', 'img.cx', im.cx, { unit: 'm' })}${num('Y', 'img.cy', im.cy, { unit: 'm' })}</div>
    <div class="row one">${num('不透明度', 'img.opacity', im.opacity * 100, { unit: '%', dec: 0 })}</div>
    <div class="row one"><button class="btn wide accent" data-act="img-scale">2 点間の実距離で縮尺を合わせる</button></div>
    <div class="row"><button class="btn" data-act="add-image">画像を差し替え</button><button class="btn danger" data-act="del-image">削除</button></div>`)
    + `<div class="note">紫のハンドル: 中央=移動、右上=回転・拡縮。<br>図面のスケールバーや寸法線の両端をクリックして縮尺を合わせると、図面上で正しい長さの道路を描けます。</div>`;
}

function renderChrome() {
  const tools = [['select', '選択 (V)'], ['draw', '道路を描く (P)'], ['measure', '計測 (M)']];
  $('#toolbar').innerHTML = tools.map(([t, tip]) => `<button class="${ui.tool === t ? 'on' : ''}" data-act="tool-${t}" data-tip="${tip}">${ic(t)}</button>`).join('')
    + `<span class="sep"></span><button data-act="fetch-osm" data-tip="既存道路を取得 (OSM)">${ic('roads')}</button><button data-act="add-image" data-tip="下絵画像を追加">${ic('image')}</button>`;
  const u = $('[data-act=undo]'), r = $('[data-act=redo]');
  u.innerHTML = ic('undo'); r.innerHTML = ic('redo'); $('[data-act=help]').innerHTML = ic('help');
  u.disabled = !hist.undo.length; r.disabled = !hist.redo.length;
  if (document.activeElement !== $('#projName')) $('#projName').value = project.name;
}
function renderPanels() { renderChrome(); renderLeft(); renderRight(); renderDock(); }

/* ───────── 値の変更 ───────── */
function setValue(key, raw, live) {
  const v = parseFloat(raw), road = selRoad(), pos = (x, min = 0) => (isFinite(x) ? Math.max(min, x) : null);
  const ip = road && ui.sel.ip != null ? road.ips[ui.sel.ip] : null, im = project.image;
  const set = (o, k, val) => { if (val != null) o[k] = val; };
  const applyClass = (o) => { const c = Rules.CLASSES[o.cls]; if (![...c.V, ...c.Vex].includes(o.V)) o.V = c.V[c.V.length - 1]; o.laneW = c.lane; o.shoulderW = c.shoulder; o.lanes = c.single ? 1 : Math.max(2, o.lanes); };
  switch (key.startsWith('vip.') ? 'vip' : key) {
    case 'road.name': road.name = raw || '計画道路'; break;
    case 'road.cls': road.cls = raw; applyClass(road); break;
    case 'road.V': road.V = +raw; break;
    case 'road.shitei': road.shitei = !!raw; break;
    case 'road.lanes': set(road, 'lanes', isFinite(v) ? Math.max(1, Math.min(8, Math.round(v))) : null); break;
    case 'road.laneW': set(road, 'laneW', pos(v, 2)); break;
    case 'road.shoulderW': set(road, 'shoulderW', pos(v)); break;
    case 'road.sidewalkW': set(road, 'sidewalkW', pos(v)); break;
    case 'def.cls': project.defaults.cls = raw; applyClass(project.defaults); break;
    case 'def.V': project.defaults.V = +raw; break;
    case 'def.lanes': set(project.defaults, 'lanes', isFinite(v) ? Math.max(1, Math.min(8, Math.round(v))) : null); break;
    case 'def.laneW': set(project.defaults, 'laneW', pos(v, 2)); break;
    case 'def.shoulderW': set(project.defaults, 'shoulderW', pos(v)); break;
    case 'def.sidewalkW': set(project.defaults, 'sidewalkW', pos(v)); break;
    case 'ip.x': set(ip, 'x', isFinite(v) ? v : null); break;
    case 'ip.y': set(ip, 'y', isFinite(v) ? v : null); break;
    case 'ip.R': set(ip, 'R', pos(v)); break;
    case 'ip.A1': set(ip, 'A1', pos(v)); break;
    case 'ip.A2': set(ip, 'A2', pos(v)); break;
    case 'ip.L1': if (isFinite(v) && ip.R > 0) ip.A1 = Math.sqrt(ip.R * Math.max(0, v)); break;
    case 'ip.L2': if (isFinite(v) && ip.R > 0) ip.A2 = Math.sqrt(ip.R * Math.max(0, v)); break;
    case 'conn.start.mode': road.conn.start.mode = raw; break;
    case 'conn.end.mode': road.conn.end.mode = raw; break;
    case 'conn.start.speed': if (v > 0) { road.conn.start.speed = v; road.conn.start.speedEst = false; } break;
    case 'conn.end.speed': if (v > 0) { road.conn.end.speed = v; road.conn.end.speedEst = false; } break;
    case 'vip': {
      const [, i, f] = key.split('.'), vp = road && road.vips && road.vips[+i];
      if (!vp || !isFinite(v)) return;
      if (f === 's') vp.s = Math.min(calc(road).length, Math.max(0, v));
      else if (f === 'z') vp.z = v;
      else if (f === 'VCL') vp.VCL = Math.max(0, v);
      break;
    }
    case 'img.w': set(im, 'w', pos(v, 1)); break;
    case 'img.rot': set(im, 'rot', isFinite(v) ? v : null); break;
    case 'img.cx': set(im, 'cx', isFinite(v) ? v : null); break;
    case 'img.cy': set(im, 'cy', isFinite(v) ? v : null); break;
    case 'img.opacity': set(im, 'opacity', isFinite(v) ? Math.max(0.05, Math.min(1, v / 100)) : null); break;
    case 'base.opacity': if (isFinite(v)) { project.baseOpacity = Math.max(0, Math.min(1, v / 100)); baseLayer && baseLayer.setOpacity(project.baseOpacity); } break;
    case 'googleKey': project.googleKey = raw.trim(); save(); return;
    case 'existingWidth': project.existingWidth = raw === '1'; save(); return renderExisting();
    case 'base': { const prev = project.base; setBase(raw).then((ok) => { if (!ok) project.base = prev; save(); renderPanels(); }); return; }
    default: return;
  }
  if (road) {
    normalize(road);
    if (key.startsWith('road.')) project.defaults = { cls: road.cls, V: road.V, lanes: road.lanes, laneW: road.laneW, shoulderW: road.shoulderW, sidewalkW: road.sidewalkW, shitei: !!road.shitei };
    if (key.startsWith('ip.') || key.startsWith('conn.')) ui.profiles.delete(road.id);
  }
  if (key.startsWith('img.')) syncImageLayer();
  if (live) { renderMap(); if (key.startsWith('vip.')) renderDock(); }
  else if (key.startsWith('def.') || key === 'base.opacity') { save(); renderPanels(); if (key.startsWith('def.')) updateHint(); }
  else commit();
}

/* ───────── イベント ───────── */
document.addEventListener('change', (e) => {
  const t = e.target, key = t.dataset && t.dataset.key;
  if (t.id === 'projName') { project.name = t.value || '無題の道路計画'; save(); return; }
  if (t.id === 'fileOpen') { if (t.files[0]) openProjectFile(t.files[0]); t.value = ''; return; }
  if (t.id === 'fileImage') { if (t.files[0]) addImageFile(t.files[0]); t.value = ''; return; }
  if (key) setValue(key, t.type === 'checkbox' ? t.checked : t.value);
});
document.addEventListener('keydown', (e) => {
  const t = e.target, typing = /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);
  if (typing) {
    if (e.key === 'Enter') t.blur();
    if (e.key === 'Escape') { renderPanels(); }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && t.dataset.key && t.dataset.step && !t.readOnly && t.tagName === 'INPUT' && t.type !== 'text' && t.type !== 'password') {
      e.preventDefault();
      const stp = +t.dataset.step * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      t.value = fmt((parseFloat(t.value) || 0) + stp, +t.dataset.dec); setValue(t.dataset.key, t.value, true);
    }
    return;
  }
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod && k === 's') { e.preventDefault(); save(); toast('ブラウザに保存しました'); }
  else if (mod) return;
  else if (k === 'v') setTool('select');
  else if (k === 'p' || k === 'r') setTool('draw');
  else if (k === 'm') setTool('measure');
  else if (k === '?') showHelp();
  else if (k === 'enter' && ui.tool === 'draw') { ui.draw.cursor = null; finishDraw(); }
  else if (k === 'escape') { if (!$('#modal').hidden) $('#modal').hidden = true; else if (ui.tool !== 'select') setTool('select'); else select(null); }
  else if (k === 'backspace' && ui.tool === 'draw') { e.preventDefault(); ui.draw.ips.pop(); if (!ui.draw.ips.length) { ui.draw.startRef = null; ui.draw.cursor = null; } renderMap(); }
  else if (k === 'delete' || k === 'backspace') { const r = selRoad(); if (r && ui.sel.ip != null) act('ip-delete'); else if (r) act('del-road'); else if (ui.sel && ui.sel.type === 'existing') act('del-existing-piece'); }
});

/* 縦断図: ● のドラッグで変化点を移動、ダブルクリックで追加、ホバーで地図上の位置を表示 */
function vchartAt(d, rect, e) {
  const vx = ((e.clientX - rect.left) * d.w) / rect.width, vy = ((e.clientY - rect.top) * d.h) / rect.height;
  return { s: ((vx - d.pl) / d.pw) * d.len, z: d.hi - ((vy - d.pt) / d.ph) * (d.hi - d.lo), vx };
}
const vchartData = (svg) => Object.fromEntries(Object.entries(svg.dataset).map(([k, v]) => [k, k === 'road' ? v : +v]));
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest && e.target.closest('svg.vchart [data-vip]'), road = selRoad();
  if (!h || !road || !road.vips) return;
  e.preventDefault(); e.stopPropagation();
  const svg = h.ownerSVGElement, d = vchartData(svg), rect = svg.getBoundingClientRect(), i = +h.dataset.vip, n = road.vips.length, v = road.vips[i];
  const p0 = vchartAt(d, rect, e), s0 = v.s, z0 = v.z;
  let moved = false;
  ui.vdrag = { road: road.id, range: { lo: d.lo, hi: d.hi } };
  const mv = (ev) => {
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
    moved = true;
    const p = vchartAt(d, rect, ev);
    v.z = r2(z0 + p.z - p0.z);
    if (i > 0 && i < n - 1 && !ev.shiftKey) {
      const L = calc(road).length, a = i > 0 ? road.vips[i - 1].s : 0, b = i < n - 2 ? road.vips[i + 1].s : L;
      v.s = Math.round(Math.min(b - 1, Math.max(a + 1, s0 + p.s - p0.s)) * 10) / 10;
    } else if (i > 0 && i < n - 1) v.s = s0;
    schedulePanel();
  };
  const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); ui.vdrag = null; if (moved) commit(); else renderPanels(); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
}, true);
document.addEventListener('dblclick', (e) => {
  const svg = e.target.closest && e.target.closest('svg.vchart'), road = selRoad();
  if (!svg || !road || !road.vips || e.target.closest('[data-vip]')) return;
  const d = vchartData(svg), p = vchartAt(d, svg.getBoundingClientRect(), e);
  if (p.s <= 0 || p.s >= d.len) return;
  const i = addVip(road, p.s); if (i) commit();
});
document.addEventListener('pointermove', (e) => {
  const svg = e.target.closest && e.target.closest('svg.vchart'), road = selRoad();
  if (!svg || !road || ui.vdrag) return;
  const d = vchartData(svg), p = vchartAt(d, svg.getBoundingClientRect(), e), al = calc(road), s = Math.min(Math.max(p.s, 0), al.length);
  const cur = svg.querySelector('.cur');
  if (cur) {
    const inside = p.s >= 0 && p.s <= d.len, x = d.pl + (s / d.len) * d.pw, pf = Geom.computeProfile(road.vips, al.length), h = groundAt(road, s);
    cur.setAttribute('visibility', inside ? 'visible' : 'hidden');
    const ln = cur.querySelector('line'), tx = cur.querySelector('text');
    ln.setAttribute('x1', x); ln.setAttribute('x2', x);
    tx.setAttribute('x', x > d.w - 220 ? x - 6 : x + 6); tx.setAttribute('text-anchor', x > d.w - 220 ? 'end' : 'start');
    const z = pf ? Geom.profileAt(pf, s) : null;
    tx.textContent = `${station(s)}` + (z ? `　計画高 ${fmt(z.z, 2)}m（${sgnPct(z.g)}）` : '') + (h != null ? `　地盤 ${fmt(h, 2)}m` : '') + (z && h != null ? `　${z.z >= h ? '盛' : '切'} ${fmt(Math.abs(z.z - h), 2)}m` : '');
  }
  const pose = Geom.poseAt(al, s);
  gHover.clearLayers();
  if (pose) L.circleMarker(P.toLL(pose.x, pose.y), { radius: 6, color: '#f24822', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false, pane: 'labels' }).addTo(gHover);
});
document.addEventListener('pointerleave', (e) => { if (e.target.matches && e.target.matches('svg.vchart')) { gHover.clearLayers(); const c = e.target.querySelector('.cur'); if (c) c.setAttribute('visibility', 'hidden'); } }, true);

/* ラベルのドラッグで数値を増減（スクラブ） */
document.addEventListener('pointerdown', (e) => {
  const lb = e.target.closest && e.target.closest('[data-scrub]');
  if (!lb) return;
  const input = lb.parentElement.querySelector('input');
  if (!input || !input.dataset.key || input.type === 'text') return;
  e.preventDefault();
  const x0 = e.clientX, v0 = parseFloat(input.value) || 0, step = +input.dataset.step || 1, dec = +input.dataset.dec;
  let moved = false;
  const mv = (ev) => { const dx = ev.clientX - x0; if (Math.abs(dx) < 3 && !moved) return; moved = true; input.value = fmt(v0 + Math.round(dx / 3) * step, dec); setValue(input.dataset.key, input.value, true); };
  const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (moved) setValue(input.dataset.key, input.value); else input.select(); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
});

function act(a, el) {
  const road = selRoad(), id = el && el.closest('[data-id]') ? el.closest('[data-id]').dataset.id : null;
  switch (a) {
    case 'undo': return undo();
    case 'redo': return redo();
    case 'tool-select': return setTool('select');
    case 'tool-draw': return setTool(ui.tool === 'draw' ? 'select' : 'draw');
    case 'tool-measure': return setTool(ui.tool === 'measure' ? 'select' : 'measure');
    case 'zoom-in': return map.zoomIn();
    case 'zoom-out': return map.zoomOut();
    case 'fetch-osm': return fetchOSM();
    case 'fetch-gsi': return fetchGSI();
    case 'clear-existing': return clearExisting();
    case 'del-existing': return ui.sel && ui.sel.type === 'existing' && deleteExisting(ui.sel.id);
    case 'del-existing-piece': return deleteExistingPiece();
    case 'dedupe-existing': return dedupeExisting();
    case 'vis-existing': project.existingVisible = !project.existingVisible; save(); renderExisting(); return renderPanels();
    case 'add-image': return $('#fileImage').click();
    case 'sel-image': return select({ type: 'image' });
    case 'vis-image': project.image.visible = !project.image.visible; syncImageLayer(); return commit();
    case 'del-image': project.image = null; ui.imageUrl = null; idb.set('image', null).catch(() => {}); ui.sel = null; syncImageLayer(); return commit();
    case 'img-scale': ui.tool = 'pick'; ui.pick = []; setTool('pick'); ui.pick = []; return;
    case 'sel-road': ui.tab = ui.tab || 'design'; return select({ type: 'road', id });
    case 'vis-road': { const r = roadById(id); r.visible = r.visible === false; return commit(); }
    case 'lanes-step': { const o = el.dataset.pre === 'def' ? project.defaults : road; if (o) setValue(el.dataset.pre + '.lanes', String(o.lanes + +el.dataset.d)); return; }
    case 'tab-design': ui.tab = 'design'; return renderPanels();
    case 'tab-check': ui.tab = 'check'; return renderPanels();
    case 'zoom-road': { const al = calc(road); if (al.samples.length) map.fitBounds(L.latLngBounds(al.samples.map((p) => P.toLL(p.x, p.y))).pad(0.25)); return; }
    case 'del-road': project.roads = project.roads.filter((r) => r !== road); alCache.delete(road.id); ui.sel = null; return commit();
    case 'ip-delete': {
      const i = ui.sel.ip, n = road.ips.length; if (n <= 2) return toast('IP は 2 点以上必要です。道路ごと削除するには道路を選択して Delete', 'err');
      road.ips.splice(i, 1);
      if (i === 0) { road.conn.start = null; Object.assign(road.ips[0], { R: 0, A1: 0, A2: 0 }); }
      if (i === n - 1) { road.conn.end = null; Object.assign(road.ips[n - 2], { R: 0, A1: 0, A2: 0 }); }
      ui.sel.ip = null; ui.profiles.delete(road.id); normalize(road); return commit();
    }
    case 'ip-recommend': fitCurve(road, ui.sel.ip); ui.profiles.delete(road.id); return commit();
    case 'profile': return loadProfile(road);
    case 'vplan-ground': return createVplan(road, 'ground');
    case 'vplan-flat': return createVplan(road, 'flat');
    case 'vplan-del': if (confirm('この道路の計画縦断（縦断変化点）を削除しますか？')) { delete road.vips; ui.vdock = false; commit(); } return;
    case 'vip-add': { const i = addVip(road); if (i) commit(); return; }
    case 'vip-del': road.vips.splice(+el.dataset.i, 1); return commit();
    case 'vip-fit': for (let i = 1; i < road.vips.length - 1; i++) fitVCL(road, i); return commit();
    case 'vip-ends': {
      const L = calc(road).length;
      if (road.conn.start) road.vips[0].z = r2(groundAt(road, 0));
      if (road.conn.end) road.vips[road.vips.length - 1].z = r2(groundAt(road, L));
      return commit();
    }
    case 'vdock-toggle': ui.vdock = !ui.vdock; return renderPanels();
    case 'vdock-open': ui.vdock = true; return renderPanels();
    case 'new': if (confirm('現在のプロジェクトを破棄して新規作成しますか？（必要なら先に書き出してください）')) { const keep = { base: project.base, googleKey: project.googleKey, view: project.view }; project = Object.assign(newProject(), keep); ui.sel = null; ui.imageUrl = null; idb.set('image', null).catch(() => {}); resetAll(); } return;
    case 'open': return $('#fileOpen').click();
    case 'menu-export': $('#exportMenu').hidden = !$('#exportMenu').hidden; return;
    case 'export-pdf': return exportPDF();
    case 'export-json': return download(project.name + '.json', JSON.stringify(Object.assign({}, project, { imageData: ui.imageUrl || null }), null, 1), 'application/json');
    case 'export-geojson': return download(project.name + '.geojson', JSON.stringify(toGeoJSON(), null, 1), 'application/geo+json');
    case 'export-csv': return download(project.name + '_線形計算書.csv', '﻿' + toCSV(), 'text/csv');
    case 'export-dxf': return download(project.name + '.dxf', toDXF(), 'application/dxf');
    case 'help': return showHelp();
    case 'close-modal': $('#modal').hidden = true; return;
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!e.target.closest('.menu')) $('#exportMenu').hidden = true;
  if (b) {
    const inner = e.target.closest('button[data-act]');
    return act((inner || b).dataset.act, inner || b);
  }
  const ci = e.target.closest('.ci[data-ip]'), road = selRoad();
  if (ci && road) { const i = +ci.dataset.ip, ip = road.ips[i]; ui.sel = { type: 'road', id: road.id, ip: i }; map.panTo(P.toLL(ip.x, ip.y)); refresh(); }
  if (e.target === $('#modal')) $('#modal').hidden = true;
});
/* 要素表のホバーで地図上の要素を強調 */
document.addEventListener('mouseover', (e) => {
  const tr = e.target.closest && e.target.closest('tr[data-el]'), road = selRoad();
  gHover.clearLayers();
  if (tr && road) { const al = calc(road), pts = al.byEl[+tr.dataset.el]; if (pts) L.polyline(pts.map((p) => P.toLL(p.x, p.y)), { color: '#fff', weight: 9, opacity: 0.9, interactive: false, pane: 'design' }).addTo(gHover) && L.polyline(pts.map((p) => P.toLL(p.x, p.y)), { color: COLORS[al.elements[+tr.dataset.el].type], weight: 5, interactive: false, pane: 'design' }).addTo(gHover); }
});

/* ───────── 入出力 ───────── */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('#exportMenu').hidden = true;
}
function openProjectFile(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const p = JSON.parse(fr.result);
      if (!p || p.version !== 1 || !Array.isArray(p.roads)) throw new Error('形式が違います');
      ui.imageUrl = p.imageData || null; delete p.imageData;
      idb.set('image', ui.imageUrl).catch(() => {});
      project = Object.assign(newProject(), p, { googleKey: project.googleKey }); ui.sel = null;
      if (project.view) map.setView([project.view.lat, project.view.lng], project.view.zoom);
      resetAll(); toast('プロジェクトを開きました');
    } catch (err) { toast('読み込めませんでした: ' + err.message, 'err'); }
  };
  fr.readAsText(file);
}
function toGeoJSON() {
  const feats = [], c = (p) => { const ll = P.toLL(p.x, p.y); return [+ll.lng.toFixed(8), +ll.lat.toFixed(8)]; };
  for (const r of project.roads) {
    const al = calc(r), hw = Rules.totalWidth(r) / 2, off = (d) => al.samples.map((p) => c({ x: p.x - Math.sin(p.th) * d, y: p.y + Math.cos(p.th) * d }));
    const base = { road: r.name, class: Rules.CLASSES[r.cls].name, designSpeed: r.V };
    const pf = Geom.computeProfile(r.vips, al.length), c3 = (p) => (pf ? [...c(p), +Geom.profileAt(pf, p.s).z.toFixed(3)] : c(p));
    feats.push({ type: 'Feature', properties: { ...base, kind: 'centerline', length: +al.length.toFixed(3), width: Rules.totalWidth(r) }, geometry: { type: 'LineString', coordinates: al.samples.map(c3) } });
    if (al.samples.length > 1) feats.push({ type: 'Feature', properties: { ...base, kind: 'area' }, geometry: { type: 'Polygon', coordinates: [[...off(hw), ...off(-hw).reverse(), off(hw)[0]]] } });
    al.points.forEach((pt) => feats.push({ type: 'Feature', properties: { ...base, kind: 'point', name: pt.name, station: +pt.s.toFixed(3) }, geometry: { type: 'Point', coordinates: c(pt) } }));
    r.ips.forEach((ip, i) => feats.push({ type: 'Feature', properties: { ...base, kind: 'IP', index: i, R: ip.R || 0, A1: ip.A1 || 0, A2: ip.A2 || 0 }, geometry: { type: 'Point', coordinates: c(ip) } }));
  }
  return { type: 'FeatureCollection', features: feats };
}
function toCSV() {
  const rows = [], q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  for (const r of project.roads) {
    const al = calc(r);
    rows.push([q(r.name), q(Rules.CLASSES[r.cls].name), `設計速度 ${r.V}km/h`, `延長 ${fmt(al.length, 3)}m`, `全幅 ${fmt(Rules.totalWidth(r))}m`]);
    rows.push(['[IP]', 'X(m)', 'Y(m)', '緯度', '経度', 'R', 'A1', 'A2', '交角(°)', 'TL1', 'TL2', 'L1', 'Lc', 'L2', 'CL']);
    r.ips.forEach((ip, i) => { const cv = al.curves[i], ll = P.toLL(ip.x, ip.y); rows.push([i === 0 ? 'BP' : i === r.ips.length - 1 ? 'EP' : 'IP' + i, fmt(ip.x, 3), fmt(ip.y, 3), ll.lat.toFixed(8), ll.lng.toFixed(8), ...(cv && !cv.none ? [fmt(cv.R, 3), fmt(cv.A1, 3), fmt(cv.A2, 3), fmt(deg(cv.delta), 4), fmt(cv.T1, 3), fmt(cv.T2, 3), fmt(cv.L1, 3), fmt(cv.Lc, 3), fmt(cv.L2, 3), fmt(cv.CL, 3)] : [])]); });
    rows.push(['[主要点]', '測点', '追加距離(m)', 'X(m)', 'Y(m)', '緯度', '経度', '接線方位角(°)']);
    al.points.forEach((pt) => { const ll = P.toLL(pt.x, pt.y); rows.push([pt.name, q(station(pt.s)), fmt(pt.s, 3), fmt(pt.x, 3), fmt(pt.y, 3), ll.lat.toFixed(8), ll.lng.toFixed(8), fmt(azimuth(pt.th), 4)]); });
    rows.push(['[要素]', '種別', '起点追加距離(m)', '長さ(m)', 'R(m)', 'A']);
    al.elements.forEach((e, i) => rows.push([i + 1, ELNAME[e.type], fmt(e.s0, 3), fmt(e.L, 3), e.R ? fmt(e.R, 3) : '', e.A ? fmt(e.A, 3) : '']));
    if (r.vips && r.vips.length >= 2) {
      const pf = Geom.computeProfile(r.vips, al.length);
      rows.push(['[縦断変化点]', '追加距離(m)', '計画高(m)', '縦断曲線長VCL(m)', '前勾配(%)', '後勾配(%)', '縦断曲線半径(m)', '種別']);
      pf.pts.forEach((p, i) => { const cv = pf.curves[i - 1]; rows.push([i === 0 ? 'BP' : i === pf.pts.length - 1 ? 'EP' : 'VIP' + i, fmt(p.s, 3), fmt(p.z, 3), cv ? fmt(cv.L, 3) : '', i > 0 ? fmt(pf.grades[i - 1] * 100, 3) : '', i < pf.pts.length - 1 ? fmt(pf.grades[i] * 100, 3) : '', cv && isFinite(cv.R) ? fmt(cv.R, 1) : '', cv && cv.L > 0 && Math.abs(cv.dg) > 0.0005 ? (cv.crest ? '凸形' : '凹形') : '']); });
      rows.push(['[縦断計算]', '測点', '追加距離(m)', '計画高(m)', '勾配(%)', '地盤高(m)', '切盛(m) +盛/-切']);
      vplanRows(r).forEach((x) => rows.push([q(x.name), q(x.station), fmt(x.s, 3), fmt(x.z, 3), fmt(x.g * 100, 3), x.h == null ? '' : fmt(x.h, 3), x.d == null ? '' : fmt(x.d, 3)]));
    }
    rows.push(['[照査]', '判定', '項目', '内容', '根拠']);
    checksOf(r).forEach((c) => rows.push(['', { error: '不適合', warn: '要確認', info: '参考', ok: '適合' }[c.level], q(c.title), q(c.detail), q(c.ref)]));
    rows.push([]);
  }
  return rows.map((r) => r.join(',')).join('\r\n');
}
function toDXF() {
  let s = '0\nSECTION\n2\nENTITIES\n';
  const pl = (layer, pts, closed, zf) => { s += `0\nPOLYLINE\n8\n${layer}\n66\n1\n70\n${(closed ? 1 : 0) | (zf ? 8 : 0)}\n`; pts.forEach((p) => { s += `0\nVERTEX\n8\n${layer}\n10\n${p.x.toFixed(4)}\n20\n${p.y.toFixed(4)}\n30\n${zf ? zf(p).toFixed(4) : '0.0'}\n${zf ? '70\n32\n' : ''}`; }); s += '0\nSEQEND\n'; };
  for (const r of project.roads) {
    const al = calc(r), off = (d) => al.samples.map((p) => ({ x: p.x - Math.sin(p.th) * d, y: p.y + Math.cos(p.th) * d }));
    const hw = Rules.carriage(r) / 2, sh = hw + r.shoulderW, sw = sh + r.sidewalkW;
    const pf = Geom.computeProfile(r.vips, al.length);
    pl('CENTER', al.samples, false, pf ? (p) => Geom.profileAt(pf, p.s).z : null); pl('IP', r.ips);
    [hw, -hw].forEach((d) => pl('LANE_EDGE', off(d)));
    if (r.shoulderW > 0) [sh, -sh].forEach((d) => pl('SHOULDER', off(d)));
    if (r.sidewalkW > 0) [sw, -sw].forEach((d) => pl('SIDEWALK', off(d)));
  }
  return s + '0\nENDSEC\n0\nEOF\n';
}

function showHelp() {
  $('#modal .modal-card').innerHTML = `<h2>Road Plan の使い方</h2>
    <h4>基本操作</h4><ul>
      <li><kbd>P</kbd> 道路を描く: 地図をクリックして IP（交点）を順に置く。<kbd>ダブルクリック</kbd> / <kbd>Enter</kbd> で確定。設計速度に応じたクロソイド＋円曲線が自動で入ります。</li>
      <li><b>幅員・車線数</b>: 道路を選択すると右パネルの一番上に表示（<b>−／＋</b> で車線数、車線幅・路肩・歩道を入力）。何も選択していないときは次に描く道路の既定値を設定できます。</li>
      <li>既存道路（緑の線）は左パネルで「中心線」/「幅員どおり」の表示を切替。クリックすると交差点・屈曲点で区切られた区間が選択され、<kbd>Delete</kbd> でその区間だけを削除（パネルから道路全体も削除可）。OSM と地理院を両方取得しても重なる線は自動で除外されます（既存データは「重複を除去」）。</li>
      <li>既存道路（緑の線）や他の計画道路の近くでは緑の丸に吸着し、そこに<b>接続</b>します。接続後は右パネルで「交差・T字」か「延伸（接線方向に拘束）」を選べます。</li>
      <li><kbd>V</kbd> 選択: 道路をクリック → IP ハンドルをドラッグ。線上の小さな丸をクリックすると IP を追加。<kbd>Delete</kbd> で削除。</li>
      <li>右パネルの数値はラベルを左右にドラッグ、または <kbd>↑</kbd><kbd>↓</kbd>（<kbd>Shift</kbd> で 10 倍）で増減できます。</li>
      <li>地図左上の検索欄（<kbd>/</kbd>）で地名・住所・施設名・緯度経度を検索。住所は国土地理院、施設名などは OpenStreetMap（Nominatim）の結果を統合して表示します。</li>
      <li><kbd>M</kbd> 計測、<kbd>Ctrl</kbd>+<kbd>Z</kbd> 元に戻す、<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> やり直す。</li></ul>
    <h4>線形要素</h4><ul>
      <li><span class="tag line"></span>直線 <span class="tag clothoid"></span>クロソイド（A² = R·L） <span class="tag arc"></span>円曲線。主要点は BP / KA / KE / BC / EC / EP、測点は 20m ピッチ（No.）。</li>
      <li>A1・A2 を別々に指定する非対称クロソイド、A=0 で単円にも対応。</li></ul>
    <h4>縦断計画（計画高）</h4><ul>
      <li>右パネル「縦断計画（計画高）」で <b>現況地盤に沿う案</b> または <b>両端を結ぶ</b> を押すと、地理院 DEM の地盤高をもとに計画縦断を作成し、地図の下に縦断図が開きます。</li>
      <li>縦断変化点（VIP）の測点・計画高・縦断曲線長（VCL）を表で入力するか、縦断図の ● をドラッグして盛土・切土の高さを決めます（<kbd>Shift</kbd> で高さのみ。ダブルクリックで変化点を追加）。</li>
      <li>縦断曲線は VIP を中心とする 2 次放物線。「曲線長を推奨値に」で縦断曲線の半径・長さの規定を満たす長さに揃えます。</li>
      <li>縦断図には計画高（赤）・現況地盤（青）・盛土（黄）・切土（茶）を表示。地図上で道路にカーソルを置くと、その測点の計画高と切盛高がステータスに出ます。</li></ul>
    <h4>照査</h4><ul>
      <li>道路構造令: 設計速度(13条)・幅員(5,8,11条)・最小曲線半径(15条)・曲線長／片勾配(16条)・緩和区間(18条)・視距(19条)・縦断勾配(20条)・縦断曲線(22条)・合成勾配(25条)・交差角(27条)。</li>
      <li>接続部: 既存道路の速度から最初の曲線までの減速距離（進入速度）を確認。</li>
      <li>位置指定道路（建築基準法施行令 第144条の4）: 幅員 4m・袋路 35m・隅切り・勾配 12%。</li>
      <li>結果は簡易照査です。最終判断は条文・道路管理者の基準で行ってください。</li></ul>
    <h4>データ</h4><ul>
      <li>書き出し ▾ → PDF: 平面図（標準縮尺・背景地図つき）と線形計算書・照査結果を印刷ダイアログ経由で PDF 保存。</li>
      <li>背景: 地理院タイル / 地理院ベクトル（Google 風）/ OpenStreetMap / Google（Map Tiles API キーが必要）/ 任意の画像。</li>
      <li>既存道路: OpenStreetMap（Overpass API）または国土地理院ベクトルタイル提供実験（道路中心線）。</li>
      <li>データはこのブラウザ内（localStorage / IndexedDB）にのみ保存されます。座標は最初の作図位置を原点としたローカル平面座標（X=東, Y=北, m）。</li></ul>
    <div class="foot"><button class="btn accent" data-act="close-modal">閉じる</button></div>`;
  $('#modal').hidden = false;
}

/* ───────── 起動 ───────── */
function resetAll() {
  alCache.clear(); ui.profiles.clear(); ui.draw = null; ui.tool = 'select';
  hist.undo = []; hist.redo = []; hist.last = snapshot();
  setBase(project.base).then((ok) => { if (!ok) setBase('gsi-pale'); renderPanels(); });
  syncImageLayer(); renderExisting(); setTool('select'); save();
}
(async function boot() {
  try { ui.imageUrl = (await idb.get('image')) || null; } catch (e) { ui.imageUrl = null; }
  resetAll();
  if (!localStorage.getItem('roadplan.seenHelp')) { showHelp(); localStorage.setItem('roadplan.seenHelp', '1'); }
})();
