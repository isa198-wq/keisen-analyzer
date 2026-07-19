# LINEゲートウェイ（GASプロジェクト）

設計: [`../設計_LINE統合ゲートウェイ.md`](../設計_LINE統合ゲートウェイ.md)。
このフォルダの `.gs` ファイルが正本。GASエディタへは手動貼り付けでデプロイする（clasp運用はしない）。

対象GASプロジェクト: 「ルーティン中継サーバー」（2026-07-08作成、`無題のプロジェクト`）を
「LINEゲートウェイ」に改名して使う。新規プロジェクトは作らない。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `gateway.gs` | doPostルータ本体。ルーティン中継（週報用）とLINE Webhookの振り分け、共通ユーティリティ（linePush_/lineReply_/notifyError_）。 |
| `memo.gs` | 気になりメモ（LINE→Vertex AI Gemini分類→Notion mydb→LINE返信）。Phase 2で追加。テキスト先頭が「かゆい」ならkayumi.gsへ委譲。 |
| `kayumi.gs` | かゆみ記録・環境ログ日次バッチ。Phase 3（拡張）で追加。 |
| `points.gs` | ポイント失効管理の日次バッチ。「ポイント管理」DBを読み、失効間近レコードをLINEにまとめてpush。 |

## デプロイ手順

1. [script.google.com](https://script.google.com/home) で対象プロジェクトを開く。
2. 各 `.gs` ファイルの内容をGASエディタの対応するファイルへ貼り付け（ファイル名はGAS側では `.gs` 拡張子なしでよい）。
3. 右上「デプロイ」→「デプロイを管理」→ 既存デプロイの鉛筆アイコン → バージョン「新バージョン」を選んで更新。
   **★「新しいデプロイ」は絶対に使わない。URLが変わり、claude.aiルーティン側の週報中継設定が壊れる。**
4. スクリプトプロパティ（歯車アイコン→スクリプトプロパティ）を下記の通り設定する。

## スクリプトプロパティ一覧

| キー | 用途 | 備考 |
|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API送信用トークン | 既存（LINE Developersで発行） |
| `LINE_USER_ID` | 送信先（自分）のユーザーID | 既存 |
| `SHARED_SECRET` | ルーティン中継の簡易認証文字列 | 既存 |
| `LINE_HOOK_TOKEN` | LINE Webhook URLに付与するクエリトークン（`?token=...`） | Phase 1で新規追加。ランダム文字列を自分で決めてよい |
| `GCP_SERVICE_ACCOUNT_JSON` | Vertex AI Gemini呼び出し用（サービスアカウント認証） | Phase 2で新規追加。値はサービスアカウントのJSON鍵の中身そのもの（1行/複数行どちらでも可、JSON.parseできればよい）。GitHub Actionsの`GCP_SERVICE_ACCOUNT_JSON` Secretと同じ値を使い回してよい（`dify-vertex-key@gen-lang-client-0643370357.iam.gserviceaccount.com`）。プロジェクトID/リージョン/モデル名は`memo.gs`内の`VERTEX_PROJECT_ID`/`VERTEX_LOCATION`/`VERTEX_MODEL`定数で管理（スクリプトプロパティ化はしない） |
| `NOTION_TOKEN` | Notion API書き込み用（内部インテグレーション） | Phase 2で新規追加。Notion側で作成した内部インテグレーションを、対象ページ・DB（「mydb」「かゆみログ」「環境ログ」「かゆみ地名キャッシュ」、いずれも「記録」ページ配下）に接続すること |

キーの値そのものはこのリポジトリに書かない。

**注意**: `GCP_SERVICE_ACCOUNT_JSON` と `NOTION_TOKEN` は実際の認証情報なので、Claudeに代わりに入力させず、必ずご自身でGASのスクリプトプロパティ画面に入力すること。

## Notionオブジェクト（Phase 3で作成済み）

「記録」ページ配下に3DB作成済み（データソースIDは`kayumi.gs`内に定数で埋め込み済み）:

| DB | data_source_id |
|---|---|
| かゆみログ | `5d55acd6-a2e9-4704-acae-f1f522b60f15` |
| 環境ログ | `be0ea889-536b-4d9e-a87d-fb2987787869` |
| かゆみ地名キャッシュ | `f5777d0c-ae0c-4a9f-b411-6996cce1b2d2` |
| ポイント管理 | `c0591366-1dc4-4d84-9d7a-88b34654f3a9` |

「ポイント管理」DBはNotion内部インテグレーションの接続先に追加しておくこと（NOTION_TOKENは既存を流用）。

## 日次バッチトリガーの設置（Phase 3で実施）

`kayumi.gs`貼り付け後、スクリプトエディタで`installDailyTrigger`を選択して一度手動実行する。
毎朝7:00 JSTに`recordDailyEnvironmentSummary_`が走り、前日の堺市環境サマリーを「環境ログ」に記録する。

`points.gs`貼り付け後、スクリプトエディタで`installPointsDailyTrigger`を選択して一度手動実行する。
毎朝8:00 JSTに`checkPointsExpiry_`が走り、失効間近（30日以内/7日以内）のポイントをLINEにまとめて通知する
（該当なしの日は何も送らない）。テストは`testCheckPointsExpiry`を手動実行、または「ポイント管理」DBの
いずれかのレコードの失効日を数日後に設定してから実行して確認する。

## LINE Webhook URLの切り替え（Phase 2で実施）

LINE Developers Console → 該当チャネル → Messaging API設定 → Webhook URLを

```
<デプロイURL>/exec?token=<LINE_HOOK_TOKENの値>
```

に変更する。切り替えるとMakeシナリオ②はイベントを受け取らなくなる（削除はしない。ロールバック手段として温存）。
切り替え直後にLINEでテキストを送信し、Notionへの保存とLINE返信を確認すること。

## 動作確認

- `testSend()` をスクリプトエディタから手動実行してLINE着信を確認。
- `notifyError_('test', new Error('x'))` を手動実行してエラー通知が届くことを確認。
