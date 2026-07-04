// 複合条件（コンボ）の成績計測（設計_次期改良v2.md §4・単体実行専用。CIには入れない）
//   combo_defs.mjs の固定セットを成長窓でリプレイし、「どの組み合わせなら通知に値するか」を
//   データで決める。採用基準（事前固定）: edge(10日) >= +1.0% かつ n >= 300 かつ 20日edgeも正。
//
//   使い方:  node combo_check.mjs [--days N]   （既定 N=1100 営業日）
//   出力:    テーブル表示 ＋ signals/combo_stats.json
import fs from "node:fs";
import { analyze, buildSeries, tfSeries } from "./src/analysis.generated.mjs";
import { classifyRegimes, buildByCode } from "./evaluate.mjs";
import { COMBOS } from "./combo_defs.mjs";

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
const DAYS = di >= 0 ? +process.argv[di + 1] || 1100 : 1100;
const HORIZONS = [5, 10, 20];
const REGIMES = ["up", "down", "range"];
const REGIME_JA = { up: "上昇", down: "下落", range: "もみ合い" };

console.log(`=== 複合条件の成績（過去${DAYS}営業日×${groups.size}銘柄を成長窓でリプレイ） ===`);
console.log(`edge = 方向調整済みリターン − 方向調整済み市場平均。採用基準: edge(10日)>=+1.0% かつ n>=300 かつ 20日edge>0\n`);

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
const regimes = classifyRegimes(groups);

const newH = () => ({ n: 0, sum: 0, win: 0, edgeSum: 0, edgeN: 0 });
const stats = Object.fromEntries(COMBOS.map((c) => [c.key, {
  n: 0,
  perH: Object.fromEntries(HORIZONS.map((h) => [h, newH()])),
  byRegime: Object.fromEntries(REGIMES.map((r) => [r, Object.fromEntries(HORIZONS.map((h) => [h, newH()]))])),
}]));

let cells = 0;
let gi = 0;
const t0 = Date.now();
const progressEvery = Math.max(1, Math.floor(groups.size / 10));
for (const [, bars] of groups) {
  gi++;
  const L = bars.length;
  const start = Math.max(80, L - DAYS);
  for (let i = start; i < L; i++) {
    const a = analyze(buildSeries(tfSeries(bars.slice(0, i + 1), "D")), "日");
    cells++;
    const date = bars[i].date;
    const reg = regimes.get(date) || null;
    for (const combo of COMBOS) {
      let hit = false;
      try { hit = !!combo.test(a, reg); } catch { hit = false; }
      if (!hit) continue;
      const st = stats[combo.key];
      st.n++;
      for (const h of HORIZONS) {
        if (i + h >= L) continue;
        const ret = bars[i + h].close / bars[i].close - 1;
        const aligned = combo.dir * ret;
        const b = baseline(date, h);
        const add = (cell) => {
          cell.n++; cell.sum += aligned;
          if (aligned > 0) cell.win++;
          if (b != null) { cell.edgeSum += aligned - combo.dir * b; cell.edgeN++; }
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

const edgeOfCell = (c) => (c.edgeN ? c.edgeSum / c.edgeN : null);
const pct = (x, d = 2) => (x == null ? "   -  " : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const rows = COMBOS.map((c) => {
  const st = stats[c.key];
  return {
    key: c.key, label: c.label, dir: c.dir, n: st.n,
    edge: Object.fromEntries(HORIZONS.map((h) => [h, edgeOfCell(st.perH[h])])),
    win: Object.fromEntries(HORIZONS.map((h) => [h, st.perH[h].n ? st.perH[h].win / st.perH[h].n : null])),
    byRegime: st.byRegime,
  };
}).sort((a, b) => (b.edge[10] ?? -Infinity) - (a.edge[10] ?? -Infinity));

console.log(`\n■ コンボ別成績（edge 10日降順）`);
for (const r of rows) {
  const adopted = r.edge[10] != null && r.edge[10] >= 0.01 && r.n >= 300 && r.edge[20] != null && r.edge[20] > 0;
  const mark = adopted ? "⭐採用" : "　見送り";
  console.log(`${mark} ${r.label}  n=${String(r.n).padStart(6)}  edge: ${HORIZONS.map((h) => `${h}日${pct(r.edge[h])}`).join(" ")}  勝率${r.win[10] != null ? (r.win[10] * 100).toFixed(0) : "-"}%(10日)`);
  const reg = REGIMES.map((g) => {
    const c2 = r.byRegime[g][10];
    return `${REGIME_JA[g]}${c2.n ? pct(edgeOfCell(c2), 1) + `(n=${c2.n})` : "-"}`;
  }).join(" / ");
  console.log(`        └ レジーム別edge(10日): ${reg}`);
}

const outDir = new URL("./signals/", ROOT);
fs.mkdirSync(outDir, { recursive: true });
const anyBars = groups.values().next().value;
fs.writeFileSync(new URL("./combo_stats.json", outDir), JSON.stringify({
  generated: anyBars.at(-1).date, days: DAYS, stocks: groups.size, cells,
  criteria: "edge10>=+1.0% && n>=300 && edge20>0",
  combos: Object.fromEntries(rows.map((r) => [r.key, {
    label: r.label, dir: r.dir, n: r.n,
    adopted: !!(r.edge[10] != null && r.edge[10] >= 0.01 && r.n >= 300 && r.edge[20] != null && r.edge[20] > 0),
    perH: Object.fromEntries(HORIZONS.map((h) => [h, { edge: r.edge[h], win: r.win[h] }])),
    byRegime: Object.fromEntries(REGIMES.map((g) => [g, Object.fromEntries(HORIZONS.map((h) => {
      const c2 = r.byRegime[g][h];
      return [h, { n: c2.n, edge: edgeOfCell(c2), win: c2.n ? c2.win / c2.n : null }];
    }))])),
  }])),
}, null, 1));
console.log(`\n保存: signals/combo_stats.json ／ 実行時間 ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
