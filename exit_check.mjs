// 退出規則（逃げ時）の成績計測（設計_次期改良v3.md §3・単体実行専用。CIには入れない）
//   exit_defs.mjs の固定6規則を全期間でシミュレーションし、「大きな下落を避けられたか」を
//   データで決める。採用基準（事前固定）は設計書§3(E-5)を参照。
//   このスクリプトは重みや表示を変更しない（変更はデータで採否が決まってから別途）。
//
//   使い方:  node exit_check.mjs
//   出力:    テーブル表示 ＋ signals/exit_stats.json
import fs from "node:fs";
import { analyze, buildSeries, tfSeries } from "./src/analysis.generated.mjs";
import { buildMarketIndex, classifyRegimes, loadMarketGroups } from "./evaluate.mjs";
import { hasF } from "./combo_defs.mjs";
import { RULES, simulateStates } from "./exit_defs.mjs";

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

const t0 = Date.now();
console.log(`=== 退出規則の成績（全期間×${groups.size}銘柄をリプレイ） ===\n`);

// --- 1. 全銘柄×全日の「トレンド因子が下向きか」「60日終値安値を更新したか」を集計 ---
// MIN_STOCKS: 集計に使う最低銘柄数（新規上場等で母数が薄い日の比率を信頼しない）
const MIN_STOCKS = 100;
const perDate = new Map(); // date -> {trendDown, trendTotal, newLow, newLowTotal}
const bump = (date) => {
  if (!perDate.has(date)) perDate.set(date, { trendDown: 0, trendTotal: 0, newLow: 0, newLowTotal: 0 });
  return perDate.get(date);
};

