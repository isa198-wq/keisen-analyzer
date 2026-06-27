// App.jsx の判定ロジック（analyze など）を抽出して src/analysis.generated.mjs を生成します。
// アプリと「全く同じ計算」をヘッドレス（Node）で使うためのものです。
// App.jsx の判定ロジックを変更したら、再実行してください:  node build_analysis.mjs
import fs from "node:fs";

const src = fs.readFileSync(new URL("./src/App.jsx", import.meta.url), "utf8");

// function 宣言を波括弧の対応で丸ごと取り出す（テンプレートリテラルの ${} は左右対になるので相殺される）
function extractFn(name) {
  const re = new RegExp("function\\s+" + name + "\\s*\\(");
  const m = re.exec(src);
  if (!m) throw new Error("関数が見つかりません: " + name);
  const open = src.indexOf("{", m.index);
  let depth = 0;
  let j = open;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(m.index, j);
}

// 小さなフォーマッタ（const アロー）は analyze が依存するため同梱
const helpers = `const fmt = (n, d = 0) =>
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
};`;

const names = [
  "sma", "ema", "rsi", "bollinger",
  "aggregate", "tfSeries", "buildSeries",
  "findSwings", "extremeBetween", "avgField", "detectPattern",
  "analyze",
];

const body = names.map(extractFn).join("\n\n");

const out = `// === 自動生成ファイル（手で編集しない）===
// 生成元: src/App.jsx ／ 生成コマンド: node build_analysis.mjs
// アプリ画面と全く同じ判定ロジックを Node から使うためのモジュールです。

${helpers}

${body}

export { analyze, buildSeries, tfSeries, detectPattern };
`;

fs.writeFileSync(new URL("./src/analysis.generated.mjs", import.meta.url), out);
console.log("生成しました: src/analysis.generated.mjs（" + names.length + " 関数 + フォーマッタ）");
