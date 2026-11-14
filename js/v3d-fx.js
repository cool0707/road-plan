/* Road Plan — 3D ビューの絵作り
 * 空（大気散乱＋雲）・環境光（空を焼いた IBL）・大気遠近（高さ付きの霞）・雲の影・SSAO・ブルーム・フィルム調トーンマッピングと、
 * 地表／水面／樹木／建物のシェーダー拡張。three.js を読み込んだあとに view3d.js から読み込む。 */
'use strict';

const V3DFX = (() => {
  let T = null;
  /* 全シェーダー共通のユニフォーム（同じオブジェクトを共有する） */
  const U = {
    uSun: { value: null }, uSky: { value: null }, uCamKm: { value: null }, uSeaY: { value: 0 },
    uExt: { value: null }, tWater: { value: null }, uRoofPhoto: { value: 0 }, uSunCol: { value: null },
  };
  const E_SUN = 5.2; // 太陽の放射照度（任意単位。日なたの白が 1 前後になる値）
  const TAU_R = [0.0465, 0.108, 0.265]; // レイリー散乱の鉛直光学的厚さ（R/G/B）
  const mieTau = (haze) => 0.025 + 0.3 * haze * haze;
  const airmass = (s) => { s = Math.min(1, Math.max(0, s)); return 1 / (s + 0.50572 * Math.pow((Math.asin(s) * 180) / Math.PI + 6.07995, -1.6364)); };
  /* 太陽の直達光の色（大気の透過率） */
  function sunColor(sunY, haze) { const m = airmass(sunY), tm = mieTau(haze); return TAU_R.map((t) => Math.exp(-(t + tm) * m)); }

  /* ───────── GLSL: ノイズ・大気・雲 ───────── */
  const GL_NOISE = `
float h12(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h12(i), h12(i+vec2(1,0)), f.x), mix(h12(i+vec2(0,1)), h12(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++) { s += a*vn(p); p = p*2.03 + vec2(17.3, 9.1); a *= .5; } return s; }
float fbm3(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 3; i++) { s += a*vn(p); p = p*2.03 + vec2(17.3, 9.1); a *= .5; } return s; }
`;
  const GL_ATMO = GL_NOISE + `
uniform vec3 uSun;   // 太陽の方向
uniform vec4 uSky;   // x: 霞 0..1, y: 雲量 0..1, z: 雲の種, w: 太陽の放射照度
uniform vec2 uCamKm; // カメラの水平位置 [km]
const vec3 TAU_R = vec3(${TAU_R.join(', ')});
float mieTau(){ return .025 + .3*uSky.x*uSky.x; }
float airmass(float s){ s = clamp(s, 0., 1.); return 1./(s + .50572*pow(degrees(asin(s)) + 6.07995, -1.6364)); }
vec3 sunTrans(){ return exp(-(TAU_R + mieTau())*airmass(uSun.y)); }
/* 晴天の空の放射輝度: 平行平板大気の一次散乱の閉形式＋多重散乱の近似 */
vec3 atmo(vec3 rd){
  float mu = dot(rd, uSun), tm = mieTau();
  vec3 tau = TAU_R + tm;
  float m = airmass(rd.y), m0 = airmass(uSun.y);
  float pr = .0597*(1. + mu*mu), g = .78;
  float pm = .0796*(1. - g*g)/pow(1. + g*g - 2.*g*mu, 1.5) + .012;
  vec3 a = exp(-tau*m0), b = exp(-tau*m);
  vec3 f = abs(m - m0) < 1e-3 ? tau*m*a : m*(a - b)/(m - m0);
  vec3 L = (TAU_R*pr*2.1 + tm*pm*1.1)/tau*f;
  L += TAU_R*(.05 + .07*uSun.y)*(1. - b)*a.g; // 多重散乱（空全体のほのかな明るさ）
  return uSky.w*L;
}
/* 雲の濃さ（位置は km）。fbm をゆがめて積雲らしいかたまりにする */
float cloudDen(vec2 p){
  if (uSky.y < .01) return 0.;
  vec2 q = p*.42 + uSky.z;
  q += .55*vec2(fbm3(q*.6 + 3.1), fbm3(q*.6 + 7.7));
  float n = fbm(q), big = vn(p*.07 + uSky.z*1.7 + 4.2);
  float c = uSky.y;
  return smoothstep(.74 - c*.52, 1.02 - c*.5, n*.8 + big*.42);
}
const float CLOUD_H = 1.9; // 雲底の高さ [km]
vec3 skyColor(vec3 rd, float withSun){
  vec3 up = normalize(vec3(rd.x, max(rd.y, .0), rd.z));
  vec3 col = atmo(up);
  vec3 sT = sunTrans();
  if (rd.y > .003) {
    float Re = 6371., y = rd.y;
    float t = sqrt(Re*Re*y*y + 2.*Re*CLOUD_H + CLOUD_H*CLOUD_H) - Re*y;
    vec2 p = uCamKm + rd.xz*t;
    float d = cloudDen(p);
    if (d > .001) {
      vec2 sd = normalize(uSun.xz + vec2(1e-4));
      float d2 = cloudDen(p + sd*.55)*.6 + cloudDen(p + sd*1.3)*.4;
      float lit = exp(-2.6*d2*(.4 + d));
      float mu = dot(rd, uSun);
      vec3 sunC = uSky.w*sT*.30;
      vec3 amb = atmo(vec3(0., 1., 0.))*2.2 + uSky.w*sT.g*.016;
      vec3 c = amb*(1. - .45*d) + sunC*lit*(1. + 2.5*pow(max(mu, 0.), 6.)*(1. - d*.7));
      float fade = exp(-t/55.);
      col = mix(col, mix(col*1.05, c, fade), d*(.55 + .45*d));
    }
  }
  if (rd.y < 0.) col = mix(col, uSky.w*sT*vec3(.035, .04, .034)*(.4 + uSun.y), smoothstep(0., -.35, rd.y)); // 地面からの照り返し
  if (withSun > .5) {
    float mu = dot(rd, uSun);
    col += uSky.w*sT*(smoothstep(.99988, .99996, mu)*40. + pow(max(mu, 0.), 900.)*1.6);
  }
  return col;
}
`;

  /* ───────── 空（ドーム）と環境マップ ───────── */
  const sky = { dome: null, pmrem: null, env: null, bakeRT: null, bakeMat: null };
  function initSky(renderer, scene) {
    const g = new T.SphereGeometry(4000, 32, 16);
    const m = new T.ShaderMaterial({
      uniforms: { uSun: U.uSun, uSky: U.uSky, uCamKm: U.uCamKm },
      vertexShader: 'varying vec3 vDir;\nvoid main(){ vDir = position; vec4 p = projectionMatrix*viewMatrix*vec4(position + cameraPosition, 1.); gl_Position = p.xyww; }',
      fragmentShader: GL_ATMO + 'varying vec3 vDir;\nvoid main(){ gl_FragColor = vec4(skyColor(normalize(vDir), 1.), 1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
      side: T.BackSide, depthWrite: false, depthTest: true, fog: false,
    });
    const dome = (sky.dome = new T.Mesh(g, m));
    dome.frustumCulled = false; dome.renderOrder = -1000; dome.name = 'sky';
    scene.add(dome);
    sky.pmrem = new T.PMREMGenerator(renderer);
    sky.bakeRT = new T.WebGLRenderTarget(512, 256, { type: T.HalfFloatType, depthBuffer: false });
    sky.bakeRT.texture.mapping = T.EquirectangularReflectionMapping;
    sky.bakeMat = new T.ShaderMaterial({
      uniforms: { uSun: U.uSun, uSky: U.uSky, uCamKm: U.uCamKm },
      vertexShader: 'varying vec2 vUv;\nvoid main(){ vUv = position.xy*.5 + .5; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: GL_ATMO + 'varying vec2 vUv;\nvoid main(){ float lo = (vUv.x - .5)*6.2831853, la = (vUv.y - .5)*3.1415927;\n vec3 d = vec3(cos(la)*cos(lo), sin(la), cos(la)*sin(lo));\n gl_FragColor = vec4(min(skyColor(d, 0.), vec3(40.)), 1.); }',
      depthTest: false, depthWrite: false,
    });
  }
  /* 太陽・霞・雲が変わったら空を焼き直して環境光にする */
  function bakeEnv(renderer, scene) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(sky.bakeRT); renderer.render(quad(sky.bakeMat), quadCam);
    renderer.setRenderTarget(prev);
    const old = sky.env;
    sky.env = sky.pmrem.fromEquirectangular(sky.bakeRT.texture);
    scene.environment = sky.env.texture;
    if (old) old.dispose();
  }

  /* ───────── ポスト処理 ───────── */
  let quadMesh = null, quadCam = null;
  function quad(material) {
    if (!quadMesh) {
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      quadMesh = new T.Mesh(g, material); quadMesh.frustumCulled = false; quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    quadMesh.material = material; return quadMesh;
  }
  const VS = 'varying vec2 vUv;\nvoid main(){ vUv = position.xy*.5 + .5; gl_Position = vec4(position.xy, 0., 1.); }';
  const post = { ok: false, w: 0, h: 0, scene: null, ao: null, ao2: null, a: null, bloom: [], mats: null, samples: 4 };
  function supported(renderer) { const gl = renderer.getContext(); return !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')); }
  function initPost() {
    const shader = (fs, uniforms) => new T.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false });
    const m = (post.mats = {});
    /* SSAO: 深度から法線を復元し、半球内の遮蔽を数える（半径は距離に比例させて引いた画でも効かせる） */
    m.ao = shader(`
uniform sampler2D tDepth; uniform mat4 uPI; uniform vec2 uPx; uniform float uP11; varying vec2 vUv;
vec3 vpos(vec2 uv){ float d = texture2D(tDepth, uv).x; vec4 v = uPI*vec4(uv*2. - 1., d*2. - 1., 1.); return v.xyz/v.w; }
void main(){
  float d = texture2D(tDepth, vUv).x;
  if (d >= 1.) { gl_FragColor = vec4(1.); return; }
  vec3 P = vpos(vUv);
  vec3 a1 = vpos(vUv + vec2(uPx.x, 0.)) - P, a2 = P - vpos(vUv - vec2(uPx.x, 0.));
  vec3 b1 = vpos(vUv + vec2(0., uPx.y)) - P, b2 = P - vpos(vUv - vec2(0., uPx.y));
  vec3 N = normalize(cross(abs(a1.z) < abs(a2.z) ? a1 : a2, abs(b1.z) < abs(b2.z) ? b1 : b2));
  float R = clamp(-P.z*.035, .8, 30.), rUv = R*uP11*.5/-P.z;
  vec2 fc = floor(gl_FragCoord.xy);
  float ang = fract(52.9829189*fract(.06711056*fc.x + .00583715*fc.y))*6.2831853, occ = 0.;
  for (int i = 0; i < 12; i++) {
    float r = (float(i) + .5)/12., t = ang + float(i)*2.39996;
    vec2 o = vec2(cos(t), sin(t))*r*rUv; o.x *= uPx.x/uPx.y;
    vec3 S = vpos(vUv + o) - P;
    float l = length(S) + 1e-4;
    occ += max(0., dot(N, S)/l - .12)/(1. + l*l/(R*R)*2.);
  }
  gl_FragColor = vec4(vec3(clamp(1. - occ/12.*2.3, 0., 1.)), 1.);
}`, { tDepth: { value: null }, uPI: { value: new T.Matrix4() }, uPx: { value: new T.Vector2() }, uP11: { value: 1 } });
    /* AO のぼかし（深度差の大きい所はまたがない） */
    m.blur = shader(`
uniform sampler2D tAO, tDepth; uniform vec2 uPx; uniform float uNear; varying vec2 vUv;
float lin(float d){ return uNear/max(1e-6, 1. - d); }
void main(){
  float z0 = lin(texture2D(tDepth, vUv).x), s = 0., w = 0.;
  for (int j = -2; j <= 1; j++) for (int i = -2; i <= 1; i++) {
    vec2 uv = vUv + (vec2(float(i), float(j)) + .5)*uPx;
    float k = 1./(1. + abs(lin(texture2D(tDepth, uv).x) - z0)/(z0*.02));
    s += texture2D(tAO, uv).r*k; w += k;
  }
  gl_FragColor = vec4(vec3(s/w), 1.);
}`, { tAO: { value: null }, tDepth: { value: null }, uPx: { value: new T.Vector2() }, uNear: { value: 1 } });
    /* 合成: AO → 雲の影 → 大気遠近（高さで薄くなる霞。太陽側ほど明るく、遠いほど青く） */
    m.comp = shader(GL_ATMO + `
uniform sampler2D tColor, tDepth, tAO; uniform mat4 uIVP; uniform vec3 uCam; uniform vec4 uFog; uniform float uSeaY; varying vec2 vUv;
void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  vec4 w = uIVP*vec4(vUv*2. - 1., d*2. - 1., 1.);
  vec3 W = w.xyz/w.w, rd = normalize(W - uCam);
  float dist = length(W - uCam), Hs = uFog.y;
  float a = uFog.x*exp(-max(uCam.y - uSeaY, 0.)/Hs), od;
  if (d < 1.) {
    col *= mix(1., texture2D(tAO, vUv).r, uFog.z);
    vec2 cp = (W.xz + uSun.xz/max(uSun.y, .08)*(CLOUD_H*1000. - (W.y - uSeaY)))*.001 + uCamKm - uCam.xz*.001;
    float cs = cloudDen(cp)*.6 + cloudDen(cp + vec2(.21, .13))*.4;
    col *= mix(vec3(1.), vec3(.42, .46, .56), smoothstep(.02, .7, cs)*uFog.w);
    float k = rd.y*dist/Hs;
    od = abs(k) > 1e-3 ? a*dist*(1. - exp(-k))/k : a*dist;
  } else od = rd.y > 1e-4 ? a*Hs/rd.y : 1e3;
  vec3 ext = exp(-od*vec3(.72, 1., 1.5));
  vec3 ins = atmo(normalize(vec3(rd.x, abs(rd.y)*.3 + .03, rd.z)))*1.05;
  col = col*ext + ins*(1. - ext);
  gl_FragColor = vec4(col, 1.);
}`, { tColor: { value: null }, tDepth: { value: null }, tAO: { value: null }, uIVP: { value: new T.Matrix4() }, uCam: { value: new T.Vector3() }, uFog: { value: new T.Vector4(1e-4, 1200, 1, 1) },
      uSun: U.uSun, uSky: U.uSky, uCamKm: U.uCamKm, uSeaY: U.uSeaY });
    /* ブルーム用の縮小（1 段目だけ明るい所を取り出す） */
    m.down = shader(`
uniform sampler2D tSrc; uniform vec2 uPx; uniform float uThr; varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb*4.;
  c += texture2D(tSrc, vUv + uPx*vec2(-1., -1.)).rgb + texture2D(tSrc, vUv + uPx*vec2(1., -1.)).rgb + texture2D(tSrc, vUv + uPx*vec2(-1., 1.)).rgb + texture2D(tSrc, vUv + uPx*vec2(1., 1.)).rgb;
  c /= 8.;
  if (uThr > 0.) { float l = max(c.r, max(c.g, c.b)); c *= smoothstep(uThr*.7, uThr*1.6, l); c = min(c, vec3(24.)); }
  gl_FragColor = vec4(c, 1.);
}`, { tSrc: { value: null }, uPx: { value: new T.Vector2() }, uThr: { value: 0 } });
    /* 仕上げ: ブルーム加算 → 露出 → ACES フィルミック → 彩度・周辺減光 → sRGB */
    m.fin = shader(`
uniform sampler2D tColor, tB1, tB2, tB3, tB4; uniform vec4 uGrade; uniform vec2 uPx; varying vec2 vUv;
vec3 aces(vec3 x){
  const mat3 A = mat3(.59719, .07600, .02840, .35458, .90834, .13383, .04823, .01566, .83777);
  const mat3 B = mat3(1.60475, -.10208, -.00327, -.53108, 1.10813, -.07276, -.07367, -.00605, 1.07602);
  x = A*x; x = (x*(x + .0245786) - .000090537)/(x*(.983729*x + .4329510) + .238081);
  return clamp(B*x, 0., 1.);
}
float h12(vec2 p){ vec3 q = fract(vec3(p.xyx)*.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y)*q.z); }
void main(){
  vec3 c = texture2D(tColor, vUv).rgb;
  vec3 b = texture2D(tB1, vUv).rgb*.4 + texture2D(tB2, vUv).rgb*.3 + texture2D(tB3, vUv).rgb*.2 + texture2D(tB4, vUv).rgb*.1;
  c += b*uGrade.y;
  c *= uGrade.x;
  vec2 q = vUv - .5; c *= 1. - uGrade.w*smoothstep(.3, .95, length(q)*1.25);
  c = aces(c*1.35);
  float l = dot(c, vec3(.2126, .7152, .0722));
  c = mix(vec3(l), c, uGrade.z);
  c = mix(c, c*c*(3. - 2.*c), .18);
  c = mix(c*12.92, 1.055*pow(max(c, vec3(1e-5)), vec3(1./2.4)) - .055, step(.0031308, c));
  c += (h12(gl_FragCoord.xy) - .5)/255.;
  gl_FragColor = vec4(c, 1.);
}`, { tColor: { value: null }, tB1: { value: null }, tB2: { value: null }, tB3: { value: null }, tB4: { value: null }, uGrade: { value: new T.Vector4(1, 0.5, 1.08, 0.3) }, uPx: { value: new T.Vector2() } });
    post.ok = true;
  }
  function resizePost(w, h, samples) {
    if (post.w === w && post.h === h && post.samples === samples && post.scene) return;
    disposePost();
    post.w = w; post.h = h; post.samples = samples;
    const hf = { type: T.HalfFloatType, depthBuffer: false, minFilter: T.LinearFilter, magFilter: T.LinearFilter };
    const dt = new T.DepthTexture(w, h); dt.type = T.UnsignedIntType; dt.minFilter = dt.magFilter = T.NearestFilter;
    post.scene = new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType, samples, depthTexture: dt, minFilter: T.LinearFilter, magFilter: T.LinearFilter });
    const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1);
    post.ao = new T.WebGLRenderTarget(w2, h2, { depthBuffer: false, minFilter: T.LinearFilter, magFilter: T.LinearFilter });
    post.ao2 = post.ao.clone();
    post.a = new T.WebGLRenderTarget(w, h, hf);
    post.bloom = [1, 2, 3, 4].map((k) => new T.WebGLRenderTarget(Math.max(1, w >> k), Math.max(1, h >> k), hf));
  }
  function disposePost() {
    for (const rt of [post.scene, post.ao, post.ao2, post.a, ...post.bloom]) if (rt) { if (rt.depthTexture) rt.depthTexture.dispose(); rt.dispose(); }
    post.scene = post.ao = post.ao2 = post.a = null; post.bloom = []; post.w = post.h = 0;
  }
  const _m = { ivp: null, v2: null };
  /* 1 フレーム描く。fx = { fog: 霞の濃さ[1/m], fogH, ao, cloudShadow, exposure, bloom, vignette } */
  function render(renderer, scene, camera, fx) {
    const size = renderer.getDrawingBufferSize(_m.v2 || (_m.v2 = new T.Vector2())), w = size.x, h = size.y, m = post.mats;
    resizePost(w, h, fx.samples == null ? 4 : fx.samples);
    camera.updateMatrixWorld();
    const tm = renderer.toneMapping; renderer.toneMapping = T.NoToneMapping;
    renderer.setRenderTarget(post.scene); renderer.render(scene, camera);
    const draw = (mat, rt) => { renderer.setRenderTarget(rt); renderer.render(quad(mat), quadCam); };
    const depth = post.scene.depthTexture;
    if (fx.ao > 0) {
      m.ao.uniforms.tDepth.value = depth; m.ao.uniforms.uPI.value.copy(camera.projectionMatrixInverse); m.ao.uniforms.uPx.value.set(1 / w, 1 / h); m.ao.uniforms.uP11.value = camera.projectionMatrix.elements[5];
      draw(m.ao, post.ao);
      m.blur.uniforms.tAO.value = post.ao.texture; m.blur.uniforms.tDepth.value = depth; m.blur.uniforms.uPx.value.set(1 / post.ao.width, 1 / post.ao.height); m.blur.uniforms.uNear.value = camera.near;
      draw(m.blur, post.ao2);
    }
    const c = m.comp.uniforms;
    c.tColor.value = post.scene.texture; c.tDepth.value = depth; c.tAO.value = post.ao2.texture;
    c.uIVP.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse); c.uCam.value.copy(camera.position);
    c.uFog.value.set(fx.fog, fx.fogH, fx.ao, fx.cloudShadow);
    draw(m.comp, post.a);
    let src = post.a;
    post.bloom.forEach((rt, k) => {
      m.down.uniforms.tSrc.value = src.texture; m.down.uniforms.uPx.value.set(1 / src.width, 1 / src.height); m.down.uniforms.uThr.value = k === 0 ? 1.15 : 0;
      draw(m.down, rt); src = rt;
    });
    const f = m.fin.uniforms;
    f.tColor.value = post.a.texture; post.bloom.forEach((rt, k) => { f['tB' + (k + 1)].value = rt.texture; });
    f.uGrade.value.set(fx.exposure, fx.bloom, fx.saturation, fx.vignette);
    draw(m.fin, null);
    renderer.toneMapping = tm;
  }

  /* ───────── マテリアルの拡張 ───────── */
  const GL_WATER = `
uniform vec2 uExt; uniform sampler2D tWater;
/* さざ波の勾配（向きと波長の違う正弦波の重ね合わせ＋ノイズ） */
vec2 ripple(vec2 p, float dist){
  vec2 g = vec2(0.);
  float f1 = 1. - smoothstep(60., 900., dist), f2 = 1. - smoothstep(400., 5000., dist);
  g += vec2(.94, .34)*cos(dot(p, vec2(.94, .34))*1.9 + vn(p*.11)*6.)*.05*f1;
  g += vec2(-.5, .87)*cos(dot(p, vec2(-.5, .87))*2.7 + vn(p*.13 + 5.)*6.)*.04*f1;
  g += vec2(.3, -.95)*cos(dot(p, vec2(.3, -.95))*.62 + vn(p*.031)*9.)*.045*f2;
  g += vec2(-.81, -.58)*cos(dot(p, vec2(-.81, -.58))*.37 + vn(p*.019 + 2.)*9.)*.04*f2;
  g += (vec2(vn(p*.9), vn(p*.9 + 31.)) - .5)*.07*f1;
  return g;
}`;
  /* 地表: 写真の補正・近距離のディテール・森の下の暗さ・のり面の色・水面 */
  function patchTerrain(mat, o = {}) {
    mat.defines = Object.assign(mat.defines || {}, o.far ? { FX_FAR: 1 } : {}, o.sea ? { FX_SEA: 1 } : {}, o.photo ? { FX_PHOTO: 1 } : {});
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uExt: U.uExt, tWater: U.tWater, tMid: { value: o.mid || null }, tWaterF: { value: o.water || U.blank }, uFarRect: { value: o.rect || new T.Vector4(0, 0, 1, 1) } });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aEarth;\nattribute vec2 aUvM;\nvarying vec4 vEarth;\nvarying vec3 vWp;\nvarying vec2 vUvM;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n#ifndef FX_SEA\nvEarth = aEarth;\n#else\nvEarth = vec4(0., 0., 0., 1.);\n#endif\n#ifdef FX_FAR\nvUvM = aUvM;\n#endif\nvWp = (modelMatrix*vec4(transformed, 1.)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vEarth;\nvarying vec3 vWp;\nvarying vec2 vUvM;\nuniform sampler2D tMid, tWaterF;\nuniform vec4 uFarRect;\nfloat fxW = 0.;\n' + GL_NOISE + GL_WATER)
        .replace('#include <map_fragment>', `#include <map_fragment>
float fxDist = length(vViewPosition);
#ifdef FX_FAR
{ vec2 e = min(vUvM, 1. - vUvM); float k = smoothstep(0., .04, min(e.x, e.y));
  if (k > 0.) { vec4 mc = texture2D(tMid, vUvM); diffuseColor.rgb = mix(diffuseColor.rgb, mc.rgb, k); } }
#endif
#ifdef FX_PHOTO
{ vec3 c = diffuseColor.rgb; float l = dot(c, vec3(.3, .59, .11));
  c = mix(vec3(l), c, 1.22); c = mix(c, c*c*(3. - 2.*c), .35); diffuseColor.rgb = max(c, 0.)*.92;
#ifdef FX_FAR
  // 木を立てていない遠くの森: 写真の緑で暗い所を樹冠らしい色・明るさに寄せ、近くでは樹冠の粒を足す
  float gr = clamp(((2.*c.g - c.r - c.b)/(c.r + c.g + c.b + .02) - .03)*7., 0., 1.)*(1. - smoothstep(.2, .42, l));
  float cn = vn(vWp.xz*.11)*.6 + vn(vWp.xz*.31)*.4;
  vec3 canopy = mix(vec3(.022, .045, .014), vec3(.06, .095, .028), cn)*(.75 + 1.3*l);
  diffuseColor.rgb = mix(diffuseColor.rgb, canopy, gr*.85*(1. - smoothstep(2500., 9000., fxDist)));
#endif
}
#endif
#ifndef FX_SEA
{ float f = 1. - smoothstep(40., 600., fxDist);
  float n = vn(vWp.xz*.9)*.5 + vn(vWp.xz*3.7)*.3 + vn(vWp.xz*13.)*.2;
  diffuseColor.rgb *= 1. + (n - .5)*.5*f; }
diffuseColor.rgb *= 1. - .5*clamp(vEarth.z, 0., 1.);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.12, .2, .05)*(.8 + .4*vn(vWp.xz*.6)), clamp(vEarth.x, 0., 1.)*.8);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.3, .22, .14)*(.75 + .5*vn(vWp.xz*.35 + 9.)), clamp(vEarth.y, 0., 1.)*.8);
#endif
#ifdef FX_FAR
fxW = max(clamp(vEarth.w, 0., 1.), smoothstep(.35, .65, texture2D(tWaterF, vec2((vWp.x - uFarRect.x)*uFarRect.z, 1. - (vWp.z - uFarRect.y)*uFarRect.w)).r));
#else
#ifdef FX_SEA
fxW = 1.;
#else
fxW = max(clamp(vEarth.w, 0., 1.), smoothstep(.35, .65, texture2D(tWater, vec2(vWp.x/uExt.x + .5, .5 - vWp.z/uExt.y)).r));
#endif
#endif
{ vec3 deep = vec3(.006, .032, .045) + vec3(.004, .014, .012)*vn(vWp.xz*.004);
  diffuseColor.rgb = mix(diffuseColor.rgb, deep, fxW); }`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, mix(.07, .32, smoothstep(200., 9000., fxDist)), fxW);')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (fxW > 0.) { vec2 g = ripple(vWp.xz, fxDist); vec3 nw = normalize(vec3(-g.x, 1., -g.y));
  normal = normalize(mix(normal, normalize((viewMatrix*vec4(nw, 0.)).xyz), fxW)); }`);
    };
    mat.customProgramCacheKey = () => 'fxT' + (o.far ? 'f' : '') + (o.sea ? 's' : '') + (o.photo ? 'p' : '');
    return mat;
  }
  /* 樹木（葉カード）: 樹冠の中心から外向きの法線でやわらかく陰影を付け、逆光では葉が透ける */
  function patchFoliage(mat) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSun = U.uSun; sh.uniforms.uSunCol = U.uSunCol;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSun;\nuniform vec3 uSunCol;')
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);') // 裏面でも法線を反転しない
        .replace('#include <opaque_fragment>', `{ vec3 l = normalize((viewMatrix*vec4(uSun, 0.)).xyz); vec3 v = normalize(vViewPosition);
  float back = pow(clamp(dot(-v, l)*.5 + .5, 0., 1.), 3.), wrap = clamp(dot(normal, l)*.5 + .5, 0., 1.);
  outgoingLight += diffuseColor.rgb*uSunCol*vec3(1.15, 1.25, .5)*back*wrap*.11; }
