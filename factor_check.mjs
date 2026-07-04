// ファクター別成績の計測（重み校正の下準備・単体実行専用。CIには入れない）
//   analyze() の factors（トレンド、クロス、RSI、三尊…）の s 値（重み）は全部手決め。
//   どのファクターが当たっていて、どれがノイズ/逆指標かを「測る道具」。
//   このスクリプトは重みを変更しない（変更はデータが半年貯まってから別途判断）。
//
//   使い方:  node factor_check.mjs [--days N] [--out NAME]   （既定 N=120 / NAME=factor_stats.json）
//   出力:    テーブル表示 ＋ signals/<NAME>（プルーン正規表現に一致しない名前にすること）
//   全期間検証は:  node factor_check.mjs --days 1100 --out factor_stats_full.json
import fs from "node:fs";
import { analyze, buildSeries, tfSeries } from "./src/analysis.generated.mjs";
import { classifyRegimes, buildByCode } from "./evaluate.mjs";

const ROOT = new URL(".", import.meta.url);
const DATA = new URL("./screening_data.csv", ROOT);
if (!fs.existsSync(DATA)) {
  console.error("screening_data.csv が見つかりません。先に fetch_data.py を実行してください。");
  process.exit(1);
}

// --- CSV 読み込み（縦持ち） ---
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
const DAYS = di >= 0 ? +process.argv[di + 1] || 120 : 120;
const oi = process.argv.indexOf("--out");
const OUT_NAME = oi >= 0 && process.argv[oi + 1] ? process.argv[oi + 1] : "factor_stats.json";
const HORIZONS = [5, 10, 20];
const REGIMES = ["up", "down", "range"];
const REGIME_JA = { up: "上昇", down: "下落", range: "もみ合い" };

console.log(`=== ファクター別成績（過去${DAYS}営業日×${groups.size}銘柄を成長窓でリプレイ） ===`);
console.log(`edge = sign(s)×リターン − sign(s)×市場平均（方向調整済み優位性。＋なら重みの向きが正しい）\n`);

// 同日・同ホライズンの全銘柄平均リターン（ベースライン）
const byCode = buildByCode(groups);
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
// レジーム別内訳（「このファクターは上昇時のみ有効」を発見できるように）
const regimes = classifyRegimes(groups);

const newH = () => ({ n: 0, sum: 0, win: 0, edgeSum: 0, edgeN: 0 });
const stats = new Map();
const factorStat = (k) => {
  if (!stats.has(k)) stats.set(k, {
    n: 0,
    perH: Object.fromEntries(HORIZONS.map((h) => [h, newH()])),
    byRegime: Object.fromEntries(REGIMES.map((r) => [r, Object.fromEntries(HORIZONS.map((h) => [h, newH()]))])),
  });
  return stats.get(k);
};

let cells = 0;                                   // 出現率の分母 = リプレイした（銘柄,日）の数
let gi = 0;
const t0 = Date.now();
const progressEvery = Math.max(1, Math.floor(groups.size / 10));
for (const [, bars] of groups) {
  gi++;
  const L = bars.length;
  const start = Math.max(80, L - DAYS);          // analyze に必要な最低本数を確保
  for (let i = start; i < L; i++) {
    const a = analyze(buildSeries(tfSeries(bars.slice(0, i + 1), "D")), "日");
    cells++;
    const date = bars[i].date;
    const reg = regimes.get(date) || null;
    for (const f of a.factors || []) {
      if (!f || !f.s) continue;                  // s===0（中立）は集計から除外
      const st = factorStat(f.k);
      st.n++;
      const dir = f.s > 0 ? 1 : -1;
      for (const h of HORIZONS) {
        if (i + h >= L) continue;                // 答え待ちはスキップ
        const ret = bars[i + h].close / bars[i].close - 1;
        const aligned = dir * ret;               // 方向調整済みリターン
        const b = baseline(date, h);
        const add = (cell) => {
          cell.n++; cell.sum += aligned;
          if (aligned > 0) cell.win++;
          if (b != null) { cell.edgeSum += aligned - dir * b; cell.edgeN++; }
        };
        add(st.perH[h]);
        if (reg) add(st.byRegime[reg][h]);
      }
    }
  }
  if (gi % progressEvery === 0) {
    console.log(`  進捗 ${Math.round((gi / groups.size) * 100)}%（${gi}/${groups.size}銘柄・${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  }
}

// --- 集計・表示 ---
const edgeOfCell = (c) => (c.edgeN ? c.edgeSum / c.edgeN : null);
const rows = [...stats.entries()].map(([k, st]) => ({
  k, n: st.n, rate: st.n / cells,
  edge: Object.fromEntries(HORIZONS.map((h) => [h, edgeOfCell(st.perH[h])])),
  win: Object.fromEntries(HORIZONS.map((h) => [h, st.perH[h].n ? st.perH[h].win / st.perH[h].n : null])),
  byRegime: st.byRegime,
}));
rows.sort((a, b) => (b.edge[10] ?? -Infinity) - (a.edge[10] ?? -Infinity));

const pct = (x, d = 2) => (x == null ? "   -  " : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const line = (r) => {
  const e = HORIZONS.map((h) => `${h}日${pct(r.edge[h])}`).join(" ");
  const w = r.win[10] != null ? `勝率${(r.win[10] * 100).toFixed(0)}%` : "勝率-";
  return `${r.k.padEnd(6, "　")} n=${String(r.n).padStart(6)} 出現率${(r.rate * 100).toFixed(1).padStart(5)}%  edge: ${e}  ${w}(10日)`;
};
const main = rows.filter((r) => r.n >= 30);
const minor = rows.filter((r) => r.n < 30);
console.log(`\n■ ファクター別成績（edge 10日降順・n>=30）`);
for (const r of main) {
  console.log(line(r));
  const reg = REGIMES.map((g) => {
    const c = r.byRegime[g][10];
    return `${REGIME_JA[g]}${c.n ? pct(edgeOfCell(c), 1) + `(n=${c.n})` : "-"}`;
  }).join(" / ");
  console.log(`  └ レジーム別edge(10日): ${reg}`);
}
if (minor.length) {
  console.log(`\n■ 参考（n<30・統計的に弱い）`);
  for (const r of minor) console.log(line(r));
}
const bad = main.filter((r) => r.edge[10] != null && r.edge[10] < 0);
console.log(`\n■ edge(10日)がマイナスのファクター＝見直し候補: ${bad.length ? bad.map((r) => r.k).join(", ") : "なし"}`);
console.log(`（重みの変更はここではしない。データが貯まってから別途判断）`);

// --- JSON 保存 ---
const outDir = new URL("./signals/", ROOT);
fs.mkdirSync(outDir, { recursive: true });
const anyBars = groups.values().next().value;
const out = {
  generated: anyBars.at(-1).date, days: DAYS, stocks: groups.size, cells,
  factors: Object.fromEntries(rows.map((r) => [r.k, {
    n: r.n, rate: +r.rate.toFixed(4),
    perH: Object.fromEntries(HORIZONS.map((h) => [h, { edge: r.edge[h], win: r.win[h] }])),
    byRegime: Object.fromEntries(REGIMES.map((g) => [g, Object.fromEntries(HORIZONS.map((h) => {
      const c = r.byRegime[g][h];
      return [h, { n: c.n, edge: edgeOfCell(c), win: c.n ? c.win / c.n : null }];
    }))])),
  }])),
};
fs.writeFileSync(new URL(`./${OUT_NAME}`, outDir), JSON.stringify(out, null, 1));
console.log(`\n保存: signals/${OUT_NAME} ／ 実行時間 ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
