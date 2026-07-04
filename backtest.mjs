// 三尊・逆三尊シグナルのバックテスト（的中率検証）
//   過去データを1日ずつ遡り、「その日にネックラインを抜けた（＝完成した）」瞬間を
//   シグナルとみなし、5/10/20営業日後のリターンを集計します。
//   三尊（天井=下落狙い）は値下がり＝勝ち、逆三尊（大底=上昇狙い）は値上がり＝勝ち。
//   使い方:  node backtest.mjs
import fs from "node:fs";
import { analyze, buildSeries, tfSeries, detectPattern } from "./src/analysis.generated.mjs";

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

// kind 別の結果バケツ（週足一致の有無で分ける＝「複合条件」運用の検証用）
const mk = () => ({ n: 0, rets: Object.fromEntries(HORIZONS.map((h) => [h, []])) });
const res = { top: mk(), inverse: mk() };
const resWk = { top: mk(), inverse: mk() };     // 週足◎あり（複合条件）
const resNoWk = { top: mk(), inverse: mk() };   // 週足◎なし（単独パターンのみ）
const baseRets = Object.fromEntries(HORIZONS.map((h) => [h, []])); // 無条件（ベースライン）

// 成長窓は生の bars ベース。以前は buildSeries(tfSeries(bars,"D")) が直近160本に
// キャップされるため、PERIOD を伸ばしてもバックテスト範囲が広がらないバグがあった。
// 判定窓は本番と同じ「その日までの直近160本」、フォワードリターンは生バーから引く。
let signalsTotal = 0;
let gi = 0;
const progressEvery = Math.max(1, Math.floor(groups.size / 10));   // 10%刻みの進捗表示
for (const [, bars] of groups) {
  gi++;
  const N = bars.length;
  if (N < MINBARS + MAXH + 5) continue;

  // ベースライン：各日の無条件フォワードリターン（生バー・間引いて収集）
  for (let t = MINBARS; t + MAXH < N; t += 3) {
    for (const h of HORIZONS) baseRets[h].push(bars[t + h].close / bars[t].close - 1);
  }

  // シグナル検出：各日 t で「その日にネックラインを抜けたか」を判定（その日までの成長窓）
  for (let t = MINBARS; t + MAXH < N; t++) {
    const win = buildSeries(tfSeries(bars.slice(0, t + 1), "D"));
    const p = detectPattern(win);
    if (!p || !p.broke) continue;
    if (p.breakI !== win.length - 1) continue;  // 「ちょうど今日割れた/抜けた」だけを採用
    const bucket = p.kind === "top" ? res.top : p.kind === "inverse" ? res.inverse : null;
    if (!bucket) continue;
    bucket.n++;
    signalsTotal++;
    for (const h of HORIZONS) bucket.rets[h].push(bars[t + h].close / bars[t].close - 1);

    // 同じ日の週足を「その日までの生データだけ」で再現し、同種パターンが出ているか判定
    // （生バー基準になったので旧 rawOffset 計算は不要）
    const rawUpToHere = bars.slice(0, t + 1);
    let weekly = false;
    if (rawUpToHere.length >= 200) {
      const wp = analyze(buildSeries(tfSeries(rawUpToHere, "W")), "週").pattern;
      weekly = !!(wp && wp.kind === p.kind);
    }
    const seg = weekly ? resWk : resNoWk;
    const segBucket = p.kind === "top" ? seg.top : seg.inverse;
    segBucket.n++;
    for (const h of HORIZONS) segBucket.rets[h].push(bars[t + h].close / bars[t].close - 1);
  }
  if (gi % progressEvery === 0) {
    console.log(`  進捗 ${Math.round((gi / groups.size) * 100)}%（${gi}/${groups.size}銘柄・シグナル${signalsTotal}件）`);
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

// --- 複合条件（パターン×週足一致）の検証：週足◎ありとなしで的中率がどう変わるか ---
console.log(`\n\n=== 複合条件の検証（週足◎の有無で分割） ===`);
console.log(`「週足◎」＝同じ日の週足チャートでも同種のパターンが出ている状態。運用を複合条件に倒す根拠になるか確認する。\n`);
const reportPair = (label, kind) => {
  const wk = resWk[kind], noWk = resNoWk[kind];
  console.log(`■ ${label}　週足◎あり ${wk.n}件 ／ 週足◎なし ${noWk.n}件`);
  for (const h of HORIZONS) {
    const base = avg(baseRets[h]);
    const line = (b) => {
      const r = b.rets[h];
      const edge = avg(r) - base;
      return `平均${pct(avg(r)).padStart(8)} 勝率${pct(winRate(r, kind)).padStart(7)} ベース比${(edge >= 0 ? "+" : "") + pct(edge)}`;
    };
    console.log(`  ${String(h).padStart(2)}日後: 週足◎あり[ ${wk.n ? line(wk) : "シグナルなし"} ] ｜ 週足◎なし[ ${noWk.n ? line(noWk) : "シグナルなし"} ]`);
  }
  console.log("");
};
reportPair("三尊", "top");
reportPair("逆三尊", "inverse");
console.log(`注: サンプル数が少ないため参考値。週足◎ありの勝率/ベース比が明確に高ければ、複合条件（パターン＋週足一致）を優先する運用の裏付けになる。`);
