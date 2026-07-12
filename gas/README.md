# LINEゲートウェイ（GASプロジェクト）

設計: [`../設計_LINE統合ゲートウェイ.md`](../設計_LINE統合ゲートウェイ.md)。
このフォルダの `.gs` ファイルが正本。GASエディタへは手動貼り付けでデプロイする（clasp運用はしない）。

対象GASプロジェクト: 「ルーティン中継サーバー」（2026-07-08作成、`無題のプロジェクト`）を
「LINEゲートウェイ」に改名して使う。新規プロジェクトは作らない。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `gateway.gs` | doPostルータ本体。ルーティン中継（週報用）とLINE Webhookの振り分け、共通ユーティリティ（linePush_/lineReply_/notifyError_）。 |
| `memo.gs` | 気になりメモ（LINE→Claude分類→Notion mydb→LINE返信）。Phase 2で追加。 |
| `kayumi.gs` | かゆみ記録・環境ログ日次バッチ。Phase 3（拡張）で追加。 |

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
| `ANTHROPIC_API_KEY` | Claude Messages API呼び出し用 | Phase 2で新規追加 |
| `NOTION_TOKEN` | Notion API書き込み用（内部インテグレーション） | Phase 2で新規追加。Notion側で作成した内部インテグレーションを対象ページ（「記録」「mydb」）に接続すること |

キーの値そのものはこのリポジトリに書かない。

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
