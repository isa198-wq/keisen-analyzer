// v6 フェーズN-1: クラスタ命名 + 開示突き合わせ（Vertex AI Gemini・構造化出力）
//   inago/clusters.json の各クラスタに、テーマ名・材料(catalyst)・確度・開示裏付け有無を付与し
//   inago/cluster_names.json に書き出す。X検索(Grok)は使わない代わりに、v5で蓄積中の適時開示
//   （signals/disclosures.jsonl）という一次情報で裏付けを取る。
//   §9-1により、当初案のClaude(@anthropic-ai/sdk)ではなく disclosure_classify.mjs と同じ
//   Vertex AI Gemini呼び出しパターン(@google/genai・認証・スキップ挙動)をそのまま流用する。
// 幻覚対策: 与えた開示・一般知識で説明できない場合は「共通テーマ不明瞭」「低」を強制する
//   プロンプトを与える（正直な不明 > 幻覚。v5の分類方針と同じ思想）。
// キー未設定・クラスタ0件・全クラスタ失敗のいずれかならファイルを書かずスキップする
//   （disclosure_classify.mjsと同じ方式。後段のscreen_daily.mjsは名前なしで動く）。
//   個別クラスタの失敗はそのクラスタだけ結果から除外する。
// 使い方: node name_clusters.mjs
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";

const ROOT = new URL(".", import.meta.url);
const CLUSTERS_PATH = new URL("./inago/clusters.json", ROOT);
const DISCLOSURES_PATH = new URL("./signals/disclosures.jsonl", ROOT);
const OUT = new URL("./inago/cluster_names.json", ROOT);
// モデル名はdisclosure_classify.mjsと同一（Vertexのモデル名は推測で書くと404になる。動作確認済みの名前のみ使う）。
const MODEL = "gemini-2.5-pro";
const LOCATION = process.env.VERTEX_AI_LOCATION || "us-central1";
const RECENT_DAYS = 5; // 開示突き合わせに使う直近営業日数（disclosures.jsonlの実在日付ベース）

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    catalyst: { type: "string" },
    confidence: { type: "string", enum: ["高", "中", "低"] },
    evidence: { type: "string", enum: ["開示あり", "開示なし"] },
  },
  required: ["name", "catalyst", "confidence", "evidence"],
};

// grok_name.py と同じ規約: 構成コード昇順連結をキーにする
function keyOf(members) {
  return members.map((m) => m.code).sort().join(",");
}

function loadClusters() {
  if (!fs.existsSync(CLUSTERS_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(CLUSTERS_PATH, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

// 直近RECENT_DAYS営業日（disclosures.jsonlに実在する日付のうち新しい方から）× メンバー銘柄のみ抽出
function loadRecentDisclosuresByCode() {
  const byCode = new Map();
  if (!fs.existsSync(DISCLOSURES_PATH)) return byCode;
  const records = [];
  for (const line of fs.readFileSync(DISCLOSURES_PATH, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* 壊れた行は無視 */ }
  }
  const recentDates = new Set([...new Set(records.map((r) => r.date))].sort().slice(-RECENT_DAYS));
  for (const r of records) {
    if (!recentDates.has(r.date)) continue;
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  return byCode;
}

function buildUserPrompt(cluster, disclosuresByCode) {
  const lines = cluster.members.map((m) => {
    const ds = disclosuresByCode.get(m.code) || [];
    const dtxt = ds.length
      ? ds.map((d) => `  - ${d.title}${d.cls ? `（分類: ${d.cls.kind}・${d.cls.oneLine}）` : ""}`).join("\n")
      : "  （直近開示なし）";
    return `${m.name}(${m.code}):\n${dtxt}`;
  }).join("\n");
  return `次の銘柄群は値動きの相関から機械抽出されたクラスタです。共通テーマがあるか判定してください。\n\n${lines}`;
}

async function nameOne(client, cluster, disclosuresByCode) {
  const res = await client.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: buildUserPrompt(cluster, disclosuresByCode) }] }],
    config: {
      systemInstruction: "あなたは日本株の銘柄クラスタ（値動きの相関で機械抽出した銘柄群）に共通テーマ名を付けるアナリストです。与えられた銘柄名・コードと、あれば適時開示の情報だけを根拠にしてください。与えられた情報や一般知識で説明できない場合は、無理に結びつけず name を「共通テーマ不明瞭」、confidence を「低」としてください。存在しない材料を作ってはいけません。",
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    },
  });
  const candidate = res.candidates?.[0];
  if (!candidate || (candidate.finishReason && candidate.finishReason !== "STOP")) {
    throw new Error(`Geminiから有効な応答がありません（finishReason: ${candidate?.finishReason || "不明"}）`);
  }
  const text = candidate.content?.parts?.find((p) => p.text)?.text;
  if (!text) throw new Error("テキスト応答がありません");
  const parsed = JSON.parse(text);
  return {
    name: String(parsed.name || "共通テーマ不明瞭"),
    catalyst: String(parsed.catalyst || ""),
    confidence: ["高", "中", "低"].includes(parsed.confidence) ? parsed.confidence : "低",
    evidence: parsed.evidence === "開示あり" ? "開示あり" : "開示なし",
  };
}

async function main() {
  const projectId = process.env.VERTEX_AI_PROJECT_ID;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!projectId || !credsPath) {
    console.log("VERTEX_AI_PROJECT_ID / GOOGLE_APPLICATION_CREDENTIALS が未設定のため命名をスキップしました。");
    return;
  }
  const clusters = loadClusters();
  if (!clusters.length) {
    console.log("クラスタが0件のため命名をスキップしました。");
    return;
  }
  const disclosuresByCode = loadRecentDisclosuresByCode();
  const client = new GoogleGenAI({ vertexai: true, project: projectId, location: LOCATION });

  const out = {};
  let ok = 0, ng = 0;
  for (const cluster of clusters) {
    const key = keyOf(cluster.members);
    try {
      out[key] = await nameOne(client, cluster, disclosuresByCode);
      ok++;
    } catch (e) {
      ng++;
      console.error(`命名に失敗（${key}）: ${e.message}`);
    }
  }
  if (ok === 0) {
    console.log(`全クラスタで命名に失敗したため cluster_names.json は書き出しません（対象${clusters.length}件中0件成功）。`);
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`命名完了: 成功 ${ok}件 / 失敗 ${ng}件（対象${clusters.length}件中） → cluster_names.json`);
}

await main();
