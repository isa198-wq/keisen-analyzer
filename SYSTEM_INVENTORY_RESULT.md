# システム全体棚卸し結果

調査日: 2026-07-07。`SYSTEM_INVENTORY_REQUEST.md` に基づく調査。
方針: このマシン(ローカルファイル・git履歴)から実際に確認できた範囲のみ記載。コードの変更は行っていない。
稼働状況・保守コスト等、実測できず推測が入る項目には「(推定)」を付す。

**前提**: このマシン上には `keisen-analyzer`（罫線アナライザー／イナゴ盤）と `Tools\dedupe`（重複ファイル整理ツール）以外のリポジトリ・ローカルコードは見つからなかった。英会話パイプライン・生活バランス・週報自動化・気になりメモ・雑談ネタ帳・症状トラッキングの6システムは、GAS/Notion/Make/LINE bot等の**オンライン側にのみ存在**し、ローカルにコードが無いためこのマシンからは中身を確認できない（既存の `ONLINE_SYSTEMS_CHECKLIST.md` が同じ結論）。

---

## 1. システム一覧表

| システム名 | 目的 | 稼働状況 | 依存関係 | 保守コスト体感 | 最終更新 |
|---|---|---|---|---|---|
| **罫線アナライザー本体**（`keisen-analyzer/src/App.jsx`） | 日経225テクニカル分析Webアプリ | **現役** | Vite/React、recharts **v2固定**（v3で即クラッシュ、[[recharts-v2-required]]参照） | 中（単一ファイル集約型、判定ロジック変更時は`build_analysis.mjs`再生成が必要） | 2026-07-06（コミット`abde699`） |
| **日次自動スクリーニング**（`screen_daily.mjs` + `.github/workflows/daily-screening.yml`） | 毎朝07:30 JSTに全銘柄判定→LINE/Discord/Slack通知 | **現役・実行実績あり**（直近5件全成功、49秒〜1分31秒） | GitHub Actions、yfinance、GitHub Secrets（`WEBHOOK_URL`等）、Make.com経由LINE配信 | 中（[[bulk-screening-architecture]]のチャンク非同期設計、[[daily-screening-automation]]） | 2026-07-06（RSI→パターン表記変更、コミット`abde699`） |
| **v5 適時開示レイヤー**（`disclosure_fetch.mjs`/`disclosure_classify.mjs`） | TDnet適時開示の取得・AI分類を日次パイプラインに追加 | **実装済み・push済みだが未検証**（分類はGitHub Secretsに`ANTHROPIC_API_KEY`未設定のため一度も実行されていない、[[design-vs-build-roles]]） | Yanoshin TDnet API、Anthropic API | 低〜中（実装は完了、動作確認が残タスク） | 2026-07-06（コミット`08c791a`） |
| **イナゴ・トレード盤**（`inago/inago_offline.html`） | 日経225バー状態パターンのバックテスト検証・新テーマ探索UI | **稼働中**（実データ`asOf:2026-07-03`接続済み、単体HTML・自動実行なし＝手動で開く運用） | `inago/data.js`（`build_data_js.mjs`が`screening_data.csv`から生成）、外部CDN非依存 | 低（単体HTML、他システムから独立） | 2026-07-06（P-1〜P-9監査移植、コミット`7e9cfc5`） |
| **イナゴ盤 日次自動更新**（`run_inago.ps1`） | イナゴ盤データを15:45に自動更新するランナー | **未接続**（Windowsタスクスケジューラに未登録、`-Register`未実行） | クラスタ検知(`detect_clusters.mjs`)・Grok命名(`grok_name.py`)は未実装のプレースホルダ | 低（動くが自動化の入口が閉じている） | 2026-07-06 |
| **重複ファイル整理ツール**（`Tools\dedupe`） | Downloads/Documents/OneDrive/Google Drive等の重複ファイルを検出しHTMLレビューUIで削除判断 | **v1完成・実スキャン未実施**（[[dedupe-tool-project]]、削除は自動実行禁止のガード有り） | PowerShell、Python（`build_html.py`）、対象は本人PC全体のファイルツリー | 中（P0+P1+P2実装済み、gitリポジトリではないため変更履歴は無し） | 2026-07-04 21:07（ファイル更新日時） |
| **英会話パイプライン**（NativeCamp分析→Notion→LINE） | NativeCampレビューの分析・記録をNotionへ蓄積しLINE通知 | **不明（推定：稼働中の可能性、未確認）** | Notion DB×3（DB名未特定）、GAS、LINE | 不明（ローカルにコード無し） | 不明 |
| **生活バランス提案システム**（GAS×カレンダー×日記） | カレンダーと日記からバランス提案を生成 | **不明（推定）** | GAS、Notion日記、LINE | 不明（ローカルにコード無し） | 不明 |
| **週報自動化**（Claude Code scheduled job→Notion→LINE） | 週次市場レポートを自動生成しNotion経由でLINE配信 | **不明（推定：要確認、直近正常配信か未確認）** | Claude Code scheduled job、Notion、GAS、LINE | 不明（ローカルにコード無し） | 不明 |
| **気になりメモパイプライン**（Make→Claude API→Notion） | LINEで送った「気になり」メモをClaude APIで処理しNotion＋日記へ | **不明（推定）** | Makeシナリオ、Claude API、Notion | 不明（ローカルにコード無し） | 不明 |
| **雑談ネタ帳アプリ** | 雑談ネタのストック・提示アプリ | **不明（推定：詳細情報自体が今回のリポジトリ内に無い）** | 不明 | 不明 | 不明 |
| **症状トラッキング**（LINE bot→GAS→Open-Meteo→Notion） | 体調症状と気象データを突き合わせて記録 | **不明（推定）** | LINE bot、GAS、Open-Meteo API、Notion | 不明（ローカルにコード無し） | 不明 |
| **フォローアップトラッカー（SQLite試作）** | 不明（`ONLINE_SYSTEMS_CHECKLIST.md`に記載はあるが詳細不明） | **不明（推定：プロトタイプ止まりの可能性）** | SQLite | 不明 | 不明 |
| **`.claude` 設定・過去セッション** | Claude Code自体の設定・セッション履歴保管 | 現役（`settings.json`は最小構成、`PowerShell`許可のみ） | `.claude/projects` 配下に3セッション、うち2件は`keisen-analyzer`のstale worktree由来 | 低 | 2026-07-07（`settings.json`更新日時） |
| **グローバルSkills** | ユーザー定義のカスタムSkill | **未確認/存在せず** | `~/.claude`配下を検索したがSkills関連ディレクトリは見つからなかった | — | — |

