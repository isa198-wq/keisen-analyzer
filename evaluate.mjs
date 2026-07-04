// シグナルの自動答え合わせ（履歴の蓄積と成績集計）
//   - screen_daily.mjs が毎日 upsertEntry() で「その日のシグナル」を signals/history.jsonl に記録
//   - evaluate() が「過去シグナルのその後（5/10/20営業日後）」を集計して成績を返す
//   - 履歴が薄いときは seedHistory() が過去分を再現して補完（その日までのデータだけで判定＝未来は見ない）
//   価格は保存せずコードだけ保存し、リターンは常に最新CSV（分割調整済み）から日付で引くので、
//   後から株式分割があっても成績計算は壊れない。
//
// 単体実行:
//   node evaluate.mjs             … 蓄積済み履歴の成績を表示（窓別・レジーム別つき）
//   node evaluate.mjs --seed 250  … 過去250営業日ぶんを再現して履歴に補完してから表示
import fs from "node:fs";
import { analyze, buildSeries, tfSeries } from "./src/analysis.generated.mjs";

const ROOT = new URL(".", import.meta.url);
const HISTORY = new URL("./signals/history.jsonl", ROOT);
const HORIZONS = [5, 10, 20];
const CATS = { buys: 1, sells: -1, topsNew: -1, invsNew: 1 }; // 値は「勝ち」の方向
const REGIMES = ["up", "down", "range"];

export function loadHistory() {
  if (!fs.existsSync(HISTORY)) return [];
  const out = [];
  for (const line of fs.readFileSync(HISTORY, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 壊れた行は無視 */ }
  }
  return out;
}

