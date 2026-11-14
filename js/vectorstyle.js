/* Road Plan — 地理院 最適化ベクトルタイル（optimal_bvmap）を Google マップ風の配色で描く MapLibre スタイル */
'use strict';

const GSI_VT_URL = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf';
const GSI_VT_ATTR = '<a href="https://github.com/gsi-cyberjapan/optimal_bvmap" target="_blank" rel="noopener">地理院 最適化ベクトルタイル</a>';

function gsiGoogleStyle() {
  // MapLibre は 512px タイル基準なので、Leaflet のズーム lz に対して MapLibre のズームは lz - 1。
  // 以下は読みやすさのため Leaflet のズームで書き、Z() で変換する。
  const Z = (lz) => lz - 1;
  const C = {
    land: '#f5f3ef', water: '#aad3f7', waterLine: '#8fc1ee', waterText: '#3b78c3',
    building: '#e8e5e0', buildingLine: '#d9d5cf', structure: '#e1ded8',
    hw: '#fcd26c', hwCase: '#e3ad48', nat: '#fff1a8', natCase: '#ebc965',
    road: '#ffffff', roadCase: '#d9d6d0', minorCase: '#e3e0db', edge: '#dcd9d3',
    rail: '#a6acb3', railJr: '#8d939b', boundary: '#a8a3b8', text: '#5f6368', textDark: '#3c4043', halo: '#ffffff',
  };
  const get = (k) => ['get', k];
  const isHighway = ['any', ['==', get('vt_motorway'), 1], ['==', get('vt_rdctg'), '高速自動車国道等'], ['in', get('vt_code'), ['literal', [52703, 52704]]]];
  const isTunnel = ['in', get('vt_code'), ['literal', [2704, 2714, 2724, 2734]]];
  // 道路の種別（配色・低ズームでの表示に使う）
  const cat = ['case', isHighway, 'hw',
    ['match', get('vt_rdctg'), ['国道', '主要道路'], 'nat', '都道府県道', 'pref', 'loc']];
  // 幅員区分（高ズームでの線幅に使う）
  const wcls = ['match', get('vt_rnkwidth'), '3m未満', 'w0', '3m-5.5m未満', 'w1', '5.5m-13m未満', 'w2', '13m-19.5m未満', 'w3', '19.5m以上', 'w4', 'w3'];
  // 線幅 [px]（Leaflet ズーム → 幅員区分ごとの幅, 種別ごとの最小幅）
  const W = {
    9: { w: [0, 0, 0, 0, 0], c: { hw: 1.2, nat: 0.8, pref: 0, loc: 0 } },
    11: { w: [0, 0, 0, 0.6, 0.8], c: { hw: 2, nat: 1.4, pref: 0.9, loc: 0 } },
    13: { w: [0, 0.6, 1.2, 2, 2.5], c: { hw: 3, nat: 2.4, pref: 1.8, loc: 0 } },
    15: { w: [1, 2.2, 3.5, 5, 6], c: { hw: 6, nat: 5, pref: 4, loc: 0 } },
    17: { w: [3, 6, 10, 14, 18], c: { hw: 14, nat: 12, pref: 10, loc: 0 } },
    20: { w: [20, 40, 64, 96, 120], c: { hw: 96, nat: 80, pref: 64, loc: 0 } },
  };
  const fillAt = (s) => ['max', ['match', wcls, 'w0', s.w[0], 'w1', s.w[1], 'w2', s.w[2], 'w3', s.w[3], s.w[4]],
    ['match', cat, 'hw', s.c.hw, 'nat', s.c.nat, 'pref', s.c.pref, s.c.loc]];
  const roadWidth = (casing) => ['interpolate', ['exponential', 1.6], ['zoom'], ...Object.entries(W).flatMap(([lz, s]) => {
    const f = fillAt(s), e = +lz < 15 ? 1 : 2;
    return [Z(+lz), casing ? ['case', ['>', f, 0], ['+', f, e], 0] : f];
  })];
  const sortKey = ['+', ['*', ['coalesce', get('vt_lvorder'), 0], 10], ['match', cat, 'hw', 4, 'nat', 3, 'pref', 2, 1]];
  const lineRound = { 'line-cap': 'round', 'line-join': 'round' };
  const src = 'gsi';
  const L = (id, type, layer, rest) => Object.assign({ id, type, source: src, 'source-layer': layer }, rest);
  const anchor = ['match', ['coalesce', get('vt_dsppos'), 'CC'],
    'LT', 'top-left', 'CT', 'top', 'RT', 'top-right', 'LC', 'left', 'RC', 'right', 'LB', 'bottom-left', 'CB', 'bottom', 'RB', 'bottom-right', 'center'];
  const code = get('vt_code');
  const ADDRESS = [110, 120, 130, 140, 210, 220, 351, 352, 431, 432, 531, 850, 1301, 1302, 1303, 1401, 1402, 1403, 51301, 51302, 51303];
  const BIG_ADDRESS = [140, 351, 850, 1301, 1401, 51301];
  const WATER = [321, 322, 323, 341, 342, 343, 344, 345, 347, 348, 353, 361, 521, 820, 822, 840, 841, 842, 843];
  const TRANSP = [411, 412, 413, 421, 422, 423, 860, 2901, 2903, 2904, 2941, 2942, 2943, 2944, 2945];
  const HIDE = [800, 7101, 7102, 7103, 7201, 7221, 7701, 7711, 7352, 7372, 57221, 5801, 7601, 7621, 6311, 6312, 6313, 6314, 6321, 6322, 6323, 6324, 6325, 6326, 6327];
  const inList = (list) => ['in', code, ['literal', list]];

  return {
    version: 8,
    glyphs: 'https://maps.gsi.go.jp/xyz/noto-jp/{fontstack}/{range}.pbf',
    sources: { [src]: { type: 'vector', tiles: [GSI_VT_URL], minzoom: 4, maxzoom: 16, attribution: GSI_VT_ATTR } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.land } },
      L('water', 'fill', 'WA', { paint: { 'fill-color': C.water } }),
      L('water-str', 'fill', 'WStrA', { minzoom: Z(14), paint: { 'fill-color': '#c7d9ea' } }),
      L('river', 'line', 'RvrCL', { minzoom: Z(11), layout: lineRound, paint: { 'line-color': C.water, 'line-width': ['interpolate', ['linear'], ['zoom'], Z(11), 0.6, Z(16), 2] } }),
      L('waterline', 'line', 'WL', { minzoom: Z(13), paint: { 'line-color': C.waterLine, 'line-width': 0.6 } }),
      L('coast', 'line', 'Cstline', { paint: { 'line-color': C.waterLine, 'line-width': 0.7 } }),
      L('structure', 'fill', 'StrctArea', { minzoom: Z(15), paint: { 'fill-color': C.structure } }),
      L('building', 'fill', 'BldA', { minzoom: Z(15), paint: { 'fill-color': C.building, 'fill-outline-color': C.buildingLine, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], Z(15), 0.5, Z(16.5), 1] } }),
      L('boundary', 'line', 'AdmBdry', { paint: { 'line-color': C.boundary, 'line-width': ['interpolate', ['linear'], ['zoom'], Z(6), 0.6, Z(14), 1.2], 'line-dasharray': [4, 2, 1, 2] } }),
      L('road-edge', 'line', 'RdEdg', { minzoom: Z(17), paint: { 'line-color': C.edge, 'line-width': 0.8 } }),
      // 道路（トンネル → 縁取り → 本体）
      L('road-tunnel', 'line', 'RdCL', { minzoom: Z(13), filter: isTunnel, paint: { 'line-color': C.roadCase, 'line-width': roadWidth(false), 'line-dasharray': [2, 1.5], 'line-opacity': 0.8 } }),
      L('road-case', 'line', 'RdCL', { filter: ['!', isTunnel], layout: Object.assign({ 'line-sort-key': sortKey }, lineRound), paint: {
        'line-color': ['match', cat, 'hw', C.hwCase, 'nat', C.natCase, 'pref', C.roadCase, C.minorCase], 'line-width': roadWidth(true) } }),
      L('road', 'line', 'RdCL', { filter: ['!', isTunnel], layout: Object.assign({ 'line-sort-key': sortKey }, lineRound), paint: {
        'line-color': ['match', cat, 'hw', C.hw, 'nat', C.nat, C.road], 'line-width': roadWidth(false) } }),
      // 鉄道（地下鉄は描かない）
      L('rail', 'line', 'RailCL', { minzoom: Z(9), filter: ['!=', get('vt_rtcode'), '地下鉄'], paint: {
        'line-color': ['case', ['==', get('vt_rtcode'), 'JR'], C.railJr, C.rail],
        'line-width': ['interpolate', ['linear'], ['zoom'], Z(9), 0.8, Z(14), 1.6, Z(18), 3] } }),
      // 注記
      L('label', 'symbol', 'Anno', { filter: ['all', ['has', 'vt_text'], ['!', inList(HIDE)],
        ['any', inList(BIG_ADDRESS), inList(TRANSP), ['>=', ['zoom'], Z(15)]]], layout: {
        'text-field': get('vt_text'), 'text-font': ['NotoSansJP-Regular'], 'text-anchor': anchor,
        'text-size': ['case', inList(BIG_ADDRESS), 13, inList(ADDRESS), 12, inList(TRANSP), 11.5, 11],
        'text-max-width': 12, 'text-padding': 2,
        'symbol-sort-key': ['case', inList(BIG_ADDRESS), 0, inList(TRANSP), 1, inList(ADDRESS), 2, 3] }, paint: {
        'text-color': ['case', inList(WATER), C.waterText, inList(ADDRESS), C.textDark, C.text],
        'text-halo-color': C.halo, 'text-halo-width': 1.4 } }),
    ],
  };
}
