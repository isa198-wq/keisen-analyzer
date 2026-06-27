// === 自動生成ファイル（手で編集しない）===
// 生成元: src/App.jsx ／ 生成コマンド: node build_analysis.mjs
// アプリ画面と全く同じ判定ロジックを Node から使うためのモジュールです。

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

function tfSeries(daily, tf) {
  if (tf === "D") return daily.slice(-160);
  if (tf === "W") return aggregate(daily, 5);
  return aggregate(daily, 21);
}

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

export { analyze, buildSeries, tfSeries, detectPattern };
