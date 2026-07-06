# イナゴ・トレード盤エコシステム 棚卸しマップ

調査日: 2026-07-06。対象: `keisen-analyzer`（OneDrive\ドキュメント配下）、`Downloads`、Windowsタスクスケジューラ、git worktree/branch。
方針: ファイルを実際に開いて確認できたことのみ記載。確認できなかったものは「不明」と明記。

---

## 4-1. ファイル一覧表

### keisen-analyzer 直下（罫線アナライザー本体・v1〜v5・日次自動化）

| ファイル名 | 場所 | 役割 | 状態 | 根拠 |
|---|---|---|---|---|
| `src/App.jsx` | keisen-analyzer/src | 罫線分析UI本体（React） | 稼働中 | `npm run dev`で動くVite構成。build_analysis.mjsがここから判定ロジックを抽出 |
| `screen_daily.mjs` | keisen-analyzer | 日次ヘッドレススクリーニング＋通知＋HTMLレポート | 稼働中 | GitHub Actions `daily-screening.yml` から毎朝07:30 JST実行 |
| `fetch_data.py` / `fetch_market.py` / `fetch_earnings.py` | keisen-analyzer | データ取得（yfinance） | 稼働中 | ワークフローに組み込み済み |
| `evaluate.mjs` / `backtest.mjs` / `factor_check.mjs` / `combo_check.mjs` / `exit_check.mjs` / `momentum_check.mjs` | keisen-analyzer | v1〜v4の検証スクリプト（単体実行専用） | 完了・アーカイブ状態 | 全て採用ゼロという結果を出して役目を終えている（設計書§7に記録済み） |
| `disclosure_fetch.mjs` / `disclosure_classify.mjs` | keisen-analyzer | v5フェーズI: TDnet開示取得・AI分類 | **実装済み・未コミット** | 本セッションで実装。`signals/disclosures.jsonl`に実データ31件（2026-07-02/03）を確認済み。分類はAPIキー未設定のためこのマシンでは未実行 |
| `.github/workflows/daily-screening.yml` | keisen-analyzer | 日次自動化の定義（GitHub Actions） | **稼働中（実行確認済み）** | WebFetchで実行履歴確認：直近5件（#7〜#11）全て成功。※これは現在push済みの旧版の実績。v5開示ステップ追加分は未push（§4-4参照） |
| `設計_次期改良.md`〜`v5.md` | keisen-analyzer | 各フェーズの設計書 | 現役（v5が最新・進行中） | §7判断記録に実測値と採否が全て記載済み |

### `inago/` フォルダ（イナゴ・トレード盤オフライン版・本番）

| ファイル名 | 役割 | 状態 | 根拠 |
|---|---|---|---|
| `inago_offline.html` | イナゴ盤の**本体・唯一の正**（外部CDN非依存の自前SVG/JS版） | **稼働中・実データ接続済み** | CDN `<script src="http...">` なし確認。`window.INAGO_DATA`参照を確認。ブラウザで開けば単体で動く |
| `inago_offline_before.html` | 監査（P-1〜P-9）適用前のバックアップ | アーカイブ（比較用に保持） | 監査レポートに明記。差分参照用途のみ、削除しても実害なし |
| `data.js` | イナゴ盤が読む実データ本体（`window.INAGO_DATA`） | **稼働中・実データ** | 中身を実際に読んで確認: `asOf:"2026-07-03"`、日経225銘柄（例: 1332ニッスイ）の実日付・実終値・実出来高が入っている。`.gitignore`対象（再生成可能なため非コミット） |
| `build_data_js.mjs` | `screening_data.csv`→`data.js`変換 | 稼働中 | 中身確認済み。CRLF対応済み（監査で発見・修正されたバグ） |
| `compare_backtest.mjs` | 新旧ロジック比較（P-1〜P-9適用前後）をNode単体実行 | 動作確認済み（単体実行専用・自動化なし） | 中身確認。`node compare_backtest.mjs`で実行、監査レポートの数値の出所 |
| `regime_deepdive.mjs` | 地合い別の中央値・t値・年別内訳の深掘り | 動作確認済み（単体実行専用・自動化なし） | 中身確認。compare_backtest.mjsに依存 |
| `run_inago.ps1` | 日次ランナー（data.js更新→クラスタ検知→Grok命名→盤を開く） | **一部未実装・タスク未登録** | 中身確認。§4-4参照 |
| `監査移植レポート.md` | P-1〜P-9監査移植の記録・結論 | 完了ドキュメント | 2026-07-05〜06作業の全記録。冒頭に「価格・出来高研究クローズ」の決定を明記 |

### `Downloads`（イナゴ盤の旧世代・破棄候補）

