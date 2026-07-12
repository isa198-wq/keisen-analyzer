/**
 * LINEゲートウェイ（GAS Webアプリとしてデプロイ）
 * -------------------------------------------------
 * 役割: 複数系統のLINE入出力を1つのGASプロジェクトに集約するルータ。
 *   1. ルーティン中継: Claudeクラウドルーティンからのレポート文面をPOSTで受け取り、
 *      LINE Messaging API経由でプッシュ通知する（従来の「ルーティン中継サーバー」ロジック、不変）。
 *   2. LINE Webhook: LINEプラットフォームからのメッセージイベントを受け取り、
 *      内容に応じて処理を振り分ける（handleLineWebhook_、memo.gsで実装）。
 *
 * デプロイ手順:
 *  1. 右上「デプロイ」→「デプロイを管理」→ 既存デプロイを編集（バージョン: 新規）。
 *     ★「新しいデプロイ」を作るとURLが変わり、ルーティン中継側の設定が壊れるため使わない。
 *  2. スクリプトプロパティは gas/README.md を参照。
 *  3. LINE WebhookのURLは `<デプロイURL>?token=<LINE_HOOK_TOKEN>` を使う（Phase 2で切替）。
 */

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }

  try {
    if (body.secret !== undefined) {
      return handleRoutineRelay_(body);
    }
    if (body.destination !== undefined && body.events !== undefined) {
      return handleLineWebhookRequest_(e, body);
    }
    return jsonResponse({ ok: false, error: 'unknown source' }, 400);
  } catch (err) {
    notifyError_('doPost', err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
}

/**
 * LINE Webhook入口: URLトークンを照合してから handleLineWebhook_（memo.gs）へ委譲する。
 * GASのWebアプリはX-Line-Signatureヘッダを読めないため、クエリトークンで代替認証する。
 */
function handleLineWebhookRequest_(e, body) {
  const expectedToken = PropertiesService.getScriptProperties().getProperty('LINE_HOOK_TOKEN');
  const givenToken = e.parameter && e.parameter.token;
  if (expectedToken && givenToken !== expectedToken) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }
  return handleLineWebhook_(body);
}

/**
 * ルーティン中継: Claudeクラウドルーティンのレポート文面をLINEへpushする（従来ロジック・不変）。
 */
function handleRoutineRelay_(body) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  const userId = props.getProperty('LINE_USER_ID');
  const sharedSecret = props.getProperty('SHARED_SECRET');

  if (sharedSecret && body.secret !== sharedSecret) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  const reportText = body.text || body.report || '';
  if (!reportText) {
    return jsonResponse({ ok: false, error: 'empty report text' }, 400);
  }

  const chunks = splitMessage(reportText, 4900);
  const messages = chunks.map(chunk => ({ type: 'text', text: chunk }));
  const payload = { to: userId, messages: messages };

  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    return jsonResponse({ ok: false, error: 'LINE API error', detail: response.getContentText() }, 502);
  }

  return jsonResponse({ ok: true, sent_chunks: chunks.length });
}

/** 自分（LINE_USER_ID）へLINEをプッシュ送信する共通ユーティリティ。 */
function linePush_(text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  const userId = props.getProperty('LINE_USER_ID');
  const chunks = splitMessage(text, 4900);
  const messages = chunks.map(chunk => ({ type: 'text', text: chunk }));
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: userId, messages: messages }),
    muteHttpExceptions: true
  });
}

/** replyTokenでLINEへ応答する共通ユーティリティ。失効時は例外を投げるので呼び出し側で握りつぶすこと。 */
function lineReply_(replyToken, text) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  const chunks = splitMessage(text, 4900);
  const messages = chunks.map(chunk => ({ type: 'text', text: chunk }));
  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('LINE reply failed: ' + response.getResponseCode() + ' ' + response.getContentText());
  }
}

/**
 * エラーを自分のLINEへ通知する。全ハンドラの最外try/catchから必ず呼ぶこと。
 * 通知自体の失敗は握りつぶす（無限ループ防止）。
 */
function notifyError_(context, err) {
  try {
    linePush_('⚠️ [LINEゲートウェイ] ' + context + ': ' + String(err).slice(0, 200));
  } catch (e2) {
    // 通知自体の失敗は無視
  }
}

function splitMessage(text, maxLen) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  return chunks;
}

function jsonResponse(obj, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * 動作確認用: スクリプトエディタから直接実行してLINE送信をテストする。
 * デプロイ前にこれで疎通確認すると早い。
 */
function testSend() {
  linePush_('【テスト】ゲートウェイからの疎通確認です。');
}
