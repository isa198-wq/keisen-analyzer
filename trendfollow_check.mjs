// 短期トレンドフォロー複合サインの検証（単体実行専用。CIには入れない）
//   提案: 移動平均GC/DC(3/9/20日) × BB2σブレイク × 短期MACD/RSI/ストキャ × 日柄 を
//   トレンドフォロー要素として組み合わせたサインに優位性があるか。
//   流儀は 設計_次期改良v2.md §4 に従う: 候補は手で列挙・基準は事前固定・結果を見ての後出し変更禁止。
//   採用基準（事前固定・combo_check.mjs と同一）: edge(10日) >= +1.0% かつ n >= 300 かつ 20日edge > 0
//   さらに頑健性の目安として期間前半/後半それぞれの edge(10日) も併記する（両方正でなければ疑う）。
//
//   指標の定義（事前固定）:
//     SMA 3/9/20。GC/DC は「当日クロス発生」のイベント。
//     トレンドフィルタ: 終値>SMA20 かつ SMA20の5日傾き>0（売りは鏡像）。
//     BB: 20日±2σ。順張り解釈＝+2σ上抜け（当日）をブレイク買い（売りは−2σ下抜け）。
//     MACD: EMA10−EMA20、シグナルEMA9（「20日程度の短め」解釈）。順張り読み: MACD>シグナル。
//     RSI: 14日Wilder。順張り読み: >50 が強気。
//     ストキャ: Slow(14,3,3)。順張り読み: %K>%D が強気。
//     日柄: SMA20の傾きが上向きに転じてからの連続日数 <= 10（トレンド初期のみ乗る）。
//
//   使い方:  node trendfollow_check.mjs [--days N]   （既定: 全期間）
import fs from "node:fs";

const ROOT = new URL(".", import.meta.url);
const DATA = new URL("./screening_data.csv", ROOT);
if (!fs.existsSync(DATA)) {
  console.error("screening_data.csv が見つかりません。先に fetch_data.py を実行してください。");
  process.exit(1);
}

const groups = new Map();
for (const line of fs.readFileSync(DATA, "utf8").split(/\r?\n/).slice(1)) {
  const c = line.split(",");
  if (c.length < 6) continue;
  const sym = c[0];
  if (!sym || sym === "銘柄") continue;
  if (!groups.has(sym)) groups.set(sym, []);
  groups.get(sym).push({ date: c[1], open: +c[2], high: +c[3], low: +c[4], close: +c[5], volume: +c[6] });
}

const di = process.argv.indexOf("--days");
const DAYS = di >= 0 ? +process.argv[di + 1] || Infinity : Infinity;
const HORIZONS = [5, 10, 20];
const WARMUP = 60;