| ファイル名 | 役割 | 状態 | 根拠 |
|---|---|---|---|
| `inago_daily.html` | イナゴ盤の旧版（React+Recharts、CDN読み込み） | **放棄版・構文エラーで開けない** | 実際に開いて確認: CDN 5本読み込み、かつ `<div>`46個に対し`</div>`44個で**閉じタグ2つ不足**（前提情報どおりの構文エラーを実測で再現） |
| `inago_dashboard.html` | イナゴ盤のさらに旧い版（同名タイトル・同系統UI） | **放棄版・こちらも閉じタグ不足** | `<div>`44個に対し`</div>`42個。inago_daily.htmlより古いイテレーションと推定（要ユーザー確認：作成順） |
| `inago_offline.html`（Downloadsのコピー） | keisen-analyzer/inago/inago_offline_before.html と同一内容の退避コピー | 重複（本物は keisen-analyzer 側） | ファイルサイズ52,227byteで完全一致。移植作業前にDownloadsから本フォルダへ複製した名残 |
| `InagoScannerList.jsx` | イナゴ・スコアリングロジックの単体Reactコンポーネント試作 | **孤立した試作品・どこからも参照されていない** | `src/`配下をgrepしても参照ゼロ。コメントに「本番では`./inagoScore`のscanInago/scoreInagoに差し替え可」とあり、その`inagoScore.js`自体も存在しない＝未完成の下書き |
| `fable_backtest_audit_prompt.md` / `_1.md` | Fableへ監査を依頼した際の指示書（テンプレ／記入済み） | 役目完了 | `_1.md`が記入済み版。ここから`inago_offline.html`のAUDIT-FIX移植が始まった。**「参照実装 inago_daily_FIXED.html」は物理ファイルとして存在しない**＝Fableとの対話内で生成され、そのままAUDIT-FIXコメントとして手動転記された可能性が高い（要ユーザー確認） |

### 存在しなかったもの（前提情報との矛盾）

| 前提情報にあった項目 | 確認結果 |
|---|---|
| `discipline.html` + 夜間バッチPython（逆指値・ルール遵守率・ペイオフレシオ） | **OneDrive全体・Desktop・home直下を検索したが見つからず**。構想段階で未着手か、別デバイス上の可能性。不明 |
| `detect_clusters.mjs` | **存在しない。ただし放置バグではなく仕様どおり**: `run_inago.ps1`が`Test-Path`で有無をチェックし、無ければ「未実装のためスキップ」とログを出す設計。未着手のプレースホルダ |
| `grok_name.py` | 同上。`XAI_API_KEY`がある場合のみ・かつ`clusters.json`（detect_clusters.mjsの出力）がある場合のみ呼ばれる設計だが、どちらも存在しないため一度も実行されていない |
| `clusters.json` / `cluster_names.js` | 存在しない（上記2つが未実装のため生成されていない、が`inago_offline.html`自体はこれらが無くても動作する設計） |

---

## 4-2. データフロー図（テキスト）

```
[yfinance]
   │ fetch_data.py (auto_adjust=True)
   ▼
screening_data.csv ─────────────┬─────────────────────────────┐
   │                            │                             │
   │ build_analysis.mjs         │ build_data_js.mjs           │ disclosure_fetch.mjs
   │ (App.jsxから判定ロジック抽出)  │ (CRLF対応済み)                │ (Yanoshin TDnet API・別データ源)
   ▼                            ▼                             ▼
src/analysis.generated.mjs   inago/data.js              signals/disclosures.jsonl
   │                       (window.INAGO_DATA)                 │
   ▼                            │                              │ disclosure_classify.mjs
screen_daily.mjs ◄──────────────┘                     (未検証: ANTHROPIC_API_KEY要)
   │  (このスクリプトはinago/data.jsを一切参照しない＝★別系統)         │
   ▼                                                            ▼
signals/history.jsonl                                   disclosures.jsonl の
signals/signals_YYYY-MM-DD.html                          各レコードにcls付与
   │
   ▼
LINE / Discord / Slack 通知（GitHub Actions daily-screening.yml, 毎朝07:30 JST）


inago/data.js
   │
   ▼
inago/inago_offline.html （ブラウザで直接開く。自動実行の仕組みなし）
   ├─ 検証タブ: scoreAt()でバー状態判定→N日後リターン集計（P-1〜P-9適用済み）
   ├─ 新テーマタブ: ブラウザ内で自前クラスタ計算（detect_clusters.mjs未実装でも動く）
   └─ Grok命名: 未接続（XAI_API_KEY・clusters.json どちらも無し）

run_inago.ps1
   ├─ (1) node build_data_js.mjs        … 実行される
   ├─ (2) node detect_clusters.mjs      … ファイルが無いためスキップ
   ├─ (3) python grok_name.py           … 条件不成立のためスキップ
   └─ (4) inago_offline.htmlを開く      … -Openフラグ時のみ
   ※ -Register未実行＝Windowsタスクスケジューラへの登録はされていない（実測で確認、後述）
```

