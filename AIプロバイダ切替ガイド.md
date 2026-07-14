# AIプロバイダ切替ガイド

作成: 2026-07-14。目的: このリポジトリ内でLLMを呼んでいる箇所を洗い出し、
将来Anthropic/xAI Grok/他プロバイダに切り替えたくなったときに、何を変えれば
いいかを迷わないようにする。

## 現状のAI呼び出し箇所(2026-07-14時点)

| # | 場所 | 用途 | プロバイダ/モデル | 認証方式 | 認証情報の置き場 |
|---|---|---|---|---|---|
| 1 | `gas/memo.gs`の`analyzeMemo_` | LINE気になりメモの分類+短文返信生成 | Vertex AI Gemini `gemini-2.5-pro` | サービスアカウントJWT→OAuth2トークン(自前実装) | GASスクリプトプロパティ`GCP_SERVICE_ACCOUNT_JSON` |
| 2 | `disclosure_classify.mjs` | 適時開示タイトルの分類(決算/増配等・ポジネガ・確信度・一言要約) | Vertex AI Gemini `gemini-2.5-pro` | `@google/genai` SDK(Application Default Credentials) | GitHub Secret `GCP_SERVICE_ACCOUNT_JSON` + vars `VERTEX_AI_PROJECT_ID`/`VERTEX_AI_LOCATION` |

両方とも同じGoogle CloudプロジェクトID `gen-lang-client-0643370357`・サービスアカウント
`dify-vertex-key@gen-lang-client-0643370357.iam.gserviceaccount.com`・リージョン
`us-central1`を使っている(Difyで動作確認済みの構成を流用)。

## 変えてはいけないインターフェース契約

プロバイダを切り替えても、**呼び出し元(handleMemoEvent_ / classifyOne)から見た
入出力の形は変えない**のが鉄則。中身(モデル呼び出し部分)だけ差し替える。

- **箇所1(memo.gs）**: 入力=LINEメッセージの原文テキスト1本。出力=JSON
  `{title: string(15字以内), category: "メモ系"|"日記系"|"英語系", reply: string(2文以内)}`
- **箇所2(disclosure_classify.mjs)**: 入力=銘柄コード+開示タイトル。出力=JSON
  `{kind: enum, surprise: "positive"|"negative"|"neutral", confidence: number(0-1), oneLine: string(60字以内)}`

どちらも「構造化出力(JSON Schema指定)」を前提にしている。切替先がJSON Schema強制に
対応していない場合は、プロンプトで「JSON以外を一切出力するな」と明示し、
`JSON.parse`失敗時のフォールバックを厚めにする必要がある。

## プロバイダ別・切替時にやること

### Anthropic (Claude) に戻す場合

- **一番簡単**。このリポジトリの過去コミット(disclosure_classify.mjsは移行前のcommit、
  memo.gsも本セッション序盤にClaude版を書いていた)がほぼそのまま使える
- 認証: `ANTHROPIC_API_KEY`をヘッダ`x-api-key`に載せるだけ。OAuth不要
- Node: `@anthropic-ai/sdk`の`client.messages.create()`、構造化出力は
  `output_config.format.json_schema`
- GAS: `UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {headers: {'x-api-key': ...}})`
  で完結。JWT署名やOAuthトークン取得のコード(`getVertexAccessToken_`等)は丸ごと不要になる
- 変更対象: `gas/memo.gs`の`analyzeMemo_`+`generateContentVertex_`+`getVertexAccessToken_`を
  Anthropic呼び出し1関数に置き換え。`disclosure_classify.mjs`は`@google/genai`→
  `@anthropic-ai/sdk`に戻す
- コスト: 従量課金(無料枠なし)

### xAI Grok に変える場合

- API仕様はOpenAI互換(`POST https://api.x.ai/v1/chat/completions`)
- 認証: `Authorization: Bearer <XAI_API_KEY>`ヘッダのみ。OAuth不要
- 構造化出力: OpenAI形式の`response_format: {type: "json_schema", json_schema: {...}}`
  (Grokの対応状況は実装時に要確認。未対応ならプロンプト内でJSON強制+パース失敗時フォールバック)
- GAS/Node双方ともSDK無しで`UrlFetchApp`/`fetch`のシンプルなPOSTで完結する見込み
- 変更対象: Anthropicと同様、Vertex関連コードを丸ごと1つのHTTP呼び出し関数に置き換え

### Google AI Studio(素のGemini API、Vertex経由でない)に戻す場合

- **このセッション中に一度実装済み**(2026-07-13、Google Cloud側の課金設定問題で断念した版)。
  gitログに残っているので `git log --all --oneline -- gas/memo.gs` で該当コミットを探せる
- 認証: APIキーをURLクエリ`?key=...`に付けるだけ。OAuth不要
- ただし前回**このGoogle Cloudアカウントでは課金設定の問題(prepayment credits depleted)で
  使えなかった**実績があるので、再度使う場合はAPIキー発行時に必ず「Gemini APIのみに制限」
  かつ**課金アカウントに紐付いていない新規プロジェクト**で発行し直すこと

## 切替作業の共通チェックリスト

1. `gas/memo.gs`: モデル呼び出し関数(`generateContentVertex_`相当)と認証関数
   (`getVertexAccessToken_`相当)を新プロバイダ用に差し替え。`analyzeMemo_`の
   入出力スキーマ(title/category/reply)は変えない
2. `disclosure_classify.mjs`: SDKのimportとクライアント初期化・`classifyOne`内の
   API呼び出し部分を差し替え。スキーマ(kind/surprise/confidence/oneLine)は変えない
3. 新しい認証情報を発行し、**Claudeに値を見せず**ご自身でGASスクリプトプロパティ
   および GitHub Secrets/Variables に設定
4. 不要になった旧認証情報(スクリプトプロパティ・GitHub Secret)は削除してよい
5. `gas/README.md`のスクリプトプロパティ一覧表を更新
6. 実機テスト: LINEでメモを1件送って`mydb`への書き込みと返信を確認、
   GitHub Actionsを手動実行して`disclosure_classify.mjs`のログを確認
