// カード引落リマインド
// Notionの「月次支払い」DBを読み、引落日が近い行を口座別に集計してLINEに通知する。
// あわせて、カードマスタの有効カードごとに「次の支払日」の行がなければ自動作成する
// （金額空欄・状態=概算。月の途中経過の入力先が常に存在する状態を保つ）。
// daily-screening と同じ通知経路（LINE_TOKEN=Messaging APIブロードキャスト / WEBHOOK_URL=Make等）を使う。
//
// 環境変数:
//   NOTION_TOKEN        必須。Notion内部インテグレーションのシークレット。
//                       「カード支払い管理」ページをインテグレーションに共有しておくこと。
//   NOTION_PAYMENTS_DB  月次支払いDBのdatabase_id（既定: 下記DEFAULT_PAYMENTS_DB）
//   NOTION_MASTER_DB    カードマスタDBのdatabase_id（既定: 下記DEFAULT_MASTER_DB）
//   LINE_TOKEN / WEBHOOK_URL  どちらか。両方あればLINE優先（screen_daily.mjsと同じ）。
//   DRY_RUN=1           送信・行作成をせず内容をコンソールに出すだけ。
//   FORCE_SEND=1        通知対象日でなくても疎通確認用の1通を送る（workflow_dispatch から使う）。
//
// 通知タイミング（毎日実行し、条件に合う日だけ送る）:
//   - 引落日の3日前: 事前リマインド（残高の準備）
//   - 引落日の1日前: 最終確認
//   「残高確認済」にチェックが入った行は通知対象から外れる。
//   引落日が10日/25日の3日前なのに未入力（該当行ゼロ）の場合は入力催促を送る。

const NOTION_TOKEN = (process.env.NOTION_TOKEN || "").trim();
const DEFAULT_PAYMENTS_DB = "571ad8ef3d6445cf87f3193150166f34"; // 月次支払いDB
const DEFAULT_MASTER_DB = "eedf9285ab3f4daa825f82e5602bd04a"; // カードマスタDB
const PAYMENTS_DB = (process.env.NOTION_PAYMENTS_DB || DEFAULT_PAYMENTS_DB).trim();
const MASTER_DB = (process.env.NOTION_MASTER_DB || DEFAULT_MASTER_DB).trim();
const LINE_TOKEN = (process.env.LINE_TOKEN || "").trim();
const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").trim();
const DRY_RUN = process.env.DRY_RUN === "1";
const FORCE_SEND = process.env.FORCE_SEND === "1"; // 日付条件に関係なく1通送って経路を確認する（疎通テスト用）
let sendFailed = false; // 送信に失敗したらジョブを赤くするためのフラグ
const NOTION_PAGE_URL = "https://app.notion.com/p/39a141c2acaa81d2b1d7e37fa5cadb19"; // カード支払い管理