**★重要な訂正（前提情報との矛盾）**: 依頼文の前提情報には「data.js は罫線アナライザーとの橋渡し用に設計されたが、未接続。現状は合成デモデータで動作」とあったが、**これは2026-07-05〜06の監査移植作業で解消済み**。現在の`data.js`は実データ（日経225・223銘柄・5年、`asOf:"2026-07-03"`）で接続されている。ただし接続経路は「App.jsxの画面から書き出し」ではなく「`screening_data.csv`（fetch_data.pyの生データ）を`build_data_js.mjs`で変換」という、罫線アナライザー本体のUIを経由しない裏経路。

---

## 4-3. 「今すぐ使える状態のもの」リスト

- **`inago/inago_offline.html`をダブルクリックで開く** — 実データ（asOf 2026-07-03）で動く。CDN不要・単体で完結。検証タブでP-1〜P-9適用済みの新仕様バックテストが見られる（ただし§4-4の限界に注意）。
- **罫線アナライザー本体**（`npm run dev`でVite起動、または最新の`signals/signals_2026-07-04.html`を開く）— 毎朝の自動スクリーニングレポート。
- **`node inago/compare_backtest.mjs`** / **`node inago/regime_deepdive.mjs`** — 単体実行でイナゴ盤ロジックの数値検証をNode上で再現できる。

## 4-4. 「動くが未接続/未検証」リスト

- **`run_inago.ps1`の日次自動化そのもの**: Windowsタスクスケジューラに`InagoDaily`という名のタスクは**登録されていない**（`Get-ScheduledTask`で実測確認）。`-Register`フラグ付きで一度実行しない限り、15:45の自動更新は動いていない。
- **クラスタ検知〜Grok命名の連携**（`detect_clusters.mjs`→`clusters.json`→`grok_name.py`→`cluster_names.js`）: 未実装。`run_inago.ps1`は無くても壊れないよう設計されているが、「新テーマ」タブのGrok命名機能自体は使えない状態。
- **`disclosure_classify.mjs`（v5フェーズI・本セッションで実装）**: コード自体は動作確認済みだが、`ANTHROPIC_API_KEY`未設定のためこのマシンでは実分類を一度も実行できていない。CI側もSecret未設定なら同様にスキップされる（意図した挙動だが、実際の分類結果はまだゼロ件）。
- **`.github/workflows/daily-screening.yml`の実行実績**: WebFetchでGitHub Actions実行履歴を確認済み。直近5件（#7〜#11）は全てスケジュール実行・全成功（緑チェック）、実行時間49秒〜1分31秒で安定。**ただしこれは「今コミット済み・push済みの旧版ワークフロー」の実績**（開示取得・分類ステップやpackage.jsonの`@anthropic-ai/sdk`追加は含まれていない）。
- **v5開示連携そのものは未コミット・未push**: `.github/workflows/daily-screening.yml`・`package.json`・`package-lock.json`・`設計_次期改良v5.md`の4ファイルが`git status`で「modified（未staged）」、`disclosure_fetch.mjs`・`disclosure_classify.mjs`は「untracked」。つまり**ローカルで実装・単体動作確認まで完了しているが、まだ一度もクラウド側に反映されていない**。`git add`→`commit`→`push`をしない限り、次回以降のクラウド実行にもこの新機能は含まれない。

- **`引継書.md`の「次にやるタスク」が未着手**: 通知レポートのRSI表記を三尊/逆三尊パターン表記へ置換する作業が指示されているが、`screen_daily.mjs`を実際に読むと現在も`RSI${r.rsi...}`という表記がレポート本文・チップ双方に残存しており、置換作業は行われていない（`patternAligned`という別機能は既にあるが、これはRSI置換とは別物）。

## 4-5. 「重複・混乱の原因になっているもの」リスト

