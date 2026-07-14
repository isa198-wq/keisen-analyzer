/**
 * 気になりメモ（LINE → Vertex AI Gemini分類 → Notion「mydb」→ LINE返信）
 * -------------------------------------------------
 * gateway.gsのdoPostルータから、LINE Webhookイベント（body.destination + body.events）
 * を受け取ったときに呼ばれる。テキスト以外・空文字のメッセージは黙ってスキップする
 * （2026-06-26に非テキストメッセージ流入でMakeシナリオが自動停止した事故の再発防止点）。
 * 先頭が「かゆい」のメッセージは kayumi.gs のかゆみ記録ハンドラへ委譲する。
 *
 * 前提:
 *  - Notion側で内部インテグレーションを作成し、「mydb」ページに接続しておくこと。
 *    トークンはスクリプトプロパティ NOTION_TOKEN へ。
 *  - AI分類はVertex AI Gemini（サービスアカウント認証）を使用。disclosure_classify.mjs
 *    （keisen-analyzerリポジトリ）で動作確認済みの構成（プロジェクト/モデル/サービス
 *    アカウント）を流用。Google AI Studioの素のAPIキーは課金設定の問題で使えなかった
 *    （2026-07-13）ため、Vertex AIに切り替え（2026-07-14）。
 *    スクリプトプロパティ GCP_SERVICE_ACCOUNT_JSON に、サービスアカウントのJSON鍵の
 *    中身をそのまま設定すること（GitHub Secretsに設定したものと同じ値でよい）。
 */

const MEMO_NOTION_DATA_SOURCE_ID = '35c141c2-acaa-80d6-9cd9-000b0c20a5a8';
const VERTEX_PROJECT_ID = 'gen-lang-client-0643370357';
const VERTEX_LOCATION = 'us-central1';
const VERTEX_MODEL = 'gemini-2.5-pro';

/** gateway.gsのdoPostルータから呼ばれるLINE Webhookのエントリポイント。 */
function handleLineWebhook_(body) {
  const events = body.events || [];
  events.forEach(function (event) {
    try {
      handleLineEvent_(event);
    } catch (err) {
      notifyError_('handleLineEvent_', err);
    }
  });
  return jsonResponse({ ok: true });
}

function handleLineEvent_(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return; // スタンプ・画像・位置情報等は黙ってスキップ
  }
  const text = (event.message.text || '').trim();
  if (!text) {
    return; // 空文字も黙ってスキップ
  }

  if (/^かゆい/.test(text)) {
    handleKayumiEvent_(event, text); // kayumi.gsへ委譲
    return;
  }

  handleMemoEvent_(event, text);
}

function handleMemoEvent_(event, text) {
  const replyToken = event.replyToken;
  let analysis;
  let aiFailed = false;

  try {
    analysis = analyzeMemo_(text);
  } catch (err) {
    notifyError_('analyzeMemo_', err);
    aiFailed = true;
    analysis = { title: text.slice(0, 15), category: '', reply: '' };
  }

  try {
    writeMemoToNotion_(text, analysis);
  } catch (err) {
    notifyError_('writeMemoToNotion_', err);
    try { lineReply_(replyToken, '保存に失敗しました'); } catch (e2) { /* replyToken失効等は握りつぶす */ }
    return;
  }

  const replyText = aiFailed ? '保存しました(AI解析は失敗)' : analysis.reply;
  try {
    lineReply_(replyToken, replyText);
  } catch (e2) {
    // replyToken失効（再送等）は握りつぶす。Notionには保存済みなのでデータ欠落なし
  }
}

/** Vertex AI（サービスアカウントJWT認証）でアクセストークンを取得する。1時間キャッシュ。 */
function getVertexAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('vertex_access_token');
  if (cached) return cached;

  const saJson = PropertiesService.getScriptProperties().getProperty('GCP_SERVICE_ACCOUNT_JSON');
  if (!saJson) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON が未設定です');
  }
  const sa = JSON.parse(saJson);

  const base64url = function (str) {
    return Utilities.base64EncodeWebSafe(str).replace(/=+$/, '');
  };
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const signingInput = header + '.' + claims;
  const signatureBytes = Utilities.computeRsaSha256Signature(signingInput, sa.private_key);
  const signature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, '');
  const jwt = signingInput + '.' + signature;

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Vertex AI OAuthトークン取得失敗 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const data = JSON.parse(res.getContentText());
  cache.put('vertex_access_token', data.access_token, Math.max(60, Math.min(data.expires_in - 60, 3600)));
  return data.access_token;
}

/** Vertex AIのgenerateContentを1コールする共通ユーティリティ。 */
function generateContentVertex_(requestBody) {
  const token = getVertexAccessToken_();
  const url = 'https://' + VERTEX_LOCATION + '-aiplatform.googleapis.com/v1/projects/' + VERTEX_PROJECT_ID +
    '/locations/' + VERTEX_LOCATION + '/publishers/google/models/' + VERTEX_MODEL + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(requestBody)
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Vertex AI API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/** Vertex AI Geminiを1コールし、メモを分類+短い返信文を生成する。 */
function analyzeMemo_(text) {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string', description: '15字以内の見出し' },
      category: { type: 'string', enum: ['メモ系', '日記系', '英語系'] },
      reply: { type: 'string', description: 'LINEで返す2文以内の短い応答。共感or一言アドバイス。' }
    },
    required: ['title', 'category', 'reply']
  };
  const data = generateContentVertex_({
    systemInstruction: { parts: [{ text: 'あなたはLINEで送られた個人メモの整理係。日本語で簡潔に。' }] },
    contents: [{ role: 'user', parts: [{ text: 'このメモを整理して: ' + text }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  });
  const candidate = data.candidates && data.candidates[0];
  if (!candidate) {
    const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error('Vertex AI blocked: ' + (blockReason || 'no candidates'));
  }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error('Vertex AI finishReason: ' + candidate.finishReason);
  }
  return JSON.parse(candidate.content.parts[0].text);
}

/** Notion「mydb」（新規データベース）へ1件書き込む。全プロパティtext型（名前のみtitle）。 */
function writeMemoToNotion_(originalText, analysis) {
  const notionToken = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const payload = {
    parent: { data_source_id: MEMO_NOTION_DATA_SOURCE_ID },
    properties: {
      '名前': { title: [{ text: { content: (analysis.title || originalText).slice(0, 100) } }] },
      '原文': { rich_text: [{ text: { content: originalText.slice(0, 2000) } }] },
      'AI解析': { rich_text: [{ text: { content: (analysis.reply || '').slice(0, 2000) } }] },
      'カテゴリ': { rich_text: [{ text: { content: analysis.category || '' } }] },
      '入力元': { rich_text: [{ text: { content: 'LINE' } }] }
    }
  };
  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + notionToken,
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify(payload)
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Notion API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
}