#include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => 'fxF';
    return mat;
  }
  /* 建物: 模様は描かず、色（航空写真の色か灰色）だけ。低い陸屋根には航空写真を貼り、壁は地面に近いほどわずかに暗くする */
  function patchBuilding(mat) {
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uRoofPhoto: U.uRoofPhoto, uRoofMap: mat.userData.roofMap });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aB;\nvarying vec4 vB;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvB = aB;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vB;\nuniform float uRoofPhoto;\nuniform sampler2D uRoofMap;')
        .replace('#include <color_fragment>', `#include <color_fragment>
if (vB.w > .5 && vB.w < 1.5 && uRoofPhoto > .5) { vec3 p = texture2D(uRoofMap, vB.xy).rgb; float l = dot(p, vec3(.3, .59, .11)); p = mix(vec3(l), p, 1.15); diffuseColor.rgb = mix(p, p*p*(3. - 2.*p), .3)*.95; }
else if (vB.w < .5) diffuseColor.rgb *= .86 + .14*smoothstep(0., 6., vB.z);`);
    };
    mat.customProgramCacheKey = () => 'fxB2';
    return mat;
  }

  function init(three, renderer, scene) {
    T = three;
    U.uSun.value = new T.Vector3(0, 1, 0); U.uSky.value = new T.Vector4(0.35, 0.4, 0, E_SUN); U.uCamKm.value = new T.Vector2();
    U.uExt.value = new T.Vector2(1, 1); U.uSunCol.value = new T.Color(1, 1, 1);
    const blank = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true; U.blank = blank; U.tWater.value = blank;
    post.ok = false;
    initSky(renderer, scene);
    if (supported(renderer)) initPost();
    return post.ok;
  }
  function dispose() {
    disposePost();
    for (const k in post.mats || {}) post.mats[k].dispose();
    post.mats = null; post.ok = false;
    if (sky.env) sky.env.dispose(); if (sky.bakeRT) sky.bakeRT.dispose(); if (sky.pmrem) sky.pmrem.dispose(); if (sky.bakeMat) sky.bakeMat.dispose();
    if (sky.dome) { sky.dome.geometry.dispose(); sky.dome.material.dispose(); }
    Object.assign(sky, { dome: null, pmrem: null, env: null, bakeRT: null, bakeMat: null });
    if (quadMesh) { quadMesh.geometry.dispose(); quadMesh = null; }
    if (U.blank) U.blank.dispose();
  }

  return { U, E_SUN, init, dispose, render, bakeEnv, sunColor, patchTerrain, patchFoliage, patchBuilding, get postOk() { return post.ok; } };
})();
