// v5フェーズI-2: 適時開示の分類（Gemini・Vertex AI経由・構造化出力）
//   disclosure_fetch.mjs が貯めた signals/disclosures.jsonl のうち未分類レコードに
//   cls:{kind,surprise,confidence,oneLine,model,classifiedAt} を付与する。
//   分類は開示当日の情報（タイトル）のみを見る。将来リターンは一切参照しない
//   （フェーズJで分類ノイズと本物のエッジを区別するため、ここでの未来参照は致命的）。
//   非決定性対策: 一度 cls が付いたレコードは再分類しない（初回結果を確定として保存）。
//   VERTEX_AI_PROJECT_ID / GOOGLE_APPLICATION_CREDENTIALS が無い環境では分類をスキップし、
//   取得だけの状態のままジョブを継続する。
//   認証はサービスアカウント(GOOGLE_APPLICATION_CREDENTIALS)によるApplication Default
//   Credentials。Anthropic版からの移行(2026-07-14、Dify等で使えているVertex AIのクレジットを
//   活用するため)。
// 使い方: node disclosure_classify.mjs
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";

const ROOT = new URL(".", import.meta.url);
const OUT = new URL("./signals/disclosures.jsonl", ROOT);
// モデル名はDifyの「時刻表2」ワークフローで実際に動作確認済みの"Gemini 2.5 Pro"に合わせる
// （このGoogle Cloudプロジェクト/リージョンでは gemini-2.0-flash-001 が404で使えなかったため）。
const MODEL = "gemini-2.5-pro";
const LOCATION = process.env.VERTEX_AI_LOCATION || "us-central1";

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["earnings", "guidance_up", "guidance_down", "buyback", "dividend", "ma", "other"] },
    surprise: { type: "string", enum: ["positive", "negative", "neutral"] },
    confidence: { type: "number" },
    oneLine: { type: "string" },
  },
  required: ["kind", "surprise", "confidence", "oneLine"],
};

function loadRecords() {
  if (!fs.existsSync(OUT)) return [];
  const out = [];
  for (const line of fs.readFileSync(OUT, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 壊れた行は無視 */ }
  }
  return out;
}

function saveRecords(records) {
  fs.writeFileSync(OUT, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function classifyOne(client, record) {
  const res = await client.models.generateContent({
    model: MODEL,
    contents: [{
      role: "user",
      parts: [{
        text: `次の適時開示タイトルを分類してください。\n銘柄コード: ${record.code}\nタイトル: ${record.title}`,
      }],
    }],
    config: {
      systemInstruction: "あなたは日本の適時開示（TDnet）のタイトルを分類するアナリストです。開示当日に一般公開されている情報だけから判断し、将来の株価やリターンには一切言及しないでください。",
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    },
  });

  const candidate = res.candidates?.[0];
  if (!candidate) {
    const blockReason = res.promptFeedback?.blockReason;
    throw new Error(`Geminiから応答がありません（blockReason: ${blockReason || "不明"}）`);
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(`モデルが分類を拒否/中断しました（finishReason: ${candidate.finishReason}）`);
  }
  const text = candidate.content?.parts?.find((p) => p.text)?.text;
  if (!text) throw new Error("テキスト応答がありません");
  const parsed = JSON.parse(text);
  return {
    kind: parsed.kind,
    surprise: parsed.surprise,
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : null,
    oneLine: String(parsed.oneLine || "").slice(0, 60),
    model: MODEL,
    classifiedAt: new Date().toISOString(),
  };
}

// 設定漏れによるスキップは ::warning:: で出す。console.log だとジョブが緑のままログにしか残らず、
// 何週間も気づかれない（2026-08-02、payment_reminder が Secret 未設定のまま3週間「緑で成功」
// していた事例を受けて導入）。Run summary の Annotations 欄に出るので開かなくても見える。
function warn(msg) {
  console.log(`::warning::${msg}`);
}

// 鍵は「envが指すパスに中身のあるJSONが実在するか」まで見る。ワークフローは
// GOOGLE_APPLICATION_CREDENTIALS を常に固定パスで渡すため、env の有無だけでは
// 「Secretが空で空ファイルが置かれた」状態を検知できない。
function credsReady(credsPath) {
  try {
    const raw = fs.readFileSync(credsPath, "utf8").trim();
    if (!raw) return false;
    const json = JSON.parse(raw);
    return Boolean(json.client_email || json.type);
  } catch {
    return false;
  }
}

async function main() {
  const projectId = process.env.VERTEX_AI_PROJECT_ID;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!projectId || !credsPath) {
    warn("VERTEX_AI_PROJECT_ID / GOOGLE_APPLICATION_CREDENTIALS が未設定のため分類をスキップしました（取得のみ・ジョブは継続）。");
    return;
  }
  if (!credsReady(credsPath)) {
    warn(`サービスアカウント鍵(${credsPath})が空または不正なJSONのため分類をスキップしました（Secret GCP_SERVICE_ACCOUNT_JSON を確認）。`);
    return;
  }
  const records = loadRecords();
  const targets = records.filter((r) => !r.cls);
  if (targets.length === 0) {
    console.log("未分類レコードはありません。");
    return;
  }

  const client = new GoogleGenAI({ vertexai: true, project: projectId, location: LOCATION });
  let ok = 0, ng = 0;
  for (const record of targets) {
    try {
      record.cls = await classifyOne(client, record);
      ok++;
      saveRecords(records); // 逐次保存: 途中でAPI障害が起きても分類済み分は失わない
    } catch (e) {
      ng++;
      console.error(`分類に失敗（${record.date} ${record.code} ${record.title}）: ${e.message}`);
      // cls を付けずにおく＝未分類のまま残り、次回実行時に自動で再試行される
    }
  }
  console.log(`分類完了: 成功 ${ok}件 / 失敗 ${ng}件（対象${targets.length}件中。失敗分は次回実行で再試行）`);
}

await main();