export function saveHistory(entries) {
  const m = new Map(entries.map((e) => [e.date, e]));           // 日付でユニーク化（後勝ち）
  const sorted = [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  fs.mkdirSync(new URL("./signals/", ROOT), { recursive: true });
  fs.writeFileSync(HISTORY, sorted.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return sorted;
}

// その日のシグナルを記録（同じ日付の再実行は上書き）
export function upsertEntry(entry) {
  const h = loadHistory().filter((e) => e.date !== entry.date);
  h.push(entry);
  return saveHistory(h);
}

// 過去 nDays 営業日ぶんのシグナルを「その日までのデータだけ」で再現して履歴に補完する。
// 既に記録がある日付はスキップ。戻り値は補完した日数。
export function seedHistory(groups, nDays) {
  const anyBars = groups.values().next().value;
  const L = anyBars.length;
  const existing = new Set(loadHistory().map((e) => e.date));
  const entries = [];
  for (let k = nDays; k >= 1; k--) {
    const idx = L - 1 - k;
    if (idx < 80) continue;                                     // analyze に必要な最低本数
    const date = anyBars[idx].date;
    if (existing.has(date)) continue;
    const e = { date, buys: [], sells: [], topsNew: [], invsNew: [], seed: true };
    for (const [sym, bars] of groups) {
      if (bars.length !== L) continue;                          // 日付ズレのある銘柄は安全のためスキップ
      const ci = sym.indexOf(":");
      const code = ci >= 0 ? sym.slice(0, ci) : sym;
      const series = buildSeries(tfSeries(bars.slice(0, idx + 1), "D"));
      const a = analyze(series, "日");
      if (a.vIdx === 4) e.buys.push(code);                      // strong 運用と同じ条件
      else if (a.vIdx === 0) e.sells.push(code);
      const p = a.pattern;
      if (p && (p.kind === "top" || p.kind === "inverse") && p.broke && p.breakI === series.length - 1) {
        (p.kind === "top" ? e.topsNew : e.invsNew).push(code);  // 「ちょうどこの日に完成」だけを記録
      }
    }
    entries.push(e);
  }
  if (entries.length) saveHistory(loadHistory().concat(entries));
  return entries.length;
}

// --- 共有部品（evaluate 系の索引・集計。価格は常に最新CSVから日付で引く） ---
export function buildByCode(groups) {
  const byCode = new Map();
  for (const [sym, bars] of groups) {
    const ci = sym.indexOf(":");
    const code = ci >= 0 ? sym.slice(0, ci) : sym;
    byCode.set(code, { closes: bars.map((b) => b.close), idx: new Map(bars.map((b, i) => [b.date, i])) });
  }
  return byCode;
}

// 全銘柄に共通の日付グリッド＝最頻の本数を持つ銘柄群の日付列（上場が浅い銘柄等のズレを除外）
export function buildDateGrid(groups) {
  const counts = new Map();
  for (const bars of groups.values()) counts.set(bars.length, (counts.get(bars.length) || 0) + 1);
  let modeLen = 0, best = -1;
  for (const [len, n] of counts) if (n > best) { modeLen = len; best = n; }
  for (const bars of groups.values()) if (bars.length === modeLen) return bars.map((b) => b.date);
  return [];
}

const newStat = () => ({ n: 0, win: 0, sum: 0, edgeSum: 0, baseN: 0 });
const makeBaseline = (byCode) => {
  const cache = new Map();
  return (date, h) => {
    const key = date + "|" + h;
    if (cache.has(key)) return cache.get(key);
    let s = 0, n = 0;
    for (const v of byCode.values()) {
      const i = v.idx.get(date);
      if (i == null || i + h >= v.closes.length) continue;
      s += v.closes[i + h] / v.closes[i] - 1; n++;
    }
    const r = n ? s / n : null;
    cache.set(key, r);
    return r;
  };
};
const addSample = (st, ret, dir, base) => {
  st.n++; st.sum += ret;
  if (dir > 0 ? ret > 0 : ret < 0) st.win++;
  if (base != null) { st.edgeSum += dir > 0 ? ret - base : base - ret; st.baseN++; }
};
export const edgeOf = (st) => (st && st.baseN ? st.edgeSum / st.baseN : null);

// 等ウェイト市場プロキシ: index[t] = index[t-1] × (1 + mean(全銘柄の当日リターン))、index[0]=100。
// このツールが見ている銘柄群に対する地合いを測るのが目的（日経平均と多少ずれてよい）。
// 決定的なので保存せず毎回CSVから導出する。SMA25 と「SMA25の5日前との差」も付ける。
export function buildMarketIndex(groups) {
  const dates = buildDateGrid(groups);
  if (dates.length < 2) return [];
  const byCode = buildByCode(groups);
  const values = [100];
  for (let t = 1; t < dates.length; t++) {
    let s = 0, n = 0;
    for (const v of byCode.values()) {
      const i0 = v.idx.get(dates[t - 1]), i1 = v.idx.get(dates[t]);
      if (i0 == null || i1 == null) continue;
      s += v.closes[i1] / v.closes[i0] - 1; n++;
    }
    values.push(values[t - 1] * (1 + (n ? s / n : 0)));
  }
  const out = dates.map((date, t) => ({ date, value: values[t], sma25: null, slope: null }));
  let run = 0;
  for (let t = 0; t < values.length; t++) {
    run += values[t];
    if (t >= 25) run -= values[t - 25];
    if (t >= 24) out[t].sma25 = run / 25;
  }
  for (let t = 5; t < out.length; t++) {
    if (out[t].sma25 != null && out[t - 5].sma25 != null) out[t].slope = out[t].sma25 - out[t - 5].sma25;
  }
  return out;
}

// レジーム分類（その日の値で決定的に）:
//   上昇 = 指数 > SMA25 かつ SMA25が5日前より上 ／ 下落 = その逆 ／ それ以外 = もみ合い
export function classifyRegimes(groups) {
  const regimes = new Map();
  for (const p of buildMarketIndex(groups)) {
    let r = "range";
    if (p.sma25 != null && p.slope != null) {
      if (p.value > p.sma25 && p.slope > 0) r = "up";
      else if (p.value < p.sma25 && p.slope < 0) r = "down";
    }
    regimes.set(p.date, r);
  }
  return regimes;
}

// 履歴の全シグナルについて 5/10/20営業日後のリターンを最新CSVから引いて集計。
// 勝率は方向どおり（買い/逆三尊=上昇、売り/三尊=下落）。対市場は同じ日→同じ日数の全銘柄平均との差
// を方向調整した値（＋なら市場より優位）。
// opts.lastN: 「答えが出た(matured)シグナル日」の末尾N日だけを集計する（鮮度の可視化用）。
//   ※単純に history.slice(-N) にすると h=20 ではほぼ全件が「答え待ち」で n=0 になるため、
//     ホライズンごとに「date のインデックス + h <= 最終日」を満たすエントリに絞ってから末尾Nを取る。
export function evaluate(groups, history, opts = {}) {
  const byCode = buildByCode(groups);
  const baseline = makeBaseline(byCode);
  let allowed = null;                                            // Map(h → Set(集計対象の日付))
  if (opts.lastN) {
    const dates = buildDateGrid(groups);
    const gi = new Map(dates.map((d, i) => [d, i]));
    const last = dates.length - 1;
    allowed = new Map(HORIZONS.map((h) => {
      const matured = history.filter((e) => gi.get(e.date) != null && gi.get(e.date) + h <= last);
      return [h, new Set(matured.slice(-opts.lastN).map((e) => e.date))];
    }));
  }
  const stats = {};
  for (const c of Object.keys(CATS)) stats[c] = Object.fromEntries(HORIZONS.map((h) => [h, newStat()]));
  for (const e of history) {
    for (const [cat, dir] of Object.entries(CATS)) {
      for (const code of e[cat] || []) {
        const v = byCode.get(code);
        if (!v) continue;
        const i = v.idx.get(e.date);
        if (i == null) continue;                                 // データ窓から外れた古い日付はスキップ
        for (const h of HORIZONS) {
          if (allowed && !allowed.get(h).has(e.date)) continue;  // 窓の外
          if (i + h >= v.closes.length) continue;                // まだ答えが出ていない（評価待ち）
          addSample(stats[cat][h], v.closes[i + h] / v.closes[i] - 1, dir, baseline(e.date, h));
        }
      }
    }
  }
  return stats;
}

// カテゴリ×レジーム×ホライズンの全期間集計（レジームは「シグナルが出た日」の地合い）。
// 「いまのレジームでの過去成績」＝過去の答えを今の文脈で読み替えるための基礎データ。
export function evaluateByRegime(groups, history, regimes) {
  const byCode = buildByCode(groups);
  const baseline = makeBaseline(byCode);
  const stats = {};
  for (const c of Object.keys(CATS)) {
    stats[c] = {};
    for (const r of REGIMES) stats[c][r] = Object.fromEntries(HORIZONS.map((h) => [h, newStat()]));
  }
  for (const e of history) {
    const reg = regimes.get(e.date);
    if (!reg) continue;                                          // グリッド外の日付は対象外
    for (const [cat, dir] of Object.entries(CATS)) {
      for (const code of e[cat] || []) {
        const v = byCode.get(code);
        if (!v) continue;
        const i = v.idx.get(e.date);
        if (i == null) continue;
        for (const h of HORIZONS) {
          if (i + h >= v.closes.length) continue;
          addSample(stats[cat][reg][h], v.closes[i + h] / v.closes[i] - 1, dir, baseline(e.date, h));
        }
      }
    }
  }
  return stats;
}

// 信頼度状態: "ok"(✅有効) / "warn"(⚠️警戒) / "hold"(❔判定保留)。
// 入力はどちらもホライズン10日の対市場edge:
//   A = 直近窓の成績（windowStats） / B = 現在レジームにおける全期間成績（regimeCurStats）
// 規則（ダムに保つ。学習・最適化はしない）:
//   n不足 → hold ／ AとB両方 > TRUST_EXIT → ok ／ AまたはB < TRUST_ENTER → warn
//   バンド内 → 前日状態を維持（ヒステリシス。前日状態が無ければ白黒つけず hold）
export function computeTrust(prevTrust, windowStats, regimeCurStats, consts) {
  const H = 10;
  const out = {};
  for (const cat of Object.keys(CATS)) {
    const minN = cat === "buys" || cat === "sells" ? consts.TRUST_MIN_N : consts.TRUST_MIN_N_PAT;
    const a = windowStats[cat][H];
    const b = regimeCurStats ? regimeCurStats[cat][H] : null;
    const eA = edgeOf(a), eB = edgeOf(b);
    if (eA == null || eB == null || a.n < minN || b.n < minN) { out[cat] = "hold"; continue; }
    if (eA > consts.TRUST_EXIT && eB > consts.TRUST_EXIT) out[cat] = "ok";
    else if (eA < consts.TRUST_ENTER || eB < consts.TRUST_ENTER) out[cat] = "warn";
    else out[cat] = (prevTrust && prevTrust[cat]) || "hold";
  }
  return out;
}

export function printReport(stats, days, extra = null) {
  const pct = (x) => (x * 100).toFixed(2) + "%";
  const REGIME_JA = { up: "上昇", down: "下落", range: "もみ合い" };
  console.log(`=== 自動答え合わせ（蓄積 ${days} 営業日） ===`);
  if (extra) console.log(`現在の地合い: ${REGIME_JA[extra.currentRegime]}レジーム（全銘柄の等ウェイト指数 vs SMA25）`);
  const labels = { buys: "買い(強い買い)", sells: "売り(強い売り)", topsNew: "三尊(当日完成)", invsNew: "逆三尊(当日完成)" };
  const line1 = (st) => {
    if (!st || !st.n) return "データ蓄積中";
    const edge = edgeOf(st);
    return `勝率${pct(st.win / st.n).padStart(7)} 平均${pct(st.sum / st.n).padStart(8)} 対市場${edge != null ? (edge >= 0 ? "+" : "") + pct(edge) : "-"} (n=${st.n})`;
  };
  for (const [cat, label] of Object.entries(labels)) {
    console.log(`■ ${label}`);
    for (const h of HORIZONS) console.log(`  ${String(h).padStart(2)}日後: ${line1(stats[cat][h])}`);
    if (extra) {
      console.log(`  直近${extra.windowDays}日窓(10日後): ${line1(extra.windowStats[cat][10])}`);
      const reg = (r) => {
        const st = extra.regimeStats[cat][r][10];
        if (!st.n) return `${REGIME_JA[r]} -`;
        const e = edgeOf(st);
        return `${REGIME_JA[r]} 勝率${(st.win / st.n * 100).toFixed(0)}%(${e != null ? (e >= 0 ? "+" : "") + (e * 100).toFixed(1) + "%" : "-"}, n=${st.n})`;
      };
      console.log(`  レジーム別(10日後): ${["up", "down", "range"].map(reg).join(" / ")}`);
    }
  }
  console.log(`\n注: 対市場がプラスなら「同じ期間に市場平均（全銘柄平均）より方向どおりに動いた」＝シグナルに優位性あり。`);
  if (extra) console.log(`注: 「直近窓」は答えが出た(matured)シグナル日の直近${extra.windowDays}日分。10日後成績は最短でも10日前のシグナルまでしか反映されない（構造的ラグ）。`);
}

// CSV 読み込み（単体実行用。screen_daily.mjs は自前で読むのでこちらは使わない）
export function loadGroups() {
  const text = fs.readFileSync(new URL("./screening_data.csv", ROOT), "utf8");
  const groups = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    const c = line.split(",");
    if (c.length < 6) continue;
    const sym = c[0];
    if (!sym || sym === "銘柄") continue;
    if (!groups.has(sym)) groups.set(sym, []);
    groups.get(sym).push({ date: c[1], open: +c[2], high: +c[3], low: +c[4], close: +c[5], volume: +c[6] });
  }
  return groups;
}

// --- 単体実行（node evaluate.mjs [--seed N]） ---
if (process.argv[1] && /evaluate\.mjs$/i.test(process.argv[1].replace(/\\/g, "/"))) {
  const groups = loadGroups();
  const si = process.argv.indexOf("--seed");
  if (si >= 0) {
    const n = +process.argv[si + 1] || 250;                     // 既定250: レジーム別サンプル確保のため
    console.log(`過去 ${n} 営業日ぶんを再現して補完します（数分かかります）...`);
    const added = seedHistory(groups, n);
    console.log(`履歴に ${added} 日分を補完しました。\n`);
  }
  const history = loadHistory();
  const regimes = classifyRegimes(groups);
  const currentRegime = regimes.size ? [...regimes.values()].at(-1) : "range";
  const WINDOW = 60;
  printReport(evaluate(groups, history), history.length, {
    windowStats: evaluate(groups, history, { lastN: WINDOW }),
    regimeStats: evaluateByRegime(groups, history, regimes),
    currentRegime,
    windowDays: WINDOW,
  });
}
