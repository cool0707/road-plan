/* Road Plan — 3D ビュー（three.js）
 * 地理院 標高タイルの地形 ＋ 背景タイルの貼り付け ＋ 計画道路（計画高・片勾配・切土／盛土のり面・区画線・歩道・街路灯）＋ 既存道路
 * ＋ 建物・水面（地理院ベクトルタイル）＋ 森 ＋ 地平線までの遠景。空・大気・影・ポスト処理は v3d-fx.js、建物は v3d-city.js。
 * マウスで回転・移動・ズーム。撮影は高解像度で別途レンダリングして PNG に保存する。 */
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
  const QUALITY = { high: '高（影・AO・ブルーム）', std: '標準', low: '軽量（影なし）' };
  const defOpts = { tex: 'photo', exag: 1, existing: true, lamps: true, buildings: true, sunAz: 150, sunAlt: 38, clouds: 40, haze: 35, quality: 'high', shot: 'screen2', caption: true, trees: 'auto', treeDensity: 80, brush: 20 };
  let opts = Object.assign({}, defOpts);
  try { Object.assign(opts, JSON.parse(localStorage.getItem(OPT_KEY)) || {}); } catch (e) { /* 既定値 */ }
  const saveOpts = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch (e) { /* 無視 */ } };

  const st = { open: false, ready: null, el: null, renderer: null, scene: null, camera: null, controls: null, world: null, sun: null, hemi: null, raf: 0, ro: null, building: 0, dirty: 0, info: null, texCache: new Map(), trees: null, terrain: null, autoMask: null, post: false, city: null, waterTex: null };
  let T = null, FX = null; // window.THREE, V3DFX
  const SEA = -1e4; // 標高タイルが「データなし」＝海

  /* ───────── 読み込み・開閉 ───────── */
  function loadThree() {
    if (!st.ready) st.ready = loadScript('vendor/three/three.min.js').then(() => Promise.all([loadScript('js/v3d-fx.js'), loadScript('js/v3d-city.js')]))
      .then(() => { T = window.THREE; FX = V3DFX; }).catch((e) => { st.ready = null; throw e; });
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
    if (st.trees) disposeTree(st.trees);
    if (st.waterTex) st.waterTex.dispose();
    if (leaf.tex) { leaf.tex.dispose(); leaf.tex = null; }
    brush.mode = null; brush.ring = null;
    st.controls && st.controls.dispose();
    FX.dispose();
    for (const t of st.texCache.values()) t.dispose();
    st.texCache.clear();
    st.renderer && (st.renderer.dispose(), st.renderer.forceContextLoss());
    st.el && st.el.remove();
    Object.assign(st, { el: null, renderer: null, scene: null, camera: null, controls: null, world: null, sun: null, hemi: null, info: null, trees: null, terrain: null, waterTex: null, autoMask: null });
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
        ${chk('buildings', '建物（高さは実測があれば使用）')}${chk('existing', '既存道路')}${chk('lamps', '街路灯')}
        <div class="v3row"><span>画質</span>${sel('quality', QUALITY)}</div>
        <div class="v3sub">木（森）<b class="v3cnt" data-out="treeCount"></b></div>
        <div class="v3row"><span>範囲</span>${sel('trees', { auto: '航空写真から自動＋塗った範囲', paint: '塗った範囲だけ', off: '木なし' })}</div>
        ${rng('treeDensity', '密度', 10, 100, 5, '%')}
        <div class="v3btns"><button class="btn" data-v3act="brush-plant" title="3D 上を左ドラッグして木を植える範囲を塗る">🌲 塗って植える</button><button class="btn" data-v3act="brush-erase" title="左ドラッグでなぞった範囲の木を消す（自動判定の森も消せます）">消す</button></div>
        ${rng('brush', 'ブラシ', 4, 80, 2, 'm')}
        <div class="v3btns"><button class="btn" data-v3act="forest-clear" title="塗って植えた範囲・消した範囲をすべて取り消す">塗った範囲をクリア</button></div>
        <div class="v3sub">太陽・空</div>
        ${rng('sunAz', '方位', 0, 359, 1, '°')}
        ${rng('sunAlt', '高度', 5, 85, 1, '°')}
        ${rng('clouds', '雲', 0, 100, 5, '%')}
        ${rng('haze', '霞', 0, 100, 5, '%')}
        <div class="v3sub">撮影</div>
        <div class="v3row"><span>サイズ</span>${sel('shot', SHOTS)}</div>
        ${chk('caption', 'タイトルを入れる')}
        <div class="v3btns"><button class="btn accent wide" data-v3act="shot">📷 高画質で撮影</button></div>
        <div class="v3btns"><button class="btn" data-v3act="reset">視点をリセット</button><button class="btn" data-v3act="top">真上から</button></div>
      </div>
      <div class="v3hint">左ドラッグ: 回転　右ドラッグ / Shift+ドラッグ: 移動　ホイール: ズーム</div>
      <div class="v3attr"></div>`;
    $('#stage').appendChild(el);
    el.addEventListener('input', (e) => {
      const t = e.target, k = t.dataset.v3; if (!k) return;
      const v = t.type === 'checkbox' ? t.checked : t.type === 'range' ? +t.value : t.value;
      opts[k] = v; saveOpts();
      const out = el.querySelector(`[data-out="${k}"]`); if (out) out.textContent = v + ({ exag: '×', treeDensity: '%', brush: 'm', clouds: '%', haze: '%' }[k] || '°');
      if (k === 'tex' || k === 'existing' || k === 'lamps' || k === 'buildings') return rebuild(false);
      if (k === 'exag') { st.world.scale.y = v; placeSun(); buildTrees(); }
      if (k === 'quality') applyQuality();
      if (k === 'trees') { ensureAutoMask().then(buildTrees); return; }
      if (k === 'treeDensity') return buildTrees();
      if (k === 'brush') return;
      if (k === 'sunAz' || k === 'sunAlt' || k === 'clouds' || k === 'haze') placeSun();
      requestRender();
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v3act]'); if (!b) return;
      const a = b.dataset.v3act;
      if (a === 'close') close();
      else if (a === 'brush-plant') setBrush('plant');
      else if (a === 'brush-erase') setBrush('erase');
      else if (a === 'forest-clear') { const S = forestSets(); if (!S.plant.size && !S.erase.size) return; if (!confirm('塗って植えた範囲・消した範囲をすべて取り消しますか？')) return; S.plant.clear(); S.erase.clear(); forestStore(); buildTrees(); }
      else if (a === 'shot') shoot();
      else if (a === 'reset') { resetView(); requestRender(); }
      else if (a === 'top') { topView(); requestRender(); }
    });
  }

  function initRenderer() {
    const box = st.el.querySelector('.v3canvas');
    const r = (st.renderer = new T.WebGLRenderer({ antialias: true }));
    r.outputColorSpace = T.SRGBColorSpace;
    r.toneMapping = T.ACESFilmicToneMapping; r.toneMappingExposure = 0.8;
    r.shadowMap.type = T.PCFSoftShadowMap;
    box.appendChild(r.domElement);
    st.scene = new T.Scene();
    st.camera = new T.PerspectiveCamera(46, 1, 0.5, 400000);
    const c = (st.controls = new T.OrbitControls(st.camera, r.domElement));
    c.enableDamping = true; c.dampingFactor = 0.12; c.screenSpacePanning = false; c.maxPolarAngle = Math.PI * 0.495;
    c.addEventListener('change', requestRender);
    st.post = FX.init(T, r, st.scene); // false: 浮動小数のレンダーターゲットが使えない → ポスト処理なし
    st.hemi = new T.HemisphereLight(0xdfeaff, 0x7a6a52, 1.1); st.hemi.visible = !st.post; // 環境マップ（空）が使えないときの環境光
    const sun = (st.sun = new T.DirectionalLight(0xfff0dc, 2.8));
    sun.shadow.bias = -0.0003;
    st.scene.add(st.hemi, sun, sun.target);
    const resize = () => {
      const w = box.clientWidth || 1, h = box.clientHeight || 1;
      r.setSize(w, h); st.camera.aspect = w / h; st.camera.updateProjectionMatrix(); requestRender();
    };
    initBrush();
    applyQuality(); placeSun();
    st.ro = new ResizeObserver(resize); st.ro.observe(box); resize();
  }
  /* 画質: 高＝影 4096・AO・ブルーム / 標準＝影 2048・解像度控えめ / 軽量＝ポスト処理も影もなし */
  const quality = () => (st.post && QUALITY[opts.quality] ? opts.quality : st.post ? 'high' : 'low');
  function applyQuality() {
    const q = quality(), r = st.renderer, dpr = window.devicePixelRatio || 1;
    r.setPixelRatio(q === 'high' ? Math.min(2, dpr) : Math.min(1.5, dpr));
    const box = st.el.querySelector('.v3canvas'); r.setSize(box.clientWidth || 1, box.clientHeight || 1);
    setShadows(q !== 'low', q === 'high' ? 4096 : 2048);
    const fog = q === 'low'; // 軽量ではポスト処理の霞の代わりに単純なフォグで遠景をなじませる
    if (!!st.scene.fog !== fog) { st.scene.fog = fog ? new T.FogExp2(0xb9c7d3, 0.00009) : null; st.scene.traverse((m) => { if (m.material) [].concat(m.material).forEach((mt) => { mt.needsUpdate = true; }); }); }
    requestRender();
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
      renderFrame();
      if (--settle > 0) st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);
  }
  /* 1 フレーム。手前の切れと奥行き精度のため near をカメラの距離・地表からの高さに合わせ、影の範囲も視点に合わせる */
  function renderFrame(shot) {
    const cam = st.camera, r = st.renderer, q = shot ? 'high' : quality();
    if (st.info) {
      const { ex, G, base } = st.info, d = cam.position.distanceTo(st.controls.target);
      const gx = cam.position.x + ex.cx, gy = ex.cy - cam.position.z;
      const hg = gx > ex.x0 && gx < ex.x1 && gy > ex.y0 && gy < ex.y1 ? (terrainAt(G, ex, gx, gy) - base) * opts.exag : 0;
      if (cam.position.y < hg + 1.5) { cam.position.y = hg + 1.5; cam.lookAt(st.controls.target); } // 地面の下にもぐらない
      const near = Math.min(40, Math.max(0.3, Math.min(d * 0.02, Math.max(0, cam.position.y - hg) * 0.25)));
      if (Math.abs(near - cam.near) > near * 0.05) { cam.near = near; cam.updateProjectionMatrix(); }
      FX.U.uCamKm.value.set(cam.position.x * 0.001, cam.position.z * 0.001);
      if (q !== 'low') fitShadow(d);
    }
    if (q === 'low' || !st.post) { r.setRenderTarget(null); r.render(st.scene, cam); return; }
    const hz = opts.haze / 100;
    FX.render(r, st.scene, cam, {
      samples: 4, fog: 2e-5 + 8e-4 * hz * hz, fogH: 900 + 900 * hz, ao: q === 'high' || shot ? 1 : 0.85, cloudShadow: 0.85,
      exposure: 1.25, bloom: q === 'high' ? 0.55 : 0.35, saturation: 1.1, vignette: 0.28,
    });
  }

  function disposeTree(o) {
    o.traverse((m) => {
      if (m.geometry) m.geometry.dispose();
      if (m.material) [].concat(m.material).forEach((mt) => { if (mt.map && !mt.map.userData.cached) mt.map.dispose(); if (mt.userData.waterTex) mt.userData.waterTex.dispose(); mt.dispose(); });
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
    } else pad = Math.max(140, 0.3 * Math.max(x1 - x0, y1 - y0));
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const MAX = 4000, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let clipped = false;
    if (x1 - x0 > MAX) { x0 = cx - MAX / 2; x1 = cx + MAX / 2; clipped = true; }
    if (y1 - y0 > MAX) { y0 = cy - MAX / 2; y1 = cy + MAX / 2; clipped = true; }
    return { x0, y0, x1, y1, cx, cy, w: x1 - x0, h: y1 - y0, D: Math.max(x1 - x0, y1 - y0), roads, clipped };
  }

  /* ───────── 地形（地理院 標高タイル） ───────── */
  const tileXY = (ll, z) => { const n = 2 ** z, r = (ll.lat * Math.PI) / 180; return { fx: ((ll.lng + 180) / 360) * n, fy: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n }; };
  /* 標高を返す関数を作る。戻り値: 標高 [m] / SEA（10m DEM にデータなし＝海）/ null（タイルを取得できない） */
  async function demSampler(ex, levels = [['dem5a_png', 15], ['dem_png', 14]]) {
    const tiles = new Map();
    const corners = [P.toLL(ex.x0, ex.y0), P.toLL(ex.x1, ex.y1)];
    const jobs = [];
    for (const [kind, z] of levels) {
      const a = tileXY(corners[0], z), b = tileXY(corners[1], z);
      for (let x = Math.floor(Math.min(a.fx, b.fx)); x <= Math.floor(Math.max(a.fx, b.fx)); x++)
        for (let y = Math.floor(Math.min(a.fy, b.fy)); y <= Math.floor(Math.max(a.fy, b.fy)); y++)
          jobs.push(demTile(kind, z, x, y).then((d) => tiles.set(`${kind}/${z}/${x}/${y}`, d)));
    }
    await Promise.all(jobs);
    const px = (kind, z, X, Y) => { // 全体ピクセル座標の標高（データなしは null、タイルがなければ undefined）
      const d = tiles.get(`${kind}/${z}/${Math.floor(X / 256)}/${Math.floor(Y / 256)}`); if (!d) return undefined;
      const i = ((Y & 255) * 256 + (X & 255)) * 4, v = d[i] * 65536 + d[i + 1] * 256 + d[i + 2];
      if (v === 8388608 || d[i + 3] === 0) return null;
      return (v < 8388608 ? v : v - 16777216) * 0.01;
    };
    return (ll) => {
      let sea = false;
      for (const [kind, z] of levels) {
        const t = tileXY(ll, z), X = t.fx * 256 - 0.5, Y = t.fy * 256 - 0.5, ix = Math.floor(X), iy = Math.floor(Y), u = X - ix, v = Y - iy;
        const a = px(kind, z, ix, iy), b = px(kind, z, ix + 1, iy), c = px(kind, z, ix, iy + 1), d = px(kind, z, ix + 1, iy + 1);
        if (a == null || b == null || c == null || d == null) {
          const any = a ?? b ?? c ?? d; if (any != null) return any;
          if (kind === 'dem_png' && (a === null || b === null || c === null || d === null)) sea = true;
          continue;
        }
        return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
      }
      return sea ? SEA : null;
    };
  }

  /* ───────── 地表テクスチャ（背景タイルを 1 枚の画像に） ───────── */
  const groundTexture = (ex, kind = opts.tex) => mosaic(kind, ex, 3000);
  /* 矩形 r = { x0, y0, x1, y1 }（ローカル m）を覆うタイルを、長辺がおよそ px ピクセルになるズームで 1 枚にまとめる */
  async function mosaic(kind, r, px) {
    const def = TEX[kind];
    if (!def || !def.url) return null;
    const ll0 = P.toLL(r.x0, r.y1), ll1 = P.toLL(r.x1, r.y0), lat = (ll0.lat + ll1.lat) / 2;
    const mpp0 = 156543.03392 * Math.cos((lat * Math.PI) / 180), D = Math.max(r.x1 - r.x0, r.y1 - r.y0);
    const z = Math.max(8, Math.min(def.max, Math.floor(Math.log2((mpp0 * px) / D))));
    const a = tileXY(ll0, z), b = tileXY(ll1, z);
    const tx0 = Math.floor(a.fx), ty0 = Math.floor(a.fy), tx1 = Math.floor(b.fx), ty1 = Math.floor(b.fy);
    const key = `${kind}/${z}/${tx0}/${ty0}/${tx1}/${ty1}`;
    const frame = { z, ox: tx0 * 256, oy: ty0 * 256, W: (tx1 - tx0 + 1) * 256, H: (ty1 - ty0 + 1) * 256 };
    if (st.texCache.has(key)) { const t = st.texCache.get(key); st.texCache.delete(key); st.texCache.set(key, t); return Object.assign({ tex: t }, frame); }
    const c = document.createElement('canvas'); c.width = frame.W; c.height = frame.H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#c9cfc4'; g.fillRect(0, 0, c.width, c.height);
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
    if (!st.open) return null;
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = st.renderer.capabilities.getMaxAnisotropy(); tex.userData.cached = true;
    if (st.texCache.size > 7) { const k = st.texCache.keys().next().value; st.texCache.get(k).dispose(); st.texCache.delete(k); }
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
    // 片勾配: 曲線区間で内側へ傾ける（緩和曲線で曲率に比例してすりつけ）。直線部は 2% の拝み勾配。
    // 値は IP に設定した片勾配（なければ必要片勾配から自動。自動で 2% 以下なら拝み勾配のまま）
    rows.forEach((r) => {
      let c = null;
      for (const cv of al.curves) if (cv && !cv.none && cv.sTS != null && r.s >= cv.sTS - 1e-6 && r.s <= cv.sST + 1e-6) { c = cv; break; }
      let inner = -0.02, outer = -0.02;
      if (c && Math.abs(r.k) > 1e-9) {
        const se = Rules.superelevation(road, c.ip, c.R), e = se.e, t = Math.min(1, Math.abs(r.k) * c.R);
        if (se.set || e > 0.02) { inner = -(0.02 + (e - 0.02) * t); outer = -0.02 + (e + 0.02) * t; }
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

  /* 既存道路の横断形状: 地面に貼り付けず、中心線の現況高を前後 20m でならした高さに、水平な横断（直線部は 2% の拝み勾配）で置く。
   * 既存道路には片勾配のデータがないので、曲線部は線形の曲率と速度から推定する（i = V²/(127R) − f、上限 8%） */
  function existingStations(ex, hRoad) {
    const out = [];
    if (!(opts.existing && project.existingVisible && project.existing.length)) return out;
    const inBox = (p) => p.x > ex.x0 + 1 && p.x < ex.x1 - 1 && p.y > ex.y0 + 1 && p.y < ex.y1 - 1;
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    for (const e of project.existing) {
      const xy = e.pts.map((q) => P.toXY(q)), parts = []; let cur = null;
      for (const p of xy) { if (inBox(p)) { if (!cur) parts.push((cur = [])); cur.push(p); } else cur = null; }
      const W = Math.max(2.5, e.width || 5) / 2, V = e.speed || 40, f = Rules.T[Rules.SPEEDS.reduce((a, b) => (Math.abs(b - V) < Math.abs(a - V) ? b : a))].f;
      for (const part of parts) {
        const pts = [];
        for (let k = 0; k < part.length; k++) {
          if (k === 0) { pts.push(part[0]); continue; }
          const a = part[k - 1], b = part[k], l = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(l / 3));
          for (let m = 1; m <= n; m++) pts.push({ x: a.x + ((b.x - a.x) * m) / n, y: a.y + ((b.y - a.y) * m) / n });
        }
        const n = pts.length; if (n < 2) continue;
        const s = [0]; for (let k = 1; k < n; k++) s.push(s[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
        const th = pts.map((p, k) => { const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)]; return Math.atan2(b.y - a.y, b.x - a.x); });
        const g = pts.map((p) => hRoad(P.toLL(p.x, p.y)));
        if (g.every((h) => h == null)) continue;
        const k0 = th.map((_, k) => { const a = Math.max(0, k - 2), b = Math.min(n - 1, k + 2); return s[b] > s[a] ? wrap(th[b] - th[a]) / (s[b] - s[a]) : 0; });
        const avg = (arr, k, win) => { let sum = 0, c = 0; for (let m = k; m >= 0 && s[k] - s[m] <= win; m--) if (arr[m] != null) { sum += arr[m]; c++; } for (let m = k + 1; m < n && s[m] - s[k] <= win; m++) if (arr[m] != null) { sum += arr[m]; c++; } return c ? sum / c : null; };
        const rows = pts.map((p, k) => {
          const kk = avg(k0, k, 15) || 0, e2 = Math.min(0.08, Math.max(0, (V * V * Math.abs(kk)) / 127 - f)), t = Math.min(1, e2 / 0.02);
          const inner = -Math.max(0.02, e2), outer = -0.02 + (e2 + 0.02) * t;
          return { s: s[k], x: p.x, y: p.y, c: Math.cos(th[k]), sn: Math.sin(th[k]), k: kk, z: avg(g, k, 20) ?? 0, slope: kk > 0 ? [inner, outer] : [outer, inner], bridge: false };
        });
        out.push({ rows, W, sw: 0, E: W, cw: 0, L: s[n - 1], existing: true });
      }
    }
    return out;
  }
  /* 既存道路の所の地形を路面に合わせる（幅員内は路面のすぐ下、外側 4m でなじませる） */
  function carveExisting(ex, G, exX) {
    const { nx, ny, sp, H } = G, best = new Float32Array(nx * ny).fill(Infinity), src = Float32Array.from(H);
    for (const R of exX) {
      const flat = R.W + sp * 0.75, reach = flat + 4;
      for (const r of R.rows) {
        const i0 = Math.max(0, Math.floor((r.x - reach - ex.x0) / sp)), i1 = Math.min(nx - 1, Math.ceil((r.x + reach - ex.x0) / sp));
        const j0 = Math.max(0, Math.floor((ex.y1 - r.y - reach) / sp)), j1 = Math.min(ny - 1, Math.ceil((ex.y1 - r.y + reach) / sp));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const vx = G.gx(i) - r.x, vy = G.gy(j) - r.y, d = -vx * r.sn + vy * r.c, a = Math.abs(d), d2 = vx * vx + vy * vy, k = j * nx + i;
          if (a > reach || Math.abs(vx * r.c + vy * r.sn) > 2.6 || d2 >= best[k]) continue;
          best[k] = d2;
          const top = surfZ(R, r, Math.max(-R.W, Math.min(R.W, d))) - 0.12;
          H[k] = a <= flat ? top : top + (src[k] - top) * sstep(a - flat, 0, 4);
        }
      }
    }
  }

  /* ───────── 地形メッシュ（切土・盛土で整形） ───────── */
  function buildTerrain(ex, hGround, roadsX, texInfo, exX = []) {
    const sp = Math.max(1.2, ex.D / 260), nx = Math.ceil(ex.w / sp) + 1, ny = Math.ceil(ex.h / sp) + 1;
    const N = nx * ny, H = new Float32Array(N), H0 = new Float32Array(N), earth = new Float32Array(N * 4);
    const gx = (i) => ex.x0 + (ex.w * i) / (nx - 1), gy = (j) => ex.y1 - (ex.h * j) / (ny - 1); // j=0 が北端
    let sum = 0, cnt = 0;
    const raw = new Array(N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const h = hGround(P.toLL(gx(i), gy(j))); raw[j * nx + i] = h; if (h != null && h !== SEA) { sum += h; cnt++; } }
    const mean = cnt ? sum / cnt : 0;
    for (let k = 0; k < N; k++) { const sea = raw[k] === SEA; H0[k] = H[k] = sea ? 0 : raw[k] ?? mean; if (sea) earth[k * 4 + 3] = 1; } // 海は標高 0 の水面
    if (exX.length) { carveExisting(ex, { nx, ny, sp, H, gx, gy }, exX); H0.set(H); } // 既存道路の路盤（計画の切盛とは区別する）
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
        if (u <= 1e-6) { H[k] = top; earth[k * 4 + 3] = 0; continue; }
        const w = u <= SLOPE_MAX ? 1 : Math.max(0, 1 - (u - SLOPE_MAX) / SLOPE_FADE); // のり長が長すぎる所は自然地形へなじませる
        if (h < top) { const f = h + (top - u / 1.5 - h) * w; if (f > h) { H[k] = f; earth[k * 4] = Math.max(earth[k * 4], Math.min(1, (f - h) / 0.6) * Math.min(1, w * 1.5)); earth[k * 4 + 3] = 0; } }
        else { const c = h + (top + u * 1.0 - h) * w; if (c < h) { H[k] = c; earth[k * 4 + 1] = Math.max(earth[k * 4 + 1], Math.min(1, (h - c) / 0.6) * Math.min(1, w * 1.5)); } }
      }
    }
    return { nx, ny, sp, H, H0, earth, gx, gy, mean, tex: texInfo, exX };
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
    const uv = new Float32Array(nr * nc * 2); // 水平投影の UV（舗装の肌理用。6m で 1 周）
    for (let k = 0; k < nr * nc; k++) { uv[k * 2] = pos[k * 3] / 6; uv[k * 2 + 1] = pos[k * 3 + 2] / 6; }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('uv', new T.BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  const mat = (color, o = {}) => new T.MeshStandardMaterial(Object.assign({ color, roughness: 0.92, metalness: 0, side: T.DoubleSide }, o));
  /* 舗装の肌理（骨材の粒と色むら）。light: 歩道用の明るい平板 */
  const asphaltT = {};
  function asphaltTex(light) {
    const key = light ? 'l' : 'd';
    if (asphaltT[key] && asphaltT[key].image) return asphaltT[key];
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d'), im = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = hash(x, y, 31), m = fbmWrap(x / S, y / S, 4), v = light ? 205 + 40 * (m - 0.5) + 22 * (n - 0.5) : 50 + 26 * (m - 0.5) + 30 * (n - 0.5) * (n > 0.85 ? 2.2 : 1);
      const k = (y * S + x) * 4; im.data[k] = v; im.data[k + 1] = v * (light ? 0.985 : 1.02); im.data[k + 2] = v * (light ? 0.95 : 1.07); im.data[k + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    if (light) { g.strokeStyle = 'rgba(90,86,80,.35)'; g.lineWidth = 1; for (let k = 0; k <= S; k += 32) { g.beginPath(); g.moveTo(k + 0.5, 0); g.lineTo(k + 0.5, S); g.moveTo(0, k + 0.5); g.lineTo(S, k + 0.5); g.stroke(); } }
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 8; t.userData.cached = true;
    return (asphaltT[key] = t);
  }
  function mesh(geo, material, shadow = true) { const m = new T.Mesh(geo, material); m.castShadow = shadow; m.receiveShadow = true; return m; }

  function build(ex, G, roadsX, base, excl) {
    const world = new T.Group();
    const toV = (x, y, z) => [x - ex.cx, z - base, -(y - ex.cy)];
    // 地形（外周には下向きのスカートを付けて遠景との継ぎ目を隠す）
    const { nx, ny, H, earth } = G, N = nx * ny, ring = [];
    for (let i = 0; i < nx; i++) ring.push(i);
    for (let j = 1; j < ny; j++) ring.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) ring.push((ny - 1) * nx + i);
    for (let j = ny - 2; j >= 1; j--) ring.push(j * nx);
    const NV = N + ring.length, pos = new Float32Array(NV * 3), uv = new Float32Array(NV * 2), ea = new Float32Array(NV * 4), idx = [];
    ea.set(earth);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = G.gx(i), y = G.gy(j);
      pos.set(toV(x, y, H[k]), k * 3);
      if (G.tex) { const t = tileXY(P.toLL(x, y), G.tex.z); uv[k * 2] = (t.fx * 256 - G.tex.ox) / G.tex.W; uv[k * 2 + 1] = 1 - (t.fy * 256 - G.tex.oy) / G.tex.H; }
    }
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const p = j * nx + i, q = p + nx; idx.push(p, q, p + 1, p + 1, q, q + 1); }
    ring.forEach((k, m) => {
      const v = N + m, m2 = (m + 1) % ring.length;
      pos[v * 3] = pos[k * 3]; pos[v * 3 + 1] = pos[k * 3 + 1] - 40; pos[v * 3 + 2] = pos[k * 3 + 2];
      uv[v * 2] = uv[k * 2]; uv[v * 2 + 1] = uv[k * 2 + 1]; ea.set(earth.subarray(k * 4, k * 4 + 4), v * 4);
      idx.push(k, ring[m2], v, ring[m2], N + m2, v);
    });
    const tg = new T.BufferGeometry();
    tg.setAttribute('position', new T.BufferAttribute(pos, 3)); tg.setAttribute('uv', new T.BufferAttribute(uv, 2));
    tg.setAttribute('aEarth', new T.BufferAttribute(ea, 4)); tg.setIndex(idx); tg.computeVertexNormals();
    const tm = FX.patchTerrain(new T.MeshStandardMaterial({ color: G.tex ? 0xffffff : 0xa9b494, map: G.tex ? G.tex.tex : null, roughness: 1, metalness: 0 }), { photo: !!G.tex && opts.tex === 'photo' });
    const terrainMesh = mesh(tg, tm); terrainMesh.name = 'terrain';
    world.add(terrainMesh);
    // 海（標高 0 の水面を水平線まで）
    const seaG = new T.CircleGeometry(180000, 96); seaG.rotateX(-Math.PI / 2);
    const sea = new T.Mesh(seaG, FX.patchTerrain(new T.MeshStandardMaterial({ color: 0x08222c, roughness: 0.1, metalness: 0 }), { sea: true }));
    sea.position.y = -base - 0.7; sea.receiveShadow = true; sea.name = 'sea';
    world.add(sea);
    // 建物
    if (opts.buildings && st.city && st.city.buildings.length) {
      const plan = excl, photo = st.autoMask && st.autoMask.rgb ? st.autoMask : null;
      const inEx = (x, y) => x > ex.x0 + 0.5 && x < ex.x1 - 0.5 && y > ex.y0 + 0.5 && y < ex.y1 - 0.5;
      const cell = (x, y) => Math.min(ny - 1, Math.max(0, Math.round((ex.y1 - y) / G.sp))) * nx + Math.min(nx - 1, Math.max(0, Math.round((x - ex.x0) / G.sp)));
      const B = V3DCity.buildGeometry(st.city.buildings, {
        T, toV, ground: (x, y) => (inEx(x, y) ? terrainAt(G, ex, x, y) : null), skip: (x, y) => (plan[cell(x, y)] & 2) > 0,
        roofUv: G.tex && opts.tex === 'photo' ? (x, y) => { const t = tileXY(P.toLL(x, y), G.tex.z); return [(t.fx * 256 - G.tex.ox) / G.tex.W, 1 - (t.fy * 256 - G.tex.oy) / G.tex.H]; } : null,
        photo: photo ? (x, y) => photoAt(photo, x, y) : null,
      });
      if (B.count) {
        const bm = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
        bm.userData.roofMap = { value: G.tex ? G.tex.tex : null };
        FX.U.uRoofPhoto.value = G.tex && opts.tex === 'photo' ? 1 : 0;
        const bmesh = mesh(B.geometry, FX.patchBuilding(bm)); bmesh.name = 'buildings';
        world.add(bmesh);
      }
      world.userData.buildings = B.count; world.userData.measured = B.measured; world.userData.footprints = B.footprints;
    }

    // 計画道路
    const asphalt = mat(0xffffff, { roughness: 0.9, map: asphaltTex() }), white = mat(0xf2f2ee, { roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      yellow = mat(0xf2b81d, { roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), walk = mat(0xb9b4aa, { roughness: 0.95, map: asphaltTex(true) }), curb = mat(0xa9a59c),
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
    // 既存道路（ならした高さ・推定した片勾配の路面）
    if (G.exX.length) {
      const exM = mat(0xffffff, { roughness: 0.9, map: asphaltTex(), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      exM.color.setScalar(1.45); // 計画道路（新しい舗装）より少し白っぽく
      for (const R of G.exX) {
        world.add(mesh(ribbonGeo(R.rows.map((r) => [P3(R, r, -R.W, 0.04), P3(R, r, 0, 0.04), P3(R, r, R.W, 0.04)])), exM, false));
        for (const sgn of [-1, 1]) world.add(mesh(ribbonGeo(R.rows.map((r) => { const t = P3(R, r, sgn * R.W, 0.04); return [[t[0], t[1] - 0.5, t[2]], t]; })), exM, false));
      }
    }
    return world;
  }

  /* ───────── 遠景（地平線までの地形） ─────────
   * 詳細範囲の外側を、外へ行くほど粗くなる格子で半径 9〜20km まで作る（標高は 10m DEM の低ズーム）。
   * 詳細範囲の縁では同じ頂点・同じ高さを使うので継ぎ目に隙間はできない。写真は中景（約 3 倍の範囲）と遠景の 2 枚 */
  async function buildFar(ex, G, base, hGround, my) {
    const lat = P.toLL(ex.cx, ex.cy).lat, mpp0 = 156543.03392 * Math.cos((lat * Math.PI) / 180);
    const R = Math.min(22000, Math.max(13000, ex.D * 7)), cap = R / 80;
    const box = { x0: ex.cx - R, y0: ex.cy - R, x1: ex.cx + R, y1: ex.cy + R }, mid = { x0: ex.cx - ex.D * 1.7, y0: ex.cy - ex.D * 1.7, x1: ex.cx + ex.D * 1.7, y1: ex.cy + ex.D * 1.7 };
    const zd = Math.max(9, Math.min(14, Math.floor(Math.log2((mpp0 * 256 * 7) / (2 * R)))));
    const gsi = /^(photo|std|pale)$/.test(opts.tex);
    const sw = P.toLL(box.x0, box.y0), ne = P.toLL(box.x1, box.y1);
    const [hCoarse, farTex, midTex, farWater] = await Promise.all([demSampler(box, [['dem_png', zd]]), gsi ? mosaic(opts.tex, box, 2300).catch(() => null) : null, gsi ? mosaic(opts.tex, mid, 2300).catch(() => null) : null,
      V3DCity.loadWater({ west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat }, (la, ln) => P.toXY({ lat: la, lng: ln }), 2 * R > 30000 ? 11 : 12).catch(() => [])]);
    if (my !== st.building || !st.open || !st.world) return;
    const wc = farWater.length ? waterCanvas(box, farWater, 2048) : null, wt = wc ? new T.CanvasTexture(wc.c) : null;
    if (wt) { wt.minFilter = T.LinearFilter; wt.generateMipmaps = false; }
    // 格子線: 詳細範囲の内側は詳細と同じ線、外側は等比で広げて cap で頭打ち
    const outward = (from, to) => { const a = []; let x = from, s = G.sp * 1.5; const dir = Math.sign(to - from); while ((to - x) * dir > 1e-6) { x += dir * s; if ((to - x) * dir < s * 0.4) x = to; a.push(x); s = Math.min(cap, s * 1.13); } return a; };
    const xin = [], yin = [];
    for (let i = 0; i < G.nx; i++) xin.push(G.gx(i));
    for (let j = 0; j < G.ny; j++) yin.push(G.gy(j));
    const xs = outward(ex.x0, box.x0).reverse().concat(xin, outward(ex.x1, box.x1)), ys = outward(ex.y1, box.y1).reverse().concat(yin, outward(ex.y0, box.y0));
    const iL = xs.indexOf(xin[0]), iR = iL + G.nx - 1, jT = ys.indexOf(yin[0]), jB = jT + G.ny - 1, nx = xs.length, ny = ys.length;
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), uvM = new Float32Array(nx * ny * 2), ea = new Float32Array(nx * ny * 4), idx = [];
    const uvOf = (t, ll, out, k) => { if (!t) return; const q = tileXY(ll, t.z); out[k * 2] = (q.fx * 256 - t.ox) / t.W; out[k * 2 + 1] = 1 - (q.fy * 256 - t.oy) / t.H; };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = xs[i], y = ys[j], ll = P.toLL(x, y);
      let h;
      if (i >= iL && i <= iR && j >= jT && j <= jB) { const kk = (j - jT) * G.nx + (i - iL); h = G.H[kk]; ea[k * 4 + 3] = G.earth[kk * 4 + 3]; }
      else { h = hGround(ll); if (h == null) h = hCoarse(ll); if (h == null || h === SEA) { h = -6; ea[k * 4 + 3] = 1; } }
      pos[k * 3] = x - ex.cx; pos[k * 3 + 1] = h - base; pos[k * 3 + 2] = -(y - ex.cy);
      uvOf(farTex, ll, uv, k); uvOf(midTex, ll, uvM, k);
      if (!midTex) uvM[k * 2] = uvM[k * 2 + 1] = -1;
    }
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      if (i >= iL && i < iR && j >= jT && j < jB) continue; // 詳細範囲は空けておく
      const p = j * nx + i, q = p + nx; idx.push(p, q, p + 1, p + 1, q, q + 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('uv', new T.BufferAttribute(uv, 2)); g.setAttribute('aUvM', new T.BufferAttribute(uvM, 2));
    g.setAttribute('aEarth', new T.BufferAttribute(ea, 4)); g.setIndex(idx); g.computeVertexNormals();
    const m = FX.patchTerrain(new T.MeshStandardMaterial({ color: farTex ? 0xffffff : 0x9aa58a, map: farTex ? farTex.tex : null, roughness: 1, metalness: 0 }), { far: true, photo: opts.tex === 'photo' && !!farTex, mid: midTex ? midTex.tex : FX.U.blank, water: wt, rect: new T.Vector4(box.x0 - ex.cx, -(box.y1 - ex.cy), 1 / (2 * R), 1 / (2 * R)) });
    if (wt) m.userData.waterTex = wt;
    const far = new T.Mesh(g, m); far.name = 'far'; far.receiveShadow = false; far.castShadow = false;
    st.world.add(far);
    requestRender();
  }

  /* 水域の多角形を白黒の画像に描く。r = { x0, y0, x1, y1 }（ローカル m）, px = 長辺のピクセル数 */
  function waterCanvas(r, water, px) {
    const k = px / Math.max(r.x1 - r.x0, r.y1 - r.y0), W = Math.max(2, Math.round((r.x1 - r.x0) * k)), H = Math.max(2, Math.round((r.y1 - r.y0) * k));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff';
    for (const rings of water) {
      g.beginPath();
      for (const ring of rings) { ring.forEach((p, i) => { const X = (p[0] - r.x0) * k, Y = (r.y1 - p[1]) * k; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }); g.closePath(); }
      g.fill('nonzero');
    }
    return { c, g, k, W, H };
  }
  /* 水域（河川・湖・海）のマスク。地表のシェーダーが水面として描き、木を植えない判定にも使う */
  function waterMask(ex, water) {
    if (st.waterTex) { st.waterTex.dispose(); st.waterTex = null; }
    FX.U.tWater.value = FX.U.blank; FX.U.uExt.value.set(ex.w, ex.h);
    if (!water || !water.length) return null;
    const { c, g, k, W, H } = waterCanvas(ex, water, 1536);
    const px = g.getImageData(0, 0, W, H).data, tex = new T.CanvasTexture(c);
    tex.minFilter = T.LinearFilter; tex.generateMipmaps = false;
    st.waterTex = tex; FX.U.tWater.value = tex;
    return (x, y) => { const X = Math.floor((x - ex.x0) * k), Y = Math.floor((ex.y1 - y) * k); return X >= 0 && Y >= 0 && X < W && Y < H && px[(Y * W + X) * 4] > 127; };
  }

  /* ───────── 木（森） ─────────
   * 森の範囲 = 航空写真からの自動判定（緑の度合い ExG ＋ 樹冠の肌理＝輝度のばらつき）と、3D 上で塗った範囲。
   * 植え方はゲームの植生配置と同じ考え方: ジッター格子（ブルーノイズ風の散らし）に値ノイズを重ねて
   * 密度のむら・樹種の群（スギ・ヒノキの植林／広葉樹）・樹高・色を変え、InstancedMesh でまとめて描く。 */
  const FCELL = 4, MAXT = 60000;
  let fsets = null;
  function forestSets() {
    if (!project.forest) project.forest = { cell: FCELL, plant: [], erase: [] };
    if (!fsets || fsets.src !== project.forest) fsets = { src: project.forest, plant: new Set(project.forest.plant), erase: new Set(project.forest.erase) };
    return fsets;
  }
  function forestStore() { const S = forestSets(); S.src.plant = [...S.plant]; S.src.erase = [...S.erase]; save(); }
  const hash = (i, j, k = 0) => {
    let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(k + 1, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const sstep = (v, a, b) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  function vnoise(x, y, k) {
    const i = Math.floor(x), j = Math.floor(y), u = sstep(x - i, 0, 1), v = sstep(y - j, 0, 1);
    const a = hash(i, j, k), b = hash(i + 1, j, k), c = hash(i, j + 1, k), d = hash(i + 1, j + 1, k);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const fbm = (x, y, k) => 0.6 * vnoise(x, y, k) + 0.3 * vnoise(x * 2.1, y * 2.1, k + 11) + 0.1 * vnoise(x * 4.3, y * 4.3, k + 23);
  /* 継ぎ目なく繰り返すノイズ（u, v は 0..1 で 1 周） */
  function fbmWrap(u, v, k) {
    let s = 0, a = 0.55;
    for (let o = 0, p = 4; o < 4; o++, p *= 2, a *= 0.5) {
      const x = u * p, y = v * p, i = Math.floor(x), j = Math.floor(y), fx = sstep(x - i, 0, 1), fy = sstep(y - j, 0, 1), w = (q) => ((q % p) + p) % p;
      const h00 = hash(w(i), w(j), k + o), h10 = hash(w(i + 1), w(j), k + o), h01 = hash(w(i), w(j + 1), k + o), h11 = hash(w(i + 1), w(j + 1), k + o);
      s += a * (h00 + (h10 - h00) * fx + (h01 - h00) * fy + (h00 - h10 - h01 + h11) * fx * fy);
    }
    return s;
  }

  /* 航空写真から森らしさ 0〜1 の格子を作る */
  async function autoForestMask(ex) {
    const t = await groundTexture(ex, 'photo').catch(() => null);
    if (!t) return null;
    const cv = t.tex.image, W = cv.width, H = cv.height;
    let px;
    try { px = cv.getContext('2d').getImageData(0, 0, W, H).data; } catch (e) { return null; }
    const cell = Math.max(4, ex.D / 400), nx = Math.ceil(ex.w / cell), ny = Math.ceil(ex.h / cell);
    let m = new Float32Array(nx * ny);
    const rgb = new Uint8Array(nx * ny * 3); // 写真の色（木・屋根の色合わせ用）
    const win = Math.max(1, Math.round(2.5 / ((156543.03392 * Math.cos((P.toLL(ex.cx, ex.cy).lat * Math.PI) / 180)) / 2 ** t.z))); // 約 2.5m の窓
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = tileXY(P.toLL(ex.x0 + (i + 0.5) * cell, ex.y1 - (j + 0.5) * cell), t.z);
      const X = Math.round(q.fx * 256 - t.ox), Y = Math.round(q.fy * 256 - t.oy);
      if (X < win || Y < win || X >= W - win || Y >= H - win) continue;
      let r = 0, g = 0, b = 0, s1 = 0, s2 = 0, n = 0;
      for (let dy = -win; dy <= win; dy++) for (let dx = -win; dx <= win; dx++) {
        const k = ((Y + dy) * W + X + dx) * 4, l = 0.3 * px[k] + 0.59 * px[k + 1] + 0.11 * px[k + 2];
        r += px[k]; g += px[k + 1]; b += px[k + 2]; s1 += l; s2 += l * l; n++;
      }
      r /= n; g /= n; b /= n;
      rgb[(j * nx + i) * 3] = r; rgb[(j * nx + i) * 3 + 1] = g; rgb[(j * nx + i) * 3 + 2] = b;
      const lum = s1 / n, sd = Math.sqrt(Math.max(0, s2 / n - lum * lum)), exg = (2 * g - r - b) / (r + g + b + 1) * 3; // 正規化 ExG（影でも効く）
      m[j * nx + i] = sstep(exg, 0.04, 0.22) * (1 - sstep(lum, 120, 175)) * (0.35 + 0.65 * sstep(sd, 4, 12));
    }
    for (let pass = 0; pass < 2; pass++) { // 3×3 平均でならす
      const o = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < nx && b < ny) { s += m[b * nx + a]; c++; } }
        o[j * nx + i] = s / c;
      }
      m = o;
    }
    for (let k = 0; k < m.length; k++) m[k] = sstep(m[k], 0.22, 0.5);
    return { cell, nx, ny, m, rgb, x0: ex.x0, y1: ex.y1, key: `${ex.x0}/${ex.y1}/${ex.w}/${ex.h}` };
  }
  /* 写真の色 [r, g, b]（sRGB 0..1）。範囲外は null */
  function photoAt(A, x, y) {
    const i = Math.floor((x - A.x0) / A.cell), j = Math.floor((A.y1 - y) / A.cell);
    if (i < 0 || j < 0 || i >= A.nx || j >= A.ny) return null;
    const k = (j * A.nx + i) * 3; return [A.rgb[k] / 255, A.rgb[k + 1] / 255, A.rgb[k + 2] / 255];
  }
  async function ensureAutoMask(ex = st.info && st.info.ex) {
    if (!ex || (opts.trees !== 'auto' && !opts.buildings)) return;
    const key = `${ex.x0}/${ex.y1}/${ex.w}/${ex.h}`;
    if (st.autoMask && st.autoMask.key === key) return;
    st.autoMask = await busy('航空写真から森の範囲・色を判定中…', () => autoForestMask(ex));
    if (!st.autoMask && opts.trees === 'auto') toast('航空写真を取得できないため自動判定できません。「塗った範囲だけ」で木を植えてください', 'err');
  }
  function forestAt(x, y) {
    const S = forestSets();
    if (S.plant.size || S.erase.size) {
      const key = Math.floor(x / FCELL) + ',' + Math.floor(y / FCELL);
      if (S.erase.has(key)) return 0;
      if (S.plant.has(key)) return 1;
    }
    const A = st.autoMask;
    if (opts.trees !== 'auto' || !A) return 0;
    const i = Math.floor((x - A.x0) / A.cell), j = Math.floor((A.y1 - y) / A.cell);
    return i < 0 || j < 0 || i >= A.nx || j >= A.ny ? 0 : A.m[j * A.nx + i];
  }
  /* 木を植えない所（bit 1: 道路・のり面・既存道路・建物・水面）と、計画道路・のり面（bit 2: 建物も取り除く） */
  function treeExclusion(ex, G, roadsX) {
    const { nx, ny, sp } = G, m = new Uint8Array(nx * ny);
    const stamp = (x, y, r, bit) => {
      const i0 = Math.max(0, Math.floor((x - r - ex.x0) / sp)), i1 = Math.min(nx - 1, Math.ceil((x + r - ex.x0) / sp));
      const j0 = Math.max(0, Math.floor((ex.y1 - y - r) / sp)), j1 = Math.min(ny - 1, Math.ceil((ex.y1 - y + r) / sp));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const dx = G.gx(i) - x, dy = G.gy(j) - y; if (dx * dx + dy * dy <= r * r) m[j * nx + i] |= bit; }
    };
    for (const R of roadsX) for (let q = 0; q < R.rows.length; q += 2) stamp(R.rows[q].x, R.rows[q].y, R.E + 3, 3);
    for (const e of project.existing) {
      const xy = e.pts.map((q) => P.toXY(q)), r = Math.max(2.5, e.width || 5) / 2 + 1.5;
      for (let k = 1; k < xy.length; k++) {
        const a = xy[k - 1], b = xy[k], l = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(l / sp));
        if (Math.max(a.x, b.x) < ex.x0 - r || Math.min(a.x, b.x) > ex.x1 + r || Math.max(a.y, b.y) < ex.y0 - r || Math.min(a.y, b.y) > ex.y1 + r) continue;
        for (let s = 0; s <= n; s++) stamp(a.x + ((b.x - a.x) * s) / n, a.y + ((b.y - a.y) * s) / n, r, 1);
      }
    }
    for (let k = 0; k < nx * ny; k++) { if (Math.abs(G.H[k] - G.H0[k]) > 0.05) m[k] |= 3; if (G.earth[k * 4 + 3] > 0.5) m[k] |= 1; }
    return m;
  }
  /* 建物の中と水面にも植えない（建物・水域を読み込んだあとに足す） */
  function excludeCity(ex, G, m, footprints, isWater) {
    const { nx, ny, sp } = G;
    if (isWater) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (isWater(G.gx(i), G.gy(j))) m[j * nx + i] |= 1;
    for (const r of footprints || []) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of r) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const i0 = Math.max(0, Math.floor((x0 - 1 - ex.x0) / sp)), i1 = Math.min(nx - 1, Math.ceil((x1 + 1 - ex.x0) / sp)), j0 = Math.max(0, Math.floor((ex.y1 - y1 - 1) / sp)), j1 = Math.min(ny - 1, Math.ceil((ex.y1 - y0 + 1) / sp));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (V3DCity.inRing(r, G.gx(i), G.gy(j))) m[j * nx + i] |= 1;
    }
  }

  /* 葉のテクスチャ（左上・右上: 広葉樹の葉むら 2 種、左下: 針葉樹を横から、右下: 針葉樹の枝を上から）。
   * 透明部分にも葉の色を入れておき、縮小（ミップ）したときに縁が黒ずまないようにする */
  const leaf = { tex: null };
  function leafTexture() {
    if (leaf.tex) return leaf.tex;
    const S = 512, H = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    let seed = 7; const rnd = () => hash(seed++, 77, 5);
    const blob = (x, y, rx, ry, rot, v, warm) => { g.fillStyle = `rgb(${Math.round(v * (0.96 + 0.08 * warm))},${Math.round(v)},${Math.round(v * (0.9 - 0.2 * warm))})`; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, 6.2832); g.fill(); };
    for (const ox of [0, H]) { // 広葉樹: 奥の暗い葉 → 手前の明るい葉の順に重ねる
      for (let k = 0; k < 520; k++) {
        const t = k / 520, a = rnd() * 6.2832, rr = Math.pow(rnd(), 0.6) * H * 0.41 * (1 - 0.18 * t), r = H * (0.026 + 0.034 * rnd());
        blob(ox + H / 2 + Math.cos(a) * rr, H / 2 + Math.sin(a) * rr * 0.96, r, r * (0.5 + 0.3 * rnd()), rnd() * 3.14, 95 + 150 * t * (0.55 + 0.45 * rnd()), rnd());
      }
    }
    for (let k = 0; k < 700; k++) { // 針葉樹（横）: 上が尖り、枝先が下がる
      const t = k / 700, yy = Math.pow(rnd(), 0.75), half = H * (0.03 + 0.4 * Math.pow(yy, 0.9)), sx = rnd() * 2 - 1, x = H / 2 + sx * half, y = H + 8 + yy * (H - 16);
      blob(x, y, H * (0.02 + 0.03 * rnd()), H * 0.011, sx * 0.9 + (rnd() - 0.5) * 0.4, 80 + 165 * t * (0.5 + 0.5 * rnd()) * (0.75 + 0.25 * Math.abs(sx)), rnd() * 0.5);
    }
    for (let k = 0; k < 15; k++) { // 針葉樹（上）: 放射状の枝
      const a = (k / 15) * 6.2832 + rnd() * 0.3, L = H * (0.3 + 0.16 * rnd());
      for (let q = 0; q < 16; q++) { const d = (q / 16) * L, w = H * 0.05 * (1 - (q / 16) * 0.75); blob(H + H / 2 + Math.cos(a) * d, H + H / 2 + Math.sin(a) * d, w * 1.3, w, a, 90 + 150 * (q / 16) * (0.6 + 0.4 * rnd()), rnd() * 0.4); }
    }
    const im = g.getImageData(0, 0, S, S), d = im.data;
    for (let k = 0; k < d.length; k += 4) if (d[k + 3] < 8) { d[k] = 120; d[k + 1] = 125; d[k + 2] = 95; d[k + 3] = 0; }
    const t = new T.DataTexture(new Uint8Array(d.buffer), S, S, T.RGBAFormat);
    t.colorSpace = T.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter; t.anisotropy = 4; t.needsUpdate = true; t.userData.cached = true;
    return (leaf.tex = t);
  }
  /* 樹木の形（高さ 1 の単位形状）: 芯になる立体＋葉むらのカード。法線は樹冠の中心から外向きにして、かたまりとして陰影を付ける。
   * 頂点色は樹冠の内側・下側ほど暗く（葉どうしの遮蔽） */
  function treeGeos() {
    const make = (cy, ry, rx) => {
      const pos = [], nor = [], uv = [], col = [];
      const push = (p, t, shade, tint) => {
        const n = [p[0] / rx, (p[1] - cy) / ry + 0.45, p[2] / rx], l = Math.hypot(n[0], n[1], n[2]) || 1;
        pos.push(p[0], p[1], p[2]); nor.push(n[0] / l, n[1] / l, n[2] / l); uv.push(t[0], t[1]);
        const k = shade * (0.42 + 0.58 * sstep(p[1], cy - ry * 0.9, cy + ry * 0.8));
        col.push(k * tint[0], k * tint[1], k * tint[2]);
      };
      const W = [1, 1, 1];
      return {
        // 立体（三角形の列）。葉むらの中央（不透明な所）の色を使う
        solid(geo, shade = 0.8, tint = W, tu = [0.25, 0.25]) { const g = geo.index ? geo.toNonIndexed() : geo, a = g.attributes.position; for (let k = 0; k < a.count; k++) push([a.getX(k), a.getY(k), a.getZ(k)], tu, shade, tint); g.dispose(); if (g !== geo) geo.dispose(); },
        // カード: 中心 c, 半幅ベクトル a, 半高ベクトル b, アトラスの区画 (u0, v0)（各 0.5 角）
        card(c, a, b, u0, v0, shade = 1) {
          const P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [c[0] + a[0] * i + b[0] * j, c[1] + a[1] * i + b[1] * j, c[2] + a[2] * i + b[2] * j]);
          const U = [[u0, v0 + 0.5], [u0 + 0.5, v0 + 0.5], [u0 + 0.5, v0], [u0, v0]];
          for (const k of [0, 1, 2, 0, 2, 3]) push(P[k], U[k], shade, W);
        },
        done() { const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new T.Float32BufferAttribute(col, 3)); return g; },
      };
    };
    const bark = [1.5, 1.05, 0.75];
    let seed = 900; const rnd = () => hash(seed++, 31, 9);
    // 広葉樹: でこぼこの芯＋外向きの葉むら 13 枚
    const B = make(0.63, 0.3, 0.33);
    { const t = new T.CylinderGeometry(0.02, 0.034, 0.5, 5, 1, true); t.translate(0, 0.25, 0); B.solid(t, 0.9, bark);
      const core = new T.IcosahedronGeometry(1, 0), a = core.attributes.position;
      for (let k = 0; k < a.count; k++) { const j = 0.8 + 0.3 * hash(Math.round(a.getX(k) * 97), Math.round(a.getY(k) * 89), Math.round(a.getZ(k) * 83)); a.setXYZ(k, a.getX(k) * 0.25 * j, 0.63 + a.getY(k) * 0.22 * j, a.getZ(k) * 0.25 * j); }
      B.solid(core, 0.62);
      for (let k = 0; k < 13; k++) {
        const y = 1 - (k + 0.5) / 13 * 1.35, r = Math.sqrt(Math.max(0, 1 - y * y)), th = k * 2.39996 + rnd();
        const dir = [r * Math.cos(th), y, r * Math.sin(th)], c = [dir[0] * 0.25, 0.63 + dir[1] * 0.2, dir[2] * 0.25];
        const n = [dir[0] + (rnd() - 0.5) * 0.9, dir[1] + (rnd() - 0.5) * 0.9 + 0.25, dir[2] + (rnd() - 0.5) * 0.9], nl = Math.hypot(n[0], n[1], n[2]);
        const up = Math.abs(n[1] / nl) > 0.9 ? [1, 0, 0] : [0, 1, 0];
        let a1 = [n[1] * up[2] - n[2] * up[1], n[2] * up[0] - n[0] * up[2], n[0] * up[1] - n[1] * up[0]]; const al = Math.hypot(a1[0], a1[1], a1[2]); a1 = a1.map((v) => v / al);
        let b1 = [n[1] * a1[2] - n[2] * a1[1], n[2] * a1[0] - n[0] * a1[2], n[0] * a1[1] - n[1] * a1[0]].map((v) => v / nl);
        const ro = rnd() * 6.28, cs = Math.cos(ro), sn = Math.sin(ro), sz = 0.2 + 0.07 * rnd();
        const A2 = a1.map((v, i) => (v * cs + b1[i] * sn) * sz), B2 = a1.map((v, i) => (-v * sn + b1[i] * cs) * sz);
        B.card(c, A2, B2, k % 2 ? 0.5 : 0, 0, 0.92 + 0.16 * rnd());
      } }
    // 針葉樹（スギ・ヒノキ）: 円錐の芯＋縦の十字カード 3 枚＋上から見た枝の段 3 枚
    const C = make(0.6, 0.42, 0.2);
    { const t = new T.CylinderGeometry(0.014, 0.028, 0.4, 5, 1, true); t.translate(0, 0.2, 0); C.solid(t, 0.9, bark);
      const cone = new T.ConeGeometry(0.105, 0.74, 7, 1, true); cone.translate(0, 0.6, 0); C.solid(cone, 0.6, [1, 1, 1], [0.25, 0.25]);
      for (let k = 0; k < 3; k++) { const th = (k / 3) * 3.14159 + 0.2; C.card([0, 0.59, 0], [Math.cos(th) * 0.2, 0, Math.sin(th) * 0.2], [0, 0.42, 0], 0, 0.5, 0.95); }
      [[0.34, 0.215], [0.52, 0.165], [0.7, 0.11]].forEach(([y, r], k) => { const th = k * 1.1; C.card([0, y, 0], [Math.cos(th) * r, 0.02, Math.sin(th) * r], [-Math.sin(th) * r, -0.02, Math.cos(th) * r], 0.5, 0.5, 0.85); }); }
    return { broad: B.done(), conifer: C.done() };
  }
  /* 木の色: 樹種ごとの基本色に、航空写真のその場所の色合いを混ぜる（明るい竹林・暗い植林などの違いが出る） */
  function treeColor(col, t, photo) {
    const c = t.c;
    if (t.conifer) col.setHSL(0.29 + 0.05 * c, 0.3 + 0.12 * c, 0.12 + 0.05 * c);
    else col.setHSL(0.215 + 0.085 * c, 0.34 + 0.16 * c, 0.19 + 0.08 * c);
    const p = photo ? photoAt(photo, t.x, t.y) : null;
    if (p) {
      const hsl = { h: 0, s: 0, l: 0 }; _pc.setRGB(p[0], p[1], p[2], T.SRGBColorSpace).getHSL(hsl);
      if (hsl.h > 0.12 && hsl.h < 0.48) { // 緑〜黄緑のときだけ色相・明るさを寄せる
        const me = { h: 0, s: 0, l: 0 }; col.getHSL(me);
        col.setHSL(me.h + (hsl.h - me.h) * 0.35, me.s, me.l * (0.72 + 0.9 * Math.min(0.62, hsl.l)));
      }
    }
    return col;
  }
  let _pc = null;
  function buildTrees() {
    if (st.trees) { disposeTree(st.trees); st.trees = null; }
    if (!st.info || !st.open) return;
    const S = forestSets();
    const none = opts.trees === 'off' || (opts.trees !== 'auto' && !S.plant.size);
    const { ex, G, base, excl } = st.info;
    // 森の下の地表を暗くする（木のすき間に明るい写真が見えないように）
    const ea = st.terrain && st.terrain.geometry.attributes.aEarth;
    if (ea) {
      for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) { const k = j * G.nx + i; ea.array[k * 4 + 2] = none || excl[k] & 1 ? 0 : forestAt(G.gx(i), G.gy(j)) * Math.min(1, opts.treeDensity / 60); }
      ea.needsUpdate = true;
    }
    const cntEl = st.el.querySelector('[data-out=treeCount]');
    if (none) { if (cntEl) cntEl.textContent = ''; return requestRender(); }
    // 植える範囲（塗った範囲だけのときはその外接矩形）
    let bx0 = ex.x0, by0 = ex.y0, bx1 = ex.x1, by1 = ex.y1;
    if (opts.trees !== 'auto') {
      bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
      for (const k of S.plant) { const [i, j] = k.split(',').map(Number); bx0 = Math.min(bx0, i * FCELL); by0 = Math.min(by0, j * FCELL); bx1 = Math.max(bx1, (i + 1) * FCELL); by1 = Math.max(by1, (j + 1) * FCELL); }
      bx0 = Math.max(bx0, ex.x0); by0 = Math.max(by0, ex.y0); bx1 = Math.min(bx1, ex.x1); by1 = Math.min(by1, ex.y1);
      if (!(bx1 > bx0 && by1 > by0)) return requestRender();
    }
    // 森の面積から間隔を決める（本数の上限 MAXT。間引いたぶん木を大きくする）
    const dens = opts.treeDensity / 100, cs = Math.max(6, Math.max(bx1 - bx0, by1 - by0) / 150);
    let area = 0;
    for (let y = by0 + cs / 2; y < by1; y += cs) for (let x = bx0 + cs / 2; x < bx1; x += cs) area += forestAt(x, y) * cs * cs;
    const sp = Math.max(4.5, Math.sqrt((area * dens) / MAXT)), big = Math.min(1.8, Math.sqrt(sp / 4.5));
    const photo = st.autoMask && st.autoMask.rgb ? st.autoMask : null;
    const items = [];
    const i0 = Math.floor(bx0 / sp), i1 = Math.ceil(bx1 / sp), j0 = Math.floor(by0 / sp), j1 = Math.ceil(by1 / sp);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = (i + 0.1 + 0.8 * hash(i, j, 1)) * sp, y = (j + 0.1 + 0.8 * hash(i, j, 2)) * sp; // ジッター格子
      if (x < ex.x0 + 2 || x > ex.x1 - 2 || y < ex.y0 + 2 || y > ex.y1 - 2) continue;
      const f = forestAt(x, y); if (f <= 0.02) continue;
      const clump = 0.55 + 0.9 * fbm(x / 45, y / 45, 3); // 群生のむら（ギャップ・疎林）
      if (hash(i, j, 3) > f * dens * clump) continue;
      const gi = Math.round((x - ex.x0) / G.sp), gj = Math.round((ex.y1 - y) / G.sp);
      if (excl[Math.min(G.ny - 1, Math.max(0, gj)) * G.nx + Math.min(G.nx - 1, Math.max(0, gi))] & 1) continue;
      // 植林（スギ・ヒノキ）の群。写真で暗く青みのある所ほど針葉樹にする
      const pc = photo ? photoAt(photo, x, y) : null, dark = pc ? 0.42 - (0.3 * pc[0] + 0.59 * pc[1] + 0.11 * pc[2]) : 0;
      const conifer = fbm(x / 160, y / 160, 7) + (hash(i, j, 4) - 0.5) * 0.25 + dark * 0.5 > 0.55;
      const edge = 0.65 + 0.35 * Math.min(1, f * 1.4), r = hash(i, j, 5);
      const h = (conifer ? 13 + 10 * r : 8 + 8 * r) * edge * big;
      items.push({ x, y, z: terrainAt(G, ex, x, y), h, conifer, w: (conifer ? 0.85 : 1.0) + 0.4 * hash(i, j, 6), rot: hash(i, j, 7) * Math.PI * 2, c: hash(i, j, 8) });
    }
    if (!items.length) { if (cntEl) cntEl.textContent = '0 本'; return requestRender(); }
    const geos = treeGeos(), group = new T.Group();
    const leafM = FX.patchFoliage(new T.MeshStandardMaterial({ map: leafTexture(), alphaTest: 0.4, alphaToCoverage: true, vertexColors: true, roughness: 0.8, metalness: 0, side: T.DoubleSide }));
    const nC = items.filter((t) => t.conifer).length;
    const mC = new T.InstancedMesh(geos.conifer, leafM, Math.max(1, nC)), mB = new T.InstancedMesh(geos.broad, leafM, Math.max(1, items.length - nC));
    mC.count = nC; mB.count = items.length - nC;
    const M = new T.Matrix4(), q = new T.Quaternion(), up = new T.Vector3(0, 1, 0), p = new T.Vector3(), s = new T.Vector3(), col = new T.Color();
    _pc = _pc || new T.Color();
    let a = 0, b = 0;
    items.forEach((t) => {
      p.set(t.x - ex.cx, (t.z - base) * opts.exag - 0.3, -(t.y - ex.cy)); q.setFromAxisAngle(up, t.rot); s.set(t.h * t.w, t.h, t.h * t.w);
      M.compose(p, q, s); treeColor(col, t, photo);
      if (t.conifer) { mC.setMatrixAt(a, M); mC.setColorAt(a++, col); } else { mB.setMatrixAt(b, M); mB.setColorAt(b++, col); }
    });
    for (const m of [mC, mB]) { m.castShadow = m.receiveShadow = true; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; m.computeBoundingSphere(); }
    if (!nC) mC.visible = false; if (nC === items.length) mB.visible = false;
    group.add(mC, mB);
    st.trees = group; st.scene.add(group);
    if (cntEl) cntEl.textContent = `${items.length.toLocaleString()} 本`;
    requestRender();
  }

  /* ブラシで森を塗る／消す */
  const brush = { mode: null, ring: null, down: false, timer: 0, raf: 0, pending: null };
  function setBrush(mode) {
    brush.mode = brush.mode === mode ? null : mode;
    const c = st.controls;
    c.mouseButtons = brush.mode ? { LEFT: null, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.ROTATE } : { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.PAN };
    c.touches = { ONE: brush.mode ? null : T.TOUCH.ROTATE, TWO: T.TOUCH.DOLLY_PAN };
    if (brush.mode && opts.trees === 'off') { opts.trees = 'paint'; saveOpts(); st.el.querySelector('[data-v3=trees]').value = 'paint'; }
    st.el.querySelectorAll('[data-v3act^=brush-]').forEach((b) => b.classList.toggle('on', b.dataset.v3act === 'brush-' + brush.mode));
    st.el.querySelector('.v3hint').textContent = brush.mode
      ? `左ドラッグ: ${brush.mode === 'plant' ? '木を植える' : '木を消す'}　右ドラッグ: 回転　Shift+右ドラッグ: 移動　ホイール: ズーム　Esc: ブラシ終了`
      : '左ドラッグ: 回転　右ドラッグ / Shift+ドラッグ: 移動　ホイール: ズーム';
    st.renderer.domElement.style.cursor = brush.mode ? 'crosshair' : '';
    if (brush.ring) brush.ring.visible = false;
    requestRender();
  }
  function brushHit(e) {
    if (!st.terrain) return null;
    const rc = st.renderer.domElement.getBoundingClientRect(), ndc = new T.Vector2(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    const ray = new T.Raycaster(); ray.setFromCamera(ndc, st.camera);
    const hit = ray.intersectObject(st.terrain, false)[0];
    if (!hit) return null;
    const ex = st.info.ex;
    return { p: hit.point, x: hit.point.x + ex.cx, y: ex.cy - hit.point.z };
  }
  function showRing(h) {
    if (!brush.ring) {
      const g = new T.RingGeometry(0.92, 1, 48); g.rotateX(-Math.PI / 2);
      brush.ring = new T.Mesh(g, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
      brush.ring.renderOrder = 10; st.scene.add(brush.ring);
    }
    brush.ring.visible = !!h;
    if (h) { brush.ring.position.copy(h.p).y += 0.5; brush.ring.scale.setScalar(opts.brush); brush.ring.material.color.set(brush.mode === 'plant' ? 0x9cff7a : 0xff8a7a); }
    requestRender();
  }
  function stamp(h) {
    const S = forestSets(), r = opts.brush;
    for (let j = Math.floor((h.y - r) / FCELL); j <= Math.floor((h.y + r) / FCELL); j++) for (let i = Math.floor((h.x - r) / FCELL); i <= Math.floor((h.x + r) / FCELL); i++) {
      const cx = (i + 0.5) * FCELL - h.x, cy = (j + 0.5) * FCELL - h.y;
      if (cx * cx + cy * cy > r * r) continue;
      const k = i + ',' + j;
      if (brush.mode === 'plant') { S.plant.add(k); S.erase.delete(k); } else { S.plant.delete(k); S.erase.add(k); }
    }
    if (!brush.timer) brush.timer = setTimeout(() => { brush.timer = 0; buildTrees(); }, 160);
  }
  function initBrush() {
    const cv = st.renderer.domElement;
    cv.addEventListener('pointermove', (e) => {
      if (!brush.mode) return;
      brush.pending = e;
      if (brush.raf) return;
      brush.raf = requestAnimationFrame(() => {
        brush.raf = 0; const ev = brush.pending, h = brushHit(ev);
        showRing(h);
        if (brush.down && h) stamp(h);
      });
    });
    cv.addEventListener('pointerdown', (e) => {
      if (!brush.mode || e.button !== 0) return;
      brush.down = true; cv.setPointerCapture(e.pointerId);
      const h = brushHit(e); if (h) stamp(h);
    });
    const up = () => { if (!brush.down) return; brush.down = false; clearTimeout(brush.timer); brush.timer = 0; forestStore(); buildTrees(); };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (brush.mode && !brush.down) showRing(null); });
  }

  /* ───────── 組み立て ───────── */
  async function rebuild(first) {
    if (!st.open) return;
    const my = ++st.building, ex = extent();
    try {
      await busy('3D 表示を作成中（地理院 標高タイル・背景・建物を取得）…', async () => {
        const sw = P.toLL(ex.x0, ex.y0), ne = P.toLL(ex.x1, ex.y1);
        const cityJob = V3DCity.load({ west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat }, (lat, lng) => P.toXY({ lat, lng })).catch(() => null);
        const [hRaw, texInfo, city] = await Promise.all([demSampler(ex), groundTexture(ex).catch(() => null), Promise.race([cityJob, new Promise((res) => setTimeout(() => res(null), 20000))])]);
        if (my !== st.building || !st.open) return;
        st.city = city;
        await ensureAutoMask(ex);
        if (my !== st.building || !st.open) return;
        const hRoad = (ll) => { const h = hRaw(ll); return h === SEA ? 0 : h; };
        const roadsX = ex.roads.map((r) => roadStations(r, hRoad)).filter(Boolean);
        const G = buildTerrain(ex, hRaw, roadsX, texInfo, existingStations(ex, hRoad));
        let base = Infinity; for (const h of G.H) base = Math.min(base, h);
        const excl = treeExclusion(ex, G, roadsX), isWater = waterMask(ex, city && city.water);
        FX.U.uSeaY.value = -base * opts.exag;
        const world = build(ex, G, roadsX, base, excl);
        excludeCity(ex, G, excl, world.userData.footprints, isWater);
        world.scale.y = opts.exag;
        if (st.world) disposeTree(st.world);
        st.world = world; st.scene.add(world);
        st.terrain = world.getObjectByName('terrain');
        const prev = st.info;
        st.info = { ex, base, G, roadsX, hmax: G.H.reduce((a, h) => Math.max(a, h), -Infinity) - base, excl };
        buildTrees();
        placeSun();
        if (first || !prev || Math.abs(prev.ex.D - ex.D) > 1 || Math.abs(prev.ex.cx - ex.cx) > 1 || Math.abs(prev.ex.cy - ex.cy) > 1) resetView();
        const tx = TEX[opts.tex], nb = world.userData.buildings || 0, nm = world.userData.measured || 0;
        st.el.querySelector('.v3attr').textContent = [tx && tx.attr ? '地表: ' + tx.attr : '', '標高: 地理院タイル（標高タイル）', nb ? `建物: 地理院ベクトルタイル ${nb.toLocaleString()} 棟（高さ ${nm ? `実測 ${nm.toLocaleString()} 棟 © OpenStreetMap contributors・ほかは推定` : '推定'}）` : ''].filter(Boolean).join('　');
        st.attr = { osm: nm > 0 };
        requestRender();
        buildFar(ex, G, base, hRaw, my).catch(() => { /* 遠景なしでも表示は続ける */ });
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
    // 地平線と空が上に入る、やや低めの俯瞰
    const az = (-35 * Math.PI) / 180, el = (20 * Math.PI) / 180, dist = D * 0.62;
    st.camera.position.set(Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    st.controls.minDistance = 5; st.controls.maxDistance = D * 6;
    st.controls.update();
  }
  function topView() {
    if (!st.info) return;
    const t = st.controls.target, d = st.info.ex.D * 1.25;
    st.camera.position.set(t.x, t.y + d, t.z + 0.001);
    st.controls.update();
  }
  /* 太陽: 方位（北から時計回り）・高度。空・環境光・直達光の色もここで合わせる */
  function placeSun() {
    if (!st.sun) return;
    const az = (opts.sunAz * Math.PI) / 180, alt = (opts.sunAlt * Math.PI) / 180, hz = opts.haze / 100, cl = opts.clouds / 100;
    const dir = (st.sunDir = new T.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)));
    FX.U.uSun.value.copy(dir); FX.U.uSky.value.set(hz, cl, 3.7, FX.E_SUN);
    const c = FX.sunColor(dir.y, hz), dim = 1 - 0.5 * cl * cl; // 雲が多いほど直達光は弱く
    st.sun.color.setRGB(c[0], c[1], c[2]); st.sun.intensity = st.post ? FX.E_SUN * dim : 2.8;
    FX.U.uSunCol.value.setRGB(c[0] * FX.E_SUN * dim, c[1] * FX.E_SUN * dim, c[2] * FX.E_SUN * dim);
    if (st.post) { FX.bakeEnv(st.renderer, st.scene); st.scene.environmentIntensity = 1.15; }
    if (st.info) FX.U.uSeaY.value = -st.info.base * opts.exag;
  }
  /* 影の範囲を視点に合わせる: 注視点のまわり（距離に比例した半径）だけを影のカメラで覆い、寄ったときも影を細かく保つ。
   * 中心は影テクスチャの画素単位に丸めて、視点を動かしたときのちらつきを防ぐ */
  const _sv = {};
  function fitShadow(d) {
    const sun = st.sun, { ex } = st.info, dir = st.sunDir;
    if (!sun.castShadow || !dir) return;
    const R = Math.min(ex.D * 0.78, Math.max(150, d * 1.5)), hm = st.info.hmax * opts.exag;
    const right = (_sv.r || (_sv.r = new T.Vector3())).set(0, 1, 0).cross(dir).normalize(), up = (_sv.u || (_sv.u = new T.Vector3())).crossVectors(dir, right);
    const c = (_sv.c || (_sv.c = new T.Vector3())).copy(st.controls.target);
    if (R >= ex.D * 0.78) c.set(0, hm / 2, 0); // 全体が入るときは中心固定
    const tex = (2 * R) / sun.shadow.mapSize.x, a = Math.round(c.dot(right) / tex) * tex, b = Math.round(c.dot(up) / tex) * tex, e = c.dot(dir);
    c.set(0, 0, 0).addScaledVector(right, a).addScaledVector(up, b).addScaledVector(dir, e);
    const L = R * 1.5 + hm / Math.max(0.09, dir.y) + 200;
    sun.position.copy(c).addScaledVector(dir, L); sun.target.position.copy(c); sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R; cam.near = 1; cam.far = L * 2; cam.updateProjectionMatrix();
    sun.shadow.normalBias = tex * 1.6;
  }
  function setShadows(on, size) {
    const r = st.renderer, sun = st.sun;
    const want = Math.min(size || 4096, r.capabilities.maxTextureSize);
    if (sun.shadow.mapSize.x !== want) { sun.shadow.mapSize.set(want, want); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
    sun.castShadow = !!on;
    if (r.shadowMap.enabled !== !!on) {
      r.shadowMap.enabled = !!on;
      st.scene.traverse((m) => { if (m.material) [].concat(m.material).forEach((mt) => { mt.needsUpdate = true; }); });
    }
    r.shadowMap.needsUpdate = true;
  }

  /* ───────── 撮影（高解像度） ───────── */
  async function shoot() {
    if (!st.info) return;
    const r = st.renderer, box = st.el.querySelector('.v3canvas'), gl = r.getContext();
    const maxRB = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], 8192);
    let w, h;
    if (opts.shot === 'fhd') { w = 1920; h = 1080; } else if (opts.shot === '4k') { w = 3840; h = 2160; } else if (opts.shot === 'sq') { w = h = 2048; }
    else { w = box.clientWidth * 2; h = box.clientHeight * 2; }
    const f = Math.min(1, maxRB / Math.max(w, h)); w = Math.round(w * f); h = Math.round(h * f);
    const shotEl = toast('高画質で撮影中…', 'busy');
    await new Promise((res) => setTimeout(res, 30));
    const prevPR = r.getPixelRatio(), prevAspect = st.camera.aspect;
    let out;
    try {
      setShadows(true, Math.min(8192, r.capabilities.maxTextureSize));
      r.setPixelRatio(1); r.setSize(w, h, false);
      st.camera.aspect = w / h; st.camera.updateProjectionMatrix();
      renderFrame(true);
      out = document.createElement('canvas'); out.width = w; out.height = h;
      const g = out.getContext('2d');
      g.drawImage(r.domElement, 0, 0);
      decorate(g, w, h);
    } finally {
      r.setPixelRatio(prevPR); r.setSize(box.clientWidth, box.clientHeight); st.camera.aspect = prevAspect; st.camera.updateProjectionMatrix();
      applyQuality();
      requestRender(); shotEl.remove();
    }
    const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
    if (!blob) return toast('画像を作成できませんでした', 'err');
    showShot(blob, w, h);
  }
  /* タイトル・出典・周辺減光 */
  function decorate(g, w, h) {
    const k = Math.max(w, h) / 1600;
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
    const tx = TEX[opts.tex], attr = [tx && tx.attr ? tx.attr : '', '標高: 地理院タイル', st.attr && st.attr.osm ? '建物の高さ: © OpenStreetMap contributors' : '', opts.exag > 1 ? `高さ ${opts.exag} 倍強調` : ''].filter(Boolean).join(' ／ ');
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
    if (e.key === 'Escape' && brush.mode) { setBrush(brush.mode); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === 'Escape') { close(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) return; // undo / redo は通す
    e.stopImmediatePropagation();
  }, true);

  return { open, close, toggle, changed, isOpen: () => st.open, _st: st, _render: () => renderFrame() };
})();
