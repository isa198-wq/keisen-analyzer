// 日次スクリーニング（ヘッドレス）
//   screening_data.csv を読み、アプリと同じ判定で「サインのある銘柄」を抽出し、
//   Discord/Slack へ通知＋HTMLレポートを出力します。
//   使い方:  node screen_daily.mjs        （通常は「毎日スクリーニング.bat」から実行）
import fs from "node:fs";
import { analyze, buildSeries, tfSeries } from "./src/analysis.generated.mjs";

const ROOT = new URL(".", import.meta.url);
// ローカルで Webhook URL を入れるなら notify_config.local.json（gitignore済み）を使う。
// クラウド(GitHub Actions)では Secret を環境変数 WEBHOOK_URL で渡すので空のままでOK。
const localCfg = new URL("./notify_config.local.json", ROOT);
const cfgPath = fs.existsSync(localCfg) ? localCfg : new URL("./notify_config.json", ROOT);
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const DATA = new URL("./screening_data.csv", ROOT);

// --- CSV 読み込み（縦持ち: コード:社名, 日付, 始値, 高値, 安値, 終値, 出来高） ---
if (!fs.existsSync(DATA)) {
  console.error("screening_data.csv が見つかりません。先に fetch_data.py を実行してください。");
  process.exit(1);
}
const text = fs.readFileSync(DATA, "utf8");
const groups = new Map();
for (const line of text.split(/\r?\n/).slice(1)) {
  const c = line.split(",");
  if (c.length < 6) continue;
  const sym = c[0];
  if (!sym || sym === "銘柄") continue;
  if (!groups.has(sym)) groups.set(sym, []);
  groups.get(sym).push({
    date: c[1], open: +c[2], high: +c[3], low: +c[4], close: +c[5], volume: +c[6],
  });
}

// --- 全銘柄を判定 ---
const wantAll = (process.env.SIGNALS || cfg.signals) === "all";
const buys = [], sells = [];
for (const [sym, bars] of groups) {
  if (bars.length < 80) continue;
  const ci = sym.indexOf(":");
  const code = ci >= 0 ? sym.slice(0, ci) : sym;
  const name = ci >= 0 ? sym.slice(ci + 1) : sym;
  const a = analyze(buildSeries(tfSeries(bars, "D")), "日");
  const row = { code, name, verdict: a.verdict, vIdx: a.vIdx, score: a.score, trend: a.trend, rsi: a.last.rsi, close: a.last.close };
  const isBuy = wantAll ? a.vIdx >= 3 : a.vIdx === 4;   // strong: 強い買いのみ / all: 買い系
  const isSell = wantAll ? a.vIdx <= 1 : a.vIdx === 0;  // strong: 強い売りのみ / all: 売り系
  if (isBuy) buys.push(row);
  else if (isSell) sells.push(row);
}
buys.sort((a, b) => b.score - a.score);
sells.sort((a, b) => a.score - b.score);

const today = new Date().toISOString().slice(0, 10);
const total = groups.size;
console.log(`判定完了: ${total}銘柄中  買い系 ${buys.length} / 売り系 ${sells.length}`);

// --- HTMLレポート ---
const fmtPrice = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1));
const tableRows = (rows) => rows.map((r) =>
  `<tr><td>${r.code}</td><td>${r.name}</td><td>${r.verdict}</td><td style="text-align:right">${r.score > 0 ? "+" : ""}${r.score.toFixed(1)}</td><td>${r.trend}</td><td style="text-align:right">${r.rsi != null ? r.rsi.toFixed(0) : "-"}</td><td style="text-align:right">${fmtPrice(r.close)}</td></tr>`
).join("");
const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>罫線シグナル ${today}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b101c;color:#e8edf5;margin:0;padding:24px}
h1{font-size:20px}h2{font-size:16px;margin-top:24px}.buy{color:#ef5a4d}.sell{color:#3f8fd6}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px}
th,td{border-bottom:1px solid #243049;padding:6px 10px;text-align:left}th{color:#8aa;}
.muted{color:#8090a8;font-size:12px}</style>
<h1>罫線スクリーニング　${today}</h1>
<p class="muted">対象 ${total} 銘柄／通知条件: ${cfg.signals === "all" ? "買い系・売り系すべて" : "強い買い・強い売りのみ"}</p>
<h2 class="buy">買いサイン（${buys.length}）</h2>
<table><tr><th>コード</th><th>銘柄</th><th>判定</th><th>スコア</th><th>トレンド</th><th>RSI</th><th>終値</th></tr>${tableRows(buys) || '<tr><td colspan=7 class="muted">該当なし</td></tr>'}</table>
<h2 class="sell">売りサイン（${sells.length}）</h2>
<table><tr><th>コード</th><th>銘柄</th><th>判定</th><th>スコア</th><th>トレンド</th><th>RSI</th><th>終値</th></tr>${tableRows(sells) || '<tr><td colspan=7 class="muted">該当なし</td></tr>'}</table>
</html>`;
const outDir = new URL("./signals/", ROOT);
fs.mkdirSync(outDir, { recursive: true });
const reportPath = new URL(`./signals_${today}.html`, outDir);
fs.writeFileSync(reportPath, html);
console.log("レポート: signals/signals_" + today + ".html");

// --- 通知（Discord / Slack Webhook） ---
async function notify() {
  // クラウド（GitHub Actions）では Secret を環境変数 WEBHOOK_URL で渡す。なければ設定ファイル。
  const url = (process.env.WEBHOOK_URL || cfg.webhook_url || "").trim();
  if (!url) {
    console.log("notify_config.json の webhook_url が未設定のため、通知はスキップしました（レポートのみ）。");
    return;
  }
  if (buys.length === 0 && sells.length === 0) {
    console.log("サイン該当なし。通知はスキップしました。");
    return;
  }
  const listing = (rows) => {
    const shown = rows.slice(0, 30).map((r) => `${r.code} ${r.name}(${r.score > 0 ? "+" : ""}${r.score.toFixed(1)})`).join("、");
    return rows.length > 30 ? `${shown} …他${rows.length - 30}件` : shown || "なし";
  };
  const lines = [
    `**罫線スクリーニング ${today}**（対象${total}銘柄）`,
    `🔴 買い（${buys.length}）: ${listing(buys)}`,
    `🔵 売り（${sells.length}）: ${listing(sells)}`,
  ];
  let msg = lines.join("\n");
  if (msg.length > 1900) msg = msg.slice(0, 1900) + " …(省略)";

  const isSlack = /hooks\.slack\.com/.test(url);
  const payload = isSlack ? { text: msg } : { content: msg };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) console.log(`通知を送信しました（${isSlack ? "Slack" : "Discord"}）。`);
    else console.error(`通知の送信に失敗: HTTP ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error("通知の送信に失敗:", e.message);
  }
}
await notify();
