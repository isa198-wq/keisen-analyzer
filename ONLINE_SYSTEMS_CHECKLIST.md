# オンライン資産 確認チェックリスト

Claude Codeからは見えない（ローカルにコードが無い、または認証が必要な）システムの現状確認用。埋めるだけの形にしてあります。

---

## 生活バランスシステム（GAS+LINE+Notion日記）

- [ ] GASプロジェクト名/URL:
- [ ] 最終更新日:
- [ ] 動作確認済みか（直近いつ正常に動いたか）:

## NativeCampレビューパイプライン（Notion MCP + GAS + LINE）

- [ ] Notion DB名 ①:
- [ ] Notion DB名 ②:
- [ ] Notion DB名 ③:
- [ ] 稼働確認日:

## 週次市場レポート自動化（Claude Code scheduled job → Notion → GAS → LINE）

- [ ] 最終実行日:
- [ ] 直近正常に届いたか（Yes/No、届いていない場合はいつから止まっているか）:

## 気になりメモ（LINE→Claude API→Notion+日記）

- [ ] Makeシナリオ名:
- [ ] 稼働状況:

## フォローアップトラッカー（SQLite試作）

- [ ] ファイルの場所:
- [ ] プロトタイプ止まりか稼働中か:

---

## 参考: 罫線アナライザー／イナゴ盤エコシステム側（ローカルで確認済み・参考情報）

以下はローカル調査（`SYSTEM_MAP.md`）で判明済みのため、このチェックリストでは確認不要です。参考として記載します。

- **罫線アナライザーの日次自動化**: GitHub Actions `daily-screening.yml`（毎朝07:30 JST、LINE/Discord/Slack Webhook通知）。WebFetchで実行履歴を確認済み・直近5件は全て成功（緑）。実際にLINEへ届いているかどうかだけ確認をお願いします:
  - [ ] 直近のLINE通知は実際に届いているか（内容もおかしくないか）:
- **イナゴ盤（`inago_offline.html`）の日次自動更新**: `run_inago.ps1 -Register`が未実行のため、Windowsタスクスケジューラには登録されていません（現状はブラウザで手動で開くだけの運用）。自動化する意思があるかどうかだけ確認できればOKです:
  - [ ] イナゴ盤の自動更新（15:45起動）を今後有効化したいか:
- **v5 開示情報レイヤー（`disclosure_fetch.mjs`/`disclosure_classify.mjs`）**: GitHub Secretsに`ANTHROPIC_API_KEY`が設定されているか未確認です。未設定だと分類だけスキップされ続けます（取得は動く）:
  - [ ] GitHub Secrets に `ANTHROPIC_API_KEY` は設定済みか:
