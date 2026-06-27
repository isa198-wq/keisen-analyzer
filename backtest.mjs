// 三尊・逆三尊シグナルのバックテスト（的中率検証）
//   過去データを1日ずつ遡り、「その日にネックラインを抜けた（＝完成した）」瞬間を
//   シグナルとみなし、5/10/20営業日後のリターンを集計します。
//   三尊（天井=下落狙い）は値下がり＝勝ち、逆三尊（大底=上昇狙い）は値上がり＝勝ち。
//   使い方:  node backtest.mjs
import fs from "node:fs";
import { buildSeries, tfSeries, detectPattern } from "./src/analysis.generated.mjs";

const ROOT = new URL(".", import.meta.url);
const DATA = new URL("./screening_data.csv", ROOT);
if (!fs.existsSync(DATA)) {
  console.error("screening_data.csv が見つかりません。先に fetch_data.py を実行してください。");
  process.exit(1);
}

// --- CSV 読み込み（縦持ち） ---
const text = fs.readFileSync(DATA, "utf8");
const groups = new Map();
for (const line of text.split(/\r?\n/).slice(1)) {
  const c = line.split(",");
  if (c.length < 6) continue;
  const sym = c[0];
  if (!sym || sym === "銘柄") continue;
  if (!groups.has(sym)) groups.set(sym, []);
  groups.get(sym).push({ date: c[1], open: +c[2], high: +c[3], low: +c[4], close: +c[5], volume: +c[6] });
}

const HORIZONS = [5, 10, 20];     // 何営業日後のリターンを見るか
const MINBARS = 60;               // 検出を始めるまでの最低本数（パターン形成に必要）
const MAXH = Math.max(...HORIZONS);

// kind 別の結果バケツ
const mk = () => ({ n: 0, rets: Object.fromEntries(HORIZONS.map((h) => [h, []])) });
const res = { top: mk(), inverse: mk() };
const baseRets = Object.fromEntries(HORIZONS.map((h) => [h, []])); // 無条件（ベースライン）

let signalsTotal = 0;
for (const [, bars] of groups) {
  const full = buildSeries(tfSeries(bars, "D"));
  const L = full.length;
  if (L < MINBARS + MAXH + 5) continue;

  // ベースライン：各日の無条件フォワードリターン（間引いて収集）
  for (let t = MINBARS; t + MAXH < L; t += 3) {
    for (const h of HORIZONS) baseRets[h].push(full[t + h].close / full[t].close - 1);
  }

  // シグナル検出：各日 t で「その日にネックラインを抜けたか」を判定（先頭〜t の成長窓）
  for (let t = MINBARS; t + MAXH < L; t++) {
    const win = full.slice(0, t + 1);
    const p = detectPattern(win);
    if (!p || !p.broke) continue;
    if (p.breakI !== win.length - 1) continue;  // 「ちょうど今日割れた/抜けた」だけを採用
    const bucket = p.kind === "top" ? res.top : p.kind === "inverse" ? res.inverse : null;
    if (!bucket) continue;
    bucket.n++;
    signalsTotal++;
    for (const h of HORIZONS) bucket.rets[h].push(full[t + h].close / full[t].close - 1);
  }
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (x) => (x * 100).toFixed(2) + "%";
// 勝率：top は下落(<0)で勝ち、inverse は上昇(>0)で勝ち
const winRate = (a, kind) => {
  if (!a.length) return 0;
  const win = a.filter((r) => (kind === "top" ? r < 0 : r > 0)).length;
  return win / a.length;
};

console.log(`=== 三尊・逆三尊 バックテスト ===`);
console.log(`対象 ${groups.size} 銘柄 ／ シグナル総数 ${signalsTotal}（三尊 ${res.top.n} / 逆三尊 ${res.inverse.n}）`);
console.log(`各シグナル＝「その日にネックラインを割った/抜けた」完成。方向どおり動けば勝ち。\n`);

const report = (label, bucket, kind) => {
  console.log(`■ ${label}（${bucket.n}件）`);
  if (!bucket.n) { console.log("  シグナルなし\n"); return; }
  for (const h of HORIZONS) {
    const r = bucket.rets[h];
    const base = avg(baseRets[h]);
    const edge = avg(r) - base;
    console.log(
      `  ${String(h).padStart(2)}日後: 平均 ${pct(avg(r)).padStart(8)} ｜ 勝率 ${pct(winRate(r, kind)).padStart(7)}` +
      ` ｜ ベース比 ${(edge >= 0 ? "+" : "") + pct(edge)}（${kind === "top" ? "下落で優位ならマイナス" : "上昇で優位ならプラス"}）`
    );
  }
  console.log("");
};
report("三尊（天井・下落狙い）", res.top, "top");
report("逆三尊（大底・上昇狙い）", res.inverse, "inverse");

console.log(`参考）無条件ベースライン平均リターン: ` +
  HORIZONS.map((h) => `${h}日 ${pct(avg(baseRets[h]))}`).join(" / "));
console.log(`\n注: 「ベース比」は同期間の全銘柄平均との差。三尊なら平均がベースより低い(マイナス方向)ほど、逆三尊なら高いほど、シグナルに優位性あり。`);
