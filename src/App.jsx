import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  ComposedChart,
  LineChart,
  BarChart,
  Line,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Customized,
} from "recharts";
import Papa from "papaparse";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Upload,
  Activity,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  数値ユーティリティ                                                  */
/* ------------------------------------------------------------------ */
const fmt = (n, d = 0) =>
  n == null || isNaN(n)
    ? "—"
    : n.toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });

const fmtVol = (n, cur = "JPY") => {
  if (n == null || isNaN(n)) return "—";
  if (cur === "USD" || cur === "IDX") {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
    return fmt(n);
  }
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "億";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return fmt(n);
};

// 通貨に応じた価格フォーマッタを生成（refClose で円の小数桁を決定）
function makeMoney(cur, ref = 0) {
  const jd = ref >= 1000 ? 0 : 1;
  return (v) => (cur === "USD" ? `$${fmt(v, 2)}` : cur === "IDX" ? fmt(v, jd) : `${fmt(v, jd)}円`);
}

function sma(values, period) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = Array(closes.length).fill(null);
  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = Math.max(ch, 0);
    const loss = Math.max(-ch, 0);
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = Array(closes.length).fill(null);
  const lower = Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

/* ------------------------------------------------------------------ */
/*  サンプル日本株データ生成（シード固定の擬似乱数）                    */
/* ------------------------------------------------------------------ */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genSeries(seed, base, days = 480, opts = {}) {
  const rnd = mulberry32(seed);
  const volScale = opts.volScale ?? base * 1800;
  const rr = (v) => (opts.dec != null ? Math.round(v * 10 ** opts.dec) / 10 ** opts.dec : round(v, base));
  const rows = [];
  let price = base;
  let drift = (rnd() - 0.5) * 0.004;
  let regime = 0;
  const vol = base * (0.012 + rnd() * 0.01);
  // 営業日（土日スキップ）をさかのぼって日付を作る
  const dates = [];
  let d = new Date(2026, 5, 19);
  while (dates.length < days) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) dates.unshift(new Date(d));
    d.setDate(d.getDate() - 1);
  }
  for (let i = 0; i < days; i++) {
    if (i - regime > 18 + Math.floor(rnd() * 20)) {
      drift = (rnd() - 0.5) * 0.006;
      regime = i;
    }
    const open = price;
    const shock = (rnd() - 0.5) * 2 * vol;
    let close = open * (1 + drift) + shock;
    close = Math.max(close, base * 0.35);
    const hi = Math.max(open, close) + rnd() * vol * 0.8;
    const lo = Math.min(open, close) - rnd() * vol * 0.8;
    const move = Math.abs(close - open) / open;
    const volume = Math.round(volScale * (0.6 + rnd() + move * 28));
    rows.push({
      date: `${dates[i].getMonth() + 1}/${dates[i].getDate()}`,
      open: rr(open),
      high: rr(hi),
      low: rr(lo),
      close: rr(close),
      volume,
    });
    price = close;
  }
  return rows;
}
function round(v, base) {
  return base >= 10000 ? Math.round(v) : base >= 1000 ? Math.round(v * 10) / 10 : Math.round(v * 10) / 10;
}