// --- 指標計算（配列一括） ---
const smaArr = (v, p) => {
  const out = new Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= p) s -= v[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
};
const emaArr = (v, p) => {
  const out = new Array(v.length).fill(null);
  const k = 2 / (p + 1);
  let e = null;
  for (let i = 0; i < v.length; i++) {
    e = e == null ? v[i] : v[i] * k + e * (1 - k);
    if (i >= p - 1) out[i] = e;
  }
  return out;
};
const rsiArr = (closes, p = 14) => {
  const out = new Array(closes.length).fill(null);
  let au = 0, ad = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const u = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= p) {
      au += u; ad += dn;
      if (i === p) { au /= p; ad /= p; out[i] = 100 - 100 / (1 + (ad === 0 ? 1e9 : au / ad)); }
    } else {
      au = (au * (p - 1) + u) / p;
      ad = (ad * (p - 1) + dn) / p;
      out[i] = 100 - 100 / (1 + (ad === 0 ? 1e9 : au / ad));
    }
  }
  return out;
};
const stochArr = (bars, kp = 14, ks = 3, dp = 3) => {
  const n = bars.length;
  const raw = new Array(n).fill(null);
  for (let i = kp - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kp + 1; j <= i; j++) { hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low); }
    raw[i] = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
  }
  const smaOf = (arr, p) => {
    const out = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) continue;
      let s = 0, c = 0;
      for (let j = i; j > i - p && j >= 0; j--) { if (arr[j] == null) { c = -1; break; } s += arr[j]; c++; }
      if (c === p) out[i] = s / p;
    }
    return out;
  };
  const slowK = smaOf(raw, ks);
  const slowD = smaOf(slowK, dp);
  return { slowK, slowD };
};
const stdevArr = (closes, p = 20) => {
  const out = new Array(closes.length).fill(null);
  for (let i = p - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += closes[j];
    const m = s / p;
    let v = 0;
    for (let j = i - p + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    out[i] = Math.sqrt(v / p);
  }
  return out;
};

// --- 銘柄ごとに指標と「当日状態」を前計算 ---
const prep = (bars) => {
  const closes = bars.map((b) => b.close);
  const s3 = smaArr(closes, 3), s9 = smaArr(closes, 9), s20 = smaArr(closes, 20);
  const e10 = emaArr(closes, 10), e20 = emaArr(closes, 20);
  const macd = closes.map((_, i) => (e10[i] != null && e20[i] != null ? e10[i] - e20[i] : null));
  // シグナル: macd が出そろってから EMA9
  const firstM = macd.findIndex((x) => x != null);
  const sigTail = emaArr(macd.slice(firstM), 9);
  const sig = new Array(closes.length).fill(null);
  for (let i = 0; i < sigTail.length; i++) sig[firstM + i] = sigTail[i];
  const rsi = rsiArr(closes, 14);
  const { slowK, slowD } = stochArr(bars, 14, 3, 3);
  const sd = stdevArr(closes, 20);
  const bbUp = closes.map((_, i) => (s20[i] != null && sd[i] != null ? s20[i] + 2 * sd[i] : null));
  const bbDn = closes.map((_, i) => (s20[i] != null && sd[i] != null ? s20[i] - 2 * sd[i] : null));
  // SMA20 の5日傾きと、その向きが続いている日柄
  const slope = closes.map((_, i) => (s20[i] != null && s20[i - 5] != null ? s20[i] - s20[i - 5] : null));
  const ageUp = new Array(closes.length).fill(0);
  const ageDn = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    ageUp[i] = slope[i] != null && slope[i] > 0 ? ageUp[i - 1] + 1 : 0;
    ageDn[i] = slope[i] != null && slope[i] < 0 ? ageDn[i - 1] + 1 : 0;
  }
  const crossUp = (a, b, i) => a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
  const crossDn = (a, b, i) => a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];
  const closeArr = closes;
  return {
    state(i) {
      if (i < WARMUP) return null;
      const c = closeArr[i];
      if ([s3[i], s9[i], s20[i], macd[i], sig[i], rsi[i], slowK[i], slowD[i], bbUp[i], bbDn[i], slope[i]].some((x) => x == null)) return null;
      return {
        gc39: crossUp(s3, s9, i), dc39: crossDn(s3, s9, i),
        gc920: crossUp(s9, s20, i), dc920: crossDn(s9, s20, i),
        upTrend: c > s20[i] && slope[i] > 0,
        dnTrend: c < s20[i] && slope[i] < 0,
        bbBreakUp: closeArr[i - 1] <= bbUp[i - 1] && c > bbUp[i],
        bbBreakDn: closeArr[i - 1] >= bbDn[i - 1] && c < bbDn[i],
        aboveMid: c > s20[i], belowMid: c < s20[i],
        macdBull: macd[i] > sig[i], macdBear: macd[i] < sig[i],
        rsiBull: rsi[i] > 50, rsiBear: rsi[i] < 50,
        stBull: slowK[i] > slowD[i], stBear: slowK[i] < slowD[i],
        youngUp: ageUp[i] >= 1 && ageUp[i] <= 10,
        youngDn: ageDn[i] >= 1 && ageDn[i] <= 10,
      };
    },
  };
};

// オシレーター確認数
const oscBull = (s) => (s.macdBull ? 1 : 0) + (s.rsiBull ? 1 : 0) + (s.stBull ? 1 : 0);
const oscBear = (s) => (s.macdBear ? 1 : 0) + (s.rsiBear ? 1 : 0) + (s.stBear ? 1 : 0);

