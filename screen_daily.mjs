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
const buys = [], sells = [], tops = [], invs = [];
for (const [sym, bars] of groups) {
  if (bars.length < 80) continue;
  const ci = sym.indexOf(":");
  const code = ci >= 0 ? sym.slice(0, ci) : sym;
  const name = ci >= 0 ? sym.slice(ci + 1) : sym;
  const series = buildSeries(tfSeries(bars, "D"));
  const a = analyze(series, "日");
  const row = { code, name, verdict: a.verdict, vIdx: a.vIdx, score: a.score, trend: a.trend, rsi: a.last.rsi, close: a.last.close };
  const isBuy = wantAll ? a.vIdx >= 3 : a.vIdx === 4;   // strong: 強い買いのみ / all: 買い系
  const isSell = wantAll ? a.vIdx <= 1 : a.vIdx === 0;  // strong: 強い売りのみ / all: 売り系
  if (isBuy) buys.push(row);
  else if (isSell) sells.push(row);

  // 三尊（天井=top）／逆三尊（底=inverse）は買い/売り判定に関わらず拾う。
  // 形成中は常に、完成（ネックライン抜け済み）は直近10営業日以内に抜けた“今効いている”ものだけ。
  const p = a.pattern;
  if (p && (p.kind === "top" || p.kind === "inverse")) {
    const brokeBarsAgo = p.broke ? series.length - 1 - p.breakI : null;
    const recentBreak = brokeBarsAgo != null && brokeBarsAgo <= 10;
    if (p.status === "forming" || recentBreak) {
      const rec = {
        code, name, close: a.last.close,
        status: p.status,                         // forming / confirmed
        brokeBarsAgo,                             // 何営業日前にネックを抜けたか
        neck: p.neckLevel, target: p.target,
        profile: p.vol ? p.vol.profile : null,    // ideal / partial / weak（出来高の理想度）
        quality: p.quality,
      };
      if (p.kind === "top") tops.push(rec);
      else invs.push(rec);
    }
  }
}
buys.sort((a, b) => b.score - a.score);
sells.sort((a, b) => a.score - b.score);
// 完成（ネックライン抜け）を上に、未完成（形成中）を下に。各内では信頼度(quality)順。
const byStatus = (a, b) => (a.status === b.status ? b.quality - a.quality : a.status === "confirmed" ? -1 : 1);
tops.sort(byStatus);
invs.sort(byStatus);

const today = new Date().toISOString().slice(0, 10);
const total = groups.size;
console.log(`判定完了: ${total}銘柄中  買い系 ${buys.length} / 売り系 ${sells.length}  三尊 ${tops.length} / 逆三尊 ${invs.length}`);

// --- HTMLレポート ---
const fmtPrice = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1));
const tableRows = (rows) => rows.map((r) =>
  `<tr><td>${r.code}</td><td>${r.name}</td><td>${r.verdict}</td><td style="text-align:right">${r.score > 0 ? "+" : ""}${r.score.toFixed(1)}</td><td>${r.trend}</td><td style="text-align:right">${r.rsi != null ? r.rsi.toFixed(0) : "-"}</td><td style="text-align:right">${fmtPrice(r.close)}</td></tr>`
).join("");

