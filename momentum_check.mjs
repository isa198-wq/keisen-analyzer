// イナゴ戦略の検証（設計_次期改良v4.md §3・単体実行専用。CIには入れない）
//   G-1: クロスセクショナル・モメンタム（K=20/60・上位10・5営業日リバランス）
//   G-2: 出来高急増フォロー（volHigh=出来高3倍×60日高値 / volJump=出来高3倍×当日+5%）
//   G-3: 退出規則の比較（fixed10/trail5/stop7、G-2のイベントを再利用）
//   全てt+1終値執行・往復コスト0.2%控除後で判定（当日終値執行は参考値のみ）。
//   採用基準（事前固定）は設計_次期改良v4.md §3 を参照。analyze()は使わない（終値・出来高のみ）。
//
//   使い方: node momentum_check.mjs
//   出力:   テーブル表示 ＋ signals/momentum_stats.json
import fs from "node:fs";
import { buildByCode, buildDateGrid, buildMarketIndex, classifyRegimes } from "./evaluate.mjs";

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
const COST = 0.002; // 往復コスト（片道0.1%・事前固定）

// 共通日付グリッドと本数が一致する銘柄だけを使う（seedHistoryと同じ安全策）
const GRID = buildDateGrid(groups);
const L = GRID.length;
const used = new Map();
for (const [sym, bars] of groups) if (bars.length === L) used.set(sym, bars);
console.log(`=== イナゴ戦略の検証（共通日付グリッド ${L}営業日・使用銘柄 ${used.size}/${groups.size}） ===\n`);

const byCode = buildByCode(used);           // code -> {closes, idx: Map(date->i)}
const mktIdx = buildMarketIndex(used);      // 等ウェイト指数
const regimes = classifyRegimes(used);
const bhRetByDate = new Map();
for (let i = 1; i < mktIdx.length; i++) bhRetByDate.set(mktIdx[i].date, mktIdx[i].value / mktIdx[i - 1].value - 1);

