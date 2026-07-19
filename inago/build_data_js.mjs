// screening_data.csv（縦持ち: 銘柄,日付,始値,高値,安値,終値,出来高）を
// イナゴ・トレード盤の data.js（window.INAGO_DATA）形式に変換する。
// 既に fetch_data.py (yfinance, auto_adjust=True) で取得済みの日経225・5年分を流用。
import fs from "node:fs";

const SRC = new URL("../screening_data.csv", import.meta.url);
const OUT = new URL("./data.js", import.meta.url);

/* ---------- 指標関数（FOMO Volatility Regime 部分導入タスクで追加。
   ATR/EMA/RSI/PercentRank をここに一箇所実装し、検証スクリプト側は import して再利用する） ---------- */
const smaAt = (arr, p, i) => { if (i + 1 < p) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += arr[k]; return s / p; };
function trAt(candles, i) {
  const c = candles[i];
  if (i === 0) return c.high - c.low;
  const pc = candles[i - 1].close;
  return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
}
// ATR(14): 単純移動平均ベース（Wilderの平滑化ではない。既存コードのsmaAt系と統一するための簡略化）
function atrAt(candles, period, i) {
  if (i + 1 < period) return null;
  let s = 0; for (let k = i - period + 1; k <= i; k++) s += trAt(candles, k);
  return s / period;
}
function rsiAt(closes, p, i) {
  if (i < p) return 50;
  let g = 0, l = 0; for (let k = i - p + 1; k <= i; k++) { const d = closes[k] - closes[k - 1]; if (d >= 0) g += d; else l -= d; }
  if (l === 0) return 100; const rs = (g / p) / (l / p); return 100 - 100 / (1 + rs);
}
// EMAは逐次計算が必要なため系列一括計算。先頭period件はSMAでシード。
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sma = 0; for (let k = 0; k < period; k++) sma += values[k];
  sma /= period; out[period - 1] = sma;
  const k_ = 2 / (period + 1); let prev = sma;
  for (let i = period; i < values.length; i++) { prev = values[i] * k_ + prev * (1 - k_); out[i] = prev; }
  return out;
}
// series の直近N件の窓内で series[i] のパーセンタイル順位（0〜100）。窓内にnullがあれば算出不能=null。
function percentRankAt(series, i, N) {
  if (i + 1 < N) return null;
  const win = [];
  for (let k = i - N + 1; k <= i; k++) { const v = series[k]; if (v == null) return null; win.push(v); }
  const x = series[i];
  const le = win.filter(v => v <= x).length;
  return Math.round(le / N * 100);
}
// ATR_PercentRank: N=120(通常)/60(履歴が浅い銘柄)。有効本数がどちらにも満たなければnull。
function computeAtrPctRank(candles) {
  const atrPctSeries = candles.map((_, i) => {
    const atr = atrAt(candles, 14, i);
    const close = candles[i].close;
    return (atr != null && close > 0) ? (atr / close) * 100 : null;
  });
  const last = candles.length - 1;
  let validLen = 0;
  for (let i = last; i >= 0; i--) { if (atrPctSeries[i] == null) break; validLen++; }
  const N = validLen >= 120 ? 120 : (validLen >= 60 ? 60 : null);
  if (N == null) return null;
  return percentRankAt(atrPctSeries, last, N);
}

/* ---------- FOMO Volatility Regime タスク2 で追加。verify_fomo_stall_exit.mjs（バックテスト）と
   screen_daily.mjs（日次レポートの現在地表示）の両方から import して使う共通ロジック。 ---------- */