function busDates(count, end = new Date(2026, 5, 19)) {
  const out = [];
  let d = new Date(end);
  while (out.length < count) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) out.unshift(new Date(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

// 教科書的な「逆三尊（インバースH&S）＋出来高」のデモ系列
function genInverseHS() {
  const rnd = mulberry32(424242);
  const anchors = [
    [0, 1086], [6, 1040], [15, 978], [24, 1043], [31, 1001],
    [36, 930], [44, 1011], [48, 1047], [55, 1004], [60, 986],
    [66, 1028], [72, 1096], [80, 1120], [89, 1109],
  ];
  const dates = busDates(90);
  const rows = [];
  let prev = anchors[0][1];
  for (let i = 0; i < 90; i++) {
    let a = anchors[0], b = anchors[anchors.length - 1];
    for (let k = 0; k < anchors.length - 1; k++) {
      if (i >= anchors[k][0] && i <= anchors[k + 1][0]) { a = anchors[k]; b = anchors[k + 1]; break; }
    }
    const t = (i - a[0]) / Math.max(1, b[0] - a[0]);
    const close = a[1] + (b[1] - a[1]) * t + (rnd() - 0.5) * 9;
    const open = prev;
    const hi = Math.max(open, close) + rnd() * 7;
    const lo = Math.min(open, close) - rnd() * 7;
    // 出来高プロファイル：下落と左肩で多→ヘッドへ細り→ネック突破で急増
    let vm;
    if (i <= 24) vm = 1.45 - i * 0.012;
    else if (i <= 44) vm = 1.05 - (i - 24) * 0.018;
    else if (i < 60) vm = 0.85;
    else if (i <= 72) vm = 1.9 + Math.sin((i - 60) / 4) * 0.4;
    else vm = 1.1;
    rows.push({
      date: `${dates[i].getMonth() + 1}/${dates[i].getDate()}`,
      open: Math.round(open * 10) / 10,
      high: Math.round(hi * 10) / 10,
      low: Math.round(lo * 10) / 10,
      close: Math.round(close * 10) / 10,
      volume: Math.round(2_600_000 * Math.max(0.4, vm) * (0.9 + rnd() * 0.2)),
    });
    prev = close;
  }
  return rows;
}

const STOCKS = [
  { code: "DEMO", name: "逆三尊デモ", market: "JP", currency: "JPY", data: genInverseHS() },
  { code: "7203", name: "トヨタ自動車", market: "JP", currency: "JPY", data: genSeries(7203, 2850) },
  { code: "6758", name: "ソニーグループ", market: "JP", currency: "JPY", data: genSeries(6758, 13200) },
  { code: "9984", name: "ソフトバンクG", market: "JP", currency: "JPY", data: genSeries(9984, 9100) },
  { code: "6861", name: "キーエンス", market: "JP", currency: "JPY", data: genSeries(6861, 61500) },
  { code: "8306", name: "三菱UFJ", market: "JP", currency: "JPY", data: genSeries(8306, 1880) },
  { code: "6098", name: "リクルートHD", market: "JP", currency: "JPY", data: genSeries(6098, 9600) },
  { code: "AAPL", name: "Apple", market: "US", currency: "USD", data: genSeries(101, 195, 480, { dec: 2, volScale: 55_000_000 }) },
  { code: "MSFT", name: "Microsoft", market: "US", currency: "USD", data: genSeries(102, 432, 480, { dec: 2, volScale: 22_000_000 }) },
  { code: "NVDA", name: "NVIDIA", market: "US", currency: "USD", data: genSeries(103, 128, 480, { dec: 2, volScale: 230_000_000 }) },
  { code: "TSLA", name: "Tesla", market: "US", currency: "USD", data: genSeries(104, 248, 480, { dec: 2, volScale: 95_000_000 }) },
  { code: "AMZN", name: "Amazon", market: "US", currency: "USD", data: genSeries(105, 186, 480, { dec: 2, volScale: 40_000_000 }) },
  { code: "GOOGL", name: "Alphabet", market: "US", currency: "USD", data: genSeries(106, 176, 480, { dec: 2, volScale: 28_000_000 }) },
];

/* ------------------------------------------------------------------ */
/*  タイムフレーム集計（日足 → 週足 / 月足）                            */
/* ------------------------------------------------------------------ */
function aggregate(daily, n) {
  const out = [];
  for (let i = 0; i < daily.length; i += n) {
    const chunk = daily.slice(i, i + n);
    if (chunk.length < Math.min(n, 2) && out.length) break;
    out.push({
      date: chunk[chunk.length - 1].date,
      open: chunk[0].open,
      high: Math.max(...chunk.map((d) => d.high)),
      low: Math.min(...chunk.map((d) => d.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, d) => s + (d.volume || 0), 0),
    });
  }
  return out;
}
const TF = {
  D: { label: "日足", unit: "日", step: 1 },
  W: { label: "週足", unit: "週", step: 7 },
  M: { label: "月足", unit: "月", step: 30 },
};
function tfSeries(daily, tf) {
  if (tf === "D") return daily.slice(-160);
  if (tf === "W") return aggregate(daily, 5);
  return aggregate(daily, 21);
}

/* ------------------------------------------------------------------ */
/*  指標の合成                                                          */
/* ------------------------------------------------------------------ */
function buildSeries(raw) {
  const closes = raw.map((r) => r.close);
  const s5 = sma(closes, 5);
  const s25 = sma(closes, 25);
  const s75 = sma(closes, 75);
  const r = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macd = closes.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const signal = ema(
    macd.map((v) => (v == null ? 0 : v)),
    9
  ).map((v, i) => (macd[i] == null ? null : v));
  return raw.map((row, i) => ({
    i,
    ...row,
    up: row.close >= row.open,
    sma5: s5[i],
    sma25: s25[i],
    sma75: s75[i],
    rsi: r[i],
    bbU: bb.upper[i],
    bbL: bb.lower[i],
    bbM: bb.mid[i],
    macd: macd[i],
    signal: signal[i],
    hist: macd[i] != null && signal[i] != null ? macd[i] - signal[i] : null,
  }));
}

/* ------------------------------------------------------------------ */
/*  三尊・逆三尊（ヘッド&ショルダー）検出                                */
/* ------------------------------------------------------------------ */
function findSwings(series, w = 4) {
  const highs = [], lows = [];
  for (let i = w; i < series.length - w; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= w; j++) {
      if (series[i].high < series[i - j].high || series[i].high < series[i + j].high) isH = false;
      if (series[i].low > series[i - j].low || series[i].low > series[i + j].low) isL = false;
    }
    if (isH) highs.push({ i, price: series[i].high });
    if (isL) lows.push({ i, price: series[i].low });
  }
  return { highs, lows };
}
function extremeBetween(series, a, b, field) {
  let best = null;
  for (let i = a + 1; i < b; i++) {
    if (!best) best = { i, price: series[i][field] };
    else if (field === "high" ? series[i].high > best.price : series[i].low < best.price)
      best = { i, price: series[i][field] };
  }
  return best;
}
function avgField(series, lo, hi, field) {
  lo = Math.max(0, lo); hi = Math.min(series.length - 1, hi);
  let s = 0, c = 0;
  for (let i = lo; i <= hi; i++) { s += series[i][field]; c++; }
  return c ? s / c : 0;
}

function detectPattern(series) {
  const n = series.length;
  const { highs, lows } = findSwings(series, 4);
  const avgVol = avgField(series, 0, n - 1, "volume");
  let best = null;

  const consider = (p1, p2, p3, kind) => {
    const span = p3.i - p1.i;
    if (span < 12 || span > 110) return;
    const shoulderDiff = Math.abs(p1.price - p3.price) / ((p1.price + p3.price) / 2);
    if (shoulderDiff > 0.08) return;
    let depth, k1, k2;
    if (kind === "inverse") {
      if (!(p2.price < p1.price && p2.price < p3.price)) return;
      depth = (Math.min(p1.price, p3.price) - p2.price) / Math.min(p1.price, p3.price);
      k1 = extremeBetween(series, p1.i, p2.i, "high");
      k2 = extremeBetween(series, p2.i, p3.i, "high");
    } else {
      if (!(p2.price > p1.price && p2.price > p3.price)) return;
      depth = (p2.price - Math.max(p1.price, p3.price)) / Math.max(p1.price, p3.price);
      k1 = extremeBetween(series, p1.i, p2.i, "low");
      k2 = extremeBetween(series, p2.i, p3.i, "low");
    }
    if (depth < 0.015 || !k1 || !k2) return;

    const m = (k2.price - k1.price) / (k2.i - k1.i);
    const neckAt = (x) => k1.price + m * (x - k1.i);

    let broke = false, breakI = null;
    for (let i = p3.i + 1; i < n; i++) {
      const nk = neckAt(i);
      if (kind === "inverse" && series[i].close > nk) { broke = true; breakI = i; break; }
      if (kind === "top" && series[i].close < nk) { broke = true; breakI = i; break; }
    }
    const refI = breakI ?? n - 1;
    if (!broke && n - 1 - p3.i > 25) return; // 古すぎる未完成形は除外

    const headHeight = Math.abs(neckAt(p2.i) - p2.price);
    const neckLevel = neckAt(refI);
    const target = kind === "inverse" ? neckLevel + headHeight : neckLevel - headHeight;
    const stop = kind === "inverse" ? p3.price * 0.99 : p3.price * 1.01;
    const entry = neckLevel;
    const rr = Math.abs(target - entry) / Math.max(1e-6, Math.abs(entry - stop));

    const breakoutVol = broke ? avgField(series, breakI - 1, breakI + 2, "volume") : avgField(series, n - 3, n - 1, "volume");
    const headVol = avgField(series, p2.i - 2, p2.i + 2, "volume");
    const volExpand = broke && breakoutVol > headVol * 1.1 && breakoutVol > avgVol;

    // 形成期間の出来高プロファイル（左肩→ヘッド→右肩→ブレイク）
    const leftV = avgField(series, p1.i - 2, p1.i + 2, "volume");
    const headV = headVol;
    const rightV = avgField(series, p3.i - 2, p3.i + 2, "volume");
    const breakV = breakoutVol;
    const formStart = Math.max(0, p1.i - 2);
    const formEnd = (broke ? breakI : p3.i) + 1;
    const formAvg = avgField(series, formStart, formEnd, "volume");
    const contraction = headV < leftV * 0.95;     // 逆三尊：ヘッドで出来高が細る
    const rsDecline = rightV < leftV * 0.95;       // 三尊：右肩で出来高が逓減（弱気ダイバージェンス）
    const breakoutExpand = broke && breakV > formAvg * 1.1;
    const goodCount =
      (kind === "inverse" ? (contraction ? 1 : 0) : rsDecline ? 1 : 0) + (breakoutExpand ? 1 : 0);
    const profile = goodCount >= 2 ? "ideal" : goodCount === 1 ? "partial" : "weak";
    const vol = { leftV, headV, rightV, breakV, formAvg, contraction, rsDecline, breakoutExpand, profile, formStart, formEnd, breakI: broke ? breakI : null };

    const status = broke ? "confirmed" : "forming";
    const quality =
      (broke ? 100 : 0) + p3.i * 0.4 + (0.08 - shoulderDiff) * 250 + depth * 120 + (volExpand ? 25 : 0) + (profile === "ideal" ? 15 : 0);

    const cand = {
      kind, status, p1, p2, p3, k1, k2, neckAt, target, stop, entry, rr,
      broke, breakI, refI, volExpand, breakoutVol, headVol, headVolToAvg: headVol / avgVol,
      neckLevel, depth, shoulderDiff, headHeight, quality, vol,
    };
    if (!best || cand.quality > best.quality) best = cand;
  };

  for (let x = 0; x + 2 < lows.length; x++) consider(lows[x], lows[x + 1], lows[x + 2], "inverse");
  for (let x = 0; x + 2 < highs.length; x++) consider(highs[x], highs[x + 1], highs[x + 2], "top");
  return best;
}

/* ------------------------------------------------------------------ */
/*  シグナル／パターン判定エンジン                                      */
/* ------------------------------------------------------------------ */
function analyze(series, unit = "日") {
  const n = series.length;
  const last = series[n - 1];
  const factors = [];
  let score = 0;

  // トレンド：sma25 の傾き ＋ 価格と sma75 の位置
  const slopeWin = 12;
  const s25now = last.sma25,
    s25prev = series[n - 1 - slopeWin]?.sma25;
  let trend = "レンジ";
  if (s25now != null && s25prev != null) {
    const slope = (s25now - s25prev) / s25prev;
    const aboveLong = last.sma75 != null && last.close > last.sma75;
    if (slope > 0.012 && aboveLong) {
      trend = "上昇トレンド";
      score += 2;
      factors.push({ k: "トレンド", v: `上昇（25${unit}線が上向き・75${unit}線の上）`, s: 2 });
    } else if (slope < -0.012 && !aboveLong) {
      trend = "下降トレンド";
      score -= 2;
      factors.push({ k: "トレンド", v: `下降（25${unit}線が下向き・75${unit}線の下）`, s: -2 });
    } else {
      factors.push({ k: "トレンド", v: "明確な方向感なし（レンジ）", s: 0 });
    }
  }

  // ゴールデン／デッドクロス（25日 × 75日）
  let crossText = "直近なし";
  for (let i = n - 1; i >= Math.max(1, n - 12); i--) {
    const a = series[i],
      b = series[i - 1];
    if (a.sma25 == null || a.sma75 == null || b.sma25 == null || b.sma75 == null) continue;
    const prevDiff = b.sma25 - b.sma75;
    const nowDiff = a.sma25 - a.sma75;
    if (prevDiff <= 0 && nowDiff > 0) {
      const ago = n - 1 - i;
      crossText = `ゴールデンクロス（${ago}日前）`;
      score += 2;
      factors.push({ k: "クロス", v: crossText, s: 2 });
      break;
    }
    if (prevDiff >= 0 && nowDiff < 0) {
      const ago = n - 1 - i;
      crossText = `デッドクロス（${ago}日前）`;
      score -= 2;
      factors.push({ k: "クロス", v: crossText, s: -2 });
      break;
    }
  }
  if (crossText === "直近なし") factors.push({ k: "クロス", v: "直近12日でクロスなし", s: 0 });

  // MACD
  let macdText = "中立";
  if (last.macd != null && last.signal != null) {
    const prev = series[n - 2];
    const crossUp = prev.macd <= prev.signal && last.macd > last.signal;
    const crossDn = prev.macd >= prev.signal && last.macd < last.signal;
    if (crossUp) {
      macdText = "強気クロス（シグナルを上抜け）";
      score += 1.5;
      factors.push({ k: "MACD", v: macdText, s: 1.5 });
    } else if (crossDn) {
      macdText = "弱気クロス（シグナルを下抜け）";
      score -= 1.5;
      factors.push({ k: "MACD", v: macdText, s: -1.5 });
    } else if (last.macd > last.signal) {
      macdText = "シグナルの上（強気優勢）";
      score += 0.7;
      factors.push({ k: "MACD", v: macdText, s: 0.7 });
    } else {
      macdText = "シグナルの下（弱気優勢）";
      score -= 0.7;
      factors.push({ k: "MACD", v: macdText, s: -0.7 });
    }
  }

  // RSI（逆張りの極値のみ評価）
  let rsiText = "中立";
  if (last.rsi != null) {
    if (last.rsi >= 70) {
      rsiText = `買われすぎ（${last.rsi.toFixed(0)}）`;
      score -= 1;
      factors.push({ k: "RSI", v: rsiText + " ／ 過熱感", s: -1 });
    } else if (last.rsi <= 30) {
      rsiText = `売られすぎ（${last.rsi.toFixed(0)}）`;
      score += 1;
      factors.push({ k: "RSI", v: rsiText + " ／ 反発期待", s: 1 });
    } else {
      rsiText = `中立（${last.rsi.toFixed(0)}）`;
      factors.push({ k: "RSI", v: rsiText, s: 0 });
    }
  }

  // ボリンジャーバンド
  if (last.bbU != null) {
    if (last.close > last.bbU) {
      score -= 0.5;
      factors.push({ k: "BB", v: "+2σを上抜け（行きすぎ警戒）", s: -0.5 });
    } else if (last.close < last.bbL) {
      score += 0.5;
      factors.push({ k: "BB", v: "−2σを下抜け（売られすぎ）", s: 0.5 });
    } else {
      factors.push({ k: "BB", v: "バンド内で推移", s: 0 });
    }
  }

  // 出来高トレンド
  const recent = series.slice(-5).map((d) => d.volume);
  const prior = series.slice(-20, -5).map((d) => d.volume);
  const avgR = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgP = prior.reduce((a, b) => a + b, 0) / Math.max(prior.length, 1);
  const volTrend = avgR > avgP * 1.15 ? "増加" : avgR < avgP * 0.85 ? "減少" : "横ばい";
  factors.push({
    k: "出来高",
    v: `${volTrend}（直近5本平均 ${fmtVol(avgR)}）`,
    s: 0,
  });

  // 支持線・抵抗線（直近30日の安値・高値）
  const win = series.slice(-30);
  const support = Math.min(...win.map((d) => d.low));
  const resistance = Math.max(...win.map((d) => d.high));

  // 三尊・逆三尊（ヘッド&ショルダー）
  const pattern = detectPattern(series);
  if (pattern) {
    if (pattern.kind === "inverse") {
      if (pattern.status === "confirmed") {
        const s = pattern.volExpand ? 2.5 : 1.8;
        score += s;
        factors.push({ k: "逆三尊", v: `ネックライン突破を確認${pattern.volExpand ? "・出来高増加で信頼度大" : "（出来高の伴い弱め）"}`, s });
      } else {
        score += 0.8;
        factors.push({ k: "逆三尊", v: "形成中（ネックライン未突破）", s: 0.8 });
      }
    } else {
      if (pattern.status === "confirmed") {
        const s = pattern.volExpand ? 2.5 : 1.8;
        score -= s;
        factors.push({ k: "三尊", v: `ネックライン割れを確認${pattern.volExpand ? "・出来高増加で信頼度大" : "（出来高の伴い弱め）"}`, s: -s });
      } else {
        score -= 0.8;
        factors.push({ k: "三尊", v: "形成中（ネックライン未割れ）", s: -0.8 });
      }
    }
  }

  // スコア → 判定
  const maxScore = 9.5;
  const norm = Math.max(-100, Math.min(100, (score / maxScore) * 100));
  let verdict, vColor, vIdx;
  if (score >= 3) [verdict, vColor, vIdx] = ["強い買い", "up", 4];
  else if (score >= 1) [verdict, vColor, vIdx] = ["買い", "up", 3];
  else if (score > -1) [verdict, vColor, vIdx] = ["中立", "neutral", 2];
  else if (score > -3) [verdict, vColor, vIdx] = ["売り", "down", 1];
  else [verdict, vColor, vIdx] = ["強い売り", "down", 0];

  return {
    last,
    factors,
    score,
    norm,
    verdict,
    vColor,
    vIdx,
    trend,
    rsiText,
    macdText,
    crossText,
    volTrend,
    support,
    resistance,
    pattern,
    change: n >= 2 ? last.close - series[n - 2].close : 0,
    changePct: n >= 2 ? ((last.close - series[n - 2].close) / series[n - 2].close) * 100 : 0,
  };
}

// デバッグ/バックテスト用：判定ロジックをそのまま外部から呼べるよう公開
if (typeof window !== "undefined") {
  window.__keisen = { buildSeries, tfSeries, analyze };
}

/* ------------------------------------------------------------------ */
/*  予測（「こう動けば〜が出そう」の想定シナリオ）                       */
/* ------------------------------------------------------------------ */
function futureDates(series, count, step = 1) {
  const parts = series[series.length - 1].date.split("/");
  let d = new Date(2026, +parts[0] - 1, +parts[1]);
  const out = [];
  while (out.length < count) {
    if (step > 1) {
      d.setDate(d.getDate() + step);
      out.push(`${d.getMonth() + 1}/${d.getDate()}`);
    } else {
      d.setDate(d.getDate() + 1);
      const wd = d.getDay();
      if (wd !== 0 && wd !== 6) out.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
  }
  return out;
}
const easeIO = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function buildProjection(series, p, a, step = 1) {
  const n = series.length;
  const last = series[n - 1].close;
  const H = 16;
  const dates = futureDates(series, H, step);
  const vals = [];
  let kind;

  if (p) {
    kind = p.kind;
    const N = p.neckLevel, T = p.target;
    const b1 = p.status === "confirmed" ? 3 : Math.round(H * 0.42); // 完成済みは軽い押し目/戻り、形成中はネックまでの距離
    for (let k = 1; k <= H; k++) {
      let v;
      if (k <= b1) v = last + (N - last) * easeIO(k / b1);
      else v = N + (T - N) * easeIO((k - b1) / (H - b1));
      vals.push(v);
    }
  } else {
    kind = "trend";
    const slope =
      a.last.sma25 != null && series[n - 13]?.sma25 != null
        ? (a.last.sma25 - series[n - 13].sma25) / 12
        : 0;
    for (let k = 1; k <= H; k++) vals.push(last + slope * k * 0.85);
  }

  const dec = a.last.close >= 1000 && kind !== "trend" ? 0 : 2;
  const bars = vals.map((v, idx) => ({
    i: n + idx,
    date: dates[idx],
    proj: Math.round(v * 10 ** dec) / 10 ** dec,
    projected: true,
    open: null, high: null, low: null, close: null, volume: null,
    sma5: null, sma25: null, sma75: null, bbU: null, bbL: null, rsi: null, macd: null, signal: null, hist: null,
  }));
  return { bars, kind, end: bars[bars.length - 1].proj, boundaryI: n - 1, from: last };
}

/* ------------------------------------------------------------------ */
/*  ローソク足の描画（recharts Customized レイヤー）                    */
/* ------------------------------------------------------------------ */
function Candles(props) {
  const { xAxisMap, yAxisMap, data } = props;
  const xAxis = Object.values(xAxisMap)[0];
  const yAxis = Object.values(yAxisMap)[0];
  if (!xAxis || !yAxis || !data) return null;
  const xs = xAxis.scale;
  const ys = yAxis.scale;
  const band = xs.bandwidth ? xs.bandwidth() : Math.abs(xs(1) - xs(0));
  const cw = Math.max(1.5, Math.min(13, band * 0.62));
  const half = (xs.bandwidth ? xs.bandwidth() / 2 : 0);

  return (
    <g>
      {data.map((d, i) => {
        if (d.open == null) return null;
        const cx = xs(d.i) + half;
        const color = d.up ? "var(--up)" : "var(--down)";
        const yO = ys(d.open),
          yC = ys(d.close),
          yH = ys(d.high),
          yL = ys(d.low);
        const top = Math.min(yO, yC);
        const h = Math.max(1, Math.abs(yO - yC));
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={yH} y2={yL} stroke={color} strokeWidth={1} />
            <rect x={cx - cw / 2} y={top} width={cw} height={h} fill={color} rx={0.5} />
          </g>
        );
      })}
    </g>
  );
}

/* ------------------------------------------------------------------ */
/*  三尊・逆三尊オーバーレイ                                            */
/* ------------------------------------------------------------------ */
function PatternOverlay(props) {
  const { xAxisMap, yAxisMap, offset, pattern, series } = props;
  if (!pattern || !xAxisMap || !yAxisMap) return null;
  const xs = Object.values(xAxisMap)[0].scale;
  const ys = Object.values(yAxisMap)[0].scale;
  const half = xs.bandwidth ? xs.bandwidth() / 2 : 0;
  const X = (i) => xs(i) + half;
  const col = pattern.kind === "inverse" ? "var(--up)" : "var(--down)";
  const labels = ["左肩", "ヘッド", "右肩"];
  const pts = [pattern.p1, pattern.p2, pattern.p3];
  const lastI = series.length - 1;
  const L = offset.left, W = offset.width, T = offset.top, H = offset.height;
  return (
    <g>
      {/* ネックライン */}
      <line
        x1={X(pattern.k1.i)} y1={ys(pattern.neckAt(pattern.k1.i))}
        x2={X(lastI)} y2={ys(pattern.neckAt(lastI))}
        stroke="var(--brass)" strokeWidth={1.4} strokeDasharray="5 3"
      />
      <text x={X(pattern.k1.i) + 4} y={ys(pattern.neckAt(pattern.k1.i)) - 4} fill="var(--brass)" fontSize="9" fontFamily="var(--font-jp)">ネックライン</text>
      {/* 目標値 */}
      <line x1={L} x2={L + W} y1={ys(pattern.target)} y2={ys(pattern.target)} stroke="var(--up)" strokeDasharray="2 3" strokeOpacity={0.85} />
      <text x={L + 5} y={ys(pattern.target) - 4} fill="var(--up)" fontSize="9" fontFamily="var(--font-mono)">目標 {fmt(pattern.target)}</text>
      {/* 損切り */}
      <line x1={L} x2={L + W} y1={ys(pattern.stop)} y2={ys(pattern.stop)} stroke="var(--down)" strokeDasharray="2 3" strokeOpacity={0.85} />
      <text x={L + 5} y={ys(pattern.stop) + 11} fill="var(--down)" fontSize="9" fontFamily="var(--font-mono)">損切り {fmt(pattern.stop)}</text>
      {/* ブレイク位置 */}
      {pattern.broke && (
        <line x1={X(pattern.breakI)} x2={X(pattern.breakI)} y1={T} y2={T + H} stroke={col} strokeOpacity={0.28} strokeWidth={1} />
      )}
      {/* 肩・ヘッドのマーカー */}
      {pts.map((p, idx) => (
        <g key={idx}>
          <circle cx={X(p.i)} cy={ys(p.price)} r={4.5} fill={col} stroke="var(--bg)" strokeWidth={1.5} />
          <text
            x={X(p.i)} y={pattern.kind === "inverse" ? ys(p.price) + 16 : ys(p.price) - 9}
            fill={col} fontSize="9.5" textAnchor="middle" fontFamily="var(--font-jp)" fontWeight="700"
          >
            {labels[idx]}
          </text>
        </g>
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------ */
/*  予測オーバーレイ（境界・想定終点）                                  */
/* ------------------------------------------------------------------ */
function ProjectionOverlay(props) {
  const { xAxisMap, yAxisMap, offset, proj, projColor } = props;
  if (!proj || !xAxisMap || !yAxisMap) return null;
  const xs = Object.values(xAxisMap)[0].scale;
  const ys = Object.values(yAxisMap)[0].scale;
  const half = xs.bandwidth ? xs.bandwidth() / 2 : 0;
  const X = (i) => xs(i) + half;
  const x0 = X(proj.boundaryI);
  const xR = offset.left + offset.width;
  const lastI = proj.bars[proj.bars.length - 1].i;
  return (
    <g>
      <rect x={x0} y={offset.top} width={Math.max(0, xR - x0)} height={offset.height} fill="rgba(200,164,85,.05)" />
      <line x1={x0} x2={x0} y1={offset.top} y2={offset.top + offset.height} stroke="var(--muted2)" strokeDasharray="3 3" />
      <text x={x0 + 5} y={offset.top + 11} fill="var(--muted)" fontSize="9" fontFamily="var(--font-jp)">予測シナリオ</text>
      <circle cx={X(lastI)} cy={ys(proj.end)} r={3.5} fill={projColor} stroke="var(--bg)" strokeWidth={1.5} />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/*  出来高：形成期間オーバーレイ（平均線・フェーズ名）                  */
/* ------------------------------------------------------------------ */
function VolFormationOverlay(props) {
  const { xAxisMap, yAxisMap, offset, pattern } = props;
  if (!pattern || !pattern.vol || !xAxisMap || !yAxisMap) return null;
  const xs = Object.values(xAxisMap)[0].scale;
  const ys = Object.values(yAxisMap)[0].scale;
  const half = xs.bandwidth ? xs.bandwidth() / 2 : 0;
  const X = (i) => xs(i) + half;
  const v = pattern.vol;
  const col = pattern.kind === "inverse" ? "var(--up)" : "var(--down)";
  const marks = [["左肩", pattern.p1.i], ["頭", pattern.p2.i], ["右肩", pattern.p3.i]];
  if (v.breakI != null) marks.push(["ブレイク", v.breakI]);
  return (
    <g>
      <line x1={X(v.formStart)} x2={X(v.formEnd)} y1={ys(v.formAvg)} y2={ys(v.formAvg)} stroke="var(--brass)" strokeWidth={1.2} strokeDasharray="4 3" />
      <text x={X(v.formEnd)} y={ys(v.formAvg) - 3} fill="var(--brass)" fontSize="8.5" textAnchor="end" fontFamily="var(--font-jp)">形成期平均</text>
      {marks.map(([lab, idx], k) => (
        <text key={k} x={X(idx)} y={offset.top + 9} fill={lab === "ブレイク" ? col : "var(--muted)"} fontSize="8.5" textAnchor="middle" fontFamily="var(--font-jp)" fontWeight={lab === "ブレイク" ? 700 : 400}>
          {lab}
        </text>
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------ */
/*  ツールチップ                                                        */
/* ------------------------------------------------------------------ */
function PriceTip({ active, label, series, cur = "JPY", dec, unit = "日" }) {
  if (!active || label == null || !series[label]) return null;
  const d = series[label];
  const dp = dec != null ? dec : cur === "USD" ? 2 : 1;
  const Row = ({ k, v, c }) => (
    <div className="tip-row">
      <span className="tip-k">{k}</span>
      <span className="tip-v" style={c ? { color: c } : undefined}>
        {v}
      </span>
    </div>
  );
  if (d.projected) {
    return (
      <div className="tip">
        <div className="tip-date">{d.date}（予測）</div>
        <Row k="想定値" v={fmt(d.proj, dp)} c="var(--brass)" />
      </div>
    );
  }
  return (
    <div className="tip">
      <div className="tip-date">{d.date}</div>
      <Row k="始値" v={fmt(d.open, dp)} />
      <Row k="高値" v={fmt(d.high, dp)} c="var(--up)" />
      <Row k="安値" v={fmt(d.low, dp)} c="var(--down)" />
      <Row k="終値" v={fmt(d.close, dp)} />
      <Row k="出来高" v={fmtVol(d.volume, cur)} />
      {d.sma25 != null && <Row k={`25${unit}線`} v={fmt(d.sma25, dp)} c="var(--sma25)" />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  チャート群                                                          */
/* ------------------------------------------------------------------ */
const MARGIN = { top: 6, right: 14, bottom: 0, left: 0 };
const YW = 56;
const AXIS = { stroke: "var(--muted2)", fontSize: 10, fontFamily: "var(--font-mono)" };

function tickEvery(n) {
  return Math.max(1, Math.floor(n / 6));
}

function PriceChart({ series, pattern, cur = "JPY", dec, proj, unit = "日" }) {
  const real = series.filter((d) => d.low != null);
  const lows = real.map((d) => d.low);
  const highs = real.map((d) => d.high);
  let lo = Math.min(...lows);
  let hi = Math.max(...highs);
  if (pattern) {
    lo = Math.min(lo, pattern.target, pattern.stop);
    hi = Math.max(hi, pattern.target, pattern.stop);
  }
  if (proj) {
    const pv = proj.bars.map((b) => b.proj);
    lo = Math.min(lo, ...pv);
    hi = Math.max(hi, ...pv);
  }
  const dmin = lo * 0.985;
  const dmax = hi * 1.015;
  const iv = tickEvery(series.length);
  const projColor = pattern ? (pattern.kind === "inverse" ? "var(--up)" : "var(--down)") : "var(--brass)";
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={series} margin={MARGIN}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          dataKey="i"
          tick={AXIS}
          tickLine={false}
          axisLine={{ stroke: "var(--line)" }}
          interval={iv}
          tickFormatter={(i) => series[i]?.date ?? ""}
          height={18}
        />
        <YAxis
          width={YW}
          domain={[dmin, dmax]}
          tick={AXIS}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => fmt(v)}
          orientation="right"
        />
        <Tooltip content={<PriceTip series={series} cur={cur} dec={dec} unit={unit} />} cursor={{ stroke: "var(--muted2)", strokeDasharray: "3 3" }} />
        <Line dataKey="bbU" stroke="var(--bb)" dot={false} strokeWidth={1} strokeDasharray="2 2" isAnimationActive={false} />
        <Line dataKey="bbL" stroke="var(--bb)" dot={false} strokeWidth={1} strokeDasharray="2 2" isAnimationActive={false} />
        <Line dataKey="sma5" stroke="var(--sma5)" dot={false} strokeWidth={1.2} isAnimationActive={false} />
        <Line dataKey="sma25" stroke="var(--sma25)" dot={false} strokeWidth={1.4} isAnimationActive={false} />
        <Line dataKey="sma75" stroke="var(--sma75)" dot={false} strokeWidth={1.4} isAnimationActive={false} />
        {proj && (
          <Line dataKey="proj" stroke={projColor} dot={false} strokeWidth={1.7} strokeDasharray="4 3" connectNulls isAnimationActive={false} />
        )}
        <Customized component={(p) => <Candles {...p} data={series} />} />
        <Customized component={(p) => <PatternOverlay {...p} pattern={pattern} series={real} />} />
        {proj && <Customized component={(p) => <ProjectionOverlay {...p} proj={proj} projColor={projColor} />} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function VolumeChart({ series, cur = "JPY", pattern = null }) {
  const iv = tickEvery(series.length);
  const fs = pattern?.vol ? pattern.vol.formStart - 1 : null;
  const fe = pattern?.vol ? pattern.vol.formEnd + 1 : null;
  const cellFill = (d) => {
    const inForm = fs != null && d.i >= fs && d.i <= fe;
    if (d.up == null) return "transparent";
    return d.up ? (inForm ? "var(--up)" : "var(--up-dim)") : inForm ? "var(--down)" : "var(--down-dim)";
  };
  return (
    <ResponsiveContainer width="100%" height={96}>
      <BarChart data={series} margin={MARGIN}>
        <XAxis dataKey="i" hide interval={iv} />
        <YAxis width={YW} tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => fmtVol(v, cur)} orientation="right" />
        <Tooltip
          cursor={{ fill: "var(--hover)" }}
          content={({ active, label }) =>
            active && series[label] && series[label].volume != null ? (
              <div className="tip">
                <div className="tip-date">{series[label].date}</div>
                <div className="tip-row">
                  <span className="tip-k">出来高</span>
                  <span className="tip-v">{fmtVol(series[label].volume, cur)}</span>
                </div>
              </div>
            ) : null
          }
        />
        <Bar dataKey="volume" isAnimationActive={false}>
          {series.map((d, i) => (
            <Cell key={i} fill={cellFill(d)} />
          ))}
        </Bar>
        {pattern && <Customized component={(p) => <VolFormationOverlay {...p} pattern={pattern} />} />}
      </BarChart>
    </ResponsiveContainer>
  );
}

function RsiChart({ series }) {
  const iv = tickEvery(series.length);
  return (
    <ResponsiveContainer width="100%" height={110}>
      <LineChart data={series} margin={MARGIN}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="i" hide interval={iv} />
        <YAxis width={YW} domain={[0, 100]} ticks={[30, 50, 70]} tick={AXIS} tickLine={false} axisLine={false} orientation="right" />
        <ReferenceLine y={70} stroke="var(--up)" strokeDasharray="3 3" strokeOpacity={0.5} />
        <ReferenceLine y={30} stroke="var(--down)" strokeDasharray="3 3" strokeOpacity={0.5} />
        <Tooltip
          cursor={{ stroke: "var(--muted2)", strokeDasharray: "3 3" }}
          content={({ active, label }) =>
            active && series[label]?.rsi != null ? (
              <div className="tip">
                <div className="tip-date">{series[label].date}</div>
                <div className="tip-row">
                  <span className="tip-k">RSI</span>
                  <span className="tip-v">{series[label].rsi.toFixed(1)}</span>
                </div>
              </div>
            ) : null
          }
        />
        <Line dataKey="rsi" stroke="var(--rsi)" dot={false} strokeWidth={1.4} isAnimationActive={false} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

function MacdChart({ series }) {
  const iv = tickEvery(series.length);
  return (
    <ResponsiveContainer width="100%" height={120}>
      <ComposedChart data={series} margin={MARGIN}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          dataKey="i"
          tick={AXIS}
          tickLine={false}
          axisLine={{ stroke: "var(--line)" }}
          interval={iv}
          tickFormatter={(i) => series[i]?.date ?? ""}
          height={18}
        />
        <YAxis width={YW} tick={AXIS} tickLine={false} axisLine={false} orientation="right" tickFormatter={(v) => fmt(v, 0)} />
        <ReferenceLine y={0} stroke="var(--line)" />
        <Tooltip
          cursor={{ fill: "var(--hover)" }}
          content={({ active, label }) =>
            active && series[label]?.macd != null ? (
              <div className="tip">
                <div className="tip-date">{series[label].date}</div>
                <div className="tip-row">
                  <span className="tip-k">MACD</span>
                  <span className="tip-v">{series[label].macd.toFixed(1)}</span>
                </div>
                <div className="tip-row">
                  <span className="tip-k">シグナル</span>
                  <span className="tip-v">{series[label].signal?.toFixed(1)}</span>
                </div>
              </div>
            ) : null
          }
        />
        <Bar dataKey="hist" isAnimationActive={false}>
          {series.map((d, i) => (
            <Cell key={i} fill={d.hist >= 0 ? "var(--up-dim)" : "var(--down-dim)"} />
          ))}
        </Bar>
        <Line dataKey="macd" stroke="var(--macd)" dot={false} strokeWidth={1.3} isAnimationActive={false} connectNulls />
        <Line dataKey="signal" stroke="var(--signal)" dot={false} strokeWidth={1.3} isAnimationActive={false} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------------ */
/*  シグナル計器（シグネチャー要素）                                    */
/* ------------------------------------------------------------------ */
const ZONES = ["強い売り", "売り", "中立", "買い", "強い買い"];
function SignalGauge({ a }) {
  // -100..100 を 0..100% に
  const pos = ((a.norm + 100) / 200) * 100;
  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="eyebrow">総合シグナル</span>
        <span className={`verdict v-${a.vColor}`}>{a.verdict}</span>
      </div>
      <div className="gauge-track">
        <div className="gauge-fill" />
        <div className="gauge-needle" style={{ left: `${pos}%` }} />
        {[0, 25, 50, 75, 100].map((t) => (
          <div key={t} className="gauge-tick" style={{ left: `${t}%` }} />
        ))}
      </div>
      <div className="gauge-labels">
        {ZONES.map((z, i) => (
          <span key={z} className={`gz ${i === a.vIdx ? "gz-on" : ""}`}>
            {z}
          </span>
        ))}
      </div>
      <div className="gauge-score">
        スコア <b>{a.score > 0 ? "+" : ""}{a.score.toFixed(1)}</b> / ±7
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  根拠リスト                                                          */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  三尊・逆三尊カード（チャート＋出来高＋損切りの読み筋）              */
/* ------------------------------------------------------------------ */
function patternReading(p, money) {
  const neck = money(p.neckLevel);
  const tgt = money(p.target);
  const stop = money(p.stop);
  const entry = money(p.entry);
  const rr = p.rr.toFixed(1);
  const risk = `想定エントリーはネック${p.kind === "inverse" ? "上抜け" : "割れ"}の${entry}、目標は計測値（パターンの高さ分）で${tgt}、${stop}${p.kind === "inverse" ? "割れ" : "超え"}を損切り目安に（リスクリワード約${rr}）。`;
  if (p.kind === "inverse") {
    const head =
      "底値圏の逆三尊（インバースH&S）はトレンド転換を示す代表的な反転パターン。";
    const body =
      p.status === "confirmed"
        ? `左肩からヘッドへ出来高が細り、ネックライン${neck}を${p.volExpand ? "出来高を伴って" : "やや薄商いで"}上抜けました。${p.volExpand ? "チャート優先の見方では買いの優位が高い形です。" : "ただし出来高の伴いが弱く、だまし上げに警戒が必要です。"}`
        : `現在ネックライン${neck}の手前で形成中。終値で明確に上抜け、かつ出来高の増加を伴えば買いシグナルとして機能しやすい局面です。`;
    return head + body + risk;
  }
  const head = "天井圏の三尊（H&Sトップ）は上昇からの転換を示す代表的な天井パターン。";
  const body =
    p.status === "confirmed"
      ? `ネックライン${neck}を${p.volExpand ? "出来高を伴って" : "やや薄商いで"}割り込みました。${p.volExpand ? "下落加速に警戒する形です。" : "出来高の伴いが弱く、だまし下げの可能性も残ります。"}`
      : `現在ネックライン${neck}を保っており形成中。終値で明確に割り込めば売りシグナルとして機能しやすい局面です。`;
  return head + body + risk;
}

function PatternCard({ p, money }) {
  if (!p) {
    return (
      <section className="card">
        <div className="card-head">
          <span className="card-title">三尊・逆三尊スキャナー</span>
          <span className="card-note">チャート＋出来高＋損切り</span>
        </div>
        <div className="pat-empty">
          直近で三尊・逆三尊（ヘッド＆ショルダー）は検出されていません。形が現れると、肩・ヘッド・ネックライン・目標値・損切りを自動で表示します。
        </div>
      </section>
    );
  }
  const inv = p.kind === "inverse";
  const name = inv ? "逆三尊" : "三尊";
  const badgeCls = inv ? (p.status === "confirmed" ? "pb-up" : "pb-up-soft") : p.status === "confirmed" ? "pb-down" : "pb-down-soft";
  const statusJa = p.status === "confirmed" ? "ネックブレイク確認" : "形成中";
  const Cell = ({ k, v, c }) => (
    <div className="pat-cell">
      <span className="pat-k">{k}</span>
      <span className="pat-v" style={c ? { color: c } : undefined}>{v}</span>
    </div>
  );
  return (
    <section className="card pattern-card">
      <div className="card-head">
        <span className="card-title">三尊・逆三尊スキャナー</span>
        <span className={`pat-badge ${badgeCls}`}>{name}・{statusJa}</span>
      </div>
      <div className="pat-grid">
        <Cell k="ネックライン" v={money(p.neckLevel)} c="var(--brass)" />
        <Cell k="目標値（計測）" v={money(p.target)} c="var(--up)" />
        <Cell k="損切り目安" v={money(p.stop)} c="var(--down)" />
        <Cell k="リスクリワード" v={`約 ${p.rr.toFixed(1)} 倍`} />
        <Cell k="出来高" v={p.status === "confirmed" ? (p.volExpand ? "増加（信頼度↑）" : "伴い弱め") : "監視中"} c={p.volExpand ? "var(--up)" : undefined} />
        <Cell k="肩の対称度" v={`±${(p.shoulderDiff * 100).toFixed(1)}%`} />
      </div>
      <p className="pat-read">{patternReading(p, money)}</p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  形成期間の出来高プロファイル                                        */
/* ------------------------------------------------------------------ */
function volReading(p) {
  const v = p.vol;
  const parts = [];
  if (p.kind === "inverse") {
    parts.push(v.contraction ? "ヘッドにかけて出来高が細っており（理想形）" : "ヘッドでの出来高の細りは弱め");
  } else {
    parts.push(v.rsDecline ? "左肩→右肩へ出来高が逓減（弱気のダイバージェンス）" : "右肩での出来高減少は弱め");
  }
  if (p.broke) parts.push(v.breakoutExpand ? "ネックライン抜けで出来高が増加" : "ブレイク時の出来高増加は確認できず");
  else parts.push("ブレイクは未発生（出来高増加の確認はこれから）");
  const tail =
    v.profile === "ideal"
      ? "。出来高を伴う教科書的な形で、信頼度は高めです。"
      : v.profile === "partial"
      ? "。条件の一部のみ満たしており、信頼度は中程度です。"
      : "。出来高の裏付けが弱く、だましに警戒が必要です。";
  return parts.join("、") + tail;
}

function VolumeProfile({ p, cur }) {
  if (!p || !p.vol) return null;
  const v = p.vol;
  const items = [
    ["左肩", v.leftV],
    ["ヘッド", v.headV],
    ["右肩", v.rightV],
    ["ブレイク", v.breakV],
  ];
  const max = Math.max(...items.map((x) => x[1]), 1);
  const col = p.kind === "inverse" ? "var(--up)" : "var(--down)";
  const lab = v.profile === "ideal" ? "理想的" : v.profile === "partial" ? "部分的に合致" : "不一致";
  const cls = v.profile === "ideal" ? "vp-good" : v.profile === "partial" ? "vp-mid" : "vp-weak";
  return (
    <div className="volprof">
      <div className="volprof-head">
        <span className="eyebrow">形成期間の出来高</span>
        <span className={`vp-badge ${cls}`}>{lab}</span>
      </div>
      <div className="vp-bars">
        {items.map(([name, val], i) => (
          <div key={name} className="vp-col">
            <div className="vp-track">
              <div
                className="vp-fill"
                style={{ height: `${Math.max(4, (val / max) * 100)}%`, background: name === "ブレイク" ? col : "var(--muted2)" }}
              />
            </div>
            <span className="vp-val">{fmtVol(val, cur)}</span>
            <span className="vp-name">{name}</span>
          </div>
        ))}
      </div>
      <p className="vp-read">{volReading(p)}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  予測カード（こう動けば〜が出そう）                                  */
/* ------------------------------------------------------------------ */
function projectionReading(p, proj, money, last) {
  const pct = (v) => {
    const r = ((v - last) / last) * 100;
    return `${r >= 0 ? "+" : ""}${r.toFixed(1)}%`;
  };
  if (!p) {
    return `明確な三尊・逆三尊は未検出です。直近の25日線の傾きをそのまま延長すると、16営業日先で概ね ${money(proj.end)}（現在値比 ${pct(proj.end)}）あたりの想定です。あくまでトレンド延長の参考で、シグナルではありません。`;
  }
  const N = money(p.neckLevel), T = money(p.target), S = money(p.stop);
  if (p.kind === "inverse") {
    return p.status === "confirmed"
      ? `逆三尊は完成済み。ネックライン ${N} 付近への押し目（リテスト）を挟みつつ、計測目標 ${T}（現在値比 ${pct(p.target)}）を目指す展開が想定されます。${S} 割れはパターン否定の目安です。`
      : `あと「出来高を伴ってネックライン ${N} を明確に上抜け」れば逆三尊が完成します。完成後の計測目標は ${T}（現在値比 ${pct(p.target)}）。逆に ${S} を割ると不成立（パターン崩れ）です。`;
  }
  return p.status === "confirmed"
    ? `三尊は完成済み。ネックライン ${N} 付近への戻りを挟みつつ、計測目標 ${T}（現在値比 ${pct(p.target)}）方向への下落が想定されます。${S} 超えはパターン否定の目安です。`
    : `あと「出来高を伴ってネックライン ${N} を明確に割り込め」ば三尊が完成します。完成後の計測目標は ${T}（現在値比 ${pct(p.target)}）。逆に ${S} を超えると不成立です。`;
}

function ProjectionCard({ p, proj, money, last }) {
  if (!proj) return null;
  const tone = !p ? "mid" : p.kind === "inverse" ? "up" : "down";
  const headline = !p
    ? "想定シナリオ（トレンド延長）"
    : p.kind === "inverse"
    ? p.status === "confirmed"
      ? "想定シナリオ：逆三尊・上昇継続"
      : "想定シナリオ：逆三尊の完成待ち"
    : p.status === "confirmed"
    ? "想定シナリオ：三尊・下落継続"
    : "想定シナリオ：三尊の完成待ち";
  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">こう動けば（予測）</span>
        <span className={`proj-tag t-${tone}`}>{headline}</span>
      </div>
      <p className="proj-read">{projectionReading(p, proj, money, last)}</p>
      <div className="proj-note">点線はパターンが想定どおり進んだ場合の参考パスです（実際の値動きの予想ではありません）。</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  複数銘柄スキャナー                                                  */
/* ------------------------------------------------------------------ */
function ScannerCard({ rows, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card scanner">
      <button className="scan-head" onClick={() => setOpen((v) => !v)}>
        <span className="card-title">スキャナー：三尊・逆三尊の検出銘柄</span>
        <span className="scan-right">
          <span className="scan-count">{rows.length}</span>
          <ChevronDown size={16} style={{ transform: open ? "rotate(180deg)" : "none", transition: ".2s" }} />
        </span>
      </button>
      {open && (
        <div className="scan-list">
          {rows.length === 0 && <div className="pat-empty">現在、検出された銘柄はありません。</div>}
          {rows.map((r) => {
            const m = makeMoney(r.s.currency, r.last);
            const inv = r.pt.kind === "inverse";
            return (
              <button key={r.i} className="scan-row" onClick={() => onPick(r)}>
                <span className={`scan-badge ${inv ? "sb-up" : "sb-down"}`}>{inv ? "逆三尊" : "三尊"}</span>
                <span className="scan-name">
                  <b>{r.s.name}</b>
                  <i>{r.s.code} ・ {r.pt.status === "confirmed" ? "ブレイク確認" : "形成中"}</i>
                </span>
                <span className="scan-nums">
                  <span className="scan-price">{m(r.last)}</span>
                  <span className="scan-tgt" style={{ color: inv ? "var(--up)" : "var(--down)" }}>目標 {m(r.pt.target)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  マルチタイムフレーム（環境認識ボード）                              */
/* ------------------------------------------------------------------ */
function Sparkline({ values, color }) {
  const w = 62, h = 22, pad = 2;
  if (!values || values.length < 2) return <svg width={w} height={h} />;
  const min = Math.min(...values), max = Math.max(...values), rng = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
      const y = h - pad - ((v - min) / rng) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/* 市況バー：主要指標を常時表示。カードをクリックすると詳細チャートへ。 */
function MarketBar({ items, activeIdx, onPick }) {
  if (!items.length) return null;
  const fmt = (v) => (v < 1000 ? v.toFixed(2) : Math.round(v).toLocaleString());
  return (
    <div className="market-bar">
      <span className="market-bar-label">市況</span>
      {items.map((it) => {
        const up = it.changePct >= 0;
        return (
          <button
            key={it.name}
            className={`mkt-card ${it.i === activeIdx ? "mkt-card-on" : ""}`}
            onClick={() => onPick(it.i)}
            title={`${it.name} の詳細チャートを表示`}
          >
            <div className="mkt-card-top">
              <span className="mkt-name">{it.name}</span>
              <Sparkline values={it.spark} color={`var(--${up ? "up" : "down"})`} />
            </div>
            <div className="mkt-card-bot">
              <span className="mkt-level">{fmt(it.last)}</span>
              <span className={`mkt-chg ${up ? "up" : "down"}`}>{up ? "▲" : "▼"} {Math.abs(it.changePct).toFixed(2)}%</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function MtfBoard({ mtf, tf, onPick }) {
  const arrow = (t) => (t.includes("上昇") ? "▲" : t.includes("下降") ? "▼" : "→");
  return (
    <div className="mtf">
      {["D", "W", "M"].map((k) => {
        const an = mtf[k].a;
        const tcls = an.trend.includes("上昇") ? "up" : an.trend.includes("下降") ? "down" : "mid";
        return (
          <button key={k} className={`mtf-cell ${k === tf ? "mtf-on" : ""}`} onClick={() => onPick(k)}>
            <div className="mtf-top">
              <span className="mtf-label">{TF[k].label}</span>
              <Sparkline values={mtf[k].spark} color={`var(--${an.change >= 0 ? "up" : "down"})`} />
            </div>
            <span className={`mtf-verdict v-${an.vColor}`}>{an.verdict}</span>
            <span className="mtf-sub">
              <i className={`mtf-arrow t-${tcls}`}>{arrow(an.trend)}</i>
              {an.trend}
              <span className="mtf-rsi">RSI {an.last.rsi != null ? an.last.rsi.toFixed(0) : "—"}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FactorList({ a }) {
  const Icon = ({ s }) =>
    s > 0 ? <TrendingUp size={14} /> : s < 0 ? <TrendingDown size={14} /> : <Minus size={14} />;
  return (
    <div className="factors">
      <span className="eyebrow">判断の根拠 ／ 検出パターン</span>
      <div className="factor-grid">
        {a.factors.map((f, i) => (
          <div key={i} className="factor">
            <span className={`factor-icon ${f.s > 0 ? "fi-up" : f.s < 0 ? "fi-down" : "fi-mid"}`}>
              <Icon s={f.s} />
            </span>
            <span className="factor-k">{f.k}</span>
            <span className="factor-v">{f.v}</span>
            {f.s !== 0 && (
              <span className={`factor-s ${f.s > 0 ? "fi-up" : "fi-down"}`}>
                {f.s > 0 ? "+" : ""}
                {f.s}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  メイン                                                              */
/* ------------------------------------------------------------------ */
export default function App() {
  const [stockList, setStockList] = useState(STOCKS);
  const [activeIdx, setActiveIdx] = useState(1); // 既定はトヨタ
  const [market, setMarket] = useState("JP");
  const [importOpen, setImportOpen] = useState(false);
  const [impCur, setImpCur] = useState("JPY");
  const [csvText, setCsvText] = useState("");
  const [importErr, setImportErr] = useState("");
  const fileRef = useRef(null);
  const multiFileRef = useRef(null);

  // スクリーニング
  const [screenOpen, setScreenOpen] = useState(false);
  const [scFilter, setScFilter] = useState("all"); // all | buy | sell | strong
  const [scSort, setScSort] = useState({ key: "score", dir: "desc" });

  const active = stockList[activeIdx];
  const [tf, setTf] = useState("D");

  // 日足・週足・月足をまとめて解析
  const mtf = useMemo(() => {
    const o = {};
    for (const k of ["D", "W", "M"]) {
      const ser = buildSeries(tfSeries(active.data, k));
      o[k] = { ser, a: analyze(ser, TF[k].unit), spark: ser.slice(-24).map((d) => d.close) };
    }
    return o;
  }, [active]);

  const series = mtf[tf].ser;
  const a = mtf[tf].a;
  const unit = TF[tf].unit;

  const cur = active.currency || "JPY";
  const jpDec = a.last.close >= 1000 ? 0 : 1;
  const dec = cur === "USD" ? 2 : jpDec;
  const money = makeMoney(cur, a.last.close);

  const [showProj, setShowProj] = useState(true);
  const proj = useMemo(() => buildProjection(series, a.pattern, a, TF[tf].step), [series, a, tf]);
  const extSeries = useMemo(() => {
    const base = series.map((d, idx) => (idx === series.length - 1 ? { ...d, proj: d.close } : { ...d, proj: null }));
    return [...base, ...proj.bars];
  }, [series, proj]);

  // 全銘柄の解析（重い：buildSeries+analyze を全銘柄ぶん）。
  // 銘柄数が多いと同期計算でUIが固まるため、チャンク分割で非同期に計算し、
  // 結果を scan（パターン検出）とスクリーニングの両方で共有する。
  // ※ analyze は内部で detectPattern を呼び pattern を返すので、別途呼ばない。
  const [analyzed, setAnalyzed] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const list = stockList;
    const unit = TF[tf].unit;
    const result = [];
    let i = 0;
    const CHUNK = 12;
    setAnalyzing(true);
    setAnalyzed([]);
    function step() {
      if (cancelled) return;
      const end = Math.min(i + CHUNK, list.length);
      for (; i < end; i++) {
        const s = list[i];
        const ser = buildSeries(tfSeries(s.data, tf));
        const an = analyze(ser, unit);
        result.push({ i, s, an, last: ser[ser.length - 1] });
      }
      setAnalyzed(result.slice()); // 計算しながら順次表示（プログレッシブ）
      if (i < list.length) {
        setTimeout(step, 0); // メインスレッドを譲ってUIを固めない
      } else {
        setAnalyzing(false);
      }
    }
    step();
    return () => { cancelled = true; };
  }, [stockList, tf]);

  // 市況指標を起動時に読み込み、銘柄リストへ追加（market:"IDX"／クリックで詳細表示）
  const idxLoaded = useRef(false);
  useEffect(() => {
    if (idxLoaded.current) return;
    idxLoaded.current = true;
    fetch("/market_data.csv?ts=" + Date.now())
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((text) => {
        const parsed = parseLongFormat(text);
        if (!parsed) return;
        const idx = parsed.map((s) => ({ ...s, market: "IDX", currency: "IDX" }));
        setStockList((prev) => (prev.some((s) => s.market === "IDX") ? prev : [...prev, ...idx]));
      })
      .catch(() => {}); // ファイルが無ければ市況バーは出ない
  }, []);

  // 市況バー用：IDX銘柄から水準・前日比・スパークラインを算出
  const marketItems = useMemo(() => {
    return stockList
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.market === "IDX")
      .map(({ s, i }) => {
        const closes = s.data.map((d) => d.close);
        const last = closes[closes.length - 1];
        const prev = closes[closes.length - 2] ?? last;
        return { i, name: s.name, last, changePct: prev ? ((last - prev) / prev) * 100 : 0, spark: closes.slice(-30) };
      });
  }, [stockList]);

  // 全銘柄スキャン（共有結果から三尊・逆三尊を抽出。指標は除外）
  const scan = useMemo(() => {
    return analyzed
      .filter((r) => r.an.pattern && r.s.market !== "IDX")
      .map((r) => ({ i: r.i, s: r.s, pt: r.an.pattern, last: r.last.close }))
      .sort((x, y) => (y.pt.status === "confirmed") - (x.pt.status === "confirmed") || y.pt.quality - x.pt.quality);
  }, [analyzed]);

  function pickScan(r) {
    setMarket(r.s.market);
    setActiveIdx(r.i);
  }

  // スクリーニング行（共有結果から。指標は除外）
  const screenRows = useMemo(() => {
    return analyzed.filter((r) => r.s.market !== "IDX").map((r) => {
      const s = r.s, an = r.an;
      return {
        i: r.i, code: s.code, name: s.name, market: s.market, currency: s.currency,
        verdict: an.verdict, vColor: an.vColor, vIdx: an.vIdx, score: an.score,
        trend: an.trend, rsi: r.last.rsi, close: an.last.close, changePct: an.changePct,
      };
    });
  }, [analyzed]);

  const screenView = useMemo(() => {
    let rows = screenRows;
    if (scFilter === "buy") rows = rows.filter((r) => r.vIdx >= 3);
    else if (scFilter === "sell") rows = rows.filter((r) => r.vIdx <= 1);
    else if (scFilter === "strong") rows = rows.filter((r) => Math.abs(r.score) >= 3);
    const dir = scSort.dir === "asc" ? 1 : -1;
    const k = scSort.key;
    return [...rows].sort((a, b) => {
      const av = a[k], bv = b[k];
      if (typeof av === "string") return String(av).localeCompare(String(bv)) * dir;
      return ((av ?? -Infinity) - (bv ?? -Infinity)) * dir;
    });
  }, [screenRows, scFilter, scSort]);

  function openStock(i, mkt) {
    setActiveIdx(i);
    setMarket(mkt);
    setScreenOpen(false);
  }
  function scPrice(r) {
    if (r.currency === "USD") return r.close.toFixed(2);
    return r.close >= 1000 ? Math.round(r.close).toLocaleString() : r.close.toFixed(1);
  }
  function toggleSort(key) {
    setScSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));
  }

  const visible = stockList.map((s, i) => ({ s, i })).filter(({ s }) => s.market === market);

  function switchMarket(m) {
    setMarket(m);
    const first = stockList.findIndex((s) => s.market === m);
    if (first >= 0) setActiveIdx(first);
  }

  // CSVテキスト → 行配列（タブ/スペース区切りにも一応対応）
  function parseCsvRows(text) {
    return Papa.parse(String(text).trim(), { header: false, skipEmptyLines: true }).data;
  }
  // 行配列 → ローソク足データ（ヘッダー/降順/カンマ桁区切りを自動処理）。30行未満は null
  function rowsToBars(rows) {
    let r2 = rows
      .map((r) => (r.length >= 5 ? r : String(r[0] || "").split(/[\t ]+/)))
      .filter((r) => r.length >= 5 && !isNaN(parseFloat(r[1])) && !isNaN(parseFloat(r[4])));
    if (r2.length < 30) return null;
    const toDate = (s) => new Date(String(s).replace(/\//g, "-"));
    if (toDate(r2[0][0]) > toDate(r2[r2.length - 1][0])) r2 = r2.slice().reverse();
    const num = (x) => {
      const v = parseFloat(String(x).replace(/,/g, ""));
      return isNaN(v) ? 0 : v;
    };
    return r2.map((r) => ({
      date: String(r[0]).replace(/\//g, "-").slice(5) || String(r[0]),
      open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]),
      // 出来高は「最終列」を採用（Yahooの Date,O,H,L,C,Adj Close,Volume にも対応）
      volume: r.length > 5 ? num(r[r.length - 1]) : 0,
    }));
  }
  // 縦持ち（先頭列＝銘柄シンボル, 2列目＝日付）を銘柄ごとに分割。該当しなければ null
  function parseLongFormat(text) {
    const rows = parseCsvRows(text).filter((r) => Array.isArray(r) && r.length >= 6);
    if (rows.length < 30) return null;
    // 日付は「区切り文字(- か /)を含む」ものに限定。
    // これをしないと "1332" 等の4桁コードが new Date で「西暦1332年」と誤判定される。
    const isDate = (s) => /[-/]/.test(String(s)) && !isNaN(new Date(String(s).replace(/\//g, "-")).getTime());
    const looksLong = rows.filter((r) => !isDate(r[0]) && isDate(r[1])).length > rows.length * 0.6;
    if (!looksLong) return null;
    const groups = new Map();
    for (const r of rows) {
      const sym = String(r[0]).trim();
      if (!sym || isDate(r[0])) continue; // ヘッダー行などを除外
      if (!groups.has(sym)) groups.set(sym, []);
      groups.get(sym).push(r.slice(1)); // シンボル列を落として 日付,O,H,L,C,V に
    }
    const out = [];
    for (const [sym, grp] of groups) {
      const bars = rowsToBars(grp);
      if (!bars) continue;
      // 先頭列が "コード:社名" 形式なら分割（社名が無ければコードを名前に流用）
      const ci = sym.indexOf(":");
      const code = ci >= 0 ? sym.slice(0, ci).trim() : sym;
      const name = ci >= 0 ? sym.slice(ci + 1).trim() || code : sym;
      out.push({ code, name, data: bars });
    }
    return out.length ? out : null;
  }
  // 銘柄をまとめて銘柄リストへ追加し、スクリーニング画面を開く（同コードは置換）
  function addStocks(stocks) {
    const newMarket = impCur === "USD" ? "US" : "JP";
    const stamped = stocks.map((s) => ({ ...s, market: newMarket, currency: impCur }));
    const codes = new Set(stamped.map((s) => s.code));
    setStockList((prev) => {
      const kept = prev.filter((s) => !codes.has(s.code));
      if (stamped.length === 1) setActiveIdx(kept.length); // 単一なら詳細表示
      return [...kept, ...stamped];
    });
    setMarket(newMarket);
    setImportOpen(false);
    setCsvText("");
    if (stamped.length > 1) setScreenOpen(true);
  }

  // 貼り付け／単一ファイル：縦持ちを自動判別、なければ単一銘柄として取込
  function loadCsv(text) {
    setImportErr("");
    const long = parseLongFormat(text);
    if (long) { addStocks(long); return; }
    const bars = rowsToBars(parseCsvRows(text));
    if (!bars) {
      setImportErr("有効な行が30件以上必要です。日付, 始値, 高値, 安値, 終値, 出来高（出来高は無くてもOK）の順で入力してください。");
      return;
    }
    const newMarket = impCur === "USD" ? "US" : "JP";
    setStockList((prev) => {
      const others = prev.filter((s) => s.code !== "USER");
      setActiveIdx(others.length);
      return [...others, { code: "USER", name: "読み込みデータ", market: newMarket, currency: impCur, data: bars }];
    });
    setMarket(newMarket);
    setTf("D");
    setImportOpen(false);
    setCsvText("");
  }

  // 複数ファイル一括：1ファイル＝1銘柄（ファイル名が銘柄名）
  function onFiles(e) {
    const files = Array.from(e.target.files || []);
    if (e.target) e.target.value = "";
    if (!files.length) return;
    setImportErr("");
    const collected = [];
    const bad = [];
    let done = 0;
    files.forEach((f) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base = f.name.replace(/\.[^.]+$/, "");
        const bars = rowsToBars(parseCsvRows(String(reader.result)));
        if (bars) collected.push({ code: base, name: base, data: bars });
        else bad.push(f.name);
        if (++done === files.length) finishFiles(collected, bad);
      };
      reader.readAsText(f);
    });
  }
  function finishFiles(collected, bad) {
    if (!collected.length) {
      setImportErr(`有効なデータがありませんでした（各ファイル30行以上必要）。${bad.join(", ")}`);
      return;
    }
    if (bad.length) setImportErr(`${bad.length}件スキップしました：${bad.join(", ")}`);
    if (collected.length === 1) {
      // 1ファイルだけなら詳細表示へ
      const newMarket = impCur === "USD" ? "US" : "JP";
      const st = { ...collected[0], market: newMarket, currency: impCur };
      setStockList((prev) => {
        setActiveIdx(prev.length);
        return [...prev, st];
      });
      setMarket(newMarket);
      setImportOpen(false);
    } else {
      addStocks(collected);
    }
  }

  return (
    <div className="app">
      <style>{CSS}</style>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">罫</span>
          <div>
            <div className="brand-title">罫線アナライザー</div>
            <div className="brand-sub">日本株・米国株テクニカル分析 ／ KEISEN ANALYZER</div>
          </div>
        </div>
        <div className="header-actions">
          <button className={`import-btn ${screenOpen ? "import-btn-on" : ""}`} onClick={() => { setScreenOpen((v) => !v); setImportOpen(false); }}>
            <Activity size={14} /> スクリーニング
          </button>
          <button className="import-btn" onClick={() => { setImportOpen((v) => !v); setScreenOpen(false); }}>
            <Upload size={14} /> データ取込
          </button>
        </div>
      </header>

      <MarketBar items={marketItems} activeIdx={activeIdx} onPick={(i) => { setActiveIdx(i); setScreenOpen(false); }} />

      {importOpen && (
        <div className="import-panel">
          <div className="import-help">
            列の順は <b>日付, 始値, 高値, 安値, 終値, 出来高</b>。<b>Yahoo Finance</b>（Date,Open,High,Low,Close,Adj&nbsp;Close,Volume）や <b>Stooq</b> のCSVはそのまま貼り付けOK（ヘッダー行・新しい順でも自動処理／出来高は最終列を採用）。30行以上で分析できます。
            <br />
            <b>大量銘柄のスクリーニング</b>は2通り：①「複数ファイルを選択」で銘柄ごとのCSVをまとめて選ぶ（ファイル名が銘柄名）／②先頭列に銘柄コードを付けた<b>縦持ちCSV</b>（銘柄, 日付, 始値, 高値, 安値, 終値, 出来高）を貼り付けると自動で銘柄ごとに分割します。
          </div>
          <div className="cur-toggle">
            <span className="cur-label">通貨</span>
            <button className={`cur-btn ${impCur === "JPY" ? "cur-on" : ""}`} onClick={() => setImpCur("JPY")}>円 / 日本株</button>
            <button className={`cur-btn ${impCur === "USD" ? "cur-on" : ""}`} onClick={() => setImpCur("USD")}>$ / 米国株</button>
          </div>
          <textarea
            className="import-area"
            placeholder={"2026/01/06,2810,2845,2790,2830,18500000\n2026/01/07,2830,2860,2815,2842,16200000\n…"}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
          {importErr && <div className="import-err"><AlertTriangle size={13} /> {importErr}</div>}
          <div className="import-actions">
            <button className="btn-primary" onClick={() => loadCsv(csvText)} disabled={!csvText.trim()}>
              貼り付けたデータを分析
            </button>
            <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
              CSVファイルを選択
            </button>
            <button className="btn-ghost" onClick={() => multiFileRef.current?.click()}>
              複数ファイルを選択（一括）
            </button>
            <input ref={fileRef} type="file" accept=".csv,.txt" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; const rd = new FileReader(); rd.onload = () => loadCsv(String(rd.result)); rd.readAsText(f); }} style={{ display: "none" }} />
            <input ref={multiFileRef} type="file" accept=".csv,.txt" multiple onChange={onFiles} style={{ display: "none" }} />
          </div>
        </div>
      )}

      {screenOpen && (
        <div className="screener-overlay">
          <div className="screener-head">
            <div className="screener-title">
              スクリーニング
              <span className="screener-sub">{TF[tf].unit}足 ・ {screenView.length}/{screenRows.length} 銘柄{analyzing ? `（計算中… ${screenRows.length}/${stockList.length}）` : ""}</span>
            </div>
            <button className="btn-ghost" onClick={() => setScreenOpen(false)}>閉じる ✕</button>
          </div>
          <div className="screener-filters">
            {[["all", "すべて"], ["buy", "買い系"], ["sell", "売り系"], ["strong", "強いシグナル"]].map(([k, l]) => (
              <button key={k} className={`chip ${scFilter === k ? "chip-on" : ""}`} onClick={() => setScFilter(k)}>{l}</button>
            ))}
            <span className="screener-hint">行をクリックで詳細チャートへ／列見出しで並べ替え</span>
          </div>
          <div className="screener-table-wrap">
            <table className="screener-table">
              <thead>
                <tr>
                  <th onClick={() => toggleSort("code")}>コード{scSort.key === "code" ? (scSort.dir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th onClick={() => toggleSort("name")}>銘柄{scSort.key === "name" ? (scSort.dir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th onClick={() => toggleSort("vIdx")}>判定{scSort.key === "vIdx" ? (scSort.dir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th className="num" onClick={() => toggleSort("score")}>スコア{scSort.key === "score" ? (scSort.dir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th onClick={() => toggleSort("trend")}>トレンド{scSort.key === "trend" ? (scSort.dir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th className="num" onClick={() => toggleSort("rsi")}>RSI{scSort.key === "rsi" ? (scSort.dir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th className="num" onClick={() => toggleSort("close")}>終値{scSort.key === "close" ? (scSort.dir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th className="num" onClick={() => toggleSort("changePct")}>騰落率{scSort.key === "changePct" ? (scSort.dir === "desc" ? " ▼" : " ▲") : ""}</th>
                </tr>
              </thead>
              <tbody>
                {screenView.map((r) => (
                  <tr key={r.code + "_" + r.i} onClick={() => openStock(r.i, r.market)}>
                    <td className="sc-code">{r.code}</td>
                    <td className="sc-name">{r.name}</td>
                    <td><span className={`verdict-badge v-${r.vColor}`}>{r.verdict}</span></td>
                    <td className="num sc-strong">{r.score > 0 ? "+" : ""}{r.score.toFixed(1)}</td>
                    <td>{r.trend}</td>
                    <td className="num">{r.rsi != null ? r.rsi.toFixed(0) : "–"}</td>
                    <td className="num">{scPrice(r)}</td>
                    <td className={`num ${r.changePct >= 0 ? "sc-up" : "sc-down"}`}>{r.changePct >= 0 ? "+" : ""}{r.changePct.toFixed(2)}%</td>
                  </tr>
                ))}
                {screenView.length === 0 && (
                  <tr><td colSpan={8} className="screener-empty">該当する銘柄がありません。フィルターを変えるか、データを取り込んでください。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* スクリーナー表示中は詳細チャートを描画しない（再描画コスト削減でフィルタ操作を軽く保つ） */}
      {!screenOpen && (<>
      <div className="market-switch">
        <button className={`mkt ${market === "JP" ? "mkt-on" : ""}`} onClick={() => switchMarket("JP")}>日本株</button>
        <button className={`mkt ${market === "US" ? "mkt-on" : ""}`} onClick={() => switchMarket("US")}>米国株</button>
      </div>

      <div className="tabs">
        {visible.map(({ s, i }) => (
          <button key={s.code + i} className={`tab ${i === activeIdx ? "tab-on" : ""}`} onClick={() => setActiveIdx(i)}>
            <span className="tab-code">{s.code}</span>
            <span className="tab-name">{s.name}</span>
          </button>
        ))}
      </div>

      <div className="quote">
        <div className="quote-main">
          {cur === "USD" && <span className="quote-cur">$</span>}
          <span className="quote-price">{fmt(a.last.close, dec)}</span>
          {cur === "JPY" && <span className="quote-unit">円</span>}
          <span className={`quote-chg ${a.change >= 0 ? "up" : "down"}`}>
            {a.change >= 0 ? "▲" : "▼"} {fmt(Math.abs(a.change), dec)}（{a.changePct >= 0 ? "+" : ""}
            {a.changePct.toFixed(2)}%）
          </span>
        </div>
        <div className="quote-meta">
          <span><i>始</i>{fmt(a.last.open, dec)}</span>
          <span><i>高</i>{fmt(a.last.high, dec)}</span>
          <span><i>安</i>{fmt(a.last.low, dec)}</span>
          <span><i>出来高</i>{fmtVol(a.last.volume, cur)}</span>
        </div>
      </div>

      <SignalGauge a={a} />

      <MtfBoard mtf={mtf} tf={tf} onPick={setTf} />

      <div className="stat-row">
        <Stat label="トレンド" value={a.trend} tone={a.trend.includes("上昇") ? "up" : a.trend.includes("下降") ? "down" : "mid"} icon={<Activity size={13} />} />
        <Stat label="抵抗線" value={money(a.resistance)} tone="down" />
        <Stat label="支持線" value={money(a.support)} tone="up" />
        <Stat label="RSI(14)" value={a.last.rsi?.toFixed(1) ?? "—"} tone={a.last.rsi >= 70 ? "down" : a.last.rsi <= 30 ? "up" : "mid"} />
      </div>

      <section className="card">
        <div className="card-head">
          <span className="card-title">【{TF[tf].label}】ローソク足 ・ 移動平均 ・ ボリンジャー</span>
          <div className="legend">
            <L c="--sma5" t={`5${unit}`} /><L c="--sma25" t={`25${unit}`} /><L c="--sma75" t={`75${unit}`} /><L c="--bb" t="±2σ" />
            <button className={`proj-toggle ${showProj ? "pt-on" : ""}`} onClick={() => setShowProj((v) => !v)}>予測</button>
          </div>
        </div>
        <PriceChart series={showProj ? extSeries : series} pattern={a.pattern} cur={cur} dec={dec} proj={showProj ? proj : null} unit={unit} />
        <div className="candle-key">
          <span><i className="sq up" />陽線（上昇）</span>
          <span><i className="sq down" />陰線（下落）</span>
          {a.pattern && <span><i className="sq" style={{ background: "var(--brass)" }} />ネックライン</span>}
          {showProj && <span><i className="sq" style={{ background: "var(--brass)", opacity: 0.7 }} />予測パス（点線）</span>}
        </div>
      </section>

      {showProj && <ProjectionCard p={a.pattern} proj={proj} money={money} last={a.last.close} />}

      <PatternCard p={a.pattern} money={money} />

      <ScannerCard rows={scan} onPick={pickScan} />

      <section className="card">
        <div className="card-head">
          <span className="card-title">出来高</span>
          {a.pattern && <span className="card-note">明るいバー＝形成期間／点線＝形成期平均</span>}
        </div>
        <VolumeChart series={showProj ? extSeries : series} cur={cur} pattern={a.pattern} />
        {a.pattern && <VolumeProfile p={a.pattern} cur={cur} />}
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">RSI（14）</span>
          <span className="card-note">70以上＝買われすぎ／30以下＝売られすぎ</span>
        </div>
        <RsiChart series={showProj ? extSeries : series} />
      </section>

      <section className="card">
        <div className="card-head">
          <span className="card-title">MACD</span>
          <div className="legend"><L c="--macd" t="MACD" /><L c="--signal" t="シグナル" /></div>
        </div>
        <MacdChart series={showProj ? extSeries : series} />
      </section>

      <section className="card">
        <FactorList a={a} />
      </section>

      <footer className="disclaimer">
        <AlertTriangle size={14} />
        <p>
          本ツールは学習・情報提供を目的としたテクニカル分析であり、投資助言ではありません。サンプル銘柄のデータは擬似生成された架空の値です。実際の売買判断はご自身の責任で、最新の市場情報をご確認ください。
        </p>
      </footer>
      </>)}
    </div>
  );
}

function Stat({ label, value, tone, icon }) {
  return (
    <div className="stat">
      <span className="stat-label">{icon}{label}</span>
      <span className={`stat-value t-${tone || "mid"}`}>{value}</span>
    </div>
  );
}
function L({ c, t }) {
  return (
    <span className="lg">
      <i style={{ background: `var(${c})` }} />
      {t}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  スタイル                                                            */
/* ------------------------------------------------------------------ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap');

.app{
  --bg:#0b101c; --bg2:#0e1424; --panel:#121a2e; --panel2:#16203a;
  --line:#27314f; --grid:#1a2238; --hover:#1b2440;
  --text:#e9edf6; --muted:#8b97b6; --muted2:#586489;
  --up:#ef5a4d; --down:#3f8fd6; --up-dim:#7a3833; --down-dim:#2c4f74;
  --sma5:#e0a24a; --sma25:#2dc0c4; --sma75:#9d7bea; --bb:#4a5680;
  --rsi:#cf86d8; --macd:#2dc0c4; --signal:#e0a24a;
  --brass:#c8a455;
  --font-jp:'Noto Sans JP','Hiragino Sans','Yu Gothic',system-ui,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;
  background:var(--bg); color:var(--text); font-family:var(--font-jp);
  min-height:100vh; max-width:920px; margin:0 auto; padding:14px;
  -webkit-font-smoothing:antialiased;
}
.app *{box-sizing:border-box;}

.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.brand{display:flex;align-items:center;gap:11px;}
.brand-mark{
  width:38px;height:38px;display:grid;place-items:center;font-size:22px;font-weight:700;
  color:var(--bg);background:var(--brass);border-radius:7px;
  box-shadow:0 0 0 1px #d9bd7a inset, 0 4px 14px rgba(200,164,85,.22);
}
.brand-title{font-weight:700;font-size:16px;letter-spacing:.04em;}
.brand-sub{font-size:10px;color:var(--muted);letter-spacing:.14em;margin-top:1px;}
.import-btn{
  display:flex;align-items:center;gap:6px;font-family:var(--font-jp);font-size:12px;font-weight:500;
  color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:7px;
  padding:8px 12px;cursor:pointer;transition:.15s;
}
.import-btn:hover{border-color:var(--brass);}

.import-panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px;}
.import-help{font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:10px;}
.import-help b{color:var(--text);font-family:var(--font-mono);font-weight:500;}
.import-area{
  width:100%;height:96px;background:var(--bg2);border:1px solid var(--line);border-radius:7px;
  color:var(--text);font-family:var(--font-mono);font-size:12px;padding:10px;resize:vertical;
}
.import-area:focus{outline:none;border-color:var(--brass);}
.import-err{display:flex;align-items:center;gap:6px;color:var(--up);font-size:12px;margin-top:8px;}
.import-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}
.btn-primary{
  font-family:var(--font-jp);font-size:12px;font-weight:700;color:var(--bg);background:var(--brass);
  border:none;border-radius:7px;padding:9px 16px;cursor:pointer;
}
.btn-primary:disabled{opacity:.4;cursor:not-allowed;}
.btn-ghost{
  font-family:var(--font-jp);font-size:12px;color:var(--text);background:transparent;
  border:1px solid var(--line);border-radius:7px;padding:9px 14px;cursor:pointer;
}
.btn-ghost:hover{border-color:var(--brass);}

.header-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}

/* 市況バー */
.market-bar{display:flex;align-items:stretch;gap:8px;overflow-x:auto;padding:4px 2px 10px;margin-bottom:6px;}
.market-bar-label{display:flex;align-items:center;font-family:var(--font-jp);font-size:11px;font-weight:700;color:var(--brass);letter-spacing:.1em;writing-mode:vertical-rl;padding:2px 0;flex:0 0 auto;}
.mkt-card{flex:0 0 auto;min-width:128px;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:8px 11px;display:flex;flex-direction:column;gap:4px;cursor:pointer;text-align:left;font-family:inherit;transition:.15s;}
.mkt-card:hover{border-color:var(--brass);background:var(--panel2);}
.mkt-card-on{border-color:var(--brass);box-shadow:0 0 0 1px var(--brass) inset;background:var(--panel2);}
.mkt-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.mkt-name{font-family:var(--font-jp);font-size:12px;font-weight:600;color:var(--muted);white-space:nowrap;}
.mkt-card-bot{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}
.mkt-level{font-family:var(--font-mono);font-size:15px;font-weight:600;color:var(--text);}
.mkt-chg{font-family:var(--font-mono);font-size:11.5px;font-weight:600;white-space:nowrap;}
.mkt-chg.up{color:var(--up);}
.mkt-chg.down{color:var(--down);}
.import-btn-on{border-color:var(--brass);background:var(--panel2);box-shadow:0 0 0 1px var(--brass) inset;}

/* スクリーニング */
.screener-overlay{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px;}
.screener-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}
.screener-title{font-family:var(--font-jp);font-size:16px;font-weight:700;color:var(--text);}
.screener-sub{font-size:12px;font-weight:400;color:var(--muted);margin-left:10px;}
.screener-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;}
.chip{font-family:var(--font-jp);font-size:12px;color:var(--text);background:var(--bg2);border:1px solid var(--line);border-radius:999px;padding:6px 14px;cursor:pointer;transition:.15s;}
.chip:hover{border-color:var(--brass);}
.chip-on{color:var(--bg);background:var(--brass);border-color:var(--brass);font-weight:700;}
.screener-hint{font-size:11px;color:var(--muted);margin-left:auto;}
.screener-table-wrap{max-height:62vh;overflow:auto;border:1px solid var(--line);border-radius:9px;}
.screener-table{width:100%;border-collapse:collapse;font-family:var(--font-jp);font-size:13px;}
.screener-table thead th{position:sticky;top:0;background:var(--panel2);color:var(--muted);font-weight:600;text-align:left;padding:9px 12px;cursor:pointer;user-select:none;white-space:nowrap;border-bottom:1px solid var(--line);}
.screener-table thead th:hover{color:var(--text);}
.screener-table th.num,.screener-table td.num{text-align:right;font-family:var(--font-mono);}
.screener-table tbody tr{border-bottom:1px solid var(--line);cursor:pointer;transition:.1s;}
.screener-table tbody tr:hover{background:var(--panel2);}
.screener-table td{padding:9px 12px;color:var(--text);white-space:nowrap;}
.sc-code{font-family:var(--font-mono);color:var(--muted);}
.sc-name{font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;}
.sc-strong{font-weight:700;}
.sc-up{color:var(--up);}
.sc-down{color:var(--down);}
.verdict-badge{font-weight:700;font-size:12.5px;}
.verdict-badge.v-up{color:var(--up);}
.verdict-badge.v-down{color:var(--down);}
.verdict-badge.v-neutral{color:var(--brass);}
.screener-empty{text-align:center;color:var(--muted);padding:28px 12px;}

.cur-toggle{display:flex;align-items:center;gap:7px;margin-bottom:10px;}
.cur-label{font-size:11px;color:var(--muted);margin-right:2px;}
.cur-btn{font-family:var(--font-jp);font-size:11.5px;color:var(--muted);background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:6px 11px;cursor:pointer;transition:.15s;}
.cur-btn.cur-on{color:var(--bg);background:var(--brass);border-color:var(--brass);font-weight:700;}

.market-switch{display:inline-flex;gap:2px;background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:3px;margin-bottom:12px;}
.mkt{font-family:var(--font-jp);font-size:13px;font-weight:500;color:var(--muted);background:transparent;border:none;border-radius:7px;padding:8px 22px;cursor:pointer;transition:.15s;}
.mkt-on{color:var(--text);background:var(--panel2);box-shadow:0 0 0 1px var(--brass) inset;}

.mtf{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;}
.mtf-cell{display:flex;flex-direction:column;gap:6px;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px 11px;cursor:pointer;transition:.15s;}
.mtf-cell:hover{border-color:var(--muted2);}
.mtf-on{border-color:var(--brass);background:var(--panel2);box-shadow:0 0 0 1px var(--brass) inset;}
.mtf-top{display:flex;align-items:center;justify-content:space-between;gap:6px;}
.mtf-label{font-size:12px;font-weight:700;color:var(--text);letter-spacing:.04em;}
.mtf-cell:not(.mtf-on) .mtf-label{color:var(--muted);}
.mtf-verdict{font-size:15px;font-weight:700;letter-spacing:.02em;}
.mtf-verdict.v-up{color:var(--up);} .mtf-verdict.v-down{color:var(--down);} .mtf-verdict.v-neutral{color:var(--brass);}
.mtf-sub{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--muted);font-family:var(--font-jp);flex-wrap:wrap;}
.mtf-arrow{font-style:normal;font-family:var(--font-mono);}
.mtf-arrow.t-up{color:var(--up);} .mtf-arrow.t-down{color:var(--down);} .mtf-arrow.t-mid{color:var(--muted);}
.mtf-rsi{font-family:var(--font-mono);color:var(--muted2);margin-left:2px;}
@media (max-width:560px){
  .mtf{gap:6px;}
  .mtf-cell{padding:9px 8px;}
  .mtf-verdict{font-size:13px;}
  .mtf-sub{font-size:9.5px;}
}

.tabs{display:flex;gap:7px;overflow-x:auto;padding-bottom:4px;margin-bottom:14px;scrollbar-width:none;}
.tabs::-webkit-scrollbar{display:none;}
.tab{
  flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:1px;
  background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:8px 13px;cursor:pointer;transition:.15s;min-width:96px;
}
.tab-on{border-color:var(--brass);background:var(--panel2);box-shadow:0 0 0 1px var(--brass) inset;}
.tab-code{font-family:var(--font-mono);font-size:11px;color:var(--muted);letter-spacing:.05em;}
.tab-on .tab-code{color:var(--brass);}
.tab-name{font-size:13px;font-weight:500;}

.quote{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px;margin-bottom:14px;padding:0 2px;}
.quote-main{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.quote-cur{font-family:var(--font-mono);font-size:22px;font-weight:700;color:var(--muted);}
.quote-price{font-family:var(--font-mono);font-size:32px;font-weight:700;letter-spacing:-.01em;}
.quote-unit{font-size:13px;color:var(--muted);}
.quote-chg{font-family:var(--font-mono);font-size:14px;font-weight:500;}
.quote-chg.up{color:var(--up);} .quote-chg.down{color:var(--down);}
.quote-meta{display:flex;gap:14px;flex-wrap:wrap;font-family:var(--font-mono);font-size:12px;color:var(--text);}
.quote-meta i{font-style:normal;color:var(--muted);font-family:var(--font-jp);margin-right:5px;font-size:11px;}

/* ゲージ（シグネチャー） */
.gauge{
  background:linear-gradient(180deg,var(--panel2),var(--panel));
  border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px;
  box-shadow:0 0 0 1px rgba(200,164,85,.08) inset;
}
.gauge-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.eyebrow{font-size:10px;letter-spacing:.2em;color:var(--muted);text-transform:uppercase;}
.verdict{font-size:24px;font-weight:700;letter-spacing:.04em;}
.v-up{color:var(--up);} .v-down{color:var(--down);} .v-neutral{color:var(--brass);}
.gauge-track{
  position:relative;height:12px;border-radius:6px;margin:6px 0 10px;
  background:linear-gradient(90deg,var(--down) 0%,#34507a 30%,var(--muted2) 50%,#7a4a45 70%,var(--up) 100%);
  box-shadow:0 1px 4px rgba(0,0,0,.4) inset;
}
.gauge-tick{position:absolute;top:-3px;width:1px;height:18px;background:rgba(255,255,255,.18);transform:translateX(-50%);}
.gauge-needle{
  position:absolute;top:50%;width:3px;height:26px;background:var(--text);border-radius:2px;
  transform:translate(-50%,-50%);box-shadow:0 0 0 2px var(--bg),0 0 10px rgba(255,255,255,.5);
  transition:left .5s cubic-bezier(.34,1.3,.5,1);
}
.gauge-labels{display:flex;justify-content:space-between;}
.gz{font-size:10.5px;color:var(--muted);flex:1;text-align:center;}
.gz:first-child{text-align:left;} .gz:last-child{text-align:right;}
.gz-on{color:var(--text);font-weight:700;}
.gauge-score{margin-top:10px;font-size:11px;color:var(--muted);font-family:var(--font-mono);}
.gauge-score b{color:var(--text);}

.stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px;}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:10px;}
.stat-label{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--muted);margin-bottom:5px;}
.stat-value{font-family:var(--font-mono);font-size:15px;font-weight:500;display:block;line-height:1.2;}
.t-up{color:var(--up);} .t-down{color:var(--down);} .t-mid{color:var(--text);}

.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 10px 10px;margin-bottom:14px;}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 4px 8px;flex-wrap:wrap;}
.card-title{font-size:13px;font-weight:700;letter-spacing:.02em;}
.card-note{font-size:10.5px;color:var(--muted);}
.legend{display:flex;gap:10px;flex-wrap:wrap;}
.lg{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--muted);font-family:var(--font-mono);}
.lg i{width:12px;height:2px;border-radius:1px;display:inline-block;}
.candle-key{display:flex;gap:16px;padding:6px 4px 2px;font-size:10.5px;color:var(--muted);}
.candle-key i.sq{width:9px;height:9px;border-radius:1px;display:inline-block;margin-right:5px;vertical-align:-1px;}
.candle-key .sq.up{background:var(--up);} .candle-key .sq.down{background:var(--down);}

.pattern-card .pat-badge{font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;letter-spacing:.03em;}
.pb-up{color:var(--up);background:rgba(239,90,77,.14);box-shadow:0 0 0 1px rgba(239,90,77,.4) inset;}
.pb-up-soft{color:var(--up);background:rgba(239,90,77,.08);}
.pb-down{color:var(--down);background:rgba(63,143,214,.14);box-shadow:0 0 0 1px rgba(63,143,214,.4) inset;}
.pb-down-soft{color:var(--down);background:rgba(63,143,214,.08);}
.pat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--grid);border:1px solid var(--grid);border-radius:9px;overflow:hidden;margin:4px 2px 0;}
.pat-cell{background:var(--panel);padding:10px 11px;display:flex;flex-direction:column;gap:3px;}
.pat-k{font-size:10px;color:var(--muted);}
.pat-v{font-family:var(--font-mono);font-size:14px;font-weight:500;}
.pat-read{font-size:12.5px;line-height:1.85;color:var(--text);margin:12px 4px 2px;padding:11px 12px;background:var(--bg2);border-left:2px solid var(--brass);border-radius:0 7px 7px 0;}
.pat-empty{font-size:12.5px;line-height:1.8;color:var(--muted);padding:6px 4px 2px;}

.proj-toggle{font-family:var(--font-jp);font-size:11px;color:var(--muted);background:var(--bg2);border:1px solid var(--line);border-radius:5px;padding:3px 10px;cursor:pointer;margin-left:2px;}
.proj-toggle.pt-on{color:var(--bg);background:var(--brass);border-color:var(--brass);font-weight:700;}
.proj-tag{font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;}
.proj-tag.t-up{color:var(--up);background:rgba(239,90,77,.12);}
.proj-tag.t-down{color:var(--down);background:rgba(63,143,214,.12);}
.proj-tag.t-mid{color:var(--brass);background:rgba(200,164,85,.12);}
.proj-read{font-size:12.5px;line-height:1.9;color:var(--text);margin:10px 4px 0;padding:11px 12px;background:var(--bg2);border-left:2px solid var(--brass);border-radius:0 7px 7px 0;}
.proj-note{font-size:10.5px;color:var(--muted);margin:8px 4px 0;line-height:1.6;}

.scanner{padding:0;overflow:hidden;}
.scan-head{width:100%;display:flex;align-items:center;justify-content:space-between;background:transparent;border:none;cursor:pointer;padding:14px 14px;color:var(--text);font-family:var(--font-jp);}
.scan-right{display:flex;align-items:center;gap:8px;color:var(--muted);}
.scan-count{font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--bg);background:var(--brass);border-radius:11px;min-width:22px;height:22px;display:inline-grid;place-items:center;padding:0 6px;}
.scan-list{border-top:1px solid var(--grid);}
.scan-row{width:100%;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:11px;padding:11px 14px;background:transparent;border:none;border-top:1px solid var(--grid);cursor:pointer;text-align:left;transition:.12s;}
.scan-row:first-child{border-top:none;}
.scan-row:hover{background:var(--hover);}
.scan-badge{font-size:11px;font-weight:700;padding:4px 9px;border-radius:6px;white-space:nowrap;}
.sb-up{color:var(--up);background:rgba(239,90,77,.13);}
.sb-down{color:var(--down);background:rgba(63,143,214,.13);}
.scan-name{display:flex;flex-direction:column;gap:2px;min-width:0;}
.scan-name b{font-size:13px;font-weight:600;color:var(--text);}
.scan-name i{font-style:normal;font-size:10.5px;color:var(--muted);font-family:var(--font-mono);}
.scan-nums{display:flex;flex-direction:column;align-items:flex-end;gap:2px;}
.scan-price{font-family:var(--font-mono);font-size:13px;font-weight:500;color:var(--text);}
.scan-tgt{font-family:var(--font-mono);font-size:10.5px;}

.volprof{margin-top:12px;padding-top:12px;border-top:1px solid var(--grid);}
.volprof-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:0 2px;}
.vp-badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:6px;}
.vp-good{color:var(--up);background:rgba(239,90,77,.13);}
.vp-mid{color:var(--brass);background:rgba(200,164,85,.13);}
.vp-weak{color:var(--muted);background:var(--hover);}
.vp-bars{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;align-items:end;padding:0 4px;}
.vp-col{display:flex;flex-direction:column;align-items:center;gap:5px;}
.vp-track{width:100%;height:56px;display:flex;align-items:flex-end;background:var(--bg2);border-radius:5px;overflow:hidden;}
.vp-fill{width:100%;border-radius:5px 5px 0 0;transition:height .4s ease;}
.vp-val{font-family:var(--font-mono);font-size:10px;color:var(--text);}
.vp-name{font-size:10.5px;color:var(--muted);}
.vp-read{font-size:12px;line-height:1.8;color:var(--text);margin:12px 4px 0;padding:10px 12px;background:var(--bg2);border-left:2px solid var(--brass);border-radius:0 7px 7px 0;}
@media (max-width:560px){.pat-grid{grid-template-columns:repeat(2,1fr);}}

.factors{padding:2px 4px;}
.factor-grid{display:flex;flex-direction:column;gap:1px;margin-top:10px;}
.factor{display:grid;grid-template-columns:auto auto 1fr auto;align-items:center;gap:10px;padding:9px 4px;border-top:1px solid var(--grid);}
.factor:first-child{border-top:none;}
.factor-icon{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;}
.fi-up{color:var(--up);} .fi-down{color:var(--down);} .fi-mid{color:var(--muted);}
.factor-icon.fi-up{background:rgba(239,90,77,.12);}
.factor-icon.fi-down{background:rgba(63,143,214,.12);}
.factor-icon.fi-mid{background:var(--hover);}
.factor-k{font-family:var(--font-mono);font-size:11px;color:var(--muted);min-width:42px;}
.factor-v{font-size:12.5px;color:var(--text);}
.factor-s{font-family:var(--font-mono);font-size:12px;font-weight:700;}

.tip{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-family:var(--font-mono);box-shadow:0 6px 20px rgba(0,0,0,.4);}
.tip-date{font-size:11px;color:var(--brass);margin-bottom:6px;letter-spacing:.05em;}
.tip-row{display:flex;justify-content:space-between;gap:18px;font-size:11.5px;line-height:1.7;}
.tip-k{color:var(--muted);} .tip-v{color:var(--text);font-weight:500;}

.disclaimer{display:flex;gap:9px;align-items:flex-start;background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:var(--muted);}
.disclaimer svg{flex:0 0 auto;margin-top:2px;color:var(--brass);}
.disclaimer p{font-size:11px;line-height:1.7;margin:0;}

@media (max-width:560px){
  .stat-row{grid-template-columns:repeat(2,1fr);}
  .quote-price{font-size:27px;}
  .verdict{font-size:21px;}
}
@media (prefers-reduced-motion:reduce){
  .gauge-needle{transition:none;}
}
`;