---

## 2. 重複・類似機能がありそうな組み合わせ

- **イナゴ盤の旧世代ファイル群**（`Downloads/inago_daily.html`・`Downloads/inago_dashboard.html`・`Downloads/InagoScannerList.jsx`等）と**現行の`keisen-analyzer/inago/inago_offline.html`**: `SYSTEM_MAP.md` §4-7によれば、明確に破棄済みと分かる5ファイルは既に削除済み。ただし`detect_clusters.mjs`・`grok_name.py`（未移植機能）と孤立プロトタイプ`InagoScannerList.jsx`は判断保留で残置されている。
- **通知経路の並存**: 罫線アナライザー（LINE/Discord/Slack Webhook、GitHub Secrets経由）と、オンライン専用システム群（気になりメモ・週報自動化・症状トラッキング等）が**それぞれ独自にLINE配信の仕組みを持っている**可能性が高い。LINE通知の送信元が複数系統に分散していると、どの通知がどのシステム由来か本人にも分かりにくくなるリスクがある。
- **Notion連携の重複可能性**: 英会話パイプライン・週報自動化・気になりメモの3つが、いずれも「Notion DBへ書き込み→LINE通知」という同じ形のパイプラインを別々に実装している可能性がある。DB構成やAPI呼び出しロジックが似ているなら、共通化の余地があるかもしれない（現時点ではローカルにコードが無く検証不可）。
- **`.claude/projects`配下の2つのstale worktree**（`heuristic-easley-1fe352`・`strange-lovelace-cdcd62`）は`SYSTEM_MAP.md`で「gitからは除去済みだが物理フォルダはOneDrive同期のハンドル保持で削除失敗」と報告されている。セッション記録側にも対応するディレクトリが残っており、実体のない参照が残っている状態。

## 3. 所感（放置・重複していそうなものへの一言）

- **イナゴ盤の自動化は「作ったが繋がっていない」状態**が一番もったいない。`run_inago.ps1`はロジックとしては完成しているのに、タスクスケジューラ登録（`-Register`）を一度実行するだけで日次自動更新が動き出す。ここだけ着手すれば投資対効果が高い。
- **v5適時開示レイヤーは実装は終わっているのに一度も本番で動いていない**。`ANTHROPIC_API_KEY`のGitHub Secret登録という最後の1手が抜けているだけなので、これも早めに埋めた方が良い。
- **オンライン専用の6システム（英会話・生活バランス・週報・気になりメモ・雑談ネタ帳・症状トラッキング）は、このマシンからは実質「ブラックボックス」**。稼働しているか止まっているかすら判断できない状態が一番のリスク。`ONLINE_SYSTEMS_CHECKLIST.md`のチェック項目を実際に埋める（GAS/Notion/Make管理画面を開いて最終実行日を見る）作業を先にやらないと、この棚卸し自体が「片肺」のままになる。
- **重複ファイル整理ツール（`Tools\dedupe`）はgitリポジトリ化されていない**。個人の全ファイルツリーに対して削除操作を行うツールという性質上、変更履歴が残らないのはやや心配。実スキャン→削除フェーズに進む前にgit管理下に置くことを検討してもよさそう。
- **「雑談ネタ帳アプリ」だけは依頼文以外に手がかりが一切見つからなかった**。存在自体が構想段階なのか、別デバイス上にあるのか、本人に確認が必要。