function isStallDay(candles, i) {
  const c = candles[i];
  const range = (c.high - c.low) || 1e-9;
  const upperWick = (c.high - Math.max(c.open, c.close)) / range;
  const closePos = (c.close - c.low) / range;
  return upperWick >= 0.4 || closePos < 0.5;
}
function isFomoDay(candles, i, ind) {
  const rsi = ind.rsiS[i], volSma = ind.volSmaS[i], atr = ind.atrS[i], ema = ind.emaS[i];
  if (rsi == null || volSma == null || atr == null || ema == null) return false;
  const longHist = ind.longHist[i];
  const rsiTh = longHist ? 72 : 70;
  const volTh = longHist ? 2.0 : 1.8;
  const atrTh = longHist ? 1.35 : 1.25;
  const c = candles[i];
  if (rsi < rsiTh) return false;
  if (c.volume < volSma * volTh) return false;
  if ((c.high - c.low) < atr * atrTh) return false;
  if (c.close <= ema) return false;
  return true;
}
function buildIndicatorSeries(candles) {
  const closes = candles.map(c => c.close);
  const vols = candles.map(c => c.volume);
  const rsiS = closes.map((_, i) => rsiAt(closes, 14, i));
  const volSmaS = vols.map((_, i) => smaAt(vols, 20, i));
  const atrS = candles.map((_, i) => atrAt(candles, 14, i));
  const emaS = emaSeries(closes, 20);
  const longHist = candles.map((_, i) => (i + 1) >= 120);
  return { rsiS, volSmaS, atrS, emaS, longHist };
}
// 現在（末尾バー）が FOMO/失速/トリガーのどの段階かを、直近lookback営業日だけ見て判定する
// （日次レポートの「今どの位置にいるか」表示用。バックテストのexitByFomoStallとは別物＝時間切れフォールバックは無い）。
// lookback既定20営業日は本関数独自パラメータ（doc未定義。「直近の兆候」を見せる目的で恣意的に選択）。
function fomoCurrentStatus(candles, ind, lookback = 20) {
  const last = candles.length - 1;
  const start = Math.max(0, last - lookback);
  let stallIdx = -1, stallLow = null, lastTrigger = null;
  for (let k = start; k <= last; k++) {
    if (stallIdx !== -1 && candles[k].close < stallLow) { lastTrigger = k; stallIdx = -1; stallLow = null; continue; }
    if (stallIdx === -1 && isFomoDay(candles, k, ind) && isStallDay(candles, k)) { stallIdx = k; stallLow = candles[k].low; }
  }
  if (stallIdx !== -1) return { state: "stalling", daysAgo: last - stallIdx };
  if (lastTrigger != null && last - lastTrigger <= 2) return { state: "trigger", daysAgo: last - lastTrigger };
  if (isFomoDay(candles, last, ind)) return { state: "fomo", daysAgo: 0 };
  return { state: "none" };
}

/* ---------- CSV → data.js 変換 ---------- */
function buildDataJs() {
  const text = fs.readFileSync(SRC, "utf-8");
  const lines = text.split(/\r?\n/).filter(Boolean); // CRLF対応（末尾列=出来高がNaN化するバグを防ぐ）
  const header = lines[0].split(",");
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const stocks = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const label = cols[idx["銘柄"]];
    const [code, ...nameParts] = label.split(":");
    const name = nameParts.join(":") || code;
    const date = cols[idx["日付"]];
    const open = +cols[idx["始値"]], high = +cols[idx["高値"]], low = +cols[idx["安値"]], close = +cols[idx["終値"]], volume = +cols[idx["出来高"]];
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    if (!stocks[code]) stocks[code] = { name, candles: [] };
    stocks[code].candles.push({ date, open, high, low, close, volume });
  }

  let asOf = null;
  for (const code of Object.keys(stocks)) {
    stocks[code].candles.sort((a, b) => a.date.localeCompare(b.date));
    const last = stocks[code].candles[stocks[code].candles.length - 1];
    if (last && (!asOf || last.date > asOf)) asOf = last.date;
    stocks[code].atrPctRank = computeAtrPctRank(stocks[code].candles); // AUDIT: FOMO Volatility Regime タスク1
  }

  const payload = { asOf, updated: asOf, stocks };
  const js = `window.INAGO_DATA=${JSON.stringify(payload)};\n`;
  fs.writeFileSync(OUT, js, "utf-8");
  console.log(`data.js 出力: ${Object.keys(stocks).length} 銘柄, asOf=${asOf}`);
}

export { smaAt, trAt, atrAt, rsiAt, emaSeries, percentRankAt, computeAtrPctRank, isFomoDay, isStallDay, buildIndicatorSeries, fomoCurrentStatus };

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("build_data_js.mjs")) {
  buildDataJs();
}