// --- 検証コンボ（手で列挙・事前固定） ---
const COMBOS = [
  { key: "B1", dir: +1, label: "買: GC(3×9)のみ",                              test: (s) => s.gc39 },
  { key: "B2", dir: +1, label: "買: GC(3×9)×トレンド(>20MA上向き)",             test: (s) => s.gc39 && s.upTrend },
  { key: "B3", dir: +1, label: "買: GC(9×20)×終値>20MA",                        test: (s) => s.gc920 && s.aboveMid },
  { key: "B4", dir: +1, label: "買: B2×オシレーター全確認(MACD/RSI/スト)",       test: (s) => s.gc39 && s.upTrend && oscBull(s) === 3 },
  { key: "B5", dir: +1, label: "買: B2×オシレーター2/3確認",                    test: (s) => s.gc39 && s.upTrend && oscBull(s) >= 2 },
  { key: "B6", dir: +1, label: "買: BB+2σ上抜け×20MA上向き",                    test: (s) => s.bbBreakUp && s.upTrend },
  { key: "B7", dir: +1, label: "買: B5×日柄(トレンド10日以内)",                 test: (s) => s.gc39 && s.upTrend && oscBull(s) >= 2 && s.youngUp },
  { key: "B8", dir: +1, label: "買: B5×BB(終値>ミッド)",                        test: (s) => s.gc39 && s.upTrend && oscBull(s) >= 2 && s.aboveMid },
  { key: "S1", dir: -1, label: "売: DC(3×9)のみ",                              test: (s) => s.dc39 },
  { key: "S2", dir: -1, label: "売: DC(3×9)×トレンド(<20MA下向き)",             test: (s) => s.dc39 && s.dnTrend },
  { key: "S3", dir: -1, label: "売: DC(9×20)×終値<20MA",                        test: (s) => s.dc920 && s.belowMid },
  { key: "S4", dir: -1, label: "売: S2×オシレーター全確認",                     test: (s) => s.dc39 && s.dnTrend && oscBear(s) === 3 },
  { key: "S5", dir: -1, label: "売: S2×オシレーター2/3確認",                    test: (s) => s.dc39 && s.dnTrend && oscBear(s) >= 2 },
  { key: "S6", dir: -1, label: "売: BB−2σ下抜け×20MA下向き",                    test: (s) => s.bbBreakDn && s.dnTrend },
  { key: "S7", dir: -1, label: "売: S5×日柄(トレンド10日以内)",                 test: (s) => s.dc39 && s.dnTrend && oscBear(s) >= 2 && s.youngDn },
];

// --- ベースライン: 日付×ホライズンごとの全銘柄平均フォワードリターン ---
const baseAgg = new Map(); // date|h -> {s,n}
for (const [, bars] of groups) {
  const L = bars.length;
  const start = Math.max(WARMUP, L - (Number.isFinite(DAYS) ? DAYS : L));
  for (let i = start; i < L; i++) {
    for (const h of HORIZONS) {
      if (i + h >= L) continue;
      const key = bars[i].date + "|" + h;
      let a = baseAgg.get(key);
      if (!a) { a = { s: 0, n: 0 }; baseAgg.set(key, a); }
      a.s += bars[i + h].close / bars[i].close - 1;
      a.n++;
    }
  }
}
const baseline = (date, h) => {
  const a = baseAgg.get(date + "|" + h);
  return a && a.n ? a.s / a.n : null;
};

// 期間を前半/後半に割る境界日（全日付の中央値）
const allDates = [...new Set([...baseAgg.keys()].map((k) => k.split("|")[0]))].sort();
const SPLIT = allDates[Math.floor(allDates.length / 2)];

// --- 集計 ---
const newH = () => ({ n: 0, sum: 0, win: 0, edgeSum: 0, edgeN: 0, edgeSumA: 0, edgeNA: 0, edgeSumB: 0, edgeNB: 0 });
const stats = Object.fromEntries(COMBOS.map((c) => [c.key, { n: 0, perH: Object.fromEntries(HORIZONS.map((h) => [h, newH()])) }]));