const NOTION_HEADERS = {
  Authorization: "Bearer " + NOTION_TOKEN,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

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
const iso = (dateUTC) => dateUTC.toISOString().slice(0, 10);
const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");
const mmdd = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

async function notionQuery(dbId, filter) {
  const rows = [];
  let cursor = undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: NOTION_HEADERS,
      body: JSON.stringify({ page_size: 100, start_cursor: cursor, ...(filter ? { filter } : {}) }),
    });
    if (!res.ok) throw new Error(`Notion query失敗(${dbId}): HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function parsePaymentRow(page) {
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

// --- 翌サイクル行の自動作成 ---
// 有効カードごとに「次に来る支払日（10日/25日）」の行が月次支払いに存在するか確認し、なければ作る。
// 既存判定は「同じカードへのrelation かつ 引落日が同じ年月」（振替日が休日ずれで手修正されていても一致する）。
async function ensureNextCycleRows(today) {
  const masters = await notionQuery(MASTER_DB, { property: "有効", checkbox: { equals: true } });
  const upcoming = await notionQuery(PAYMENTS_DB, {
    property: "引落日",
    date: { on_or_after: iso(new Date(today.getTime() - 27 * 86400000)) }, // 当月分も既存判定に含める
  });
  let created = 0;
  for (const card of masters) {
    const p = card.properties || {};
    const name = (p["カード名"]?.title || []).map((t) => t.plain_text).join("") || "(カード名未設定)";
    const payDaySel = p["支払日"]?.select?.name || "";
    const m = payDaySel.match(/^(\d+)日$/);
    if (!m) {
      console.log(`行自動作成スキップ（支払日「${payDaySel || "未設定"}」は日付を特定できない）: ${name}`);
      continue;
    }
    const day = Number(m[1]);
    // 次に来る支払日: 今日がその日以降なら翌月
    const y = today.getUTCFullYear();
    const mo = today.getUTCMonth();
    const target =
      today.getUTCDate() < day ? new Date(Date.UTC(y, mo, day)) : new Date(Date.UTC(y, mo + 1, day));
    const targetIso = iso(target);
    const targetYM = targetIso.slice(0, 7);
    const exists = upcoming.some((row) => {
      const rel = (row.properties?.["カード"]?.relation || []).map((r) => r.id);
      const d = row.properties?.["引落日"]?.date?.start || "";
      return rel.includes(card.id) && d.slice(0, 7) === targetYM;
    });
    if (exists) continue;
    if (DRY_RUN) {
      console.log(`DRY_RUN: 行を作成する想定 → ${targetYM} ${name}（引落日 ${targetIso}）`);
      continue;
    }
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: NOTION_HEADERS,
      body: JSON.stringify({
        parent: { database_id: PAYMENTS_DB },
        properties: {
          名前: { title: [{ text: { content: `${targetYM} ${name}` } }] },
          カード: { relation: [{ id: card.id }] },
          引落日: { date: { start: targetIso } },
          状態: { select: { name: "概算" } },
        },
      }),
    });
    if (!res.ok) {
      console.error(`行の自動作成に失敗（${name}）: HTTP ${res.status} ${await res.text()}`);
      continue;
    }
    created++;
    console.log(`行を自動作成: ${targetYM} ${name}（引落日 ${targetIso}）`);
  }
  if (created === 0) console.log("翌サイクル行: すべて存在（作成なし）。");
}

function buildMessage(due, daysUntil) {
  const byAccount = new Map();
  for (const r of due) {
    if (!byAccount.has(r.account)) byAccount.set(r.account, []);
    byAccount.get(r.account).push(r);
  }
  const when = daysUntil === 0 ? "本日" : daysUntil === 1 ? "明日" : `${daysUntil}日後`;
  const lines = [`💳 カード引落リマインド（${mmdd(due[0].date)}・${when}）`];
  let total = 0;
  let missingAll = 0;
  for (const [account, rows] of byAccount) {
    const sum = rows.reduce((a, r) => a + (r.amount || 0), 0);
    total += sum;
    // 金額未入力の行は合計に 0 で効くので、額面を素直に読むと「払うものが無い」と誤読する。
    // 件数を明示して、この数字が下限であることが分かるようにする。
    const missing = rows.filter((r) => r.amount == null).length;
    missingAll += missing;
    const note =
      missing > 0
        ? `（金額未入力${missing}件を除く）`
        : rows.some((r) => r.status === "概算")
          ? "（概算含む）"
          : "";
    lines.push("", `【${account}】 ${yen(sum)}${note}`);
    for (const r of rows) {
      // 未入力は「概算」より重い情報なので、状態が概算でも未入力を優先して出す
      const flag = r.amount == null ? " ※金額未入力" : r.status === "概算" ? " ※概算" : "";
      lines.push(`・${r.title} ${r.amount != null ? yen(r.amount) : "—"}${flag}`);
    }
  }
  const totalNote = missingAll > 0 ? `（金額未入力${missingAll}件を除く。実際はこれより多い）` : "";
  lines.push("", `合計 ${yen(total)}${totalNote}`, "残高を確認したらNotionの「残高確認済」にチェック", NOTION_PAGE_URL);
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
    else {
      sendFailed = true;
      console.log(`::error::LINE通知の送信に失敗: HTTP ${res.status} ${await res.text()}`);
    }
  } else if (WEBHOOK_URL) {
    // Make.com のシナリオは payload の `content` を LINE 本文にマッピングしている
    // （screen_daily.mjs と同じ約束事）。ここを `message` だけにしていたため、
    // Webhook は 200 を返すのに LINE には空文字が渡り、8/7の初回リマインドが消えた。
    // `kind` / `message` は他の受け口のために残す。
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, kind: "payment_reminder", message: text }),
    });
    if (res.ok) console.log("通知を送信しました（Webhook）。");
    else {
      sendFailed = true;
      console.log(`::error::Webhook通知の送信に失敗: HTTP ${res.status} ${await res.text()}`);
    }
  } else {
    // 送るべき通知があるのに宛先が無い＝取りこぼし。緑のまま見逃さないようジョブを赤くする。
    sendFailed = true;
    console.log("::error::通知先が未設定（LINE_TOKEN も WEBHOOK_URL も空）のため送信できませんでした。");
    console.log("送れなかった本文:\n" + text);
  }
}

// 通知すべき日なら送って true、対象外なら何もせず false を返す。
async function notifyIfDue(rows, today) {
  // 3日前と1日前だけ通知（毎日送ってスパムにならないように）
  // 状態=スキップの行はメッセージに出さない（存在自体は anyThisDate 側で「入力済み」扱いのまま）
  for (const daysUntil of [3, 1]) {
    const due = rows.filter((r) => daysBetween(today, r.date) === daysUntil && r.status !== "スキップ");
    if (due.length > 0) {
      await send(buildMessage(due, daysUntil));
      return true;
    }
  }

  // 定例支払日（10日・25日）が3日後なのに1行も入力がない場合は催促
  // （行の自動作成が動いていれば通常ここには来ない。作成失敗時のセーフティネット）
  const ahead3 = new Date(today.getTime() + 3 * 86400000);
  const day = ahead3.getUTCDate();
  if (day === 10 || day === 25) {
    const anyThisDate = rows.some((r) => Math.abs(daysBetween(today, r.date) - 3) <= 2);
    if (!anyThisDate) {
      await send(
        `💳 ${ahead3.getUTCMonth() + 1}/${day} は定例の引落日ですが、「月次支払い」に入力がありません。\n各カードの請求額を入力してください。\n${NOTION_PAGE_URL}`
      );
      return true;
    }
  }
  return false;
}

// 疎通テスト用の本文。直近の未確認行があれば実物と同じ体裁で作る（見た目も一緒に確認できる）。
function testMessage(rows, today) {
  const upcoming = rows
    .filter((r) => r.status !== "スキップ" && daysBetween(today, r.date) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length === 0) {
    return `💳 カード引落リマインド（疎通テスト）\n通知対象の支払いはありません。\n${NOTION_PAGE_URL}`;
  }
  const nearest = upcoming[0].date;
  return buildMessage(upcoming.filter((r) => r.date === nearest), daysBetween(today, nearest));
}

async function main() {
  if (!NOTION_TOKEN) {
    // Secret設定前でもジョブを赤くしない（disclosure_classify と同じスキップ方針）。
    // ただし ::warning:: にして Run summary の Annotations に出す（ログを開かずに気づけるように）。
    console.log("::warning::NOTION_TOKEN が未設定のためスキップしました。");
    return;
  }
  const today = todayJST();

  // 行の自動作成に失敗してもリマインド本体は続行する
  try {
    await ensureNextCycleRows(today);
  } catch (e) {
    console.error("翌サイクル行の自動作成でエラー（リマインドは継続）:", e);
  }

  const rows = (await notionQuery(PAYMENTS_DB, { property: "残高確認済", checkbox: { equals: false } }))
    .map(parsePaymentRow)
    .filter(Boolean);
  console.log(`未確認の支払い行: ${rows.length}件`);

  const notified = await notifyIfDue(rows, today);

  if (!notified) {
    if (FORCE_SEND) {
      console.log("FORCE_SEND=1 のため、通知対象日ではありませんが疎通確認の1通を送ります。");
      await send("【疎通テスト】\n" + testMessage(rows, today));
    } else {
      console.log("本日の通知対象なし。");
    }
  }

  // 送信に失敗していたらジョブを赤くする（緑＝届いた、と読めるようにするため）
  if (sendFailed) process.exit(1);
}

main().catch((e) => {
  console.error("payment_reminder 実行エラー:", e);
  process.exit(1);
});