| 重複グループ | 内訳 | 提案 |
|---|---|---|
| **イナゴ盤HTML 4種** | `keisen-analyzer/inago/inago_offline.html`(正)、`inago_offline_before.html`(直前バックアップ)、`Downloads/inago_offline.html`(移植前コピー・本物と同一内容)、`Downloads/inago_daily.html`(CDN依存・閉じタグ欠落で壊れている)、`Downloads/inago_dashboard.html`(さらに古い版・同じく壊れている) | 正は`keisen-analyzer/inago/inago_offline.html`の一本のみ。`Downloads`の3ファイルはアーカイブ行き（削除は監査レポートが「旧Downloads版は廃止」と明言済みだが実ファイルはまだ残っている）。`inago_offline_before.html`も差分確認が終われば削除可 |
| **孤立した試作コンポーネント** | `Downloads/InagoScannerList.jsx` | どこからも参照されていない下書き。使う予定が無ければ削除、将来使うなら`inago/`直下か`src/`へ移動して存在理由を明確にする |
| **git worktree 2件（未削除）** | `.claude/worktrees/heuristic-easley-1fe352`（mainに対しユニークコミット無し＝完全に用済み）、`.claude/worktrees/strange-lovelace-cdcd62`（ユニークコミット3bc5b56は既にcherry-pickされmainにba4fc33として反映済み＝内容的に重複） | どちらも安全に削除可能（`git worktree remove`）。ただし本棚卸しは実装変更をしない方針のため実行はしていない。ユーザー判断で削除推奨 |
| **監査プロンプト2種** | `Downloads/fable_backtest_audit_prompt.md`(空テンプレ)、`_1.md`(記入済み・実際に使われた版) | テンプレ本体は今後別の監査で再利用可能なので保持でよい。`_1.md`は実行ログとして`inago/監査移植レポート.md`と合わせて保管、または`inago/`直下へ移動して一元化を検討 |

## 4-7. 後続対応（2026-07-06・本棚卸し後に実施）

棚卸し結果を受けて、ユーザー承認のもと以下を実施済み：

- **v5フェーズI（`disclosure_fetch.mjs`/`disclosure_classify.mjs`）をコミット・push**（コミット`08c791a`）。`.github/workflows/daily-screening.yml`・`package.json`等も同時にpush済み。**これでクラウド側にも開示取得・分類ステップが反映される**（分類の実行には引き続き`ANTHROPIC_API_KEY`のGitHub Secret登録が必要、§4-4参照）。
- **`引継書.md`の「RSI→三尊/逆三尊パターン表記」タスクを実装**（コミット`abde699`）。`screen_daily.mjs`のHTML表・LINE本文ともRSI表記を撤去し、パターンの近さ（形成中は「あと○%」、完成済みは「確定」）を表示するよう変更。golden tests全PASS、実データでの生成確認済み。push済み。
- 本ドキュメント一式（`SYSTEM_MAP.md`/`ONLINE_SYSTEMS_CHECKLIST.md`/`SYSTEM_INVENTORY_REQUEST.md`）をコミット・push（コミット`4e965de`）。
- **Downloads配下の明確に重複・破棄済みのイナゴ盤旧ファイルを削除**: `20260705files\inago_daily.html`・`20260705files\run_inago.ps1`（旧run_inago.ps1）・`Downloads\inago_offline.html`（移植前コピー）・`Downloads\inago_daily.html`（閉じタグ欠落・壊れた旧版）・`Downloads\inago_dashboard.html`（同じくさらに旧い壊れた版）の5ファイルを削除。**`detect_clusters.mjs`・`grok_name.py`（未移植機能）と`InagoScannerList.jsx`（孤立プロトタイプ）は判断が割れるため削除せず残置**。
- **git worktreeの削除は不完全**: `git worktree remove --force`でgitの内部登録（worktree一覧）からは`heuristic-easley-1fe352`・`strange-lovelace-cdcd62`とも除去できたが、物理フォルダ（`.claude/worktrees/`配下）は「別プロセスが使用中」でOSレベルの削除に失敗（おそらくOneDriveの同期プロセスがハンドルを保持）。**フォルダ自体はディスク上にまだ残っている**（gitの管理下からは外れた孤児状態）。OneDriveの同期を一時停止するか、PCを再起動してから手動で`.claude\worktrees\`配下の2フォルダをエクスプローラーで削除することを推奨。ローカルブランチ`claude/heuristic-easley-1fe352`・`claude/strange-lovelace-cdcd62`自体は実害がないため残置（不要なら`git branch -D`で削除可）。

## 4-6. オンライン側（GAS/Notion/LINE）についての注記

ローカルから確認できたのは以下のみ:
- `screen_daily.mjs`のLINE Messaging API / Discord / Slack Webhook通知コード自体は存在し、`notify_config.json`（雛形）・`LINE_TOKEN`/`WEBHOOK_URL`のGitHub Secrets参照が実装されている。
- GAS・Notion・その他オンライン連携については、このフォルダ内にコードが一切見当たらない（罫線アナライザー/イナゴ盤エコシステムはLINE/Discord/Slack Webhook止まりで、Notion/GAS連携は別システムの可能性が高い）。

これ以上はローカルのファイルからは判断できないため、`ONLINE_SYSTEMS_CHECKLIST.md`にユーザー確認事項としてまとめた。