// 三尊（天井=割れ）／逆三尊（底=抜け）の状態ラベル。breakWord で「割れ／抜け」を切替。
const patStatus = (r, breakWord) => (r.status === "confirmed" ? `ネックライン${breakWord}（${r.brokeBarsAgo === 0 ? "本日" : r.brokeBarsAgo + "日前"}）` : "形成中");
const profileLabel = (p) => (p === "ideal" ? "理想的" : p === "partial" ? "やや伴う" : p === "weak" ? "弱い" : "-");
const patRows = (rows, breakWord, cls) => rows.map((r) =>
  `<tr><td>${r.code}</td><td>${r.name}</td><td class="${cls}">${patStatus(r, breakWord)}</td><td style="text-align:right">${fmtPrice(r.neck)}</td><td style="text-align:right">${fmtPrice(r.target)}</td><td>${profileLabel(r.profile)}</td><td style="text-align:right">${fmtPrice(r.close)}</td></tr>`
).join("");
const topRows = (rows) => patRows(rows, "割れ", "sell");
const invRows = (rows) => patRows(rows, "抜け", "buy");
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
<h2 class="sell">三尊（ヘッドアンドショルダー天井）（${tops.length}）</h2>
<p class="muted">買い／売り判定に関わらず、三尊を形成中・完成している銘柄。終値がネックラインを割ると「完成」＝下落シグナル。</p>
<table><tr><th>コード</th><th>銘柄</th><th>状態</th><th>ネックライン</th><th>目標</th><th>出来高</th><th>終値</th></tr>${topRows(tops) || '<tr><td colspan=7 class="muted">該当なし</td></tr>'}</table>
<h2 class="buy">逆三尊（インバースH&S・大底）（${invs.length}）</h2>
<p class="muted">買い／売り判定に関わらず、逆三尊を形成中・完成している銘柄。終値がネックラインを上抜けると「完成」＝上昇シグナル。</p>
<table><tr><th>コード</th><th>銘柄</th><th>状態</th><th>ネックライン</th><th>目標</th><th>出来高</th><th>終値</th></tr>${invRows(invs) || '<tr><td colspan=7 class="muted">該当なし</td></tr>'}</table>
</html>`;
const outDir = new URL("./signals/", ROOT);
fs.mkdirSync(outDir, { recursive: true });
const reportPath = new URL(`./signals_${today}.html`, outDir);
fs.writeFileSync(reportPath, html);
console.log("レポート: signals/signals_" + today + ".html");

// --- 通知（LINE Messaging API / Discord / Slack Webhook） ---
async function notify() {
  // クラウド(GitHub Actions)では Secret を環境変数で渡す。なければ設定ファイル。
  const lineToken = (process.env.LINE_TOKEN || cfg.line_token || "").trim();
  const url = (process.env.WEBHOOK_URL || cfg.webhook_url || "").trim();
  if (!lineToken && !url) {
    console.log("通知先が未設定（LINE_TOKEN も webhook_url も空）のため、通知はスキップしました（レポートのみ）。");
    return;
  }
  if (buys.length === 0 && sells.length === 0 && tops.length === 0 && invs.length === 0) {
    console.log("サイン該当なし。通知はスキップしました。");
    return;
  }
  // レポート形式の本文（1銘柄1行：コード 社名 スコア / トレンド RSI / 終値）
  const shortTrend = (t) => (t.includes("上昇") ? "上昇" : t.includes("下降") ? "下降" : "レンジ");
  const reportLines = (rows) => {
    const cap = 50;
    const lines = rows.slice(0, cap).map((r) =>
      `${r.code} ${r.name} ${r.score > 0 ? "+" : ""}${r.score.toFixed(1)} / ${shortTrend(r.trend)} RSI${r.rsi != null ? r.rsi.toFixed(0) : "-"} / ${fmtPrice(r.close)}`
    );
    if (rows.length > cap) lines.push(`…他${rows.length - cap}件`);
    return lines.join("\n") || "なし";
  };
  const patLines = (rows, breakWord) => {
    const cap = 50;
    const lines = rows.slice(0, cap).map((r) =>
      `${r.code} ${r.name} ${r.status === "confirmed" ? `${breakWord}(${r.brokeBarsAgo === 0 ? "本日" : r.brokeBarsAgo + "日前"})` : "形成中"} / ネック${fmtPrice(r.neck)} 目標${fmtPrice(r.target)} / ${fmtPrice(r.close)}`
    );
    if (rows.length > cap) lines.push(`…他${rows.length - cap}件`);
    return lines.join("\n") || "なし";
  };
  let msg = [
    `📊 罫線スクリーニング ${today}`,
    `対象${total}銘柄 ｜ 🔴買い ${buys.length} ｜ 🔵売り ${sells.length} ｜ ⛰️三尊 ${tops.length} ｜ 🛡逆三尊 ${invs.length}`,
    "",
    `🔴 買いサイン（${buys.length}）`,
    reportLines(buys),
    "",
    `🔵 売りサイン（${sells.length}）`,
    reportLines(sells),
    "",
    `⛰️ 三尊・天井（${tops.length}）`,
    patLines(tops, "割れ"),
    "",
    `🛡 逆三尊・大底（${invs.length}）`,
    patLines(invs, "抜け"),
  ].join("\n");

  try {
    if (lineToken) {
      // LINE Messaging API：友だち全員へブロードキャスト（テキストは最大5000字）
      const text = msg.length > 4900 ? msg.slice(0, 4900) + " …(省略)" : msg;
      const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + lineToken },
        body: JSON.stringify({ messages: [{ type: "text", text }] }),
      });
      if (res.ok) console.log("通知を送信しました（LINE）。");
      else console.error(`LINE通知の送信に失敗: HTTP ${res.status} ${await res.text()}`);
    } else {
      // Webhook（URLで自動判別）。Make/Zapier等の汎用Webhookには構造化JSONを送る。
      const clip = (s, n) => (s.length > n ? s.slice(0, n) + " …(省略)" : s);
      const isSlack = /hooks\.slack\.com/.test(url);
      const isDiscord = /discord(app)?\.com/.test(url);
      const brief = (rows) => rows.map((r) => ({ code: r.code, name: r.name, score: +r.score.toFixed(1), close: r.close }));
      let payload, label;
      if (isSlack) { payload = { text: clip(msg, 2900) }; label = "Slack"; }
      else if (isDiscord) { payload = { content: clip(msg, 1900) }; label = "Discord"; }
      else {
        const briefPat = (rows) => rows.map((r) => ({ code: r.code, name: r.name, status: r.status, broke_bars_ago: r.brokeBarsAgo, neck: r.neck, target: r.target, close: r.close }));
        payload = {
          content: clip(msg, 4900),          // LINE等へ転送する本文（Makeで content を使う）
          date: today,
          buy_count: buys.length,
          sell_count: sells.length,
          top_count: tops.length,
          inverse_count: invs.length,
          buys: brief(buys),
          sells: brief(sells),
          tops: briefPat(tops),
          inverses: briefPat(invs),
        };
        label = "Webhook(Make等)";
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) console.log(`通知を送信しました（${label}）。`);
      else console.error(`通知の送信に失敗: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (e) {
    console.error("通知の送信に失敗:", e.message);
  }
}
await notify();
