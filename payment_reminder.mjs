// カード引落リマインド
// Notionの「月次支払い」DBを読み、引落日が近い行を口座別に集計してLINEに通知する。
// daily-screening と同じ通知経路（LINE_TOKEN=Messaging APIブロードキャスト / WEBHOOK_URL=Make等）を使う。
//
// 環境変数:
//   NOTION_TOKEN        必須。Notion内部インテグレーションのシークレット。
//                       「カード支払い管理」ページをインテグレーションに共有しておくこと。
//   NOTION_PAYMENTS_DB  月次支払いDBのdatabase_id（既定: 下記DEFAULT_DB）
//   LINE_TOKEN / WEBHOOK_URL  どちらか。両方あればLINE優先（screen_daily.mjsと同じ）。
//   DRY_RUN=1           送信せず本文をコンソールに出すだけ。
//
// 通知タイミング（毎日実行し、条件に合う日だけ送る）:
//   - 引落日の3日前: 事前リマインド（残高の準備）
//   - 引落日の1日前: 最終確認
//   「残高確認済」にチェックが入った行は通知対象から外れる。
//   引落日が10日/25日の3日前なのに未入力（該当行ゼロ）の場合は入力催促を送る。

const NOTION_TOKEN = (process.env.NOTION_TOKEN || "").trim();
const DEFAULT_DB = "571ad8ef3d6445cf87f3193150166f34"; // 月次支払いDB
const DB_ID = (process.env.NOTION_PAYMENTS_DB || DEFAULT_DB).trim();
const LINE_TOKEN = (process.env.LINE_TOKEN || "").trim();
const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").trim();
const DRY_RUN = process.env.DRY_RUN === "1";
const NOTION_PAGE_URL = "https://app.notion.com/p/39a141c2acaa81d2b1d7e37fa5cadb19"; // カード支払い管理

// JSTの「今日」（Actionsのランナー=UTCでも正しく動くように明示変換）
function todayJST() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function daysBetween(fromUTC, isoDate) {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  return Math.round((t - fromUTC.getTime()) / 86400000);
}
const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");
const mmdd = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

async function queryPayments() {
  const rows = [];
  let cursor = undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${DB_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + NOTION_TOKEN,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 100,
        start_cursor: cursor,
        filter: { property: "残高確認済", checkbox: { equals: false } },
      }),
    });
    if (!res.ok) throw new Error(`Notion query失敗: HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return rows.map(parseRow).filter(Boolean);
}

function parseRow(page) {
  const p = page.properties || {};
  const date = p["引落日"]?.date?.start;
  if (!date) return null;
  const title = (p["名前"]?.title || []).map((t) => t.plain_text).join("") || "(名称未設定)";
  const amount = p["金額"]?.number;
  const status = p["状態"]?.select?.name || "";
  // 引落口座はカードマスタからのロールアップ（selectの配列で返る）
  const roll = p["引落口座"]?.rollup?.array || [];
  const account = roll.map((r) => r.select?.name).filter(Boolean)[0] || "口座不明";
  return { title, date, amount, status, account };
}

function buildMessage(due, daysUntil) {
  const byAccount = new Map();
  for (const r of due) {
    if (!byAccount.has(r.account)) byAccount.set(r.account, []);
    byAccount.get(r.account).push(r);
  }
  const when = daysUntil === 1 ? "明日" : `${daysUntil}日後`;
  const lines = [`💳 カード引落リマインド（${mmdd(due[0].date)}・${when}）`];
  let total = 0;
  for (const [account, rows] of byAccount) {
    const sum = rows.reduce((a, r) => a + (r.amount || 0), 0);
    total += sum;
    const approx = rows.some((r) => r.status === "概算" || r.amount == null) ? "（概算含む）" : "";
    lines.push("", `【${account}】 ${yen(sum)}${approx}`);
    for (const r of rows) {
      const flag = r.status === "概算" ? " ※概算" : r.amount == null ? " ※金額未入力" : "";
      lines.push(`・${r.title} ${r.amount != null ? yen(r.amount) : "?"}${flag}`);
    }
  }
  lines.push("", `合計 ${yen(total)}`, "残高を確認したらNotionの「残高確認済」にチェック", NOTION_PAGE_URL);
  return lines.join("\n");
}

async function send(text) {
  if (DRY_RUN) {
    console.log("--- DRY_RUN: 送信せず本文のみ表示 ---\n" + text);
    return;
  }
  if (LINE_TOKEN) {
    const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + LINE_TOKEN },
      body: JSON.stringify({ messages: [{ type: "text", text }] }),
    });
    if (res.ok) console.log("通知を送信しました（LINE）。");
    else console.error(`LINE通知の送信に失敗: HTTP ${res.status} ${await res.text()}`);
  } else if (WEBHOOK_URL) {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "payment_reminder", message: text }),
    });
    if (res.ok) console.log("通知を送信しました（Webhook）。");
    else console.error(`Webhook通知の送信に失敗: HTTP ${res.status} ${await res.text()}`);
  } else {
    console.log("通知先が未設定（LINE_TOKEN も WEBHOOK_URL も空）。本文:\n" + text);
  }
}

async function main() {
  if (!NOTION_TOKEN) {
    // Secret設定前でもジョブを赤くしない（disclosure_classify と同じスキップ方針）
    console.log("NOTION_TOKEN が未設定のためスキップしました。");
    return;
  }
  const today = todayJST();
  const rows = await queryPayments();
  console.log(`未確認の支払い行: ${rows.length}件`);

  // 3日前と1日前だけ通知（毎日送ってスパムにならないように）
  for (const daysUntil of [3, 1]) {
    const due = rows.filter((r) => daysBetween(today, r.date) === daysUntil);
    if (due.length > 0) {
      await send(buildMessage(due, daysUntil));
      return;
    }
  }

  // 定例支払日（10日・25日）が3日後なのに1行も入力がない場合は催促
  const ahead3 = new Date(today.getTime() + 3 * 86400000);
  const day = ahead3.getUTCDate();
  if (day === 10 || day === 25) {
    const anyThisDate = rows.some((r) => Math.abs(daysBetween(today, r.date) - 3) <= 2);
    if (!anyThisDate) {
      await send(
        `💳 ${ahead3.getUTCMonth() + 1}/${day} は定例の引落日ですが、「月次支払い」に入力がありません。\n各カードの請求額を入力してください。\n${NOTION_PAGE_URL}`
      );
      return;
    }
  }
  console.log("本日の通知対象なし。");
}

main().catch((e) => {
  console.error("payment_reminder 実行エラー:", e);
  process.exit(1);
});