const pct = (x, d = 2) => (x == null ? "  -  " : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

// ============================================================
// G-1: クロスセクショナル・モメンタム
// ============================================================
function topKBasket(i, K) {
  const date = GRID[i], kDate = GRID[i - K];
  const rets = [];
  for (const [code, v] of byCode) {
    const i0 = v.idx.get(kDate), i1 = v.idx.get(date);
    if (i0 == null || i1 == null) continue;
    rets.push({ code, ret: v.closes[i1] / v.closes[i0] - 1 });
  }
  rets.sort((a, b) => b.ret - a.ret);
  return rets.slice(0, 10).map((r) => r.code);
}

// 252営業日窓ごとに「本戦略の累積リターン(log) > B&Hの累積リターン(log)」の割合を返す
function rollingPositiveShare(dailyRets, window = 252) {
  if (dailyRets.length < window) return null;
  const prefixPort = [0], prefixBh = [0];
  for (const d of dailyRets) {
    prefixPort.push(prefixPort.at(-1) + Math.log(1 + d.port));
    prefixBh.push(prefixBh.at(-1) + Math.log(1 + d.bh));
  }
  let pos = 0, total = 0;
  for (let s = 0; s + window <= dailyRets.length; s++) {
    total++;
    if (prefixPort[s + window] - prefixPort[s] > prefixBh[s + window] - prefixBh[s]) pos++;
  }
  return total ? pos / total : null;
}

// v3で確定した主要下落局面（設計_次期改良v3.md §7）。モメンタム・クラッシュの確認用。
const CRASH_EPISODES = [
  { peak: "2021-09-14", trough: "2022-03-09" },
  { peak: "2024-07-17", trough: "2024-08-05" },
  { peak: "2025-03-26", trough: "2025-04-07" },
  { peak: "2026-02-27", trough: "2026-03-23" },
];

function episodeReturns(dailyRets) {
  const byDate = new Map(dailyRets.map((d) => [d.date, d]));
  const gi = new Map(GRID.map((d, i) => [d, i]));
  return CRASH_EPISODES.map((e) => {
    const peakI = gi.get(e.peak), troughI = gi.get(e.trough);
    if (peakI == null || troughI == null) return { ...e, covered: false };
    const startI = Math.max(0, peakI - 20), endI = Math.min(L - 1, troughI + 20);
    let portSum = 0, bhSum = 0, covered = 0, total = 0;
    for (let i = startI + 1; i <= endI; i++) {
      total++;
      const d = byDate.get(GRID[i]);
      if (!d) continue;
      covered++;
      portSum += Math.log(1 + d.port);
      bhSum += Math.log(1 + d.bh);
    }
    return {
      ...e, covered: covered > 0, coverage: `${covered}/${total}`,
      portReturn: covered ? Math.exp(portSum) - 1 : null,
      bhReturn: covered ? Math.exp(bhSum) - 1 : null,
    };
  });
}

function simulateMomentum(K) {
  const warmup = K + 10;
  const rebalanceIdxs = [];
  for (let i = warmup; i < L; i += 5) rebalanceIdxs.push(i);

  let equity = 1, maxEq = 1, maxDD = 0;
  let prevBasket = null;
  let totalCost = 0, rebalances = 0;
  const dailyRets = [];

  for (let r = 0; r < rebalanceIdxs.length; r++) {
    const i = rebalanceIdxs[r];
    const entryI = i + 1;
    if (entryI >= L) break;
    const basket = topKBasket(i, K);
    const added = prevBasket ? basket.filter((c) => !prevBasket.includes(c)).length : basket.length;
    const cost = (added / 10) * COST;
    equity *= 1 - cost;
    totalCost += cost;
    rebalances++;

    const nextI = rebalanceIdxs[r + 1];
    const holdEndI = nextI != null ? Math.min(nextI + 1, L - 1) : L - 1;
    for (let d = entryI + 1; d <= holdEndI; d++) {
      const date0 = GRID[d - 1], date1 = GRID[d];
      let s = 0, n = 0;
      for (const code of basket) {
        const v = byCode.get(code);
        const i0 = v.idx.get(date0), i1 = v.idx.get(date1);
        if (i0 == null || i1 == null) continue;
        s += v.closes[i1] / v.closes[i0] - 1; n++;
      }
      const ret = n ? s / n : 0;
      equity *= 1 + ret;
      maxEq = Math.max(maxEq, equity);
      maxDD = Math.max(maxDD, (maxEq - equity) / maxEq);
      dailyRets.push({ date: date1, port: ret, bh: bhRetByDate.get(date1) ?? 0 });
    }
    prevBasket = basket;
  }

  if (!dailyRets.length) return null;
  let bhEq = 1, bhMaxEq = 1, bhMaxDD = 0;
  for (const d of dailyRets) {
    bhEq *= 1 + d.bh;
    bhMaxEq = Math.max(bhMaxEq, bhEq);
    bhMaxDD = Math.max(bhMaxDD, (bhMaxEq - bhEq) / bhMaxEq);
  }
  const years = dailyRets.length / 252;
  const portCAGR = Math.pow(equity, 1 / years) - 1;
  const bhCAGR = Math.pow(bhEq, 1 / years) - 1;

  return {
    K, rebalances, totalCostPct: totalCost,
    from: dailyRets[0].date, to: dailyRets.at(-1).date, years,
    portReturn: equity - 1, bhReturn: bhEq - 1,
    portCAGR, bhCAGR, excessAnnual: portCAGR - bhCAGR,
    maxDD, bhMaxDD, rollingShare: rollingPositiveShare(dailyRets),
    episodes: episodeReturns(dailyRets),
  };
}

const g1Results = [20, 60].map(simulateMomentum).filter(Boolean);
const g1Adopted = (r) => r.excessAnnual >= 0.03 && r.rollingShare != null && r.rollingShare >= 0.6 && r.maxDD <= r.bhMaxDD * 1.3;

console.log(`■ G-1 クロスセクショナル・モメンタム（上位10・5日リバランス・コスト往復${(COST * 100).toFixed(1)}%控除後）`);
for (const r of g1Results) {
  const mark = g1Adopted(r) ? "⭐採用" : "　見送り";
  console.log(`${mark} K=${r.K}（${r.from}〜${r.to}・${r.years.toFixed(1)}年・${r.rebalances}回リバランス・累計コスト${pct(r.totalCostPct)}）`);
  console.log(`        総リターン${pct(r.portReturn)}(B&H比${pct(r.bhReturn)}) 年率${pct(r.portCAGR)}(B&H${pct(r.bhCAGR)}・超過${pct(r.excessAnnual)})`);
  console.log(`        maxDD${pct(r.maxDD)}(B&H比${pct(r.bhMaxDD)}) ローリング1年窓で優位${r.rollingShare != null ? pct(r.rollingShare, 0) : "データ不足"}`);
  console.log(`        主要局面での相対成績（本戦略 / B&H）:`);
  for (const e of r.episodes) {
    console.log(`          ${e.peak}→${e.trough}: ${e.covered ? `${pct(e.portReturn)} / ${pct(e.bhReturn)}（カバー${e.coverage}日）` : "対象外（ウォームアップ前）"}`);
  }
}

// ============================================================
// G-2: 出来高急増フォロー（イベント方式）
// ============================================================
const EVENT_START = 60; // 60日高値判定に必要な最小本数（volJumpもここに合わせて統一）
const events = { volHigh: [], volJump: [] };
for (const [sym, bars] of used) {
  const ci = sym.indexOf(":");
  const code = ci >= 0 ? sym.slice(0, ci) : sym;
  const L2 = bars.length;
  let lastHighI = -Infinity, lastJumpI = -Infinity;
  for (let i = EVENT_START; i < L2; i++) {
    let volSum = 0;
    for (let k = i - 20; k < i; k++) volSum += bars[k].volume;   // 直近20日平均（当日を含まない）
    const avgVol20 = volSum / 20;
    if (!(avgVol20 > 0) || !(bars[i].volume >= avgVol20 * 3)) continue;

    const entryDate = bars[i + 1] ? bars[i + 1].date : null;
    let is60dHigh = true;
    for (let k = i - 59; k < i; k++) { if (bars[k].close > bars[i].close) { is60dHigh = false; break; } }
    if (is60dHigh && i - lastHighI >= 10) {
      events.volHigh.push({ code, date: bars[i].date, i, entryI: i + 1, entryDate });
      lastHighI = i;
    }
    const dayRet = bars[i].close / bars[i - 1].close - 1;
    if (dayRet >= 0.05 && i - lastJumpI >= 10) {
      events.volJump.push({ code, date: bars[i].date, i, entryI: i + 1, entryDate });
      lastJumpI = i;
    }
  }
}

const HORIZONS = [5, 10, 20];
const baselineCache = new Map();
function baseline(date, h) {
  const key = date + "|" + h;
  if (baselineCache.has(key)) return baselineCache.get(key);
  let s = 0, n = 0;
  for (const v of byCode.values()) {
    const i = v.idx.get(date);
    if (i == null || i + h >= v.closes.length) continue;
    s += v.closes[i + h] / v.closes[i] - 1; n++;
  }
  const r = n ? s / n : null;
  baselineCache.set(key, r);
  return r;
}

// execOffset: 0=当日終値執行（参考・理論上限） / 1=翌日終値執行（採否判定はこちらのみ）
function evalEvents(list, execOffset) {
  const byH = {};
  for (const h of HORIZONS) byH[h] = { rets: [], edges: [] };
  const byRegime = {};
  for (const e of list) {
    const v = byCode.get(e.code);
    if (!v) continue;
    const execI = e.i + execOffset;
    const execDate = execOffset === 0 ? e.date : e.entryDate;
    if (execI >= v.closes.length || !execDate) continue;
    const reg = regimes.get(e.date);
    if (reg) byRegime[reg] = (byRegime[reg] || 0) + 1;
    for (const h of HORIZONS) {
      const exitI = execI + h;
      if (exitI >= v.closes.length) continue;
      const ret = v.closes[exitI] / v.closes[execI] - 1 - COST;
      byH[h].rets.push(ret);
      const b = baseline(execDate, h);
      if (b != null) byH[h].edges.push(ret - b);
    }
  }
  const perH = {};
  for (const h of HORIZONS) {
    perH[h] = {
      n: byH[h].rets.length,
      mean: mean(byH[h].rets), median: median(byH[h].rets),
      win: byH[h].rets.length ? byH[h].rets.filter((x) => x > 0).length / byH[h].rets.length : null,
      edge: byH[h].edges.length ? mean(byH[h].edges) : null,
    };
  }
  return { n: list.length, byRegime, perH };
}

const g2Primary = evalEvents(events.volHigh, 1);
const g2Ref = evalEvents(events.volHigh, 0);
const g2VolJumpPrimary = evalEvents(events.volJump, 1);
const g2VolJumpRef = evalEvents(events.volJump, 0);

const usedEventKey = g2Primary.n >= 300 ? "volHigh" : "volJump";
const g2Main = usedEventKey === "volHigh" ? g2Primary : g2VolJumpPrimary;

const g2Adopted = g2Main.perH[10].edge != null && g2Main.perH[10].edge >= 0.01 &&
  g2Main.perH[10].n >= 300 && g2Main.perH[20].edge != null && g2Main.perH[20].edge > 0;

console.log(`\n■ G-2 出来高急増フォロー（採用基準は edge10>=+1.0% かつ n>=300 かつ edge20>0・コスト控除後）`);
function printEventBlock(label, r, ref) {
  console.log(`  ${label}: n=${r.n}`);
  for (const h of HORIZONS) {
    const p = r.perH[h], rf = ref.perH[h];
    console.log(`    ${h}日後(t+1執行): 平均${pct(p.mean)} 中央値${pct(p.median)} 勝率${p.win != null ? (p.win * 100).toFixed(0) + "%" : "-"} 対市場edge${pct(p.edge)}（参考・当日執行: 平均${pct(rf.mean)}）`);
  }
  console.log(`    レジーム別件数: 上昇${r.byRegime.up || 0} / 下落${r.byRegime.down || 0} / もみ合い${r.byRegime.range || 0}`);
}
printEventBlock("volHigh（出来高3倍×60日高値）", g2Primary, g2Ref);
printEventBlock("volJump（出来高3倍×当日+5%）", g2VolJumpPrimary, g2VolJumpRef);
console.log(`\n  ${g2Adopted ? "⭐採用" : "見送り"}: 主判定は ${usedEventKey}（n=${g2Main.n}）`);

// ============================================================
// G-3: 退出規則の比較（G-2の主判定イベントを再利用）
// ============================================================
const g3Source = events[usedEventKey];
const MAX_HOLD = 20;

function simulateExit(rule) {
  const rets = [], holdDays = [];
  for (const e of g3Source) {
    const v = byCode.get(e.code);
    if (!v) continue;
    const entryI = e.entryI;
    if (entryI >= v.closes.length) continue;
    const entryClose = v.closes[entryI];
    let exitI = null;
    if (rule === "fixed10") {
      exitI = Math.min(entryI + 10, v.closes.length - 1);
    } else {
      const maxI = Math.min(entryI + MAX_HOLD, v.closes.length - 1);
      for (let d = entryI + 1; d <= maxI; d++) {
        let triggered = false;
        if (rule === "trail5" && d - 5 >= 0) {
          let low5 = Infinity;
          for (let k = d - 5; k < d; k++) low5 = Math.min(low5, v.closes[k]);
          if (v.closes[d] < low5) triggered = true;
        } else if (rule === "stop7") {
          if (v.closes[d] / entryClose - 1 <= -0.07) triggered = true;
        }
        if (triggered) { exitI = Math.min(d + 1, v.closes.length - 1); break; }
      }
      if (exitI == null) exitI = maxI;
    }
    if (exitI == null || exitI <= entryI) continue;
    rets.push(v.closes[exitI] / entryClose - 1 - COST);
    holdDays.push(exitI - entryI);
  }
  const sorted = [...rets].sort((a, b) => a - b);
  const worstN = Math.max(1, Math.round(sorted.length * 0.1));
  const worst10 = sorted.length ? mean(sorted.slice(0, worstN)) : null;
  return {
    rule, n: rets.length, mean: mean(rets), median: median(rets),
    worst10, win: rets.length ? rets.filter((x) => x > 0).length / rets.length : null,
    avgHoldDays: mean(holdDays),
  };
}

const g3Results = ["fixed10", "trail5", "stop7"].map(simulateExit);
const g3Base = g3Results.find((r) => r.rule === "fixed10");
function g3Improved(r) {
  if (r.rule === "fixed10") return false;
  return r.mean != null && g3Base.mean != null && r.mean >= g3Base.mean &&
    r.worst10 != null && g3Base.worst10 != null && r.worst10 - g3Base.worst10 >= 0.02;
}

console.log(`\n■ G-3 退出規則の比較（入口=${usedEventKey}のイベント・コスト往復${(COST * 100).toFixed(1)}%控除後${g2Adopted ? "" : "・G-2見送りのため参考記録のみ"}）`);
for (const r of g3Results) {
  const mark = !g2Adopted ? "　参考" : r.rule === "fixed10" ? "　基準" : g3Improved(r) ? "⭐採用" : "　見送り";
  console.log(`${mark} ${r.rule}: n=${r.n} 平均${pct(r.mean)} 中央値${pct(r.median)} ワースト10%平均${pct(r.worst10)} 勝率${r.win != null ? (r.win * 100).toFixed(0) + "%" : "-"} 平均保有${r.avgHoldDays != null ? r.avgHoldDays.toFixed(1) : "-"}日`);
}

const outDir = new URL("./signals/", ROOT);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(new URL("./momentum_stats.json", outDir), JSON.stringify({
  generated: GRID.at(-1), stocksUsed: used.size, stocksTotal: groups.size, days: L,
  cost: COST,
  g1: g1Results.map((r) => ({ ...r, adopted: g1Adopted(r) })),
  g2: {
    usedEventKey, adopted: g2Adopted,
    volHigh: { primary: g2Primary, ref: g2Ref, n: events.volHigh.length },
    volJump: { primary: g2VolJumpPrimary, ref: g2VolJumpRef, n: events.volJump.length },
  },
  g3: g3Results.map((r) => ({ ...r, adopted: g2Adopted && g3Improved(r) })),
}, null, 1));
console.log(`\n保存: signals/momentum_stats.json ／ 実行時間 ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
