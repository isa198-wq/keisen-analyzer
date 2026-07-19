// FOMO Volatility Regime 部分導入 タスク2:「FOMO失速→直前安値割れ」撤退ルールの検証スクリプト。
// 指標計算(ATR/RSI/EMA)は build_data_js.mjs 側に一箇所実装したものを import して再利用する（二重管理禁止）。
// エントリ判定・既存出口シグナルは compare_backtest.mjs の scoreAt を再利用する。
//
// 本スクリプトが独自に決めたパラメータ（引き継ぎ書に明記が無いため、ここで固定する。閾値の最適化探索はしない）:
//   - HORIZON = 60営業日: 撤退シグナルが発火しない場合の時間切れ決済までの最大保有日数。
//     ATR PercentRankの「履歴が浅い銘柄」判定と同じN=60に合わせた。
//   - 最大DDは単純化: 複数銘柄の同時保有・ポジションサイジングは考慮せず、
//     決済日順に並べた単一トレード列の累積リターン曲線から算出する（真のポートフォリオDDではない）。
//
// バックテスト規律（前回監査P-1〜P-9の再発防止を踏襲）:
//   - シグナルは t 日引け確定データで計算し、執行は t+1 日寄り（ルックアヘッド禁止）
//   - 取引コスト（CFG.cost、往復）を控除
//   - エントリはエピソード圧縮（同一銘柄で連続発火した場合は初回のみ）。既存Tool4の「初動候補」と同一の入口
//   - 比較対象: 検証タブの既存出口シグナル（heatScore>=70→「出口」）。同一エントリ・撤退タイミングのみ差し替え
import { isFomoDay, isStallDay, buildIndicatorSeries } from "./build_data_js.mjs";
import { getStock, listStocks, dataSanity, CFG, scoreAt } from "./compare_backtest.mjs";

const HORIZON = 60; // 本スクリプト独自パラメータ（理由は上記コメント）

// エントリ以降、HORIZON営業日以内で最初に「出口」状態になった日を探す（既存ルール＝ベースライン）
function exitByExistingSignal(candles, entryIdx) {
  const end = Math.min(entryIdx + HORIZON, candles.length - 2);
  for (let k = entryIdx + 1; k <= end; k++) {
    const r = scoreAt(candles, k);
    if (r && r.state === "出口") return { exitAt: k + 1, kind: "signal" };
  }
  return { exitAt: end + 1, kind: "time" };
}

// エントリ以降、FOMO日→失速→（失速日の）安値を終値で割った日、をHORIZON営業日以内で探す（新ルール）
function exitByFomoStall(candles, entryIdx, ind) {
  const end = Math.min(entryIdx + HORIZON, candles.length - 2);
  let stallIdx = -1, stallLow = null;
  for (let k = entryIdx + 1; k <= end; k++) {
    if (stallIdx === -1) {
      if (isFomoDay(candles, k, ind) && isStallDay(candles, k)) { stallIdx = k; stallLow = candles[k].low; }
      continue;
    }
    if (candles[k].close < stallLow) return { exitAt: k + 1, kind: "signal" };
  }
  return { exitAt: end + 1, kind: "time" };
}

function computeTrades(stocks) {
  const need = Math.max(CFG.volSma, CFG.range, CFG.ma) + 2;
  const tradesA = [], tradesB = [];
  let skippedGap = 0;

  stocks.forEach(st => {
    const c = st.candles;
    if (c.length < need + HORIZON + 2) return; // 検証期間を確保できない銘柄は除外
    const ind = buildIndicatorSeries(c);
    let prevState = null;

    for (let i = need; i < c.length - HORIZON - 2; i++) {
      const r = scoreAt(c, i);
      if (!r) { prevState = null; continue; }
      const isNew = r.state !== prevState;
      prevState = r.state;
      if (!isNew || r.state !== "初動候補") continue; // エピソード圧縮＋エントリは初動候補のみ

      const entryPrice = c[i + 1].open;
      if (!isFinite(entryPrice) || entryPrice <= 0) continue;
      const gap = (entryPrice / c[i].close - 1) * 100;
      if (gap >= CFG.gapSkip) { skippedGap++; continue; }

      const a = exitByExistingSignal(c, i);
      const b = exitByFomoStall(c, i, ind);

      [[a, tradesA], [b, tradesB]].forEach(([res, bucket]) => {
        const exitBar = c[res.exitAt];
        const exitPrice = exitBar ? exitBar.open : null;
        if (!isFinite(exitPrice) || exitPrice == null || exitPrice <= 0) return;
        const ret = (exitPrice / entryPrice - 1) * 100 - CFG.cost;
        bucket.push({ code: st.code, entryDate: c[i].date, exitDate: exitBar.date, ret, kind: res.kind });
      });
    }
  });

  return { tradesA, tradesB, skippedGap };
}

function tradeStats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: 0, avgRet: 0, payoff: null, maxDD: 0, signalExit: 0, timeExit: 0 };
  const wins = trades.filter(t => t.ret > 0);
  const losses = trades.filter(t => t.ret <= 0);
  const winRate = wins.length / n * 100;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.ret, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.ret, 0) / losses.length : 0;
  const payoff = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;
  const sorted = [...trades].sort((x, y) => x.exitDate.localeCompare(y.exitDate));
  let equity = 1, peak = 1, maxDD = 0;
  sorted.forEach(t => { equity *= (1 + t.ret / 100); if (equity > peak) peak = equity; const dd = (peak - equity) / peak * 100; if (dd > maxDD) maxDD = dd; });
  return {
    n, winRate: +winRate.toFixed(1), avgRet: +(trades.reduce((s, t) => s + t.ret, 0) / n).toFixed(3),
    payoff: payoff != null ? +payoff.toFixed(2) : null, maxDD: +maxDD.toFixed(1),
    signalExit: trades.filter(t => t.kind === "signal").length, timeExit: trades.filter(t => t.kind === "time").length,
  };
}

// ============================================================
export { computeTrades, tradeStats, HORIZON };

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify_fomo_stall_exit.mjs")) {
  const stocks = listStocks().map(getStock).filter(Boolean);
  console.log(`\n=== ユニバース: ${stocks.length}銘柄 ===`);
  const sanity = dataSanity(stocks);
  console.log(`データ品質警告: ${sanity.length}件` + (sanity.length ? "（先頭5件: " + sanity.slice(0, 5).join(" / ") + "）" : ""));

  const { tradesA, tradesB, skippedGap } = computeTrades(stocks);
  console.log(`\nエントリ（初動候補・エピソード圧縮後）: A=${tradesA.length}件 / B=${tradesB.length}件（ギャップ除外 ${skippedGap}件）`);

  const statsA = tradeStats(tradesA);
  const statsB = tradeStats(tradesB);
  console.log("\n=== 撤退ルール比較（同一エントリ・撤退タイミングのみ差し替え） ===");
  console.table({
    "A: 既存出口シグナル(heatScore>=70)": statsA,
    "B: FOMO失速→安値割れ": statsB,
  });
  console.log(`\n最大保有日数(本スクリプト独自パラメータ・doc未定義): ${HORIZON}営業日`);
  console.log("※ ヒストリカルな自己検証で、将来の成績を保証しません。投資助言ではありません。");
}
