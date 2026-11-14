/* Road Plan — PDF 書き出し（印刷用レポートを生成し、ブラウザの「PDF に保存」で出力） */
'use strict';

const PAGE_W = 277, PLAN_H = 158; // A4 横・余白 10mm の作図領域 [mm]
const SCALES = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];

function planSvg(roads) {
  // 図郭: 対象道路の範囲から標準縮尺を選ぶ
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const als = roads.map((r) => calc(r));
  als.forEach((al, i) => { const hw = Rules.totalWidth(roads[i]) / 2; [...al.samples, ...roads[i].ips].forEach((p) => { x0 = Math.min(x0, p.x - hw); x1 = Math.max(x1, p.x + hw); y0 = Math.min(y0, p.y - hw); y1 = Math.max(y1, p.y + hw); }); });
  const w = (x1 - x0) * 1.15 + 10, h = (y1 - y0) * 1.15 + 10;
  const N = SCALES.find((s) => (w * 1000) / s <= PAGE_W && (h * 1000) / s <= PLAN_H) || SCALES[SCALES.length - 1];
  const mm = N / 1000, VW = PAGE_W * mm, VH = PLAN_H * mm; // 1mm あたりの m、図郭の実寸 [m]
  const minX = (x0 + x1) / 2 - VW / 2, maxY = (y0 + y1) / 2 + VH / 2;
  const X = (x) => (x - minX).toFixed(3), Y = (y) => (maxY - y).toFixed(3);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)},${Y(p.y)}`).join('');
  const line = (pts, color, wmm, extra = '') => `<path d="${path(pts)}" fill="none" stroke="${color}" stroke-width="${(wmm * mm).toFixed(4)}" ${extra}/>`;
  const text = (x, y, s, size = 2.2, extra = '') => `<text x="${X(x)}" y="${Y(y)}" font-size="${(size * mm).toFixed(4)}" ${extra}>${esc(s)}</text>`;
  let out = '';

  // 背景タイル（表示中のベースマップ）
  const tileUrl = baseLayer && (baseLayer._url || baseLayer.options.printUrl);
  if (tileUrl) {
    const sw = P.toLL(minX, maxY - VH), ne = P.toLL(minX + VW, maxY);
    const tx = (lng, n) => ((lng + 180) / 360) * n, ty = (lat, n) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n; };
    const lngOf = (x, n) => (x / n) * 360 - 180, latOf = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    let z = Math.min(baseLayer.options.maxNativeZoom || 18, 19), n, ax, bx, ay, by;
    for (; z > 3; z--) { n = 2 ** z; ax = Math.floor(tx(sw.lng, n)); bx = Math.floor(tx(ne.lng, n)); ay = Math.floor(ty(ne.lat, n)); by = Math.floor(ty(sw.lat, n)); if ((bx - ax + 1) * (by - ay + 1) <= 48) break; }
    for (let x = ax; x <= bx; x++) for (let y = ay; y <= by; y++) {
      const a = P.toXY([latOf(y, n), lngOf(x, n)]), b = P.toXY([latOf(y + 1, n), lngOf(x + 1, n)]);
      const url = tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      out += `<image href="${esc(url)}" x="${X(a.x)}" y="${Y(a.y)}" width="${(b.x - a.x + 0.02 * mm).toFixed(3)}" height="${(a.y - b.y + 0.02 * mm).toFixed(3)}" preserveAspectRatio="none" opacity="${Math.min(0.85, project.baseOpacity)}"/>`;
    }
  }
  // 下絵画像
  if (project.image && project.image.visible && ui.imageUrl && imageLayer && imageLayer._img.naturalWidth) {
    const [tl, tr, , bl] = imageCorners().map((ll) => { const p = P.toXY(ll); return { x: p.x - minX, y: maxY - p.y }; });
    const iw = imageLayer._img.naturalWidth, ih = imageLayer._img.naturalHeight;
    out += `<image href="${ui.imageUrl}" width="${iw}" height="${ih}" preserveAspectRatio="none" opacity="${project.image.opacity}" transform="matrix(${(tr.x - tl.x) / iw},${(tr.y - tl.y) / iw},${(bl.x - tl.x) / ih},${(bl.y - tl.y) / ih},${tl.x},${tl.y})"/>`;
  }
  // 既存道路
  if (project.existingVisible) for (const ex of project.existing) {
    const pts = ex.pts.map((p) => P.toXY(p));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y); // 図郭と外接矩形が重なるものだけ描く
    if (Math.max(...xs) > minX && Math.min(...xs) < minX + VW && Math.min(...ys) < maxY && Math.max(...ys) > maxY - VH) out += line(pts, '#0f9d8f', 0.35, 'opacity="0.8"');
  }
  // 計画道路
  roads.forEach((r, ri) => {
    const al = als[ri], sm = al.samples;
    if (sm.length < 2) return;
    const hw = Rules.carriage(r) / 2, sh = hw + r.shoulderW, sw = sh + r.sidewalkW;
    const off = (d) => sm.map((p) => ({ x: p.x - Math.sin(p.th) * d, y: p.y + Math.cos(p.th) * d }));
    const side = (p, d) => ({ x: p.x - Math.sin(p.th) * d, y: p.y + Math.cos(p.th) * d });
    if (r.sidewalkW > 0) out += `<path d="${path([...off(sw), ...off(-sw).reverse()])}Z" fill="#b8a48c" fill-opacity="0.55" stroke="#6b5b45" stroke-width="${0.12 * mm}"/>`;
    out += `<path d="${path([...off(sh), ...off(-sh).reverse()])}Z" fill="#3f4a5a" fill-opacity="0.35" stroke="#1f2937" stroke-width="${0.15 * mm}"/>`;
    if (r.shoulderW > 0) out += line(off(hw), '#fff', 0.12) + line(off(-hw), '#fff', 0.12);
    out += line(r.ips, '#0d99ff', 0.12, `stroke-dasharray="${1.2 * mm} ${1.2 * mm}"`);
    al.elements.forEach((e, i) => { out += line(al.byEl[i], COLORS[e.type], 0.4); });
    // 測点（20m ピッチ。小縮尺では 100m のみ）
    const lab = Math.max(sw, 0) + 1.2 * mm;
    for (let s = 0; s <= al.length; s += 20) {
      const major = Math.round(s) % 100 === 0;
      if (N > 2500 && !major) continue;
      const p = Geom.poseAt(al, s), t = sw + (major ? 1.6 : 0.9) * mm;
      out += line([side(p, t), side(p, -t)], '#555', 0.1);
      if (major || N <= 500) { const q = side(p, -(lab + 2.2 * mm)); out += text(q.x, q.y, 'No.' + Math.round(s / 20), 1.8, 'fill="#555" text-anchor="middle"'); }
    }
    for (const pt of al.points) {
      out += line([side(pt, sw + 2.5 * mm), side(pt, -(sw + 2.5 * mm))], '#111', 0.2);
      const q = side(pt, lab + 2.6 * mm); out += text(q.x, q.y, pt.name, 2.1, 'font-weight="600" text-anchor="middle" class="halo"');
    }
    r.ips.forEach((ip, i) => {
      if (i === 0 || i === r.ips.length - 1) return;
      out += `<circle cx="${X(ip.x)}" cy="${Y(ip.y)}" r="${0.7 * mm}" fill="#fff" stroke="#0d99ff" stroke-width="${0.2 * mm}"/>` + text(ip.x + 1.2 * mm, ip.y + 1.2 * mm, 'IP' + i, 2.1, 'fill="#0d99ff" font-weight="600" class="halo"');
    });
    const mid = Geom.poseAt(al, al.length / 2), q = side(mid, -(lab + 6 * mm));
    out += text(q.x, q.y, r.name, 2.8, 'font-weight="700" text-anchor="middle" class="halo"');
  });
  // 方位・スケールバー
  const bar = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((b) => b / mm >= 25) || 5000;
  const bx = 6 * mm, byy = VH - 6 * mm, nx = VW - 10 * mm, ny = 16 * mm;
  out += `<g><rect x="${bx - 2 * mm}" y="${byy - 6 * mm}" width="${bar + 4 * mm}" height="${9 * mm}" fill="#fff" fill-opacity="0.85"/>
    <path d="M${bx},${byy - mm}V${byy}H${bx + bar}V${byy - mm}M${bx + bar / 2},${byy - 0.6 * mm}V${byy}" fill="none" stroke="#111" stroke-width="${0.25 * mm}"/>
    <text x="${bx}" y="${byy - 2 * mm}" font-size="${2.2 * mm}">0</text><text x="${bx + bar}" y="${byy - 2 * mm}" font-size="${2.2 * mm}" text-anchor="end">${bar} m</text>
    <circle cx="${nx}" cy="${ny}" r="${7 * mm}" fill="#fff" fill-opacity="0.85"/><path d="M${nx},${ny - 6 * mm}L${nx + 2.2 * mm},${ny + 4 * mm}L${nx},${ny + 2.4 * mm}L${nx - 2.2 * mm},${ny + 4 * mm}Z" fill="#111"/>
    <text x="${nx}" y="${ny - 7.6 * mm}" font-size="${2.6 * mm}" text-anchor="middle" font-weight="700" class="halo">N</text></g>`;
  return { svg: `<svg class="plan" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" style="width:${PAGE_W}mm;height:${PLAN_H}mm">${out}</svg>`, N };
}

