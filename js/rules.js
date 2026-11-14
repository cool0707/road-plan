/* 道路構造令 等に基づく照査ルール。
 * 数値は道路構造令（昭和45年政令第320号）本則の表、および「道路構造令の解説と運用」の一般的な目安に基づく。
 * 条例・管理者基準が優先される場合があるため、結果は参考値。 */
(function (root) {
  'use strict';

  /* 設計速度別の基準値
   * Rmin: 最小曲線半径(15条) / Rex: 同・特例値 / clK,clMin: 曲線長 K/θ と下限(16条) / Ls: 緩和区間長(18条)
   * sight: 視距(19条) / f: 横すべり摩擦係数(解説と運用) / grade: 縦断勾配 %(20条) / gradeEx: 同・特例値
   * vR, vRc: 凸形・凹形の縦断曲線の半径(22条) / vL: 縦断曲線長(22条) / comb: 合成勾配 %(25条) */
  const T = {
    120: { Rmin: 710, Rex: 570, clK: 1400, clMin: 200, Ls: 100, sight: 210, f: 0.10, grade: 2, gradeEx: 5, vR: 11000, vRc: 4000, vL: 100, comb: 10 },
    100: { Rmin: 460, Rex: 380, clK: 1200, clMin: 170, Ls: 85, sight: 160, f: 0.11, grade: 3, gradeEx: 6, vR: 6500, vRc: 3000, vL: 85, comb: 10 },
    80: { Rmin: 280, Rex: 230, clK: 1000, clMin: 140, Ls: 70, sight: 110, f: 0.12, grade: 4, gradeEx: 7, vR: 3000, vRc: 2000, vL: 70, comb: 10.5 },
    60: { Rmin: 150, Rex: 120, clK: 700, clMin: 100, Ls: 50, sight: 75, f: 0.13, grade: 5, gradeEx: 8, vR: 1400, vRc: 1000, vL: 50, comb: 10.5 },
    50: { Rmin: 100, Rex: 80, clK: 600, clMin: 80, Ls: 40, sight: 55, f: 0.14, grade: 6, gradeEx: 9, vR: 800, vRc: 700, vL: 40, comb: 11.5 },
    40: { Rmin: 60, Rex: 50, clK: 500, clMin: 70, Ls: 35, sight: 40, f: 0.15, grade: 7, gradeEx: 10, vR: 450, vRc: 450, vL: 35, comb: 11.5 },
    30: { Rmin: 30, Rex: 30, clK: 350, clMin: 50, Ls: 25, sight: 30, f: 0.15, grade: 8, gradeEx: 11, vR: 250, vRc: 250, vL: 25, comb: 11.5 },
    20: { Rmin: 15, Rex: 15, clK: 280, clMin: 40, Ls: 20, sight: 20, f: 0.15, grade: 9, gradeEx: 12, vR: 100, vRc: 100, vL: 20, comb: 11.5 },
  };
  const SPEEDS = [120, 100, 80, 60, 50, 40, 30, 20];

  /* 道路区分（3条）: V=設計速度, Vex=特例, lane=車線幅員(5条), shoulder=左側路肩(8条), single=1車線道路(車道幅員) */
  const CLASSES = {
    '1-1': { name: '第1種第1級', V: [120], Vex: [100], lane: 3.5, shoulder: 2.5, shoulderEx: 1.75 },
    '1-2': { name: '第1種第2級', V: [100], Vex: [80], lane: 3.5, shoulder: 2.5, shoulderEx: 1.75 },
    '1-3': { name: '第1種第3級', V: [80], Vex: [60], lane: 3.5, shoulder: 1.75, shoulderEx: 1.25 },
    '1-4': { name: '第1種第4級', V: [60], Vex: [50], lane: 3.25, shoulder: 1.75, shoulderEx: 1.25 },
    '2-1': { name: '第2種第1級', V: [80], Vex: [60], lane: 3.5, shoulder: 1.25, shoulderEx: 1.25 },
    '2-2': { name: '第2種第2級', V: [60], Vex: [50, 40], lane: 3.25, shoulder: 1.25, shoulderEx: 1.25 },
    '3-1': { name: '第3種第1級', V: [80], Vex: [60], lane: 3.5, shoulder: 1.25, shoulderEx: 0.75 },
    '3-2': { name: '第3種第2級', V: [60], Vex: [50, 40], lane: 3.25, shoulder: 0.75, shoulderEx: 0.5 },
    '3-3': { name: '第3種第3級', V: [60, 50, 40], Vex: [30], lane: 3.0, shoulder: 0.75, shoulderEx: 0.5 },
    '3-4': { name: '第3種第4級', V: [50, 40, 30], Vex: [20], lane: 2.75, shoulder: 0.75, shoulderEx: 0.5 },
    '3-5': { name: '第3種第5級', V: [40, 30, 20], Vex: [], lane: 4.0, single: true, shoulder: 0.5, shoulderEx: 0.5 },
    '4-1': { name: '第4種第1級', V: [60], Vex: [50, 40], lane: 3.25, shoulder: 0.5, shoulderEx: 0.5 },
    '4-2': { name: '第4種第2級', V: [60, 50, 40], Vex: [30], lane: 3.0, shoulder: 0.5, shoulderEx: 0.5 },
    '4-3': { name: '第4種第3級', V: [50, 40, 30], Vex: [20], lane: 3.0, shoulder: 0.5, shoulderEx: 0.5 },
    '4-4': { name: '第4種第4級', V: [40, 30, 20], Vex: [], lane: 4.0, single: true, shoulder: 0.5, shoulderEx: 0.5 },
  };

  const DECEL = 2.0; // 快適な減速度の目安 [m/s²]
  const deg = (r) => (r * 180) / Math.PI;
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

  const emaxOf = (road) => (road.cls[0] === '4' ? 0.06 : 0.10); // 最大片勾配(16条)
  const carriage = (road) => road.lanes * road.laneW;
  const totalWidth = (road) => carriage(road) + 2 * road.shoulderW + 2 * road.sidewalkW;

  /* 曲線 R での必要片勾配と走行可能速度 */
  function curveSpeed(road, R) {
    const t = T[road.V], emax = emaxOf(road);
    const need = (road.V * road.V) / (127 * R) - t.f;
    const e = Math.min(emax, Math.max(0.02, need));
    return { need, e, vSafe: Math.sqrt(127 * R * (e + t.f)), vMax: Math.sqrt(127 * R * (emax + t.f)) };
  }

  function foldAngle(a) { // 2直線のなす角 0〜90°
    a = Math.abs(a) % Math.PI;
    return deg(a > Math.PI / 2 ? Math.PI - a : a);
  }

  /* 推奨曲線諸元（新規IPの初期値） */
  function recommend(V, absDelta) {
    const t = T[V];
    const R = Math.round((t.Rmin * 1.5) / 10) * 10;
    return { R, L: recommendL(V, R, absDelta) };
  }
  function recommendL(V, R, absDelta) {
    let L = Math.max(T[V].Ls, R / 9);        // A ≥ R/3
    L = Math.min(L, R, 0.8 * absDelta * R);  // A ≤ R、円曲線を残す
    return Math.max(0, L);
  }

  function check(road, al, extra) {
    extra = extra || {};
    const out = [];
    const add = (level, cat, title, detail, ref, ip) => out.push({ level, cat, title, detail: detail || '', ref: ref || '', ip });
    const V = road.V, t = T[V], c = CLASSES[road.cls], emax = emaxOf(road);
    const n = road.ips.length;
    const ipName = (i) => (i === 0 ? 'BP' : i === n - 1 ? 'EP' : 'IP' + i);

    /* ── 設計条件 ── */
    if (c.V.includes(V)) add('ok', '設計条件', `設計速度 ${V}km/h`, `${c.name} の標準値`, '道路構造令 第13条');
    else if (c.Vex.includes(V)) add('warn', '設計条件', `設計速度 ${V}km/h は特例値`, `${c.name} の標準は ${c.V.join('・')}km/h。地形の状況その他の特別の理由によりやむを得ない場合に限る`, '道路構造令 第13条');
    else add('error', '設計条件', `設計速度 ${V}km/h は ${c.name} の規定外`, `標準 ${c.V.join('・')}km/h${c.Vex.length ? '（特例 ' + c.Vex.join('・') + 'km/h）' : ''}`, '道路構造令 第13条');

    /* ── 横断構成 ── */
    if (c.single) {
      const w = carriage(road);
      if (w >= 4) add('ok', '横断構成', `車道幅員 ${f2(w)}m`, '1車線道路の標準 4m 以上', '道路構造令 第5条');
      else if (w >= 3) add('warn', '横断構成', `車道幅員 ${f2(w)}m は特例値`, '標準 4m。交通量が極めて少なく地形等によりやむを得ない場合のみ 3m まで縮小可', '道路構造令 第5条');
      else add('error', '横断構成', `車道幅員 ${f2(w)}m が不足`, '第3種第5級・第4種第4級の車道幅員は 4m（特例 3m）', '道路構造令 第5条');
    } else {
      if (road.lanes < 2) add('warn', '横断構成', '車線数が1', `${c.name} は車線により構成される道路（2車線以上）`, '道路構造令 第5条');
      if (road.laneW >= c.lane - 1e-9) add('ok', '横断構成', `車線幅員 ${f2(road.laneW)}m`, `${c.name} の標準 ${f2(c.lane)}m 以上`, '道路構造令 第5条');
      else if (road.laneW >= c.lane - 0.25 - 1e-9) add('warn', '横断構成', `車線幅員 ${f2(road.laneW)}m は標準未満`, `標準 ${f2(c.lane)}m。縮小は条文の特例規定に該当する場合のみ`, '道路構造令 第5条');
      else add('error', '横断構成', `車線幅員 ${f2(road.laneW)}m が不足`, `${c.name} の標準 ${f2(c.lane)}m`, '道路構造令 第5条');
    }
    if (road.shoulderW >= c.shoulder - 1e-9) add('ok', '横断構成', `路肩 ${f2(road.shoulderW)}m`, `標準 ${f2(c.shoulder)}m 以上`, '道路構造令 第8条');
    else if (road.shoulderW >= c.shoulderEx - 1e-9) add('warn', '横断構成', `路肩 ${f2(road.shoulderW)}m は特例値`, `標準 ${f2(c.shoulder)}m（特例 ${f2(c.shoulderEx)}m）`, '道路構造令 第8条');
    else add(road.cls[0] === '4' && road.sidewalkW > 0 ? 'warn' : 'error', '横断構成', `路肩 ${f2(road.shoulderW)}m が不足`, `標準 ${f2(c.shoulder)}m（特例 ${f2(c.shoulderEx)}m）。歩道等を設ける第4種の道路等は省略・縮小できる場合あり`, '道路構造令 第8条');
    if (road.sidewalkW > 0) {
      if (road.sidewalkW >= 2) add('ok', '横断構成', `歩道 ${f2(road.sidewalkW)}m`, '2m 以上（歩行者交通量が多い道路は 3.5m 以上）', '道路構造令 第11条');
      else add('error', '横断構成', `歩道 ${f2(road.sidewalkW)}m が不足`, '歩道の幅員は 2m 以上（歩行者交通量が多い道路は 3.5m 以上）', '道路構造令 第11条');
    }

    /* ── 線形の成立性 ── */
    for (const is of al.issues) {
      if (is.type === 'overlap') add('error', '線形', `${ipName(is.ip - 1)}〜${ipName(is.ip)} 間で曲線が収まらない`, `接線長の合計が IP 間距離を ${f2(is.amount)}m 超過。R または A を小さくするか IP を離す`, '幾何条件', is.ip);
      if (is.type === 'clamp') add('error', '線形', `${ipName(is.ip)} の緩和曲線が交角に対して長すぎる`, 'クロソイドの接線角の合計が交角を超過。A を小さくするか R を大きくする', '幾何条件', is.ip);
      if (is.type === 'kink') add('error', '線形', `${ipName(is.ip)} が曲線なしの折れ点`, `交角 ${f1(is.deg)}°。曲線半径 R を設定する`, '道路構造令 第15条', is.ip);
    }

    /* ── 曲線ごとの照査 ── */
    const curves = al.curves.filter((cv) => cv && !cv.none);
    curves.forEach((cv) => {
      const nm = ipName(cv.ip), R = cv.R, ip = cv.ip;
      const th = deg(Math.abs(cv.delta));
      // 最小曲線半径
      if (R >= t.Rmin) add('ok', '曲線半径', `${nm}: R=${f1(R)}m`, `最小曲線半径 ${t.Rmin}m 以上`, '道路構造令 第15条', ip);
      else if (R >= t.Rex) add('warn', '曲線半径', `${nm}: R=${f1(R)}m は特例値の範囲`, `標準 ${t.Rmin}m 未満（特例 ${t.Rex}m 以上）。やむを得ない場合のみ`, '道路構造令 第15条', ip);
      else add('error', '曲線半径', `${nm}: R=${f1(R)}m が最小曲線半径未満`, `設計速度 ${V}km/h の最小曲線半径 ${t.Rmin}m（特例 ${t.Rex}m）`, '道路構造令 第15条', ip);
      if (R < 6) add('error', '曲線半径', `${nm}: 小型自動車も回転不可`, '小型自動車の最小回転半径 6m 未満', '道路構造令 第4条', ip);
      else if (R < 12) add('warn', '曲線半径', `${nm}: 普通自動車の最小回転半径未満`, '普通自動車・セミトレーラ連結車の最小回転半径は 12m', '道路構造令 第4条', ip);
      // 片勾配・走行速度
      const sp = curveSpeed(road, R);
      if (sp.need > emax + 1e-9) add('error', '片勾配', `${nm}: 必要片勾配 ${f1(sp.need * 100)}% が上限超過`, `最大片勾配 ${emax * 100}%（f=${t.f}）での走行可能速度は約 ${Math.floor(sp.vMax)}km/h`, '道路構造令 第16条', ip);
      else add('info', '片勾配', `${nm}: 必要片勾配 約${f1(Math.max(0, sp.need) * 100)}%`, `i = V²/(127R) − f（f=${t.f}）。最大 ${emax * 100}%${road.cls[0] === '4' ? '（第4種は片勾配を付さないことができる）' : ''}`, '道路構造令 第16条', ip);
      // 曲線長
      const need = th < 7 ? Math.max(t.clK / Math.max(th, 2), t.clMin) : t.clMin;
      if (cv.CL >= need - 1e-6) add('ok', '曲線長', `${nm}: 曲線長 ${f1(cv.CL)}m`, `必要 ${f1(need)}m 以上${th < 7 ? '（交角7°未満）' : ''}`, '道路構造令 第16条', ip);
      else add('error', '曲線長', `${nm}: 曲線長 ${f1(cv.CL)}m が不足`, `必要 ${f1(need)}m（緩和曲線を含む）${th < 7 ? '。交角 ' + f1(th) + '° のため ' + t.clK + '/θ を適用' : ''}`, '道路構造令 第16条', ip);
      // 緩和区間
      const rOmit = (t.Ls * t.Ls) / (24 * 0.2); // 移程量 20cm 未満となる半径
      [['起点側', cv.L1], ['終点側', cv.L2]].forEach(([side, L]) => {
        if (L >= t.Ls - 1e-6) add('ok', '緩和区間', `${nm} ${side}: 緩和曲線長 ${f1(L)}m`, `緩和区間長 ${t.Ls}m 以上`, '道路構造令 第18条', ip);
        else if (L < 1e-6 && R >= rOmit) add('info', '緩和区間', `${nm} ${side}: 緩和曲線なし（省略可の範囲）`, `R ≥ ${Math.ceil(rOmit)}m では移程量が 20cm 未満となり省略可能とされる`, '道路構造令 第18条／解説と運用', ip);
        else if (L < 1e-6) add('warn', '緩和区間', `${nm} ${side}: 緩和曲線なし`, `車道の屈曲部には緩和区間（${t.Ls}m 以上）を設ける。省略の目安は R ≥ ${Math.ceil(rOmit)}m`, '道路構造令 第18条', ip);
        else add('error', '緩和区間', `${nm} ${side}: 緩和曲線長 ${f1(L)}m が不足`, `緩和区間長 ${t.Ls}m 以上（A ≥ ${f1(Math.sqrt(R * t.Ls))}）`, '道路構造令 第18条', ip);
      });
      // クロソイドパラメータの目安
      [['A1', cv.A1, cv.L1], ['A2', cv.A2, cv.L2]].forEach(([k, A, L]) => {
        if (L > 1e-6 && R < 1500 && (A < R / 3 - 1e-6 || A > R + 1e-6)) add('info', '緩和区間', `${nm}: ${k}=${f1(A)} が目安 R/3〜R の範囲外`, `視覚的に滑らかな線形の目安は ${f1(R / 3)} ≤ A ≤ ${f1(R)}`, '解説と運用（目安）', ip);
      });
      // 視距（曲線内側の見通し）
      const S = t.sight;
      const Rp = Math.max(1, R - (c.single ? 0 : (road.lanes / 2 - 0.5) * road.laneW));
      const mReq = cv.CL >= S ? Rp * (1 - Math.cos(S / (2 * Rp))) : (cv.CL * (2 * S - cv.CL)) / (8 * Rp);
      const mAvail = (c.single ? carriage(road) / 2 : road.laneW / 2) + road.shoulderW + road.sidewalkW;
      if (mReq <= mAvail + 1e-6) add('ok', '視距', `${nm}: 視距 ${S}m を道路敷内で確保`, `内側車線中心から必要な見通し幅 ${f2(mReq)}m ≤ ${f2(mAvail)}m`, '道路構造令 第19条', ip);
      else add('warn', '視距', `${nm}: 曲線内側の見通し要確認`, `視距 ${S}m の確保に、道路端からさらに ${f2(mReq - mAvail)}m の見通し空間が必要（内側に建物・法面・植栽がある場合）`, '道路構造令 第19条', ip);
    });

    // 同方向曲線間の短い直線
    for (let i = 0; i + 1 < curves.length; i++) {
      const a = curves[i], b = curves[i + 1];
      const gap = b.sTS - a.sST;
      if (a.sgn === b.sgn && gap > 0.5 && gap < 6 * V) add('info', '線形', `IP${a.ip}〜IP${b.ip}: 同方向曲線間の直線が短い（${f1(gap)}m）`, `ブロークンバックカーブを避けるため、直線を十分長く（目安 6V=${6 * V}m）とるか複合曲線とする`, '解説と運用（目安）', b.ip);
    }

    /* ── 既存道路との接続・進入速度 ── */
    [['start', '起点', 0], ['end', '終点', n - 1]].forEach(([key, label, ipIdx]) => {
      const conn = road.conn && road.conn[key];
      if (!conn) { add('info', '接続', `${label}が既存道路に未接続`, '端点を既存道路にスナップすると接続条件を照査します', '', ipIdx); return; }
      const dir = key === 'start' ? al.dirs[0] : al.dirs[al.dirs.length - 1];
      const ang = foldAngle(dir - conn.bearing);
      const cv = key === 'start' ? curves[0] : curves[curves.length - 1];
      const straight = cv ? (key === 'start' ? cv.sTS : al.length - cv.sST) : al.length;
      const who = conn.name || '既存道路';
      if (conn.mode === 'tangent') {
        if (ang < 0.5) add('ok', '接続', `${label}: ${who} に接線方向で接続`, '既存道路の延長方向と一致', '', ipIdx);
        else add('warn', '接続', `${label}: 接線接続だが方向が ${f1(ang)}° ずれている`, '隣接 IP を既存道路の延長線上に置く', '', ipIdx);
        if (conn.width && Math.abs(conn.width - carriage(road)) > 0.5) add('info', '接続', `${label}: 幅員差 ${f2(Math.abs(conn.width - carriage(road)))}m`, `既存 約${f1(conn.width)}m ／ 計画車道 ${f2(carriage(road))}m。幅員のすりつけ区間を検討`, '解説と運用', ipIdx);
        const Ve = conn.speed || V;
        if (cv) {
          const sp = curveSpeed(road, cv.R);
          const Vc = Math.min(sp.vSafe, sp.vMax);
          if (Ve > Vc + 0.5) {
            const d = (Ve * Ve - Vc * Vc) / (2 * DECEL * 12.96);
            if (straight < d) add('warn', '進入速度', `${label}: 進入速度 ${Ve}km/h に対し減速区間が不足`, `最初の曲線 IP${cv.ip}（R=${f1(cv.R)}m）の走行可能速度は約 ${Math.floor(Vc)}km/h。減速に約 ${Math.ceil(d)}m 必要（減速度 ${DECEL}m/s²）だが直線区間は ${f1(straight)}m`, '走行力学による目安', cv.ip);
            else add('info', '進入速度', `${label}: 曲線手前で ${Ve}→${Math.floor(Vc)}km/h への減速が必要`, `必要減速距離 約${Math.ceil(d)}m ≤ 直線区間 ${f1(straight)}m。速度規制・警戒標識を検討`, '走行力学による目安', cv.ip);
          } else add('ok', '進入速度', `${label}: 進入速度 ${Ve}km/h で最初の曲線を走行可能`, `IP${cv.ip} の走行可能速度 約${Math.floor(Vc)}km/h`, '走行力学による目安', cv.ip);
        }
        if (Ve >= V + 20) add('warn', '進入速度', `${label}: 接続道路の速度 ${Ve}km/h が設計速度を 20km/h 以上超過`, '速度差が大きい。速度抑制策または設計速度の見直しを検討', '解説と運用（目安）', ipIdx);
      } else {
        if (ang >= 75) add('ok', '接続', `${label}: ${who} との交差角 ${f1(ang)}°`, '直角またはそれに近い角度（75°以上）', '道路構造令 第27条／解説と運用', ipIdx);
        else if (ang >= 60) add('warn', '接続', `${label}: 交差角 ${f1(ang)}° が 75° 未満`, '交差角は直角に近い角度（75°以上）が望ましい。やむを得ない場合でも 60°以上', '道路構造令 第27条／解説と運用', ipIdx);
        else add('error', '接続', `${label}: 交差角 ${f1(ang)}° が 60° 未満`, '鋭角交差は見通し・右左折の安全性が低下。線形を見直す', '道路構造令 第27条／解説と運用', ipIdx);
        if (cv && straight < t.sight) add('info', '接続', `${label}: 交差点から ${f1(straight)}m で曲線開始`, `交差点取付部は直線が望ましい（目安: 制動停止視距 ${t.sight}m）`, '解説と運用（目安）', cv.ip);
        const Ve = conn.speed;
        if (Ve) {
          const S = (T[SPEEDS.reduce((a, b) => (Math.abs(b - Ve) < Math.abs(a - Ve) ? b : a))] || t).sight;
          add('info', '進入速度', `${label}: 交差道路 ${Ve}km/h に対する見通し`, `交差道路側の車両に対し、左右それぞれ ${S}m 以上（制動停止視距）の見通しを確保する`, '道路構造令 第19条／解説と運用', ipIdx);
        }
      }
    });

    /* ── 位置指定道路 ── */
    if (road.shitei) {
      const w = totalWidth(road);
      if (w >= 4) add('ok', '位置指定道路', `幅員 ${f2(w)}m`, '4m 以上', '建築基準法 第42条');
      else add('error', '位置指定道路', `幅員 ${f2(w)}m が不足`, '道路の幅員は 4m 以上', '建築基準法 第42条');
      const cs = !!(road.conn && road.conn.start), ce = !!(road.conn && road.conn.end);
      if (cs !== ce) {
        if (al.length <= 35) add('ok', '位置指定道路', `袋路状道路 延長 ${f1(al.length)}m`, '35m 以下', '建築基準法施行令 第144条の4');
        else if (w >= 6) add('ok', '位置指定道路', `袋路状道路 延長 ${f1(al.length)}m（幅員 6m 以上）`, '幅員 6m 以上のため延長制限なし', '建築基準法施行令 第144条の4');
        else add('warn', '位置指定道路', `袋路状道路 延長 ${f1(al.length)}m が 35m 超`, '終端および区間 35m 以内ごとに自動車の転回広場が必要（または幅員 6m 以上）', '建築基準法施行令 第144条の4');
      } else if (!cs) add('info', '位置指定道路', '両端とも未接続', '両端が他の道路に接続するか、袋路状道路の基準を満たす必要がある', '建築基準法施行令 第144条の4');
      [['start', '起点'], ['end', '終点']].forEach(([key, label]) => {
        const conn = road.conn && road.conn[key];
        if (conn && conn.mode !== 'tangent') add('info', '位置指定道路', `${label}: 隅切りが必要`, '交差・接続・屈曲箇所（内角120°以上を除く）には一辺 2m の二等辺三角形の隅切りを設ける', '建築基準法施行令 第144条の4');
      });
      al.curves.forEach((cv) => { if (cv && deg(Math.abs(cv.delta)) > 60 && (cv.none || cv.R < 6)) add('info', '位置指定道路', `IP${cv.ip}: 屈曲部に隅切りが必要`, '内角 120° 未満の屈曲箇所には隅切りを設ける', '建築基準法施行令 第144条の4', cv.ip); });
    }

    /* ── 縦断（現況地盤） ── */
    const vp = extra.vplan && extra.vplan.pf;
    if (vp) {
      /* ── 計画縦断 ── */
      const vn = (i) => (i === 0 ? 'BP' : i === vp.pts.length - 1 ? 'EP' : 'VIP' + i);
      const sta = (s) => `測点 ${f1(s)}m`;
      for (const is of vp.issues) {
        if (is.type === 'order') add('error', '縦断線形', `${vn(is.i)} の測点が前の点より手前`, '縦断変化点は起点側から順に、測点が増える順に並べる', '幾何条件');
        if (is.type === 'overlap') add('error', '縦断線形', `${vn(is.i)}〜${vn(is.i + 1)} 間で縦断曲線が重なる`, `縦断曲線長の半分の合計が変化点間距離を ${f2(is.amount)}m 超過。曲線長を短くするか変化点を離す`, '幾何条件');
      }
      const lim = road.shitei ? Math.min(12, t.grade) : t.grade, limEx = road.shitei ? Math.min(12, t.gradeEx) : t.gradeEx;
      let gmax = 0, gmaxAt = 0, flat = false;
      vp.grades.forEach((g, k) => {
        const a = Math.abs(g) * 100, s0 = vp.pts[k].s, s1 = vp.pts[k + 1].s, nm = `${vn(k)}〜${vn(k + 1)}`;
        if (a > gmax) { gmax = a; gmaxAt = (s0 + s1) / 2; }
        if (a < 0.3 && s1 - s0 > 1) flat = true;
        if (a > limEx + 1e-9) add('error', '縦断勾配', `${nm}: 計画勾配 ${f2(g * 100)}% が上限超過`, `設計速度 ${V}km/h の縦断勾配 ${lim}%（特例 ${limEx}%）以下`, road.shitei && a > 12 ? '建築基準法施行令 第144条の4' : '道路構造令 第20条');
        else if (a > lim + 1e-9) add('warn', '縦断勾配', `${nm}: 計画勾配 ${f2(g * 100)}% は特例値`, `標準 ${lim}%（特例 ${limEx}%）。地形の状況等によりやむを得ない場合に限る`, '道路構造令 第20条');
      });
      if (gmax <= lim + 1e-9) add('ok', '縦断勾配', `計画縦断の最大勾配 ${f2(gmax)}%`, `縦断勾配の規定値 ${lim}% 以下（${sta(gmaxAt)} 付近）`, '道路構造令 第20条');
      if (flat) add('info', '縦断勾配', '勾配 0.3% 未満の区間あり', '路面排水のため、側溝のある区間等では 0.3% 以上の縦断勾配が望ましい', '道路構造令の解説と運用');
      vp.curves.forEach((c) => {
        const nm = vn(c.i), dg = Math.abs(c.dg) * 100;
        if (dg < 0.05) return;
        const kind = c.crest ? '凸形' : '凹形', Rmin = c.crest ? t.vR : t.vRc;
        if (c.L <= 0) return add('error', '縦断曲線', `${nm}: 縦断曲線がない（勾配差 ${f2(dg)}%）`, `縦断勾配が変移する箇所には縦断曲線を設ける。${kind} R≥${Rmin}m・曲線長 ${t.vL}m 以上`, '道路構造令 第22条');
        if (c.R < Rmin - 1e-6) add('error', '縦断曲線', `${nm}: ${kind}縦断曲線 R=${Math.round(c.R)}m が不足`, `設計速度 ${V}km/h の${kind}縦断曲線半径 ${Rmin}m 以上（必要曲線長 ${f1(Math.max(t.vL, (Rmin * dg) / 100))}m）`, '道路構造令 第22条');
        else add('ok', '縦断曲線', `${nm}: ${kind}縦断曲線 R=${Math.round(c.R)}m`, `${kind}の縦断曲線半径 ${Rmin}m 以上`, '道路構造令 第22条');
        if (c.L < t.vL - 1e-6) add('error', '縦断曲線', `${nm}: 縦断曲線長 ${f1(c.L)}m が不足`, `設計速度 ${V}km/h の縦断曲線長 ${t.vL}m 以上`, '道路構造令 第22条');
      });
      // 合成勾配（平面曲線区間の片勾配と縦断勾配）
      if (extra.vplan.comb) for (const cb of extra.vplan.comb) {
        if (cb.value > t.comb + 1e-9) add('error', '合成勾配', `IP${cb.ip}: 合成勾配 ${f1(cb.value)}% が上限超過`, `√(縦断勾配² + 片勾配²) ≤ ${t.comb}%（縦断 ${f1(cb.grade)}%・片勾配 ${f1(cb.e)}%）`, '道路構造令 第25条', cb.ip);
        else add('ok', '合成勾配', `IP${cb.ip}: 合成勾配 ${f1(cb.value)}%`, `${t.comb}% 以下（縦断 ${f1(cb.grade)}%・片勾配 ${f1(cb.e)}%）`, '道路構造令 第25条', cb.ip);
      }
      const ex = extra.vplan;
      if (ex.cut || ex.fill) add('info', '切土・盛土', `最大切土 ${f2(ex.cut ? ex.cut.d : 0)}m ／ 最大盛土 ${f2(ex.fill ? ex.fill.d : 0)}m`, `${ex.cut ? `切土は ${sta(ex.cut.s)} 付近` : ''}${ex.cut && ex.fill ? '、' : ''}${ex.fill ? `盛土は ${sta(ex.fill.s)} 付近` : ''}。現況地盤（地理院 DEM）との差`, '参考');
      [['start', '起点'], ['end', '終点']].forEach(([k, label]) => {
        const d = ex.ends && ex.ends[k];
        if (d == null) return;
        if (Math.abs(d) > 0.3) add('warn', '縦断線形', `${label}: 接続先の地盤高と ${f2(Math.abs(d))}m の高低差`, `計画高が現況地盤より ${d > 0 ? '高い' : '低い'}。接続部は既存道路の路面高に合わせる（すり付け）`, '接続条件');
        else add('ok', '縦断線形', `${label}: 接続先の地盤高とほぼ一致（差 ${f2(Math.abs(d))}m）`, '既存道路の路面高にすり付け', '接続条件');
      });
    }
    if (extra.profile && extra.profile.maxGrade != null) {
      const g = extra.profile.maxGrade, lim = road.shitei ? Math.min(12, t.grade) : t.grade;
      if (vp) add('info', '縦断勾配', `現況地盤の最大勾配 ${f1(g)}%（参考）`, `測点 ${f1(extra.profile.maxAt)}m 付近。照査は計画縦断で行っています`, '道路構造令 第20条');
      else if (g <= lim) add('ok', '縦断勾配', `現況地盤の最大勾配 ${f1(g)}%`, `縦断勾配の規定値 ${lim}% 以下`, '道路構造令 第20条');
      else add('warn', '縦断勾配', `現況地盤の最大勾配 ${f1(g)}% が規定値 ${lim}% を超過`, `測点 ${f1(extra.profile.maxAt)}m 付近。切土・盛土による縦断計画が必要（特例値は条文参照）`, '道路構造令 第20条');
      if (!vp && road.shitei && g > 12) add('warn', '位置指定道路', '縦断勾配 12% 超の区間あり', '縦断勾配は 12% 以下、かつ階段状でないこと', '建築基準法施行令 第144条の4');
    }
    return out;
  }

  const Rules = { T, SPEEDS, CLASSES, check, curveSpeed, recommend, recommendL, emaxOf, carriage, totalWidth, foldAngle };
  if (typeof module !== 'undefined' && module.exports) module.exports = Rules;
  else root.Rules = Rules;
})(typeof self !== 'undefined' ? self : this);