let gi = 0;
const progressEvery = Math.max(1, Math.floor(groups.size / 10));
for (const [, bars] of groups) {
  gi++;
  const L = bars.length;
  const closes = bars.map((b) => b.close);
  for (let i = 59; i < L; i++) {
    const rec = bump(bars[i].date);
    rec.newLowTotal++;
    let isLow = true;
    for (let k = i - 59; k < i; k++) { if (closes[k] < closes[i]) { isLow = false; break; } }
    if (isLow) rec.newLow++;
    if (i >= 80) {
      const a = analyze(buildSeries(tfSeries(bars.slice(0, i + 1), "D")), "日");
      rec.trendTotal++;
      if (hasF(a, "トレンド", -1)) rec.trendDown++;
    }
  }
  if (gi % progressEvery === 0) {
    console.log(`  進捗 ${Math.round((gi / groups.size) * 100)}%（${gi}/${groups.size}銘柄・${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  }
}

// --- 2. 指数・レジーム・VIXを日次集計値に合成（先頭260営業日はウォームアップ扱い＝全規則未整備） ---
const idx = buildMarketIndex(groups);              // [{date,value,sma25,slope}]
const regimes = classifyRegimes(groups);           // Map(date -> "up"/"down"/"range")

const marketGroups = loadMarketGroups();
const vixBars = marketGroups ? marketGroups.get("VIX恐怖指数") : null;
let vp = 0;                                        // 両方日付昇順なので前進ポインタでas-of結合
const vixOf = (date) => {
  if (!vixBars) return null;
  while (vp + 1 < vixBars.length && vixBars[vp + 1].date <= date) vp++;
  return vixBars[vp] && vixBars[vp].date <= date ? vixBars[vp].close : null;
};

const WARMUP = 260;                                // 250日高値とSMA25の成立待ち（設計書§3）
const L = idx.length;
const metrics = new Array(L);
let belowRun = 0, aboveRun = 0;
const newLowRatios = [];
for (let i = 0; i < L; i++) {
  const p = idx[i];
  if (p.sma25 != null) {
    if (p.value < p.sma25) { belowRun++; aboveRun = 0; }
    else if (p.value > p.sma25) { aboveRun++; belowRun = 0; }
    else { belowRun = 0; aboveRun = 0; }
  } else { belowRun = 0; aboveRun = 0; }

  const rec = perDate.get(p.date);
  const breadthDownPct = rec && rec.trendTotal >= MIN_STOCKS ? rec.trendDown / rec.trendTotal : null;
  const newLowRatio = rec && rec.newLowTotal >= MIN_STOCKS ? rec.newLow / rec.newLowTotal : null;
  newLowRatios.push(newLowRatio);
  let newLowPct5d = null;
  if (i >= 4) {
    const win = newLowRatios.slice(i - 4, i + 1);
    if (win.every((x) => x != null)) newLowPct5d = win.reduce((a, b) => a + b, 0) / win.length;
  }

  let runHigh250 = p.value;
  for (let k = Math.max(0, i - 249); k <= i; k++) if (idx[k].value > runHigh250) runHigh250 = idx[k].value;
  const ddPct = (runHigh250 - p.value) / runHigh250 * 100;

  const ready = i >= WARMUP;
  metrics[i] = {
    date: p.date, value: p.value,
    regime: ready ? (regimes.get(p.date) || null) : null,
    belowRun: ready ? belowRun : null,
    aboveRun: ready ? aboveRun : null,
    breadthDownPct: ready ? breadthDownPct : null,
    newLowPct5d: ready ? newLowPct5d : null,
    ddPct: ready ? ddPct : null,
    vix: ready ? vixOf(p.date) : null,
  };
}
console.log(`\n集計完了（${((Date.now() - t0) / 1000).toFixed(0)}秒）。全${L}営業日・規則${RULES.length}件を評価します。\n`);

// --- 3. 主要下落局面の検出（E-1）: ランニング最高値の更新で区間を締め、区間内最安値をトラフとする ---
function findEpisodes(idxArr, minDepth) {
  const out = [];
  let peakI = 0, troughI = 0;
  for (let i = 1; i < idxArr.length; i++) {
    if (idxArr[i].value > idxArr[peakI].value) {
      if (troughI !== peakI) {
        const depth = (idxArr[peakI].value - idxArr[troughI].value) / idxArr[peakI].value;
        if (depth >= minDepth) out.push({ peakI, troughI, depth, ongoing: false });
      }
      peakI = i; troughI = i;
    } else if (idxArr[i].value < idxArr[troughI].value) {
      troughI = i;
    }
  }
  if (troughI !== peakI) {
    const depth = (idxArr[peakI].value - idxArr[troughI].value) / idxArr[peakI].value;
    if (depth >= minDepth) out.push({ peakI, troughI, depth, ongoing: true });
  }
  return out;
}
const episodesAll = findEpisodes(idx, 0.07);
const majorEpisodes = episodesAll.filter((e) => e.depth >= 0.10);

console.log(`■ 下落局面（参考7%以上を含む・${idx[0].date}〜${idx.at(-1).date}）`);
for (const e of episodesAll) {
  const tag = e.depth >= 0.10 ? "主要" : "参考";
  console.log(`  ${tag} ${idx[e.peakI].date} → ${idx[e.troughI].date}（深さ${(e.depth * 100).toFixed(1)}%・${e.troughI - e.peakI}営業日）${e.ongoing ? "（末尾・回復未了）" : ""}`);
}
if (majorEpisodes.length === 0 || majorEpisodes.length > 10) {
  console.log(`\n⚠ 主要局面(>=10%)が${majorEpisodes.length}件。想定(3〜5件)から外れています。定義かデータを確認してください。`);
}

// --- 4. 規則ごとの評価（局面捕捉 + 全期間in/outシミュレーション。E-3） ---
function evalRule(rule) {
  const states = simulateStates(rule, metrics);           // "in"/"out" 配列（全期間）
  const readyFromI = metrics.findIndex((m) => rule.ready(m));

  const captures = majorEpisodes.map((e) => {
    let signalI = null;
    for (let i = e.peakI + 1; i <= e.troughI; i++) {
      if (states[i] === "out" && states[i - 1] === "in") { signalI = i; break; }
    }
    if (signalI == null) return { peak: idx[e.peakI].date, trough: idx[e.troughI].date, captured: false };
    const peakV = idx[e.peakI].value, troughV = idx[e.troughI].value, sigV = idx[signalI].value;
    return {
      peak: idx[e.peakI].date, trough: idx[e.troughI].date, captured: true,
      signalDate: idx[signalI].date, lagDays: signalI - e.peakI,
      capturePct: (sigV - troughV) / (peakV - troughV),
    };
  });
  const capturedAll = captures.length > 0 && captures.every((c) => c.captured);
  const captureVals = captures.filter((c) => c.captured).map((c) => c.capturePct);
  const captureAvg = captureVals.length ? captureVals.reduce((a, b) => a + b, 0) / captureVals.length : null;
  const captureMin = captureVals.length ? Math.min(...captureVals) : null;

  let ruleEq = 1, bhEq = 1, ruleMaxEq = 1, ruleMaxDD = 0, bhMaxEq = 1, bhMaxDD = 0;
  let roundTrips = 0, fakeouts = 0, fakeoutLossSum = 0, daysIn = 0, daysTotal = 0;
  let exitValue = null;
  const start = readyFromI < 0 ? L : readyFromI;
  for (let i = Math.max(start, 1); i < L - 1; i++) {
    const ret = idx[i + 1].value / idx[i].value - 1;
    bhEq *= 1 + ret;
    if (states[i] === "in") { ruleEq *= 1 + ret; daysIn++; }
    daysTotal++;
    ruleMaxEq = Math.max(ruleMaxEq, ruleEq);
    ruleMaxDD = Math.max(ruleMaxDD, (ruleMaxEq - ruleEq) / ruleMaxEq);
    bhMaxEq = Math.max(bhMaxEq, bhEq);
    bhMaxDD = Math.max(bhMaxDD, (bhMaxEq - bhEq) / bhMaxEq);
    if (states[i] === "out" && states[i - 1] === "in") exitValue = idx[i].value;
    if (states[i] === "in" && states[i - 1] === "out") {
      roundTrips++;
      if (exitValue != null && idx[i].value > exitValue) {
        fakeouts++;
        fakeoutLossSum += (idx[i].value - exitValue) / exitValue;
      }
    }
  }
  const years = start < L ? (L - start) / 252 : 0;

  return {
    key: rule.key, label: rule.label, ref: rule.ref,
    capturedAll, captureAvg, captureMin, captures,
    ruleReturn: ruleEq - 1, bhReturn: bhEq - 1, ruleMaxDD, bhMaxDD,
    roundTrips, tripsPerYear: years > 0 ? roundTrips / years : null, fakeouts,
    fakeoutAvgLoss: fakeouts ? fakeoutLossSum / fakeouts : null,
    marketPresence: daysTotal ? daysIn / daysTotal : null,
    readyFrom: readyFromI >= 0 ? metrics[readyFromI].date : null,
    currentState: states.at(-1),
  };
}
const results = RULES.map(evalRule);

// E-5: 採用基準（事前固定・参考規則は対象外）
const adopted = (r) => !r.ref && r.capturedAll &&
  r.captureAvg != null && r.captureAvg >= 0.5 &&
  r.captureMin != null && r.captureMin >= 0.3 &&
  r.ruleMaxDD <= r.bhMaxDD * 0.7 &&
  r.ruleReturn >= r.bhReturn * 0.7 &&
  r.tripsPerYear != null && r.tripsPerYear <= 4;

// --- 5. 表示 ---
const pct = (x, d = 1) => (x == null ? "  -  " : `${(x * 100).toFixed(d)}%`);
const pctSigned = (x, d = 1) => (x == null ? "  -  " : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);

console.log(`\n■ 規則別成績（局面捕捉率の平均 降順・採用基準は設計書§3(E-5)）`);
const sorted = [...results].sort((a, b) => (b.captureAvg ?? -Infinity) - (a.captureAvg ?? -Infinity));
for (const r of sorted) {
  const mark = r.ref ? "　参考" : adopted(r) ? "⭐採用" : "　見送り";
  console.log(`${mark} ${r.label}`);
  console.log(`        局面捕捉: 全件点灯=${r.capturedAll ? "○" : "×"} 平均${pct(r.captureAvg)} 最悪${pct(r.captureMin)}`);
  console.log(`        シミュレーション(${r.readyFrom || "-"}〜): リターン${pctSigned(r.ruleReturn)}(B&H比${pctSigned(r.bhReturn)}) maxDD${pct(r.ruleMaxDD)}(B&H比${pct(r.bhMaxDD)}) 滞在率${pct(r.marketPresence)}`);
  console.log(`        ラウンドトリップ${r.roundTrips}回(年${r.tripsPerYear != null ? r.tripsPerYear.toFixed(1) : "-"}回) うちダマシ${r.fakeouts}回(平均損失${pct(r.fakeoutAvgLoss)}) 現在=${r.currentState}`);
}

console.log(`\n■ 主要下落局面ごとの点灯状況`);
for (const r of results) {
  if (r.ref) continue;
  console.log(`  ${r.label}:`);
  for (const c of r.captures) {
    console.log(`    ${c.peak}→${c.trough}: ${c.captured ? `点灯${c.signalDate}(遅れ${c.lagDays}日・捕捉${pct(c.capturePct)})` : "捕捉失敗（点灯なし）"}`);
  }
}

const outDir = new URL("./signals/", ROOT);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(new URL("./exit_stats.json", outDir), JSON.stringify({
  generated: idx.at(-1).date, days: L, stocks: groups.size,
  episodesAll: episodesAll.map((e) => ({ peak: idx[e.peakI].date, trough: idx[e.troughI].date, depth: e.depth, major: e.depth >= 0.10, ongoing: !!e.ongoing })),
  criteria: "captureAll && avg>=50% && min>=30% && maxDD<=0.7*BH && return>=0.7*BH && trips<=4/yr",
  rules: Object.fromEntries(results.map((r) => [r.key, { ...r, adopted: adopted(r) }])),
}, null, 1));
console.log(`\n保存: signals/exit_stats.json ／ 実行時間 ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