function reportHtml() {
  const roads = project.roads.filter((r) => r.visible !== false && r.ips.length >= 2);
  const { svg, N } = planSvg(roads);
  const today = new Date(), date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const o = P.origin(), attr = baseLayer ? baseLayer.options.attribution.replace(/<[^>]+>/g, '') : '';
  const tbl = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const LV = { error: '不適合', warn: '要確認', info: '参考', ok: '適合' };
  let h = `<div class="pg"><div class="frame">${svg}</div>
    <div class="title"><div><b>${esc(project.name)}</b><span>平面図</span></div><div>縮尺 1:${N}（A4 横・100% 印刷時）</div><div>${date}</div>
    <div class="lg"><i style="background:#0d99ff"></i>直線 <i style="background:#f59e0b"></i>クロソイド <i style="background:#f24822"></i>円曲線 <i style="background:#0f9d8f"></i>既存道路</div>
    <div class="sm">座標: 原点 (${o.lat.toFixed(6)}, ${o.lng.toFixed(6)}) のローカル平面座標 X=東 Y=北 [m]${attr ? ' ／ 背景: ' + esc(attr) : ''}${project.existing.length ? ' ／ 既存道路: © OpenStreetMap contributors・国土地理院' : ''}</div></div></div>`;
  for (const r of roads) {
    const al = calc(r), res = checksOf(r), cnt = (l) => res.filter((c) => c.level === l).length, n = r.ips.length, c = Rules.CLASSES[r.cls];
    const connTxt = (k) => { const cn = r.conn[k]; if (!cn) return '未接続'; const dir = k === 'start' ? al.dirs[0] : al.dirs[al.dirs.length - 1]; return `${esc(cn.name || '既存道路')}（${cn.mode === 'tangent' ? '延伸' : '交差'}・交差角 ${fmt(Rules.foldAngle(dir - cn.bearing), 1)}°・既存幅員 約${fmt(cn.width, 1)}m・進入速度 ${cn.speed}km/h）`; };
    h += `<div class="pg"><h1>${esc(r.name)} 線形計算書</h1>
      ${tbl(['道路区分', '設計速度', '延長', '車線', '路肩', '歩道', '全幅'], [[c.name + (r.shitei ? '／位置指定道路' : ''), r.V + ' km/h', fmt(al.length, 3) + ' m', `${r.lanes} × ${fmt(r.laneW)} m`, fmt(r.shoulderW) + ' m', fmt(r.sidewalkW) + ' m', fmt(Rules.totalWidth(r)) + ' m']])}
      ${tbl(['起点の接続', '終点の接続'], [[connTxt('start'), connTxt('end')]])}
      <h2>IP・曲線諸元</h2>
      ${tbl(['点', 'X (m)', 'Y (m)', '緯度', '経度', '交角', 'R', 'A1', 'A2', 'TL1', 'TL2', 'L1', 'Lc', 'L2', 'CL'], r.ips.map((ip, i) => { const cv = al.curves[i], ll = P.toLL(ip.x, ip.y); return [i === 0 ? 'BP' : i === n - 1 ? 'EP' : 'IP' + i, fmt(ip.x, 3), fmt(ip.y, 3), ll.lat.toFixed(7), ll.lng.toFixed(7), ...(cv && !cv.none ? [`${fmt(deg(Math.abs(cv.delta)), 3)}° ${cv.delta > 0 ? '左' : '右'}`, fmt(cv.R, 2), fmt(cv.A1, 2), fmt(cv.A2, 2), fmt(cv.T1, 3), fmt(cv.T2, 3), fmt(cv.L1, 3), fmt(cv.Lc, 3), fmt(cv.L2, 3), fmt(cv.CL, 3)] : cv ? [fmt(deg(Math.abs(cv.delta)), 3) + '°', ...Array(9).fill('—')] : Array(10).fill(''))]; }))}
      <h2>主要点</h2>
      ${tbl(['点名', '測点', '追加距離 (m)', 'X (m)', 'Y (m)', '緯度', '経度', '接線方位角'], al.points.map((pt) => { const ll = P.toLL(pt.x, pt.y); return [pt.name, station(pt.s), fmt(pt.s, 3), fmt(pt.x, 3), fmt(pt.y, 3), ll.lat.toFixed(7), ll.lng.toFixed(7), fmt(azimuth(pt.th), 4) + '°']; }))}
      <h2>線形要素</h2>
      ${tbl(['No.', '種別', '起点追加距離 (m)', '長さ (m)', 'R (m)', 'A', '起点方位角'], al.elements.map((e, i) => [i + 1, ELNAME[e.type], fmt(e.s0, 3), fmt(e.L, 3), e.R ? fmt(e.R, 2) : '—', e.A ? fmt(e.A, 2) : '—', fmt(azimuth(e.th0), 4) + '°']))}
      ${(() => {
        const pf = Geom.computeProfile(r.vips, al.length);
        if (!pf) return '';
        const np = pf.pts.length;
        return `<h2>縦断図</h2><div class="vprint">${profileSvg(r, 1040, 300)}</div>
      <h2>縦断変化点</h2>
      ${tbl(['点', '測点', '追加距離 (m)', '計画高 (m)', '前勾配', '後勾配', 'VCL (m)', '縦断曲線半径 (m)', '形状'], pf.pts.map((p, i) => { const cv = pf.curves[i - 1]; return [i === 0 ? 'BP' : i === np - 1 ? 'EP' : 'VIP' + i, station(p.s), fmt(p.s, 3), fmt(p.z, 3), i > 0 ? sgnPct(pf.grades[i - 1]) : '—', i < np - 1 ? sgnPct(pf.grades[i]) : '—', cv ? fmt(cv.L, 2) : '—', cv && cv.L > 0 && isFinite(cv.R) ? fmt(cv.R, 1) : '—', cv && cv.L > 0 && Math.abs(cv.dg) > 0.0005 ? (cv.crest ? '凸形' : '凹形') : '—']; }))}
      <h2>縦断計算（計画高・切盛）</h2>
      ${tbl(['点名', '測点', '追加距離 (m)', '計画高 (m)', '勾配', '地盤高 (m)', '切盛 (m)'], vplanRows(r).map((x) => [x.name, x.station, fmt(x.s, 3), fmt(x.z, 3), sgnPct(x.g), x.h == null ? '—' : fmt(x.h, 3), x.d == null ? '—' : (x.d >= 0 ? '盛 ' : '切 ') + fmt(Math.abs(x.d), 3)]))}`;
      })()}
      <h2>照査結果（不適合 ${cnt('error')}・要確認 ${cnt('warn')}・参考 ${cnt('info')}・適合 ${cnt('ok')}）</h2>
      ${tbl(['判定', '項目', '内容', '根拠'], ['error', 'warn', 'info', 'ok'].flatMap((l) => res.filter((x) => x.level === l)).map((x) => [`<span class="lv ${x.level}">${LV[x.level]}</span>`, esc(x.title), esc(x.detail), esc(x.ref)]))}
      <p class="sm">道路構造令（本則の表）・建築基準法施行令および「道路構造令の解説と運用」の一般的な目安に基づく簡易照査です。条例・道路管理者基準・特例値の適用条件は別途確認してください。</p></div>`;
  }
  return h;
}

async function exportPDF() {
  $('#exportMenu').hidden = true;
  if (!project.roads.some((r) => r.visible !== false && r.ips.length >= 2)) return toast('書き出す計画道路がありません', 'err');
  const el = $('#print');
  el.innerHTML = reportHtml();
  // 背景タイルの読み込みを待つ（最大 8 秒）。読めなかったタイルは外す
  const imgs = [...el.querySelectorAll('svg image')];
  if (imgs.length) toast('PDF 用の図面を準備中…');
  await Promise.race([
    Promise.all(imgs.map((im) => new Promise((res) => { im.addEventListener('load', res); im.addEventListener('error', () => { im.remove(); res(); }); }))),
    new Promise((res) => setTimeout(res, 8000)),
  ]);
  const title = document.title;
  document.title = project.name; // 保存時の既定ファイル名になる
  const done = () => { document.title = title; el.innerHTML = ''; removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  toast('印刷ダイアログで送信先を「PDF に保存」にしてください（用紙 A4 横・倍率 100%）');
  setTimeout(() => window.print(), 50);
}
