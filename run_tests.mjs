// 判定ロジックの健全性テスト（golden tests・フレームワーク不使用）
//   build_analysis.mjs の波括弧マッチング抽出は App.jsx の書き方変更で静かに壊れうる。
//   壊れたまま通知が飛ぶのを CI で止めるための回帰の保険。失敗時は exit 1（=CIジョブ失敗=通知が飛ばない）。
//   使い方:  node run_tests.mjs
import { analyze, buildSeries, tfSeries, detectPattern } from "./src/analysis.generated.mjs";
import { classifyRegimes } from "./evaluate.mjs";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failed++; console.error(`  FAIL  ${name}${detail ? `  → ${detail}` : ""}`); }
};

// ---------------------------------------------------------------------------
// 1) 抽出健全性: 必須関数が全て関数として import できること
// ---------------------------------------------------------------------------
console.log("■ 抽出健全性（analysis.generated.mjs のエクスポート）");
for (const [name, fn] of Object.entries({ analyze, buildSeries, tfSeries, detectPattern })) {
  check(`${name} が function`, typeof fn === "function", `typeof=${typeof fn}`);
}

// ---------------------------------------------------------------------------
// 2) golden 逆三尊: 決定的な合成OHLCVで detectPattern が inverse/broke を返すこと
//    形状: 下降(1100→900)→左肩900→戻り960→頭850→戻り970→右肩905→ネック上抜けラリー(1020)
//    各レグは単調（findSwings w=4 がちょうど左肩/頭/右肩の3つの安値だけを拾う設計）。
//    検出条件: 肩差<8% ／ 深さ>1.5% ／ 肩間スパン12〜110本 を満たす数値をハードコード。
// ---------------------------------------------------------------------------
console.log("■ golden 逆三尊（合成データ・乱数不使用）");
function goldenFixture() {
  const closes = [];
  const seg = (from, to, steps) => {           // from の次から to まで steps 本（単調）
    for (let k = 1; k <= steps; k++) closes.push(from + ((to - from) * k) / steps);
  };
  closes.push(1100);
  seg(1100, 900, 34);   // i=1..34  下降 → 左肩の安値 i=34 (900)
  seg(900, 960, 7);     // i=35..41 戻り高値 i=41 (960)
  seg(960, 850, 8);     // i=42..49 頭 i=49 (850)
  seg(850, 970, 8);     // i=50..57 戻り高値 i=57 (970)
  seg(970, 905, 7);     // i=58..64 右肩 i=64 (905)
  seg(905, 1010, 12);   // i=65..76 ネックライン上抜けラリー
  seg(1010, 1020, 8);   // i=77..84 続伸（終端に余計なスイング高値を作らない）
  const bars = [];
  const VALLEYS = new Set([34, 49, 64]);   // 左肩・頭・右肩の谷バー
  for (let i = 0; i < closes.length; i++) {
    const open = i === 0 ? closes[0] : closes[i - 1];
    const c = closes[i];
    // 谷バーだけ安値を深くする（-6）。翌バーは open=谷の終値 なので low が同値になり
    // findSwings がスイング安値を二重検出してしまう（連続3安値の条件が壊れる）のを防ぐ。
    bars.push({
      date: `2025-01-${String(i + 1).padStart(2, "0")}`,   // 日付は判定に使われない（形式だけ揃える）
      open, high: Math.max(open, c) + 2, low: Math.min(open, c) - (VALLEYS.has(i) ? 6 : 2), close: c,
      volume: i === 73 ? 2e6 : 1e6,                        // ブレイク日想定だけ出来高2倍
    });
  }
  return bars;
}
const fixture = goldenFixture();
check("fixture が80本以上", fixture.length >= 80, `本数=${fixture.length}`);
const gSeries = buildSeries(tfSeries(fixture, "D"));
const gp = detectPattern(gSeries);
check("detectPattern が検出", !!gp, "null が返った");
if (gp) {
  check('kind === "inverse"', gp.kind === "inverse", `kind=${gp.kind}`);
  check("broke === true", gp.broke === true, `broke=${gp.broke} status=${gp.status}`);
}

// ---------------------------------------------------------------------------
// 3) analyze スモーク: 同フィクスチャで vIdx が 0..4 の整数・factors 配列・逆三尊ファクター
// ---------------------------------------------------------------------------
console.log("■ analyze スモーク");
const ga = analyze(gSeries, "日");
check("vIdx が 0..4 の整数", Number.isInteger(ga.vIdx) && ga.vIdx >= 0 && ga.vIdx <= 4, `vIdx=${ga.vIdx}`);
check("factors が配列", Array.isArray(ga.factors));
check('factors に k==="逆三尊" を含む', Array.isArray(ga.factors) && ga.factors.some((f) => f.k === "逆三尊"),
  `factors=${(ga.factors || []).map((f) => f.k).join(",")}`);

// ---------------------------------------------------------------------------
// 4) CSVパーサ: screen_daily と同じ分割ロジック（ヘッダスキップ・銘柄列分解・日付昇順）
// ---------------------------------------------------------------------------
console.log("■ CSVパーサ（screen_daily と同じ分割ロジック）");
const csvText = [
  "銘柄,日付,始値,高値,安値,終値,出来高",
  "7203:トヨタ自動車,2025-01-06,2500,2550,2490,2540,1000000",
  "7203:トヨタ自動車,2025-01-07,2540,2560,2500,2510,900000",
  "9984:ソフトバンクG,2025-01-06,9000,9100,8900,9050,2000000",
  "9984:ソフトバンクG,2025-01-07,9050,9200,9000,9150,2100000",
].join("\n");
const groups = new Map();
for (const line of csvText.split(/\r?\n/).slice(1)) {
  const c = line.split(",");
  if (c.length < 6) continue;
  const sym = c[0];
  if (!sym || sym === "銘柄") continue;
  if (!groups.has(sym)) groups.set(sym, []);
  groups.get(sym).push({ date: c[1], open: +c[2], high: +c[3], low: +c[4], close: +c[5], volume: +c[6] });
}
check("2銘柄に分割される", groups.size === 2, `size=${groups.size}`);
{
  const sym = [...groups.keys()][0];
  const ci = sym.indexOf(":");
  check('銘柄列が「コード:社名」に分解できる', ci > 0 && sym.slice(0, ci) === "7203" && sym.slice(ci + 1) === "トヨタ自動車", `sym=${sym}`);
  const bars = groups.get(sym);
  check("日付昇順・数値変換", bars.length === 2 && bars[0].date < bars[1].date && bars[1].close === 2510,
    JSON.stringify(bars));
}

// ---------------------------------------------------------------------------
// 5) classifyRegimes スモーク: 単調上昇の合成データで最終日が "up"
// ---------------------------------------------------------------------------
console.log("■ classifyRegimes スモーク");
{
  const bars = [];
  for (let i = 0; i < 60; i++) {
    bars.push({ date: `2025-03-${String(Math.floor(i / 30) + 1)}${String(i % 30).padStart(2, "0")}`, close: 100 + i });
  }
  // 日付は昇順の文字列なら何でもよい（グリッド用）。単調上昇 → 指数>SMA25 かつ SMA25上向き
  const g = new Map([["0001:テスト", bars]]);
  const regimes = classifyRegimes(g);
  const lastRegime = [...regimes.values()].at(-1);
  check('単調上昇で "up"', lastRegime === "up", `regime=${lastRegime}`);
}

// ---------------------------------------------------------------------------
console.log(failed ? `\n${failed} 件失敗` : "\n全テスト PASS");
process.exit(failed ? 1 : 0);
