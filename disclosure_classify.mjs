// v5フェーズI-2: 適時開示の分類（Claude Haiku 4.5・構造化出力）
//   disclosure_fetch.mjs が貯めた signals/disclosures.jsonl のうち未分類レコードに
//   cls:{kind,surprise,confidence,oneLine,model,classifiedAt} を付与する。
//   分類は開示当日の情報（タイトル）のみを見る。将来リターンは一切参照しない
//   （フェーズJで分類ノイズと本物のエッジを区別するため、ここでの未来参照は致命的）。
//   非決定性対策: 一度 cls が付いたレコードは再分類しない（初回結果を確定として保存）。
//   ANTHROPIC_API_KEY が無い環境では分類をスキップし、取得だけの状態のままジョブを継続する。
// 使い方: node disclosure_classify.mjs
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = new URL(".", import.meta.url);
const OUT = new URL("./signals/disclosures.jsonl", ROOT);
// 分類は高頻度・低難度なので claude-haiku-4-5 を使う（v5§2）。要約や曖昧判断が要る箇所のみ
// opus検討だが、本スキーマは固定enum＋短文要約でhaikuで十分なため本実装では使わない。
const MODEL = "claude-haiku-4-5";

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["earnings", "guidance_up", "guidance_down", "buyback", "dividend", "ma", "other"] },
    surprise: { type: "string", enum: ["positive", "negative", "neutral"] },
    confidence: { type: "number" },
    oneLine: { type: "string" },
  },
  required: ["kind", "surprise", "confidence", "oneLine"],
  additionalProperties: false,
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
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: "あなたは日本の適時開示（TDnet）のタイトルを分類するアナリストです。開示当日に一般公開されている情報だけから判断し、将来の株価やリターンには一切言及しないでください。",
    output_config: {
      format: { type: "json_schema", schema: SCHEMA },
    },
    messages: [{
      role: "user",
      content: `次の適時開示タイトルを分類してください。\n銘柄コード: ${record.code}\nタイトル: ${record.title}`,
    }],
  });
  if (res.stop_reason === "refusal") throw new Error("モデルが分類を拒否しました");
  const text = res.content.find((b) => b.type === "text")?.text;
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

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("ANTHROPIC_API_KEY が未設定のため分類をスキップしました（取得のみ・ジョブは継続）。");
    return;
  }
  const records = loadRecords();
  const targets = records.filter((r) => !r.cls);
  if (targets.length === 0) {
    console.log("未分類レコードはありません。");
    return;
  }

  const client = new Anthropic({ apiKey });
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