let cells = 0;
const t0 = Date.now();
for (const [, bars] of groups) {
  const L = bars.length;
  if (L < WARMUP + 25) continue;
  const p = prep(bars);
  const start = Math.max(WARMUP, L - (Number.isFinite(DAYS) ? DAYS : L));
  for (let i = start; i < L; i++) {
    const s = p.state(i);
    if (!s) continue;
    cells++;
    const date = bars[i].date;
    for (const combo of COMBOS) {
      if (!combo.test(s)) continue;
      const st = stats[combo.key];
      st.n++;
      for (const h of HORIZONS) {
        if (i + h >= L) continue;
        const ret = bars[i + h].close / bars[i].close - 1;
        const aligned = combo.dir * ret;
        const b = baseline(date, h);
        const cell = st.perH[h];
        cell.n++; cell.sum += aligned;
        if (aligned > 0) cell.win++;
        if (b != null) {
          const e = aligned - combo.dir * b;
          cell.edgeSum += e; cell.edgeN++;
          if (date < SPLIT) { cell.edgeSumA += e; cell.edgeNA++; } else { cell.edgeSumB += e; cell.edgeNB++; }
        }
      }
    }
  }
}

const pct = (x, d = 2) => (x == null ? "   -  " : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const edgeOf = (c) => (c.edgeN ? c.edgeSum / c.edgeN : null);

console.log(`=== 短期トレンドフォロー複合サイン検証（3/9/20MA・BB2σ・短期MACD/RSI/スト・日柄） ===`);
console.log(`対象 ${groups.size} 銘柄 ／ 判定セル ${cells} ／ 期間 ${allDates[0]}〜${allDates.at(-1)}（前後半境界 ${SPLIT}）`);
console.log(`edge = 方向調整済みリターン − 方向調整済み市場平均。採用基準(事前固定): edge(10日)>=+1.0% かつ n>=300 かつ 20日edge>0\n`);

const rows = COMBOS.map((c) => {
  const st = stats[c.key];
  return {
    ...c, n: st.n,
    edge: Object.fromEntries(HORIZONS.map((h) => [h, edgeOf(st.perH[h])])),
    win10: st.perH[10].n ? st.perH[10].win / st.perH[10].n : null,
    e10A: st.perH[10].edgeNA ? st.perH[10].edgeSumA / st.perH[10].edgeNA : null,
    e10B: st.perH[10].edgeNB ? st.perH[10].edgeSumB / st.perH[10].edgeNB : null,
  };
}).sort((a, b) => (b.edge[10] ?? -Infinity) - (a.edge[10] ?? -Infinity));

for (const r of rows) {
  const adopted = r.edge[10] != null && r.edge[10] >= 0.01 && r.n >= 300 && r.edge[20] != null && r.edge[20] > 0;
  const robust = r.e10A != null && r.e10B != null && r.e10A > 0 && r.e10B > 0;
  console.log(`${adopted ? "⭐採用" : "　見送り"} ${r.label}`);
  console.log(`        n=${String(r.n).padStart(6)}  edge: ${HORIZONS.map((h) => `${h}日${pct(r.edge[h])}`).join(" ")}  勝率${r.win10 != null ? (r.win10 * 100).toFixed(0) : "-"}%(10日)`);
  console.log(`        └ 頑健性: 前半edge10 ${pct(r.e10A)} ／ 後半edge10 ${pct(r.e10B)} ${robust ? "（両方正）" : "（片側または両側マイナス→再現性疑い）"}`);
}

const outDir = new URL("./signals/", ROOT);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(new URL("./trendfollow_stats.json", outDir), JSON.stringify({
  generated: allDates.at(-1), split: SPLIT, stocks: groups.size, cells,
  criteria: "edge10>=+1.0% && n>=300 && edge20>0",
  combos: Object.fromEntries(rows.map((r) => [r.key, {
    label: r.label, dir: r.dir, n: r.n,
    edge: r.edge, win10: r.win10, edge10FirstHalf: r.e10A, edge10SecondHalf: r.e10B,
    adopted: !!(r.edge[10] != null && r.edge[10] >= 0.01 && r.n >= 300 && r.edge[20] != null && r.edge[20] > 0),
  }])),
}, null, 1));
console.log(`\n保存: signals/trendfollow_stats.json ／ 実行時間 ${((Date.now() - t0) / 1000).toFixed(1)}秒`);
console.log(`注: コンボを${COMBOS.length}本並べているため、偶然どれかが基準を超える多重比較リスクあり。採用は「基準クリア＋前後半とも正」を必須とすること。`);
