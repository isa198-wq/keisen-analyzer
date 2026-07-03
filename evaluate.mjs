// シグナルの自動答え合わせ（履歴の蓄積と成績集計）
//   - screen_daily.mjs が毎日 upsertEntry() で「その日のシグナル」を signals/history.jsonl に記録
//   - evaluate() が「過去シグナルのその後（5/10/20営業日後）」を集計して成績を返す
//   - 履歴が薄いときは seedHistory() が過去分を再現して補完（その日までのデータだけで判定＝未来は見ない）
//   価格は保存せずコードだけ保存し、リターンは常に最新CSV（分割調整済み）から日付で引くので、
//   後から株式分割があっても成績計算は壊れない。
//
// 単体実行:
//   node evaluate.mjs             … 蓄積済み履歴の成績を表示
//   node evaluate.mjs --seed 60   … 過去60営業日ぶんを再現して履歴に補完してから表示
import fs from "node:fs";
import { analyze, buildSeries, tfSeries } from "./src/analysis.generated.mjs";

const ROOT = new URL(".", import.meta.url);
const HISTORY = new URL("./signals/history.jsonl", ROOT);
const HORIZONS = [5, 10, 20];

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

// 履歴の全シグナルについて 5/10/20営業日後のリターンを最新CSVから引いて集計。
// 勝率は方向どおり（買い/逆三尊=上昇、売り/三尊=下落）。対市場は同じ日→同じ日数の全銘柄平均との差
// を方向調整した値（＋なら市場より優位）。
export function evaluate(groups, history) {
  const byCode = new Map();
  for (const [sym, bars] of groups) {
    const ci = sym.indexOf(":");
    const code = ci >= 0 ? sym.slice(0, ci) : sym;
    byCode.set(code, { closes: bars.map((b) => b.close), idx: new Map(bars.map((b, i) => [b.date, i])) });
  }
  const baseCache = new Map();
  const baseline = (date, h) => {
    const key = date + "|" + h;
    if (baseCache.has(key)) return baseCache.get(key);
    let s = 0, n = 0;
    for (const v of byCode.values()) {
      const i = v.idx.get(date);
      if (i == null || i + h >= v.closes.length) continue;
      s += v.closes[i + h] / v.closes[i] - 1; n++;
    }
    const r = n ? s / n : null;
    baseCache.set(key, r);
    return r;
  };
  const CATS = { buys: 1, sells: -1, topsNew: -1, invsNew: 1 }; // 値は「勝ち」の方向
  const stats = {};
  for (const c of Object.keys(CATS)) stats[c] = Object.fromEntries(HORIZONS.map((h) => [h, { n: 0, win: 0, sum: 0, edgeSum: 0, baseN: 0 }]));
  for (const e of history) {
    for (const [cat, dir] of Object.entries(CATS)) {
      for (const code of e[cat] || []) {
        const v = byCode.get(code);
        if (!v) continue;
        const i = v.idx.get(e.date);
        if (i == null) continue;                                 // データ窓から外れた古い日付はスキップ
        for (const h of HORIZONS) {
          if (i + h >= v.closes.length) continue;                // まだ答えが出ていない（評価待ち）
          const ret = v.closes[i + h] / v.closes[i] - 1;
          const st = stats[cat][h];
          st.n++; st.sum += ret;
          if (dir > 0 ? ret > 0 : ret < 0) st.win++;
          const b = baseline(e.date, h);
          if (b != null) { st.edgeSum += dir > 0 ? ret - b : b - ret; st.baseN++; }
        }
      }
    }
  }
  return stats;
}

export function printReport(stats, days) {
  const pct = (x) => (x * 100).toFixed(2) + "%";
  console.log(`=== 自動答え合わせ（蓄積 ${days} 営業日） ===`);
  const labels = { buys: "買い(強い買い)", sells: "売り(強い売り)", topsNew: "三尊(当日完成)", invsNew: "逆三尊(当日完成)" };
  for (const [cat, label] of Object.entries(labels)) {
    console.log(`■ ${label}`);
    for (const h of HORIZONS) {
      const st = stats[cat][h];
      if (!st.n) { console.log(`  ${String(h).padStart(2)}日後: データ蓄積中`); continue; }
      const edge = st.baseN ? st.edgeSum / st.baseN : null;
      console.log(`  ${String(h).padStart(2)}日後: 勝率${pct(st.win / st.n).padStart(7)} 平均${pct(st.sum / st.n).padStart(8)} 対市場${edge != null ? (edge >= 0 ? "+" : "") + pct(edge) : "-"} (n=${st.n})`);
    }
  }
  console.log(`\n注: 対市場がプラスなら「同じ期間に市場平均（全銘柄平均）より方向どおりに動いた」＝シグナルに優位性あり。`);
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
    const n = +process.argv[si + 1] || 60;
    console.log(`過去 ${n} 営業日ぶんを再現して補完します（数十秒かかります）...`);
    const added = seedHistory(groups, n);
    console.log(`履歴に ${added} 日分を補完しました。\n`);
  }
  const history = loadHistory();
  printReport(evaluate(groups, history), history.length);
}
