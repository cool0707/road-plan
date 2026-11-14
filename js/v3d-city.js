/* Road Plan — 3D ビューの建物・水面
 * 地理院 最適化ベクトルタイル（optimal_bvmap, z16）の建物（BldA）と水域（WA）を読み、建物を押し出す（住宅は切妻屋根、ほかは陸屋根。窓などの模様は描かない）。
 * 高さは OpenStreetMap に登録された実測値（PLATEAU から取り込まれた高さ・階数を含む。OpenFreeMap のベクトルタイル経由）を使い、
 * 無い建物だけ種別・面積・位置から推定する。
 * ブラウザでは V3DCity、node（テスト）では module.exports。 */
'use strict';

(function (root) {
  /* ───────── Mapbox Vector Tile（protobuf）の最小デコーダー ───────── */
  function reader(buf) {
    let p = 0;
    const r = {
      get pos() { return p; }, set pos(v) { p = v; },
      eof: () => p >= buf.length,
      varint() { let v = 0, s = 1, b; do { b = buf[p++]; v += (b & 127) * s; s *= 128; } while (b & 128); return v; },
      bytes() { const n = r.varint(), o = buf.subarray(p, p + n); p += n; return o; },
      skip(w) { if (w === 0) r.varint(); else if (w === 2) p += r.varint(); else if (w === 5) p += 4; else if (w === 1) p += 8; else p = buf.length; },
    };
    return r;
  }
  const utf8 = (b) => new TextDecoder().decode(b);
  /* want = { レイヤー名: true }。戻り値 { レイヤー名: { extent, feats: [{ type, props, rings }] } }（座標はタイル内整数） */
  function parseMVT(buf, want) {
    const out = {}, R = reader(buf);
    while (!R.eof()) {
      const t = R.varint();
      if (t >> 3 === 3 && (t & 7) === 2) { const l = parseLayer(R.bytes(), want); if (l) out[l.name] = l; } else R.skip(t & 7);
    }
    return out;
  }
  function parseLayer(buf, want) {
    const R = reader(buf), L = { name: '', extent: 4096, feats: [] }, keys = [], vals = [], raw = [];
    while (!R.eof()) {
      const t = R.varint(), f = t >> 3;
      if (f === 1) { L.name = utf8(R.bytes()); if (want && !want[L.name]) return null; }
      else if (f === 2) raw.push(R.bytes());
      else if (f === 3) keys.push(utf8(R.bytes()));
      else if (f === 4) vals.push(parseValue(R.bytes()));
      else if (f === 5) L.extent = R.varint();
      else R.skip(t & 7);
    }
    L.feats = raw.map((b) => parseFeature(b, keys, vals));
    return L;
  }
  function parseValue(buf) {
    const R = reader(buf), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let v = null;
    while (!R.eof()) {
      const t = R.varint(), f = t >> 3;
      if (f === 1) v = utf8(R.bytes());
      else if (f === 2) { v = dv.getFloat32(R.pos, true); R.pos += 4; }
      else if (f === 3) { v = dv.getFloat64(R.pos, true); R.pos += 8; }
      else if (f === 4 || f === 5) v = R.varint();
      else if (f === 6) { const z = R.varint(); v = z % 2 ? -(z + 1) / 2 : z / 2; }
      else if (f === 7) v = !!R.varint();
      else R.skip(t & 7);
    }
    return v;
  }
  function parseFeature(buf, keys, vals) {
    const R = reader(buf), F = { type: 0, props: {}, rings: [] };
    while (!R.eof()) {
      const t = R.varint(), f = t >> 3;
      if (f === 2) { const b = reader(R.bytes()); while (!b.eof()) { const k = b.varint(), v = b.varint(); F.props[keys[k]] = vals[v]; } }
      else if (f === 3) F.type = R.varint();
      else if (f === 4) {
        const b = reader(R.bytes());
        let x = 0, y = 0, cur = null;
        while (!b.eof()) {
          const c = b.varint(), id = c & 7, n = c >> 3;
          for (let i = 0; i < n; i++) {
            if (id === 7) continue; // ClosePath（始点は繰り返さない）
            const dx = b.varint(), dy = b.varint();
            x += (dx >>> 1) ^ -(dx & 1); y += (dy >>> 1) ^ -(dy & 1);
            if (id === 1) F.rings.push((cur = []));
            cur.push([x, y]);
          }
        }
      } else R.skip(t & 7);
    }
    return F;
  }

  /* ───────── 多角形の道具 ───────── */
  const area2 = (r) => { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a; };
  /* 軸に平行な半平面で切る（Sutherland–Hodgman）。axis 0:x 1:y, keep>0 なら v 以上を残す */
  function clipHalf(ring, axis, v, keep) {
    const out = [], n = ring.length, inside = (p) => (keep > 0 ? p[axis] >= v : p[axis] <= v);
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n], ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) { const t = (v - a[axis]) / (b[axis] - a[axis]), q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; q[axis] = v; out.push(q); }
    }
    return out;
  }
  function clipBox(ring, x0, y0, x1, y1) {
    let r = clipHalf(ring, 0, x0, 1); if (r.length < 3) return [];
    r = clipHalf(r, 0, x1, -1); if (r.length < 3) return [];
    r = clipHalf(r, 1, y0, 1); if (r.length < 3) return [];
    r = clipHalf(r, 1, y1, -1);
    return r.length < 3 ? [] : r;
  }
  /* 重複点と一直線上の点を除く */
  function tidy(ring, eps) {
    let r = ring.filter((p, i) => { const q = ring[(i + 1) % ring.length]; return Math.abs(p[0] - q[0]) > eps || Math.abs(p[1] - q[1]) > eps; });
    for (let pass = 0; pass < 2 && r.length > 3; pass++) {
      r = r.filter((p, i) => {
        const a = r[(i + r.length - 1) % r.length], b = r[(i + 1) % r.length];
        const cr = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]), dt = (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]);
        return Math.abs(cr) > eps * (Math.hypot(p[0] - a[0], p[1] - a[1]) + Math.hypot(b[0] - p[0], b[1] - p[1])) || dt < 0;
      });
    }
    return r;
  }
  const inRing = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };

  /* タイル 1 枚の建物をタイル境界でぴったり切り、全体座標（タイル番号×extent＋タイル内座標）の多角形にする。
   * 戻り値 [{ code, outer, holes }]。outer の向きは全体座標（y 下向き）で時計回り＝面積が正 */
  function tilePolys(layer, tx, ty) {
    const E = layer.extent, list = [];
    for (const f of layer.feats) {
      if (f.type !== 3) continue;
      let cur = null;
      for (const ring of f.rings) {
        if (ring.length < 3) continue;
        const a = area2(ring);
        if (a === 0) continue;
        const r = tidy(clipBox(ring, 0, 0, E, E), 0.01).map((p) => [p[0] + tx * E, p[1] + ty * E]);
        if (a > 0) { cur = r.length >= 3 ? { code: +f.props.vt_code || 0, outer: r, holes: [] } : null; if (cur) list.push(cur); } else if (cur && r.length >= 3) cur.holes.push(r);
      }
    }
    return list;
  }
  /* タイル境界で分かれた同じ建物をまとめる。境界上の辺が向かい合って重なる多角形どうしを同じ組にし、
   * ちょうど 1 辺ずつで接する 2 片は 1 つの多角形につなぎ直す（切妻屋根を正しく掛けるため）。
   * 戻り値 [{ code, parts: [{ outer, holes, seam: Set(辺番号) }] }] */
  function mergeTiles(polys, E) {
    const onSeam = (p, q) => (p[0] === q[0] && p[0] % E === 0 ? 'v' + p[0] : p[1] === q[1] && p[1] % E === 0 ? 'h' + p[1] : null);
    const seamEdges = (pl) => { const es = []; pl.outer.forEach((p, i) => { const q = pl.outer[(i + 1) % pl.outer.length], k = onSeam(p, q); if (k) es.push({ k, i, a: k[0] === 'v' ? Math.min(p[1], q[1]) : Math.min(p[0], q[0]), b: k[0] === 'v' ? Math.max(p[1], q[1]) : Math.max(p[0], q[0]) }); }); return es; };
    const par = polys.map((_, i) => i), find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    let work = polys.map((pl) => Object.assign({}, pl)), alive = work.map(() => true);
    for (let round = 0; round < 3; round++) {
      const bySeam = new Map();
      work.forEach((pl, i) => { if (alive[i]) for (const e of (pl.se = seamEdges(pl))) { if (!bySeam.has(e.k)) bySeam.set(e.k, []); bySeam.get(e.k).push(Object.assign(e, { pi: i })); } });
      let merged = false;
      for (const es of bySeam.values()) {
        es.sort((u, v) => u.a - v.a);
        for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length && es[j].a < es[i].b - 1e-6; j++) {
          const u = es[i], v = es[j];
          if (u.pi === v.pi || !alive[u.pi] || !alive[v.pi]) continue;
          par[find(u.pi)] = find(v.pi);
          const A = work[u.pi], B = work[v.pi];
          // ちょうど同じ区間で 1 辺ずつ接していて穴がなければ、つないで 1 つの多角形にする
          if (A.se.length === 1 && B.se.length === 1 && !A.holes.length && !B.holes.length && Math.abs(u.a - v.a) < 1e-6 && Math.abs(u.b - v.b) < 1e-6) {
            const ra = A.outer.slice(u.i + 1).concat(A.outer.slice(0, u.i + 1)), rb = B.outer.slice(v.i + 1).concat(B.outer.slice(0, v.i + 1));
            // ra は境界辺の終点から始点まで。rb も同じ。向きが同じ（時計回り）なので端点が入れ違いに一致する
            const j1 = rb.slice(1, -1), ring = tidy(ra.concat(j1), 0.01);
            if (ring.length >= 3) { A.outer = ring; A.se = []; alive[v.pi] = false; B.se = []; merged = true; }
          }
        }
      }
      if (!merged) break;
    }
    const groups = new Map();
    work.forEach((pl, i) => {
      if (!alive[i]) return;
      const g = find(i), seam = new Set();
      pl.outer.forEach((p, k) => { if (onSeam(p, pl.outer[(k + 1) % pl.outer.length])) seam.add(k); });
      if (!groups.has(g)) groups.set(g, { code: pl.code, parts: [] });
      groups.get(g).parts.push({ outer: pl.outer, holes: pl.holes, seam });
    });
    // 1 片だけになった建物の境界上の辺はふつうの壁（相手がいない）
    return [...groups.values()].map((g) => { if (g.parts.length === 1) g.parts[0].seam = new Set(); return g; });
  }

  /* ───────── 取得 ───────── */
  const URL_VT = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf';
  const cache = new Map();
  function tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (!cache.has(key)) {
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      cache.set(key, fetch(URL_VT.replace('{z}', z).replace('{x}', x).replace('{y}', y)).then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b ? parseMVT(new Uint8Array(b), { BldA: true, WA: true }) : null)).catch(() => { cache.delete(key); return null; }));
    }
    return cache.get(key);
  }
  /* 建物の高さ（OpenStreetMap）。OpenFreeMap の planet タイル（OpenMapTiles 形式, z14）の building レイヤーにある
   * render_height [m]（height タグ、なければ階数×3.66）を読む。高さも階数もない建物は 5 が入るので「不明」として扱う。
   * 戻り値 [{ ring, h, x0, y0, x1, y1 }]（ring はローカル m の外周） */
  const OFM = 'https://tiles.openfreemap.org/planet';
  let ofmTpl = null;
  const hcache = new Map();
  function ofmTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (!hcache.has(key)) {
      if (hcache.size > 60) hcache.delete(hcache.keys().next().value);
      if (!ofmTpl) ofmTpl = fetch(OFM).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.tiles && j.tiles[0]) || null).catch(() => null);
      hcache.set(key, ofmTpl.then((tpl) => { if (!tpl) { ofmTpl = null; throw new Error('no template'); } return fetch(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y)); })
        .then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? parseMVT(new Uint8Array(b), { building: true }) : null)).catch(() => { hcache.delete(key); return null; }));
    }
    return hcache.get(key);
  }
  async function loadHeights(bounds, toXY) {
    const z = 14, n = 2 ** z;
    const fx = (lng) => ((lng + 180) / 360) * n, fy = (lat) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n; };
    const x0 = Math.floor(fx(bounds.west)), x1 = Math.floor(fx(bounds.east)), y0 = Math.floor(fy(bounds.north)), y1 = Math.floor(fy(bounds.south));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 30) return [];
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(ofmTile(z, x, y).then((t) => ({ t, x, y })));
    const out = [];
    for (const { t, x, y } of await Promise.all(jobs)) {
      const L = t && t.building; if (!L) continue;
      const E = L.extent;
      for (const f of L.feats) {
        const h = +f.props.render_height;
        if (f.type !== 3 || !(h > 0) || h === 5) continue; // 5 = 高さ不明の既定値
        for (const r of f.rings) {
          if (r.length < 3 || area2(r) <= 0) continue; // 外周だけ
          let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
          const ring = r.map((p) => { const X = p[0] + x * E, Y = p[1] + y * E, lng = (X / (n * E)) * 360 - 180, lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / (n * E)))) * 180) / Math.PI, q = toXY(lat, lng); bx0 = Math.min(bx0, q.x); by0 = Math.min(by0, q.y); bx1 = Math.max(bx1, q.x); by1 = Math.max(by1, q.y); return [q.x, q.y]; });
          out.push({ ring, h, x0: bx0, y0: by0, x1: bx1, y1: by1 });
        }
      }
    }
    return out;
  }
  /* 建物（地理院の外形）に高さを割り当てる: 建物の中の点を含む OSM の建物のうち最も高いもの。戻り値は割り当てた棟数 */
  function assignHeights(buildings, hs) {
    if (!hs.length) return 0;
    const CELL = 64, grid = new Map(), key = (i, j) => i + ',' + j;
    hs.forEach((o, k) => { for (let i = Math.floor(o.x0 / CELL); i <= Math.floor(o.x1 / CELL); i++) for (let j = Math.floor(o.y0 / CELL); j <= Math.floor(o.y1 / CELL); j++) { const kk = key(i, j); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(k); } });
    let n = 0;
    for (const b of buildings) {
      const part = b.parts.reduce((a, c) => (Math.abs(area2(c.outer)) > Math.abs(area2(a.outer)) ? c : a)), r = part.outer;
      let cx = 0, cy = 0; for (const p of r) { cx += p[0]; cy += p[1]; } cx /= r.length; cy /= r.length;
      // 重心（凹んだ形で外に出るときは、重心と頂点の中間点も試す）
      const probes = [[cx, cy]].concat([0, Math.floor(r.length / 3), Math.floor((2 * r.length) / 3)].map((i) => [(cx + r[i][0]) / 2, (cy + r[i][1]) / 2])).filter((q, i) => i === 0 || inRing(r, q[0], q[1]));
      let h = 0;
      for (const q of probes) {
        for (const k of grid.get(key(Math.floor(q[0] / CELL), Math.floor(q[1] / CELL))) || []) { const o = hs[k]; if (o.h > h && q[0] >= o.x0 && q[0] <= o.x1 && q[1] >= o.y0 && q[1] <= o.y1 && inRing(o.ring, q[0], q[1])) h = o.h; }
        if (h) break;
      }
      if (h) { b.h = h; n++; }
    }
    return n;
  }

  /* 範囲（緯度経度の外接矩形）の建物と水域を取得する。toXY(lat, lng) → {x, y}（ローカル m）
   * 戻り値 { buildings: [{ code, parts: [{ outer, holes, seam }], area, h?（実測の高さ） }], water: [[ [x,y]... ]...], measured, ok } */
  async function load(bounds, toXY) {
    const hJob = Promise.race([loadHeights(bounds, toXY).catch(() => []), new Promise((res) => setTimeout(() => res([]), 12000))]);
    const z = 16, n = 2 ** z;
    const fx = (lng) => ((lng + 180) / 360) * n, fy = (lat) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n; };
    const x0 = Math.floor(fx(bounds.west)), x1 = Math.floor(fx(bounds.east)), y0 = Math.floor(fy(bounds.north)), y1 = Math.floor(fy(bounds.south));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 160) return { buildings: [], water: [], ok: false };
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(tile(z, x, y).then((t) => ({ t, x, y })));
    const tiles = await Promise.all(jobs);
    const polys = [], water = [];
    let ok = false, E = 4096;
    const ll = (X, Y) => { const lng = (X / (n * E)) * 360 - 180, lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / (n * E)))) * 180) / Math.PI; const p = toXY(lat, lng); return [p.x, p.y]; };
    for (const { t, x, y } of tiles) {
      if (!t) continue;
      ok = true;
      if (t.BldA) { E = t.BldA.extent; for (const p of tilePolys(t.BldA, x, y)) polys.push(p); }
      if (t.WA) for (const f of t.WA.feats) if (f.type === 3) water.push(f.rings.filter((r) => r.length >= 3).map((r) => r.map((p) => ll(p[0] + x * t.WA.extent, p[1] + y * t.WA.extent))));
    }
    const buildings = mergeTiles(polys, E).map((g) => {
      let area = 0;
      const parts = g.parts.map((pt) => {
        const outer = pt.outer.map((p) => ll(p[0], p[1])), holes = pt.holes.map((h) => h.map((p) => ll(p[0], p[1])));
        area += Math.abs(area2(outer)) / 2 - holes.reduce((s, h) => s + Math.abs(area2(h)) / 2, 0);
        return { outer, holes, seam: pt.seam };
      });
      return { code: g.code, parts, area };
    }).filter((b) => b.area > 4);
    const measured = buildings.length ? assignHeights(buildings, await hJob) : 0;
    return { buildings, water, measured, ok };
  }

  /* 広い範囲の水域だけを粗いズームで取得する（遠景用）。戻り値 [[ [x,y]... ]...] */
  async function loadWater(bounds, toXY, z) {
    const n = 2 ** z;
    const fx = (lng) => ((lng + 180) / 360) * n, fy = (lat) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n; };
    const x0 = Math.floor(fx(bounds.west)), x1 = Math.floor(fx(bounds.east)), y0 = Math.floor(fy(bounds.north)), y1 = Math.floor(fy(bounds.south));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) return [];
    const jobs = [], water = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(tile(z, x, y).then((t) => ({ t, x, y })));
    for (const { t, x, y } of await Promise.all(jobs)) {
      if (!t || !t.WA) continue;
      const E = t.WA.extent, ll = (X, Y) => { const lng = (X / (n * E)) * 360 - 180, lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / (n * E)))) * 180) / Math.PI, p = toXY(lat, lng); return [p.x, p.y]; };
      for (const f of t.WA.feats) if (f.type === 3) water.push(f.rings.filter((r) => r.length >= 3).map((r) => r.map((p) => ll(p[0] + x * E, p[1] + y * E))));
    }
    return water;
  }

  /* ───────── 建物の形 ───────── */
  const hash = (i, j, k = 0) => {
    let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(k + 1, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  function vnoise(x, y, k) {
    const i = Math.floor(x), j = Math.floor(y), u = sm(x - i), v = sm(y - j);
    const a = hash(i, j, k), b = hash(i + 1, j, k), c = hash(i, j + 1, k), d = hash(i + 1, j + 1, k);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  /* 種別（3101 普通・3102 堅ろう・3103 高層・3111/3112 無壁舎）と面積・位置から高さと外観を決める。
   * 高さは実測ではなく推定（同じ街区は似た高さになるよう位置のノイズで決める） */
  function classify(code, area, cx, cy, known) {
    if (known > 0) { // 実測の高さがあるとき: 外観だけ決める
      const r0 = hash(Math.round(cx * 3), Math.round(cy * 3), 8);
      if (code === 3111 || code === 3112) return { kind: 3, h: known, gable: false, r: r0 };
      if (known >= 31) return { kind: 2, h: known, gable: false, r: r0 };
      if (area < 300 && known <= 11.5) return { kind: 0, h: known, gable: true, r: r0, top: true };
      return { kind: area < 900 && known < 9 ? 0 : 1, h: known, gable: false, r: r0 };
    }
    const n = Math.min(1, Math.max(0, 0.65 * vnoise(cx / 260, cy / 260, 5) + 0.35 * vnoise(cx / 70, cy / 70, 6) + 0.25 * (hash(Math.round(cx), Math.round(cy), 7) - 0.5)));
    const r = hash(Math.round(cx * 3), Math.round(cy * 3), 8);
    if (code === 3111 || code === 3112) return { kind: 3, h: code === 3112 ? 6 + 5 * r : 3.5 + 2.5 * r, gable: false, r };
    if (code === 3103) {
      const floors = area < 3500 ? 13 + Math.floor(Math.pow(0.3 * r + 0.7 * n, 1.4) * 36) : 9 + Math.floor(n * 11);
      return { kind: 2, h: floors * 3.4 + 4, gable: false, r };
    }
    if (code === 3102) {
      const floors = 3 + Math.floor(n * n * 8) + (area > 2500 ? 1 : 0);
      return { kind: 1, h: floors * 3.4 + 1, gable: false, r };
    }
    if (area < 300) { const floors = r < 0.2 ? 1 : r > 0.94 ? 3 : 2; return { kind: 0, h: floors * 2.8 + 0.5, gable: true, r }; }
    return { kind: area < 900 ? 0 : 1, h: 5.5 + 5.5 * n, gable: false, r };
  }
  /* 面積最小の外接長方形。戻り値 { ux, uy（長辺方向）, cu, cv（中心）, hu, hv（半幅）, fill（充填率） } */
  function obb(ring) {
    let best = null;
    const a = Math.abs(area2(ring)) / 2;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l < 0.5) continue;
      const ux = (q[0] - p[0]) / l, uy = (q[1] - p[1]) / l;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const s of ring) { const u = s[0] * ux + s[1] * uy, v = -s[0] * uy + s[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const A = (u1 - u0) * (v1 - v0);
      if (!best || A < best.A) best = u1 - u0 >= v1 - v0 ? { A, ux, uy, cu: (u0 + u1) / 2, cv: (v0 + v1) / 2, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2 } : { A, ux: -uy, uy: ux, cu: (v0 + v1) / 2, cv: -(u0 + u1) / 2, hu: (v1 - v0) / 2, hv: (u1 - u0) / 2 };
    }
    if (best) best.fill = a / Math.max(1e-6, best.A);
    return best;
  }
  /* 建物の色: 航空写真のその場所の色（暗すぎ・明るすぎはならす）。写真がなければ灰色 */
  const GREY = 0xb4b6b8;
  function photoColor(ph) {
    const l = 0.3 * ph[0] + 0.59 * ph[1] + 0.11 * ph[2], t = Math.min(0.8, Math.max(0.34, l)), k = t / Math.max(0.02, l);
    return ph.map((v) => Math.min(1, Math.max(0, (l + (v - l) * 0.9) * k)));
  }

  /* 建物の BufferGeometry を作る。
   * c = { T, toV(x,y,z)→[X,Y,Z], ground(x,y)→標高, skip(x,y)→bool（計画道路・のり面）, roofUv(x,y)→[u,v]|null, photo(x,y)→[r,g,b]|null（sRGB 0..1） }
   * 窓などの模様は描かない。色は航空写真の色（なければ灰色）で、低い陸屋根には写真そのものを貼る。
   * 頂点属性 aB = (写真の u, v, 地面からの高さ, 屋根フラグ 0:壁 1:写真を貼る陸屋根 2:単色の屋根) */
  function buildGeometry(buildings, c) {
    const T = c.T, pos = [], nor = [], col = [], aB = [], foot = [];
    const color = new T.Color();
    const lin = (hex, mul = 1) => { color.setHex(hex); return [color.r * mul, color.g * mul, color.b * mul]; };
    const linRGB = (rgb) => { color.setRGB(rgb[0], rgb[1], rgb[2], T.SRGBColorSpace); return [color.r, color.g, color.b]; };
    const tri = (A, B, C, n, cl, b, b2) => { // A,B,C = { p:[X,Y,Z], b:[..4], b2:[..3] }
      const ux = B.p[0] - A.p[0], uy = B.p[1] - A.p[1], uz = B.p[2] - A.p[2], vx = C.p[0] - A.p[0], vy = C.p[1] - A.p[1], vz = C.p[2] - A.p[2];
      let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      const fl = Math.hypot(fx, fy, fz); if (fl < 1e-9) return;
      if (!n) { const s = fy < 0 ? -1 : 1; n = [(s * fx) / fl, (s * fy) / fl, (s * fz) / fl]; } // 屋根は上向きにそろえる
      const order = fx * n[0] + fy * n[1] + fz * n[2] >= 0 ? [A, B, C] : [A, C, B];
      for (const v of order) { pos.push(v.p[0], v.p[1], v.p[2]); nor.push(n[0], n[1], n[2]); col.push(cl[0], cl[1], cl[2]); aB.push(v.b[0], v.b[1], v.hz || 0, b2[1]); }
    };
    let count = 0, measured = 0;
    for (const bd of buildings) {
      // 重心・接地高
      let sx = 0, sy = 0, np = 0, zmin = Infinity, zmax = -Infinity, skip = false;
      for (const pt of bd.parts) for (const p of pt.outer) { sx += p[0]; sy += p[1]; np++; const z = c.ground(p[0], p[1]); if (z == null) { skip = true; break; } zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); if (c.skip(p[0], p[1])) skip = true; }
      if (skip || !np) continue;
      const cx = sx / np, cy = sy / np, k = classify(bd.code, bd.area, cx, cy, bd.h);
      if (bd.h > 0) measured++;
      const single = bd.parts.length === 1 && !bd.parts[0].holes.length, box = single ? obb(bd.parts[0].outer) : null;
      const gable = k.gable && box && box.fill > 0.6 && box.hv > 1.6 && box.hv < 7.5;
      const pitch = 0.36 + 0.2 * hash(Math.round(cx), Math.round(cy), 11), seed = hash(Math.round(cx * 2), Math.round(cy * 2), 12);
      if (gable && k.top) k.h = Math.max(2.6, k.h - pitch * box.hv); // 実測は棟の高さなので軒の高さに直す
      const zr = Math.min(zmax, zmin + 3), top = zr + k.h; // 斜面では低い側から 3m までを地階扱い
      const ph = c.photo ? c.photo(cx, cy) : null;
      const baseC = ph ? linRGB(photoColor(ph)) : lin(GREY, 0.94 + 0.12 * seed);
      const wallC = baseC, roofC = ph ? baseC : [baseC[0] * 0.86, baseC[1] * 0.86, baseC[2] * 0.86];
      const roofFlag = !gable && c.roofUv && k.h < 22 ? 1 : 2; // 高い建物は写真が倒れ込んでずれるので単色
      const wb = [seed, k.kind], rb = [seed, k.kind];
      const roofZ = (x, y) => (gable ? top + pitch * Math.max(0, box.hv - Math.abs(-x * box.uy + y * box.ux - box.cv)) : top);
      for (const pt of bd.parts) {
        let outer = pt.outer, seam = pt.seam;
        if (gable) { // 棟と交わる辺に頂点を足す（妻壁の三角と屋根の折れ目）
          const r2 = [];
          outer.forEach((p, i) => {
            const q = outer[(i + 1) % outer.length], vp = -p[0] * box.uy + p[1] * box.ux - box.cv, vq = -q[0] * box.uy + q[1] * box.ux - box.cv;
            r2.push(p);
            if (vp * vq < -1e-6) { const t = vp / (vp - vq); r2.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
          });
          outer = r2; seam = new Set();
        }
        const ccw = area2(outer) > 0;
        // 壁
        const rings = [[outer, ccw ? 1 : -1, seam]].concat(pt.holes.map((h) => [h, area2(h) > 0 ? -1 : 1, null]));
        for (const [ring, sgn, sm2] of rings) {
          let u = 0;
          for (let i = 0; i < ring.length; i++) {
            const p = ring[i], q = ring[(i + 1) % ring.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (l < 1e-3) continue;
            if (!(sm2 && sm2.has(i))) {
              const nx = (sgn * (q[1] - p[1])) / l, ny = (-sgn * (q[0] - p[0])) / l, n = [nx, 0, -ny];
              const zb = zmin - 1.5, zp = roofZ(p[0], p[1]), zq = roofZ(q[0], q[1]);
              const A = { p: c.toV(p[0], p[1], zb), b: [0, 0], hz: zb - zr }, B = { p: c.toV(q[0], q[1], zb), b: [0, 0], hz: zb - zr };
              const C = { p: c.toV(q[0], q[1], zq), b: [0, 0], hz: zq - zr }, D = { p: c.toV(p[0], p[1], zp), b: [0, 0], hz: zp - zr };
              tri(A, B, C, n, wallC, wb, [k.h, 0]); tri(A, C, D, n, wallC, wb, [k.h, 0]);
            }
            u += l;
          }
        }
        // 屋根
        const uvOf = (x, y) => (roofFlag === 1 ? c.roofUv(x, y) : [0, 0]);
        const roofTris = (cont, holes, stripe) => {
          const V2 = (r) => r.map((p) => new T.Vector2(p[0], p[1]));
          const all = cont.concat(...holes);
          let faces = [];
          try { faces = T.ShapeUtils.triangulateShape(V2(cont), holes.map(V2)); } catch (e) { faces = []; }
          for (const f of faces) {
            const vs = f.map((i) => { const p = all[i]; return { p: c.toV(p[0], p[1], roofZ(p[0], p[1])), b: uvOf(p[0], p[1]), hz: k.h }; });
            tri(vs[0], vs[1], vs[2], null, roofC, rb, [k.h, roofFlag]);
          }
        };
        if (gable) {
          for (const side of [1, -1]) {
            const half = tidy(outer.filter((p) => side * (-p[0] * box.uy + p[1] * box.ux - box.cv) >= -1e-6), 1e-4);
            if (half.length >= 3) roofTris(half, [], true);
          }
        } else roofTris(outer, pt.holes, false);
        foot.push(outer);
      }
      count++;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new T.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(col), 3));
    g.setAttribute('aB', new T.BufferAttribute(new Float32Array(aB), 4));
    return { geometry: g, count, measured, footprints: foot };
  }

  const api = { parseMVT, tilePolys, mergeTiles, clipBox, tidy, area2, obb, classify, load, loadWater, loadHeights, assignHeights, buildGeometry, inRing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.V3DCity = api;
})(typeof self !== 'undefined' ? self : this);
