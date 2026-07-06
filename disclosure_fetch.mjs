// v5フェーズI-1: 適時開示の取得（Yanoshin 東証TDnet WEB-API・無料/無認証）
//   指定日（省略時は前日=JST。ジョブは翌朝実行のため前日分はもう出揃っている）の
//   日経225銘柄（nikkei225.txt）の適時開示を取得し、signals/disclosures.jsonl に冪等追記する。
//   本文（PDF/HTML）は保存しない。タイトル・URLのみ保存し、分類は disclosure_classify.mjs が担当する。
//   冪等性: 同一 date|code|title の組は重複追記しない（Yanoshin再取得での二重計上を防ぐ）。
//   個人運営の無料APIは「突然停止しうる」ため、失敗時は握りつぶさずログに残し、
//   当日分をスキップして正常終了する（日次ジョブ全体を落とさない）。
// 使い方: node disclosure_fetch.mjs [--date YYYY-MM-DD]
import fs from "node:fs";

const ROOT = new URL(".", import.meta.url);
const LIST_FILE = new URL("./nikkei225.txt", ROOT);
const OUT = new URL("./signals/disclosures.jsonl", ROOT);
// エンドポイント形は個人運営API仕様変更のリスクがあるため設計書§2の注記どおり実装時に確認したもの:
// https://webapi.yanoshin.jp/webapi/tdnet/list/YYYYMMDD.json?limit=N → {total_count, items:[{Tdnet:{...}}]}
const API_BASE = "https://webapi.yanoshin.jp/webapi/tdnet/list";
const LIMIT = 1000; // 東証全体で1日数百件程度。日経225銘柄だけの絞り込みでも余裕を持った上限。

function loadUniverse() {
  const codes = new Map(); // code -> name
  if (!fs.existsSync(LIST_FILE)) return codes;
  for (const line of fs.readFileSync(LIST_FILE, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const [code, name] = s.split(",");
    if (code) codes.set(code.trim(), (name || "").trim());
  }
  return codes;
}

// JST基準の日付文字列（offsetDays=-1で前日）。CIランナーはUTCのため単純な new Date() では日付がずれる。
function jstDate(offsetDays = 0) {
  const t = Date.now() + 9 * 3600 * 1000 + offsetDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function loadExistingKeys() {
  const seen = new Set();
  if (!fs.existsSync(OUT)) return seen;
  for (const line of fs.readFileSync(OUT, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      seen.add(`${r.date}|${r.code}|${r.title}`);
    } catch { /* 壊れた行は無視 */ }
  }
  return seen;
}

function appendRecords(records) {
  if (!records.length) return;
  fs.mkdirSync(new URL("./signals/", ROOT), { recursive: true });
  fs.appendFileSync(OUT, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function main() {
  const di = process.argv.indexOf("--date");
  const dateArg = di >= 0 ? process.argv[di + 1] : null;
  const date = dateArg || jstDate(-1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`日付形式が不正です: ${date}（YYYY-MM-DD で指定してください）`);
    process.exitCode = 1;
    return;
  }

  const universe = loadUniverse();
  if (universe.size === 0) {
    console.error("nikkei225.txt が見つからないか空です。対象銘柄がありません。");
    process.exitCode = 1;
    return;
  }

  const ymd = date.replace(/-/g, "");
  const url = `${API_BASE}/${ymd}.json?limit=${LIMIT}`;
  let json;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (e) {
    // 無料APIの停止・タイムアウトはここで完結させ、日次ジョブ全体は落とさない。
    console.error(`開示取得に失敗（${date}）: ${e.message}。当日分はスキップします（欠損日として記録）。`);
    return;
  }

  const items = Array.isArray(json.items) ? json.items : [];
  if (typeof json.total_count === "number" && json.total_count > items.length) {
    console.warn(`⚠ 取得件数(${items.length})が総件数(${json.total_count})より少ない可能性があります（limit=${LIMIT}を検討）。`);
  }

  const seen = loadExistingKeys();
  const retrievedAt = new Date().toISOString();
  const records = [];
  for (const it of items) {
    const t = it.Tdnet || it;
    const rawCode = String(t.company_code || "");
    const code = rawCode.slice(0, 4);
    if (!universe.has(code)) continue; // 対象は既存223銘柄のみ（v4§6と同じユニバース制約）
    const title = (t.title || "").trim();
    if (!title) continue;
    const disclosureDate = String(t.pubdate || date).slice(0, 10);
    const key = `${disclosureDate}|${code}|${title}`;
    if (seen.has(key)) continue; // 冪等性: 同一date|code|titleは重複追記しない
    seen.add(key);
    records.push({ date: disclosureDate, code, title, docUrl: t.document_url || "", retrievedAt });
  }
  appendRecords(records);
  console.log(`${date}: 対象銘柄の開示 ${records.length}件を追記しました（取得総数${items.length}件中）。`);
}

await main();
