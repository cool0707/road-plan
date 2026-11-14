/* Road Plan — 3D ビュー（three.js）
 * 地理院 標高タイルの地形 ＋ 背景タイルの貼り付け ＋ 計画道路（計画高・片勾配・切土／盛土のり面・区画線・歩道・街路灯）＋ 既存道路。
 * マウスで回転・移動・ズーム。撮影は影付き・高解像度で別途レンダリングして PNG に保存する。 */
'use strict';

const V3D = (() => {
  const OPT_KEY = 'roadplan.v3d';
  const TEX = {
    photo: { name: '航空写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', max: 18, attr: '地理院タイル（全国最新写真）' },
    std: { name: '地理院地図（標準）', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', max: 18, attr: '地理院タイル' },
    pale: { name: '地理院地図（淡色）', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', max: 18, attr: '地理院タイル' },
    osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attr: '© OpenStreetMap contributors' },
    none: { name: 'なし（ジオラマ）' },
  };
  const SHOTS = { screen2: '画面の 2 倍', fhd: '1920 × 1080', '4k': '3840 × 2160', sq: '2048 × 2048' };
  const defOpts = { tex: 'photo', exag: 1, existing: true, lamps: true, sunAz: 150, sunAlt: 38, shot: 'screen2', caption: true, preview: false };
  let opts = Object.assign({}, defOpts);
  try { Object.assign(opts, JSON.parse(localStorage.getItem(OPT_KEY)) || {}); } catch (e) { /* 既定値 */ }
  const saveOpts = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch (e) { /* 無視 */ } };

  const st = { open: false, ready: null, el: null, renderer: null, scene: null, camera: null, controls: null, world: null, sun: null, raf: 0, ro: null, building: 0, dirty: 0, info: null, texCache: new Map() };
  let T = null; // window.THREE

  /* ───────── 読み込み・開閉 ───────── */
  function loadThree() {
    if (!st.ready) st.ready = loadScript('vendor/three/three.min.js').then(() => { T = window.THREE; }).catch((e) => { st.ready = null; throw e; });
    return st.ready;
  }
  async function open() {
    if (st.open) return;
    const cv = document.createElement('canvas');
    if (!cv.getContext('webgl2')) return toast('このブラウザは WebGL2 に対応していないため 3D 表示できません', 'err');
    try { await loadThree(); } catch (e) { return toast('3D ライブラリを読み込めません: ' + e.message, 'err'); }
    st.open = true;
    mountUI();
    initRenderer();
    $('[data-act=view3d]') && $('[data-act=view3d]').classList.add('on');
    await rebuild(true);
  }
  function close() {
    if (!st.open) return;
    st.open = false;
    cancelAnimationFrame(st.raf); st.raf = 0;
    if (st.ro) st.ro.disconnect();
    if (st.world) disposeTree(st.world);
    st.controls && st.controls.dispose();
    st.renderer && (st.renderer.dispose(), st.renderer.forceContextLoss());
    st.el && st.el.remove();
    Object.assign(st, { el: null, renderer: null, scene: null, camera: null, controls: null, world: null, sun: null, info: null });
    $('[data-act=view3d]') && $('[data-act=view3d]').classList.remove('on');
  }
  const toggle = () => (st.open ? close() : open());
  /* 計画が変わったら作り直す（パネルの数値入力など） */
  function changed() {
    if (!st.open) return;
    clearTimeout(st.dirty);
    st.dirty = setTimeout(() => rebuild(false), 700);
  }

  function mountUI() {
    const el = (st.el = document.createElement('div'));
    el.id = 'v3d';
    const sel = (key, list) => `<select data-v3="${key}">${Object.entries(list).map(([k, v]) => `<option value="${k}"${opts[key] === k ? ' selected' : ''}>${typeof v === 'string' ? v : v.name}</option>`).join('')}</select>`;
    const chk = (key, label) => `<label class="v3chk"><input type="checkbox" data-v3="${key}"${opts[key] ? ' checked' : ''}>${label}</label>`;
    const rng = (key, label, min, max, step, unit) => `<label class="v3rng"><span>${label}</span><input type="range" data-v3="${key}" min="${min}" max="${max}" step="${step}" value="${opts[key]}"><b data-out="${key}">${opts[key]}${unit}</b></label>`;
    el.innerHTML = `<div class="v3canvas"></div>
      <div class="v3panel">
        <div class="v3head"><b>3D ビュー</b><button class="ibtn" data-v3act="close" title="閉じる (Esc)">✕</button></div>
        <div class="v3row"><span>地表</span>${sel('tex', TEX)}</div>
        ${rng('exag', '高さ強調', 1, 5, 0.5, '×')}
        ${chk('existing', '既存道路')}${chk('lamps', '街路灯')}
        <div class="v3sub">太陽（撮影時の影）</div>
        ${rng('sunAz', '方位', 0, 359, 1, '°')}
        ${rng('sunAlt', '高度', 5, 85, 1, '°')}
        ${chk('preview', '影をプレビュー（重くなります）')}
        <div class="v3sub">撮影</div>
        <div class="v3row"><span>サイズ</span>${sel('shot', SHOTS)}</div>
        ${chk('caption', 'タイトルを入れる')}
        <div class="v3btns"><button class="btn accent wide" data-v3act="shot">📷 影付きで撮影</button></div>
        <div class="v3btns"><button class="btn" data-v3act="reset">視点をリセット</button><button class="btn" data-v3act="top">真上から</button></div>
      </div>
      <div class="v3hint">左ドラッグ: 回転　右ドラッグ / Shift+ドラッグ: 移動　ホイール: ズーム</div>
      <div class="v3attr"></div>`;
    $('#stage').appendChild(el);
    el.addEventListener('input', (e) => {
      const t = e.target, k = t.dataset.v3; if (!k) return;
      const v = t.type === 'checkbox' ? t.checked : t.type === 'range' ? +t.value : t.value;
      opts[k] = v; saveOpts();
      const out = el.querySelector(`[data-out="${k}"]`); if (out) out.textContent = v + (k === 'exag' ? '×' : '°');
      if (k === 'tex' || k === 'existing' || k === 'lamps') return rebuild(false);
      if (k === 'exag') { st.world.scale.y = v; placeSun(); }
      if (k === 'sunAz' || k === 'sunAlt') placeSun();
      if (k === 'preview') setShadows(v);
      requestRender();
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v3act]'); if (!b) return;
      const a = b.dataset.v3act;
      if (a === 'close') close();
      else if (a === 'shot') shoot();
      else if (a === 'reset') { resetView(); requestRender(); }
      else if (a === 'top') { topView(); requestRender(); }
    });
  }

  function initRenderer() {
    const box = st.el.querySelector('.v3canvas');
    const r = (st.renderer = new T.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = T.SRGBColorSpace;
    r.toneMapping = T.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    r.shadowMap.type = T.PCFSoftShadowMap;
    r.shadowMap.enabled = !!opts.preview;
    box.appendChild(r.domElement);
    st.scene = new T.Scene();
    st.scene.background = skyTexture();
    st.camera = new T.PerspectiveCamera(38, 1, 0.5, 50000);
    const c = (st.controls = new T.OrbitControls(st.camera, r.domElement));
    c.enableDamping = true; c.dampingFactor = 0.12; c.screenSpacePanning = false; c.maxPolarAngle = Math.PI * 0.495;
    c.addEventListener('change', requestRender);
    st.scene.add(new T.HemisphereLight(0xdfeaff, 0x7a6a52, 1.1));
    const sun = (st.sun = new T.DirectionalLight(0xfff0dc, 2.8));
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6; sun.shadow.radius = 2;
    st.scene.add(sun, sun.target);
    const resize = () => {
      const w = box.clientWidth || 1, h = box.clientHeight || 1;
      r.setSize(w, h); st.camera.aspect = w / h; st.camera.updateProjectionMatrix(); requestRender();
    };
    st.ro = new ResizeObserver(resize); st.ro.observe(box); resize();
  }
  /* 描画は変化があったときだけ（減衰が止まるまで数フレーム続ける） */
  let settle = 0;
  function requestRender() {
    settle = 20;
    if (st.raf || !st.open) return;
    const loop = () => {
      st.raf = 0;
      if (!st.open) return;
      st.controls.update();
      st.renderer.render(st.scene, st.camera);
      if (--settle > 0) st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);
  }

  function skyTexture() {
    const c = document.createElement('canvas'); c.width = 4; c.height = 256;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#6fa6dc'); gr.addColorStop(0.55, '#bcd6ee'); gr.addColorStop(1, '#eef2f4');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  }
  function disposeTree(o) {
    o.traverse((m) => {
      if (m.geometry) m.geometry.dispose();
      if (m.material) [].concat(m.material).forEach((mt) => { if (mt.map && !mt.map.userData.cached) mt.map.dispose(); mt.dispose(); });
    });
    o.parent && o.parent.remove(o);
  }

  /* ───────── 範囲 ───────── */
  function extent() {
    const roads = project.roads.filter((r) => r.visible !== false && r.ips.length >= 2);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of roads) for (const p of calc(r).samples) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    let pad;
    if (!isFinite(x0)) {
      const b = map.getBounds(), a = P.toXY(b.getSouthWest()), c = P.toXY(b.getNorthEast());
      x0 = a.x; y0 = a.y; x1 = c.x; y1 = c.y; pad = 0;
    } else pad = Math.max(80, 0.22 * Math.max(x1 - x0, y1 - y0));
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const MAX = 4000, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let clipped = false;
    if (x1 - x0 > MAX) { x0 = cx - MAX / 2; x1 = cx + MAX / 2; clipped = true; }
    if (y1 - y0 > MAX) { y0 = cy - MAX / 2; y1 = cy + MAX / 2; clipped = true; }
    return { x0, y0, x1, y1, cx, cy, w: x1 - x0, h: y1 - y0, D: Math.max(x1 - x0, y1 - y0), roads, clipped };
  }

  /* ───────── 地形（地理院 標高タイル） ───────── */
  const tileXY = (ll, z) => { const n = 2 ** z, r = (ll.lat * Math.PI) / 180; return { fx: ((ll.lng + 180) / 360) * n, fy: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n }; };
  async function demSampler(ex) {
    const levels = [['dem5a_png', 15], ['dem_png', 14]], tiles = new Map();
    const corners = [P.toLL(ex.x0, ex.y0), P.toLL(ex.x1, ex.y1)];
    const jobs = [];
    for (const [kind, z] of levels) {
      const a = tileXY(corners[0], z), b = tileXY(corners[1], z);
      for (let x = Math.floor(Math.min(a.fx, b.fx)); x <= Math.floor(Math.max(a.fx, b.fx)); x++)
        for (let y = Math.floor(Math.min(a.fy, b.fy)); y <= Math.floor(Math.max(a.fy, b.fy)); y++)
          jobs.push(demTile(kind, z, x, y).then((d) => tiles.set(`${kind}/${z}/${x}/${y}`, d)));
    }
    await Promise.all(jobs);
    const px = (kind, z, X, Y) => { // 全体ピクセル座標の標高（無効値は null）
      const d = tiles.get(`${kind}/${z}/${Math.floor(X / 256)}/${Math.floor(Y / 256)}`); if (!d) return null;
      const i = ((Y & 255) * 256 + (X & 255)) * 4, v = d[i] * 65536 + d[i + 1] * 256 + d[i + 2];
      if (v === 8388608 || d[i + 3] === 0) return null;
      return (v < 8388608 ? v : v - 16777216) * 0.01;
    };
    return (ll) => {
      for (const [kind, z] of levels) {
        const t = tileXY(ll, z), X = t.fx * 256 - 0.5, Y = t.fy * 256 - 0.5, ix = Math.floor(X), iy = Math.floor(Y), u = X - ix, v = Y - iy;
        const a = px(kind, z, ix, iy), b = px(kind, z, ix + 1, iy), c = px(kind, z, ix, iy + 1), d = px(kind, z, ix + 1, iy + 1);
        if (a == null || b == null || c == null || d == null) { const any = a ?? b ?? c ?? d; if (any != null) return any; continue; }
        return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
      }
      return null;
    };
  }

  /* ───────── 地表テクスチャ（背景タイルを 1 枚の画像に） ───────── */
  async function groundTexture(ex) {
    const def = TEX[opts.tex];
    if (!def || !def.url) return null;
    const ll0 = P.toLL(ex.x0, ex.y1), ll1 = P.toLL(ex.x1, ex.y0), lat = (ll0.lat + ll1.lat) / 2;
    const mpp0 = 156543.03392 * Math.cos((lat * Math.PI) / 180);
    const z = Math.max(8, Math.min(def.max, Math.floor(Math.log2((mpp0 * 3000) / ex.D))));
    const a = tileXY(ll0, z), b = tileXY(ll1, z);
    const tx0 = Math.floor(a.fx), ty0 = Math.floor(a.fy), tx1 = Math.floor(b.fx), ty1 = Math.floor(b.fy);
    const key = `${opts.tex}/${z}/${tx0}/${ty0}/${tx1}/${ty1}`;
    const frame = { z, ox: tx0 * 256, oy: ty0 * 256, W: (tx1 - tx0 + 1) * 256, H: (ty1 - ty0 + 1) * 256 };
    if (st.texCache.has(key)) return Object.assign({ tex: st.texCache.get(key) }, frame);
    const c = document.createElement('canvas'); c.width = frame.W; c.height = frame.H;
    const g = c.getContext('2d'); g.fillStyle = '#c9cfc4'; g.fillRect(0, 0, c.width, c.height);
    const jobs = [];
    for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) {
      jobs.push(new Promise((res) => {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => { g.drawImage(img, (x - tx0) * 256, (y - ty0) * 256); res(); };
        img.onerror = res;
        img.src = def.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      }));
    }
    await Promise.all(jobs);
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = st.renderer.capabilities.getMaxAnisotropy(); tex.userData.cached = true;
    if (st.texCache.size > 4) { const k = st.texCache.keys().next().value; st.texCache.get(k).dispose(); st.texCache.delete(k); }
    st.texCache.set(key, tex);
    return Object.assign({ tex }, frame);
  }

  /* ───────── 道路の横断形状 ─────────
   * 中心線の測点ごとに 位置・方向・計画高・左右の横断勾配（片勾配）を求める。 */
  function roadStations(road, hGround) {
    const al = calc(road), L = al.length;
    if (!(L > 0.5)) return null;
    const ds = Math.min(2.5, Math.max(0.5, L / 900)), ss = [];
    for (let s = 0; s < L; s += ds) ss.push(s);
    ss.push(L);
    al.elements.forEach((e) => ss.push(e.s0));
    ss.sort((a, b) => a - b);
    const S = [];
    for (const s of ss) if (!S.length || s - S[S.length - 1] > 1e-3) S.push(s);
    const pf = Geom.computeProfile(road.vips, L);
    const rows = S.map((s) => { const p = Geom.poseAt(al, s); return { s, x: p.x, y: p.y, c: Math.cos(p.th), sn: Math.sin(p.th), k: p.k || 0, z: 0 }; });
    const raw = rows.map((r) => hGround(P.toLL(r.x, r.y)));
    const valid = raw.filter((h) => h != null), mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
    rows.forEach((r, i) => { r.g = raw[i] ?? mean; });
    if (pf) rows.forEach((r) => { r.z = Geom.profileAt(pf, r.s).z; });
    else { // 縦断計画がない → 現況地盤（60m 移動平均）に沿わせる
      let j0 = 0, j1 = 0, sum = 0;
      rows.forEach((r) => {
        while (j1 < rows.length && rows[j1].s <= r.s + 30) sum += rows[j1++].g;
        while (rows[j0].s < r.s - 30) sum -= rows[j0++].g;
        r.z = sum / (j1 - j0);
      });
    }
    // 盛土高 8m 超は橋梁とみなす（前後 10m は橋台として含める）
    const high = rows.filter((r) => r.z - r.g > 8).map((r) => r.s);
    let h = 0;
    rows.forEach((r) => { while (h < high.length - 1 && high[h] < r.s - 10) h++; r.bridge = high.length > 0 && Math.abs(high[h] - r.s) <= 10; });
    // 片勾配: 曲線区間で内側へ傾ける（緩和曲線で曲率に比例してすりつけ）。直線部は 2% の拝み勾配
    rows.forEach((r) => {
      let c = null;
      for (const cv of al.curves) if (cv && !cv.none && cv.sTS != null && r.s >= cv.sTS - 1e-6 && r.s <= cv.sST + 1e-6) { c = cv; break; }
      let inner = -0.02, outer = -0.02;
      if (c && Math.abs(r.k) > 1e-9) {
        const e = Rules.curveSpeed(road, c.R).e, t = Math.min(1, Math.abs(r.k) * c.R);
        if (e > 0.02) { inner = -(0.02 + (e - 0.02) * t); outer = -0.02 + (e + 0.02) * t; }
      }
      const leftInner = r.k > 0;
      r.slope = leftInner ? [inner, outer] : [outer, inner]; // [左, 右]: 外向きの勾配
    });
    const cw = road.lanes * road.laneW, W = cw / 2 + road.shoulderW, sw = road.sidewalkW || 0;
    return { road, rows, L, cw, W, sw, E: W + sw, ds };
  }
  /* 横断位置 d（左が正）の路面高 */
  function surfZ(R, r, d) {
    const a = Math.abs(d), sl = r.slope[d >= 0 ? 0 : 1];
    if (a <= R.W) return r.z + sl * a;
    return r.z + sl * R.W + (R.sw > 0 ? 0.15 : 0);
  }

  /* ───────── 地形メッシュ（切土・盛土で整形） ───────── */
  function buildTerrain(ex, hGround, roadsX, texInfo) {
    const sp = Math.max(1.2, ex.D / 260), nx = Math.ceil(ex.w / sp) + 1, ny = Math.ceil(ex.h / sp) + 1;
    const N = nx * ny, H = new Float32Array(N), H0 = new Float32Array(N), earth = new Float32Array(N * 2);
    const gx = (i) => ex.x0 + (ex.w * i) / (nx - 1), gy = (j) => ex.y1 - (ex.h * j) / (ny - 1); // j=0 が北端
    let sum = 0, cnt = 0;
    const raw = new Array(N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const h = hGround(P.toLL(gx(i), gy(j))); raw[j * nx + i] = h; if (h != null) { sum += h; cnt++; } }
    const mean = cnt ? sum / cnt : 0;
    for (let k = 0; k < N; k++) H0[k] = H[k] = raw[k] ?? mean;
    // 切盛: 路面の下 0.4m まで掘る／盛る。路肩（歩道）端から 盛土 1:1.5・切土 1:1.0
    for (const R of roadsX) {
      const rows = R.rows, reach = R.E + SLOPE_MAX + SLOPE_FADE;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const r of rows) { bx0 = Math.min(bx0, r.x); by0 = Math.min(by0, r.y); bx1 = Math.max(bx1, r.x); by1 = Math.max(by1, r.y); }
      const i0 = Math.max(0, Math.floor((bx0 - reach - ex.x0) / sp)), i1 = Math.min(nx - 1, Math.ceil((bx1 + reach - ex.x0) / sp));
      const j0 = Math.max(0, Math.floor((ex.y1 - by1 - reach) / sp)), j1 = Math.min(ny - 1, Math.ceil((ex.y1 - by0 + reach) / sp));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = gx(i), y = gy(j);
        let best = -1, bd = reach * reach;
        for (let q = 0; q < rows.length; q++) { const dx = x - rows[q].x, dy = y - rows[q].y, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = q; } }
        if (best < 0 || rows[best].bridge) continue;
        const r = rows[best], vx = x - r.x, vy = y - r.y, along = vx * r.c + vy * r.sn, d = -vx * r.sn + vy * r.c;
        const over = (best === 0 && along < 0) || (best === rows.length - 1 && along > 0) ? Math.abs(along) : 0;
        const k = j * nx + i, h = H[k], dd = Math.max(-R.E, Math.min(R.E, d)), top = surfZ(R, r, dd) - 0.4;
        const lat = Math.max(0, Math.abs(d) - R.E), u = over > 0 ? Math.hypot(lat, over) : lat;
        if (u <= 1e-6) { H[k] = top; continue; }
        const w = u <= SLOPE_MAX ? 1 : Math.max(0, 1 - (u - SLOPE_MAX) / SLOPE_FADE); // のり長が長すぎる所は自然地形へなじませる
        if (h < top) { const f = h + (top - u / 1.5 - h) * w; if (f > h) { H[k] = f; earth[k * 2] = Math.max(earth[k * 2], Math.min(1, (f - h) / 0.6) * Math.min(1, w * 1.5)); } }
        else { const c = h + (top + u * 1.0 - h) * w; if (c < h) { H[k] = c; earth[k * 2 + 1] = Math.max(earth[k * 2 + 1], Math.min(1, (h - c) / 0.6) * Math.min(1, w * 1.5)); } }
      }
    }
    return { nx, ny, sp, H, H0, earth, gx, gy, mean, tex: texInfo };
  }
  const SLOPE_MAX = 30, SLOPE_FADE = 15;
  /* 整形後の地形高（双一次補間） */
  function terrainAt(G, ex, x, y) {
    const fi = Math.max(0, Math.min(G.nx - 1.001, (x - ex.x0) / G.sp)), fj = Math.max(0, Math.min(G.ny - 1.001, (ex.y1 - y) / G.sp));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j, H = G.H, nx = G.nx;
    return H[j * nx + i] * (1 - u) * (1 - v) + H[j * nx + i + 1] * u * (1 - v) + H[(j + 1) * nx + i] * (1 - u) * v + H[(j + 1) * nx + i + 1] * u * v;
  }

  /* ───────── メッシュ生成ヘルパー ───────── */
  // grid[row][col] = [X, Y, Z]（three 座標）。列は右→左（上向き面になる順）
  function ribbonGeo(grid) {
    const nr = grid.length, nc = grid[0].length, pos = new Float32Array(nr * nc * 3), idx = [];
    grid.forEach((row, a) => row.forEach((p, b) => pos.set(p, (a * nc + b) * 3)));
    for (let a = 0; a < nr - 1; a++) for (let b = 0; b < nc - 1; b++) {
      const p = a * nc + b, q = p + nc;
      idx.push(p, q, p + 1, p + 1, q, q + 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  const mat = (color, o = {}) => new T.MeshStandardMaterial(Object.assign({ color, roughness: 0.92, metalness: 0, side: T.DoubleSide }, o));
  function mesh(geo, material, shadow = true) { const m = new T.Mesh(geo, material); m.castShadow = shadow; m.receiveShadow = true; return m; }

  function build(ex, G, roadsX, base) {
    const world = new T.Group();
    const toV = (x, y, z) => [x - ex.cx, z - base, -(y - ex.cy)];
    // 地形
    const { nx, ny, H, earth } = G, N = nx * ny, pos = new Float32Array(N * 3), uv = new Float32Array(N * 2), idx = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = G.gx(i), y = G.gy(j);
      pos.set(toV(x, y, H[k]), k * 3);
      if (G.tex) { const t = tileXY(P.toLL(x, y), G.tex.z); uv[k * 2] = (t.fx * 256 - G.tex.ox) / G.tex.W; uv[k * 2 + 1] = 1 - (t.fy * 256 - G.tex.oy) / G.tex.H; }
    }
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const p = j * nx + i, q = p + nx; idx.push(p, q, p + 1, p + 1, q, q + 1); }
    const tg = new T.BufferGeometry();
    tg.setAttribute('position', new T.BufferAttribute(pos, 3)); tg.setAttribute('uv', new T.BufferAttribute(uv, 2));
    tg.setAttribute('aEarth', new T.BufferAttribute(earth, 2)); tg.setIndex(idx); tg.computeVertexNormals();
    const tm = new T.MeshStandardMaterial({ color: G.tex ? 0xffffff : 0xa9b494, map: G.tex ? G.tex.tex : null, roughness: 1, metalness: 0 });
    tm.onBeforeCompile = (sh) => { // 盛土のり面は芝、切土のり面は土の色
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aEarth;\nvarying vec2 vEarth;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvEarth = aEarth;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vEarth;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.32, 0.10), clamp(vEarth.x, 0.0, 1.0) * 0.6);\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.40, 0.29, 0.18), clamp(vEarth.y, 0.0, 1.0) * 0.7);');
    };
    world.add(mesh(tg, tm));
    // ジオラマの側面と底
    let hmin = Infinity; for (let k = 0; k < N; k++) hmin = Math.min(hmin, H[k]);
    const bottom = hmin - Math.max(6, ex.D * 0.035), side = [];
    const edge = (list) => { const top = list.map(([i, j]) => toV(G.gx(i), G.gy(j), H[j * nx + i])), bot = list.map(([i, j]) => toV(G.gx(i), G.gy(j), bottom)); side.push([bot, top]); };
    const rowI = (j, rev) => { const a = []; for (let i = 0; i < nx; i++) a.push([rev ? nx - 1 - i : i, j]); return a; };
    const colJ = (i, rev) => { const a = []; for (let j = 0; j < ny; j++) a.push([i, rev ? ny - 1 - j : j]); return a; };
    edge(rowI(0, true)); edge(rowI(ny - 1)); edge(colJ(0)); edge(colJ(nx - 1, true));
    const soil = mat(0x8a6f55, { side: T.DoubleSide });
    for (const [bot, top] of side) world.add(mesh(ribbonGeo(bot.map((b, k) => [b, top[k]])), soil, false));
    const bg = new T.PlaneGeometry(ex.w, ex.h); bg.rotateX(Math.PI / 2); bg.translate(0, bottom - base, 0);
    world.add(mesh(bg, soil, false));

    // 計画道路
    const asphalt = mat(0x3b3e44, { roughness: 0.85 }), white = mat(0xf2f2ee, { roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      yellow = mat(0xf2b81d, { roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), walk = mat(0xc9c4ba, { roughness: 0.95 }), curb = mat(0xb3aea4),
      metal = mat(0x8d939a, { roughness: 0.45, metalness: 0.4 }), lampM = mat(0xfff6e0, { emissive: 0xffe9b8, emissiveIntensity: 0.4 });
    const P3 = (R, r, d, dz = 0) => { const n = { x: -r.sn, y: r.c }; return toV(r.x + n.x * d, r.y + n.y * d, surfZ(R, r, d) + dz); };
    for (const R of roadsX) {
      const rows = R.rows;
      // 舗装（車道＋路肩）と側面の厚み
      world.add(mesh(ribbonGeo(rows.map((r) => [P3(R, r, -R.W), P3(R, r, 0), P3(R, r, R.W)])), asphalt));
      for (const sgn of [-1, 1]) world.add(mesh(ribbonGeo(rows.map((r) => { const d = sgn * R.W, t = P3(R, r, d); return [[t[0], t[1] - 0.45, t[2]], t]; })), asphalt));
      // 歩道（縁石 15cm）
      if (R.sw > 0) for (const sgn of [-1, 1]) {
        world.add(mesh(ribbonGeo(rows.map((r) => (sgn > 0 ? [P3(R, r, R.W + 0.001), P3(R, r, R.E)] : [P3(R, r, -R.E), P3(R, r, -R.W - 0.001)]))), walk));
        world.add(mesh(ribbonGeo(rows.map((r) => { const t = P3(R, r, sgn * R.W, 0.15); return [P3(R, r, sgn * R.W * 0.9999), t]; })), curb));
        world.add(mesh(ribbonGeo(rows.map((r) => { const t = P3(R, r, sgn * R.E); return [[t[0], t[1] - 0.6, t[2]], t]; })), curb));
      }
      // 橋梁: 桁（厚さ 1.6m）・高欄・橋脚
      const concrete = mat(0xb9b6ae, { roughness: 0.9 });
      const bsegs = []; let bc = null;
      rows.forEach((r) => { if (r.bridge) { if (!bc) bsegs.push((bc = [])); bc.push(r); } else bc = null; });
      for (const sg of bsegs) {
        if (sg.length < 2) continue;
        const dn = (t, dz) => [t[0], t[1] + dz, t[2]];
        for (const sgn of [-1, 1]) {
          world.add(mesh(ribbonGeo(sg.map((r) => { const t = P3(R, r, sgn * R.E); return [dn(t, -1.6), t]; })), concrete));
          world.add(mesh(ribbonGeo(sg.map((r) => { const t = P3(R, r, sgn * R.E); return [t, dn(t, 1.0)]; })), concrete));
        }
        world.add(mesh(ribbonGeo(sg.map((r) => [dn(P3(R, r, R.E), -1.6), dn(P3(R, r, -R.E), -1.6)])), concrete));
        const len = sg[sg.length - 1].s - sg[0].s, nSpan = Math.max(1, Math.round(len / 35));
        for (let k = 1; k < nSpan; k++) {
          const s = sg[0].s + (len * k) / nSpan, r = sg.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a));
          const topZ = r.z - 1.6, gZ = r.g - 1, hh = topZ - gZ; if (hh < 1) continue;
          const pg = new T.BoxGeometry(1.8, hh, R.E * 1.3); pg.translate(0, hh / 2, 0);
          const pier = mesh(pg, concrete), v = toV(r.x, r.y, gZ);
          pier.position.set(v[0], v[1], v[2]); pier.rotation.y = Math.atan2(r.sn, r.c);
          world.add(pier);
        }
      }
      // 区画線: 外側線（実線）・中央線（実線）・車線境界線（破線 5m/5m）
      const lines = [];
      if (R.cw > 0) { lines.push({ d: -R.cw / 2 + 0.15, m: white }, { d: R.cw / 2 - 0.15, m: white }); }
      const nL = R.road.lanes;
      for (let j = 1; j < nL; j++) {
        const d = -R.cw / 2 + j * R.road.laneW, center = nL % 2 === 0 && j === nL / 2;
        lines.push({ d, m: center ? (R.road.V >= 50 && nL >= 4 ? yellow : white) : white, dash: !center, w: center ? 0.15 : 0.12 });
      }
      for (const ln of lines) {
        const w = (ln.w || 0.15) / 2, segs = [];
        let cur = null;
        for (const r of rows) {
          const on = !ln.dash || r.s % 10 < 5;
          if (on) { if (!cur) segs.push((cur = [])); cur.push(r); } else cur = null;
        }
        for (const sg of segs) if (sg.length >= 2) world.add(mesh(ribbonGeo(sg.map((r) => [P3(R, r, ln.d - w, 0.012), P3(R, r, ln.d + w, 0.012)])), ln.m, false));
      }
      // 街路灯（左右交互に 30m 間隔）
      if (opts.lamps && R.L > 20) {
        const poleG = new T.CylinderGeometry(0.07, 0.11, 8, 10); poleG.translate(0, 4, 0);
        const armG = new T.BoxGeometry(2.2, 0.09, 0.09), headG = new T.BoxGeometry(0.7, 0.14, 0.34);
        let side = 1;
        for (let s = 10; s < R.L - 5; s += 30, side = -side) {
          const r = rows.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a));
          const d = side * (R.sw > 0 ? R.W + Math.min(0.6, R.sw / 2) : R.W + 0.5), p = P3(R, r, Math.max(-R.E, Math.min(R.E, d)));
          const gp = new T.Group(); gp.position.set(p[0], p[1], p[2]);
          gp.rotation.y = Math.atan2(r.sn, r.c) + (side > 0 ? -Math.PI / 2 : Math.PI / 2); // +X を道路の内側へ
          const pole = mesh(poleG, metal), arm = mesh(armG, metal), head = mesh(headG, lampM);
          arm.position.set(1.0, 7.9, 0); arm.rotation.z = 0.08; head.position.set(2.05, 7.95, 0);
          gp.add(pole, arm, head); world.add(gp);
        }
      }
    }
    // 既存道路（地形に沿わせた帯）
    if (opts.existing && project.existingVisible && project.existing.length) {
      const exM = mat(0x5a5e64, { roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      const inBox = (p) => p.x > ex.x0 + 1 && p.x < ex.x1 - 1 && p.y > ex.y0 + 1 && p.y < ex.y1 - 1;
      for (const e of project.existing) {
        const xy = e.pts.map((q) => P.toXY(q));
        const parts = []; let cur = null;
        for (const p of xy) { if (inBox(p)) { if (!cur) parts.push((cur = [])); cur.push(p); } else cur = null; }
        const w = Math.max(2.5, e.width || 5) / 2;
        for (const part of parts) {
          const pts = [];
          for (let k = 0; k < part.length; k++) {
            if (k === 0) { pts.push(part[0]); continue; }
            const a = part[k - 1], b = part[k], l = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(l / 3));
            for (let m = 1; m <= n; m++) pts.push({ x: a.x + ((b.x - a.x) * m) / n, y: a.y + ((b.y - a.y) * m) / n });
          }
          if (pts.length < 2) continue;
          const rowsE = pts.map((p, k) => {
            const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)], th = Math.atan2(b.y - a.y, b.x - a.x), nx = -Math.sin(th), ny = Math.cos(th);
            return [-w, w].map((d) => { const x = p.x + nx * d, y = p.y + ny * d; return toV(x, y, terrainAt(G, ex, x, y) + 0.12); });
          });
          world.add(mesh(ribbonGeo(rowsE), exM, false));
        }
      }
    }
    return world;
  }

  /* ───────── 組み立て ───────── */
  async function rebuild(first) {
    if (!st.open) return;
    const my = ++st.building, ex = extent();
    try {
      await busy('3D 表示を作成中（地理院 標高タイル・背景を取得）…', async () => {
        const [hGround, texInfo] = await Promise.all([demSampler(ex), groundTexture(ex).catch(() => null)]);
        if (my !== st.building || !st.open) return;
        const roadsX = ex.roads.map((r) => roadStations(r, hGround)).filter(Boolean);
        const G = buildTerrain(ex, hGround, roadsX, texInfo);
        let base = Infinity; for (const h of G.H) base = Math.min(base, h);
        const world = build(ex, G, roadsX, base);
        world.scale.y = opts.exag;
        if (st.world) disposeTree(st.world);
        st.world = world; st.scene.add(world);
        const prev = st.info;
        st.info = { ex, base, G, roadsX, hmax: Math.max(...G.H) - base };
        placeSun(); setShadows(opts.preview);
        if (first || !prev || Math.abs(prev.ex.D - ex.D) > 1 || Math.abs(prev.ex.cx - ex.cx) > 1 || Math.abs(prev.ex.cy - ex.cy) > 1) resetView();
        const tx = TEX[opts.tex];
        st.el.querySelector('.v3attr').textContent = [tx && tx.attr ? '地表: ' + tx.attr : '', '標高: 地理院タイル（標高タイル）'].filter(Boolean).join('　');
        requestRender();
      });
      if (ex.clipped) toast('範囲が広いため中央の 4km 四方だけを 3D 表示しています');
      if (first && !ex.roads.length) toast('計画道路がないため、地図の表示範囲の地形を表示しています');
    } catch (e) { toast('3D 表示を作成できませんでした: ' + e.message, 'err'); }
  }

  function resetView() {
    if (!st.info) return;
    const { ex, roadsX } = st.info, D = ex.D;
    // 注視点: 道路の中央付近の路面
    let ty = 0;
    const all = roadsX.flatMap((R) => R.rows);
    if (all.length) ty = (all.reduce((a, r) => a + r.z, 0) / all.length - st.info.base) * opts.exag;
    else ty = (st.info.G.mean - st.info.base) * opts.exag;
    st.controls.target.set(0, ty, 0);
    const az = (-35 * Math.PI) / 180, el = (36 * Math.PI) / 180, dist = D * 0.78;
    st.camera.position.set(Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    st.camera.near = Math.max(0.3, D / 3000); st.camera.far = D * 20; st.camera.updateProjectionMatrix();
    st.controls.minDistance = 5; st.controls.maxDistance = D * 4;
    st.controls.update();
  }
  function topView() {
    if (!st.info) return;
    const t = st.controls.target, d = st.info.ex.D * 1.25;
    st.camera.position.set(t.x, t.y + d, t.z + 0.001);
    st.controls.update();
  }
  /* 太陽: 方位（北から時計回り）・高度。影のカメラは地形全体を覆う */
  function placeSun() {
    if (!st.info || !st.sun) return;
    const { ex } = st.info, az = (opts.sunAz * Math.PI) / 180, alt = (opts.sunAlt * Math.PI) / 180, D = ex.D;
    const dir = new T.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    const tgt = new T.Vector3(0, (st.info.hmax * opts.exag) / 2, 0);
    st.sun.position.copy(tgt).addScaledVector(dir, D * 2);
    st.sun.target.position.copy(tgt); st.sun.target.updateMatrixWorld();
    const cam = st.sun.shadow.camera, half = D * 0.75;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half; cam.near = D * 0.5; cam.far = D * 4; cam.updateProjectionMatrix();
  }
  function setShadows(on, size) {
    const r = st.renderer, sun = st.sun;
    const want = size || Math.min(4096, r.capabilities.maxTextureSize);
    if (sun.shadow.mapSize.x !== want) { sun.shadow.mapSize.set(want, want); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
    sun.castShadow = !!on;
    if (r.shadowMap.enabled !== !!on) {
      r.shadowMap.enabled = !!on;
      st.scene.traverse((m) => { if (m.material) [].concat(m.material).forEach((mt) => { mt.needsUpdate = true; }); });
    }
    r.shadowMap.needsUpdate = true;
  }

  /* ───────── 撮影（影付き・高解像度） ───────── */
  async function shoot() {
    if (!st.info) return;
    const r = st.renderer, box = st.el.querySelector('.v3canvas'), gl = r.getContext();
    const maxRB = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], 8192);
    let w, h;
    if (opts.shot === 'fhd') { w = 1920; h = 1080; } else if (opts.shot === '4k') { w = 3840; h = 2160; } else if (opts.shot === 'sq') { w = h = 2048; }
    else { w = box.clientWidth * 2; h = box.clientHeight * 2; }
    const f = Math.min(1, maxRB / Math.max(w, h)); w = Math.round(w * f); h = Math.round(h * f);
    const shotEl = toast('影付きで撮影中…', 'busy');
    await new Promise((res) => setTimeout(res, 30));
    const prevPR = r.getPixelRatio(), prevAspect = st.camera.aspect;
    let out;
    try {
      setShadows(true, Math.min(8192, r.capabilities.maxTextureSize));
      st.sun.shadow.radius = 3;
      r.setPixelRatio(1); r.setSize(w, h, false);
      st.camera.aspect = w / h; st.camera.updateProjectionMatrix();
      r.render(st.scene, st.camera);
      out = document.createElement('canvas'); out.width = w; out.height = h;
      const g = out.getContext('2d');
      g.drawImage(r.domElement, 0, 0);
      decorate(g, w, h);
    } finally {
      st.sun.shadow.radius = 2;
      setShadows(opts.preview);
      r.setPixelRatio(prevPR); r.setSize(box.clientWidth, box.clientHeight); st.camera.aspect = prevAspect; st.camera.updateProjectionMatrix();
      requestRender(); shotEl.remove();
    }
    const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
    if (!blob) return toast('画像を作成できませんでした', 'err');
    showShot(blob, w, h);
  }
  /* タイトル・出典・周辺減光 */
  function decorate(g, w, h) {
    const k = Math.max(w, h) / 1600;
    const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.hypot(w, h) * 0.6);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.22)');
    g.fillStyle = vg; g.fillRect(0, 0, w, h);
    const font = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif';
    if (opts.caption) {
      const roads = st.info.roadsX, len = roads.reduce((a, R) => a + R.L, 0);
      const sub = roads.length ? `${roads.map((R) => R.road.name).slice(0, 3).join('・')}${roads.length > 3 ? ' ほか' : ''}　延長 ${fmt(len, 0)} m` : '';
      const pad = 34 * k;
      g.font = `700 ${30 * k}px ${font}`;
      const tw = Math.max(g.measureText(project.name).width, (g.font = `500 ${16 * k}px ${font}`, g.measureText(sub).width));
      g.fillStyle = 'rgba(255,255,255,0.86)';
      const bw = tw + 36 * k, bh = (sub ? 86 : 58) * k, bx = pad, by = h - pad - bh;
      g.beginPath(); g.roundRect(bx, by, bw, bh, 10 * k); g.fill();
      g.fillStyle = '#0d99ff'; g.fillRect(bx, by + 14 * k, 5 * k, bh - 28 * k);
      g.fillStyle = '#1e1e1e'; g.font = `700 ${30 * k}px ${font}`; g.textBaseline = 'top';
      g.fillText(project.name, bx + 20 * k, by + 14 * k);
      if (sub) { g.fillStyle = '#555'; g.font = `500 ${16 * k}px ${font}`; g.fillText(sub, bx + 20 * k, by + 54 * k); }
    }
    const tx = TEX[opts.tex], attr = [tx && tx.attr ? tx.attr : '', '標高: 地理院タイル', opts.exag > 1 ? `高さ ${opts.exag} 倍強調` : ''].filter(Boolean).join(' ／ ');
    g.font = `500 ${11 * k}px ${font}`; g.textBaseline = 'bottom'; g.textAlign = 'right';
    g.fillStyle = 'rgba(255,255,255,0.75)'; const aw = g.measureText(attr).width;
    g.fillRect(w - aw - 16 * k, h - 22 * k, aw + 16 * k, 22 * k);
    g.fillStyle = '#333'; g.fillText(attr, w - 8 * k, h - 5 * k);
    g.textAlign = 'left';
  }
  function showShot(blob, w, h) {
    const url = URL.createObjectURL(blob), name = `${(project.name || 'road-plan').replace(/[\\/:*?"<>|]/g, '_')}_3d.png`;
    const card = $('#modal .modal-card');
    card.innerHTML = `<h2>3D スクリーンショット</h2>
      <img class="v3shot" src="${url}" alt="3D スクリーンショット">
      <div class="foot"><span class="muted">${w} × ${h} px・${fmt(blob.size / 1048576, 1)} MB</span><a class="btn accent" href="${url}" download="${esc(name)}">PNG を保存</a><button class="btn" data-act="close-modal">閉じる</button></div>`;
    card.classList.add('wide-card');
    $('#modal').hidden = false;
    const obs = new MutationObserver(() => { if ($('#modal').hidden) { card.classList.remove('wide-card'); URL.revokeObjectURL(url); obs.disconnect(); } });
    obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
  }

  /* 3D 表示中は地図のショートカット（Delete など）を無効にする */
  document.addEventListener('keydown', (e) => {
    if (!st.open) return;
    const inForm = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (inForm && !st.el.contains(e.target)) return; // 右パネルでの数値入力は通常どおり
    if (!$('#modal').hidden) return;
    if (e.key === 'Escape') { close(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) return; // undo / redo は通す
    e.stopImmediatePropagation();
  }, true);

  return { open, close, toggle, changed, isOpen: () => st.open, _st: st };
})();
