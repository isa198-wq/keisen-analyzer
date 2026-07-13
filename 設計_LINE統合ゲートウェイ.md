# 設計: LINE統合ゲートウェイ

作成: 2026-07-11(Fable設計)。実装はSonnetセッションで行う想定(1フェーズ=1コミット)。
Phase 0のみ手作業(Make管理画面)であり、コード実装はPhase 1以降。

---

## 1. 背景と目的

2026-07-11のオンラインシステム棚卸し(`ONLINE_SYSTEMS_CHECKLIST.md`)で判明した現状:

- 個人向けLINE配信が**4系統に分散**している:
  1. 日次スクリーニング通知: GitHub Actions → Make①「keisen-screening」Webhook → LINE
  2. 朝の天気アドバイス: GASトリガー(6:15) → Dify「天気確認(automatically notify)」 → LINE
  3. 週報(新設中): claude.aiルーティン → GAS「ルーティン中継サーバー」(7/8作成) → LINE
  4. 気になりメモ: LINE → Make②「Integration Webhooks」 → Dify「LINE_AI_Router」 → Notion + LINE返信
- 気になりメモは6/26、空メッセージ1通による「Validation failed for 1 parameter(s)」で**Makeがシナリオを自動停止**し、2週間誰も気づかなかった(7/11復旧済み)。障害通知の仕組みがどの系統にも無い。
- MakeとDifyはどちらもオーケストレーターであり役割が重複。管理画面が4つ(GitHub/Make/Dify/GAS)に分散し、障害調査に全部を見て回る必要がある。

**目的**: LINE入出力系を「1つのGASプロジェクト(LINEゲートウェイ)」に段階的に集約し、
(a) 障害点と管理画面を減らす、(b) エラーを本人のLINEに通知してサイレント死を根絶する、
(c) コードをgit管理下に置き、Fable設計→Sonnet実装の流儀に乗せる。

## 2. 方針(決定事項)

- **土台**: 7/8に作成済みのGAS「ルーティン中継サーバー」(無題のプロジェクト)を「LINEゲートウェイ」に改名・拡張する。新規プロジェクトは作らない。
- **移行順序**: 延命(Phase 0) → ゲートウェイ整備(1) → 気になりメモ移設(2) → 天気通知移設(3) → 退役(4)。各フェーズは独立してロールバック可能。
- **触らないもの**: Make①「keisen-screening」(日次スクリーニング通知)は**本設計のスコープ外**。GitHub Actions側も変更しない。
- **AI呼び出し**: Dify経由をやめ、GASの`UrlFetchApp`からClaude Messages APIを直接叩く。
- **コード管理**: 本リポジトリの `gas/` フォルダに `.gs` ファイルとして置き、GASエディタへは手貼りでデプロイ(clasp導入は非目標)。`gas/README.md` にデプロイ手順とスクリプトプロパティ一覧を書く。

## 3. 不変条件(壊してはいけないもの)

1. Notion DB「mydb > 新規データベース」(collection 35c141c2-acaa-80d6-9cd9-000b0c20a5a8)のスキーマ: `名前`(title) / `原文` / `AI解析` / `カテゴリ` / `入力元` — 列の追加・削除・改名をしない。既存15件+のレコードに触れない。
2. 週報中継(claude.aiルーティン → doPost、SHARED_SECRET認証)の既存インターフェースを壊さない。ルーティン側のプロンプトに書いたURL・パラメータ形式はそのまま動き続けること。
3. Make①のWebhook URL(keisen-screening)と、GitHub Actionsの`WEBHOOK_URL` Secretには触れない。
4. 移設完了して受け入れ確認が通るまで、Make②とDifyの既存フローを**削除しない**(OFFにするだけ。ロールバック手段として温存)。
5. LINE返信は必ず1通。AI障害時でも入力の取りこぼし(Notion未保存)を起こさない。

## 4. Phase 0: 現行Make②の延命処置(手作業・実装不要)

目的: Phase 2完了までの間、再び「1通の変なメッセージで全体停止」しないようにする。

Make管理画面(us2.make.com)でシナリオ②に対して:

1. **テキスト以外を弾くフィルタ**: Webhookモジュールと次モジュールの間の接続線をクリック → 「Set up a filter」。条件は「LINEイベントのメッセージテキスト項目(webhook出力の`text`に相当する項目)」が **Exists / 空でない**。ラベル「テキストのみ通す」。
2. **自動停止の無効化**: 画面下部のシナリオ設定(⚙) → 「**Allow storing of incomplete executions**」を**ON**。これでエラー時はシナリオ停止ではなく未完了実行キューに積まれる。
3. (任意)**エラー時LINE通知**: NotionモジュールとLINE返信モジュールを右クリック → 「Add error handler」→ 最低限は「Ignore」。余力があればエラールートにLINE送信モジュール(自分宛てpush「気になりメモでエラー発生」)を付ける。

受け入れ確認: LINEでスタンプ(非テキスト)を送る → 何も起きない(エラーにならない)こと。テキストを送る → 従来どおりNotion保存+返信が来ること。シナリオがONのままであること。

## 5. Phase 1: LINEゲートウェイの整備(コード)

対象: GAS「ルーティン中継サーバー」プロジェクト(2026-07-08作成の無題プロジェクト)。

1. プロジェクト名を「**LINEゲートウェイ**」に改名。
2. 現行コードをリポジトリに取り込み: `gas/gateway.gs` を新規作成し、既存のdoPost(週報中継)ロジックを移植・整理する。以後はリポジトリ側が原本、GASエディタは配置先。
3. **ルーター構造**にする。doPostの入口で入力種別を判定:
   - `body.secret` がある → 既存の**ルーティン中継**(週報)処理へ(現行ロジック不変)。
   - HTTPヘッダ…はGASでは取得不可のため、**LINE Webhookは `body.destination` と `body.events` の存在で判定** → Phase 2の気になりメモ処理へ。
   - どちらでもない → `jsonResponse({ok:false, error:'unknown source'}, 400)`。
4. **LINE署名検証**: GASのWebアプリは生ヘッダ(`X-Line-Signature`)を読めない制約がある。代替として、(a) LINE Developers側のWebhook URLにクエリ`?token=<乱数>`を付け、doPostで照合する方式を採用(スクリプトプロパティ `LINE_HOOK_TOKEN`)。URLを知らない第三者は叩けない。本格的な署名検証は非目標(§10)。
5. **共通ユーティリティ**を同ファイルに実装:
   - `linePush(text)` : LINE Messaging APIで自分(`LINE_USER_ID`)へpush。既存実装を流用。
   - `lineReply(replyToken, text)` : 応答トークンで返信。
   - `notifyError(context, err)` : `linePush("⚠️ [LINEゲートウェイ] " + context + ": " + String(err).slice(0,200))`。**全ハンドラの最外try/catchから必ず呼ぶ**。通知自体の失敗は握りつぶす(無限ループ防止)。
6. スクリプトプロパティ(既存: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_USER_ID`, `SHARED_SECRET` / 新規: `LINE_HOOK_TOKEN`, `ANTHROPIC_API_KEY`, `NOTION_TOKEN`)の一覧と設定手順を `gas/README.md` に記載。**キー値はリポジトリに書かない**。
7. 再デプロイ手順: 「デプロイ」→「デプロイを管理」→ 既存デプロイを**編集**(バージョン: 新規)。※「新しいデプロイ」を作るとURLが変わり、ルーティン側の設定が壊れる — この注意を README に太字で書く。

受け入れ確認: 週報中継のテストPOST(既存のdoPostテスト手順)が従来どおり成功。不正token付きLINE風POSTが400になる。`notifyError('test', new Error('x'))` を手動実行してLINEに通知が届く。

## 6. Phase 2: 気になりメモの移設(コード)

LINE Developersの該当チャネルのWebhook URLを、Make②からゲートウェイの `https://script.google.com/macros/s/<deploy-id>/exec?token=<LINE_HOOK_TOKEN>` に切り替える。

処理フロー(`handleLineWebhook(body)`):

1. `body.events` を走査。`event.type === 'message' && event.message.type === 'text'` 以外は**黙ってスキップ**(200を返す。ここが6/26事故の再発防止点)。
2. テキストを取得し、**Claude Messages APIを1コール**で分類+返信生成:

```javascript
function analyzeMemo_(text) {
  const schema = {
    type: 'object',
    properties: {
      title:    { type: 'string', description: '15字以内の見出し' },
      category: { type: 'string', enum: ['メモ系', '日記系', '英語系'] },
      reply:    { type: 'string', description: 'LINEで返す2文以内の短い応答。共感or一言アドバイス。' }
    },
    required: ['title', 'category', 'reply'],
    additionalProperties: false
  };
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      'x-api-key': PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: 'あなたはLINEで送られた個人メモの整理係。日本語で簡潔に。',
      messages: [{ role: 'user', content: 'このメモを整理して: ' + text }],
      output_config: { format: { type: 'json_schema', schema: schema } }
    })
  });
  if (res.getResponseCode() !== 200) throw new Error('Claude API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const msg = JSON.parse(res.getContentText());
  if (msg.stop_reason === 'refusal') throw new Error('Claude refusal');
  return JSON.parse(msg.content.find(function(b){ return b.type === 'text'; }).text);
}
```

   - モデルは `claude-haiku-4-5`(v5開示分類と同じ・分類+短文で十分。品質を上げたければ `claude-opus-4-8` に差し替え可能な定数にする)。
   - 構造化出力(`output_config.format`)により戻りJSONのパース失敗は起きない前提だが、`JSON.parse`失敗もthrowで拾う。
3. **Notion API**でDBへ書き込み(`UrlFetchApp` → `POST https://api.notion.com/v1/pages`、ヘッダ `Notion-Version: 2022-06-28`、親は上記data source)。プロパティ: 名前=title、原文=原文テキスト、AI解析=reply、カテゴリ=category、入力元='LINE'。
   - 前提タスク: Notion側でインテグレーション(内部)を作成し、`mydb`ページに接続する。トークンをスクリプトプロパティ `NOTION_TOKEN` へ。
4. `lineReply(replyToken, reply)` で返信。
5. **フォールバック**(この順で劣化):
   - Claude API失敗 → AI解析空のままNotion保存だけ実行し、返信は「保存しました(AI解析は失敗)」。`notifyError`も送る。
   - Notion保存失敗 → 返信「保存に失敗しました」+ `notifyError`(原文をエラー通知に含め、取りこぼしを本人が救えるようにする)。
   - replyToken失効(受信から1分超・再送時) → `lineReply`失敗を握りつぶし、処理結果はNotionに残っているのでOK。
6. 常に200を返す(LINEプラットフォームへの再送ループ防止)。

受け入れ確認:
- テキスト送信 → Notionに新レコード(全5プロパティ入り)+LINEに返信が届く。
- スタンプ/画像送信 → 何も起きない(エラー通知も出ない)。
- `ANTHROPIC_API_KEY`を一時的に壊して送信 → 「保存しました(AI解析は失敗)」返信+エラーLINE通知+Notionに原文だけのレコード。
- 確認後、Make②をOFF(削除しない)。Dify「LINE_AI_Router」も放置でよい(呼ばれなくなる)。

## 7. Phase 3: 天気通知の移設(任意・コード)

現行: GAS `triggerDifyWorkflow`(毎朝6:15) → Dify → LINE。動いているため優先度は低い。Dify依存を消したくなった時に実施。

1. `gas/weather.gs`: Open-Meteo API(無料・キー不要)で当日の降水確率を取得(`https://api.open-meteo.com/v1/forecast?latitude=34.57&longitude=135.48&daily=precipitation_probability_max&timezone=Asia%2FTokyo` — 座標は堺市付近。実装時に本人の生活圏に合わせて確認)。
2. 降水確率30%以上のときだけ、Claude APIで一言アドバイスを生成し `linePush`。30%未満は送らない(現行仕様の[通知不要]と同じ)。Claude失敗時は定型文「降水確率N%。傘を検討」で送る(通知自体は止めない)。
3. トリガーを新関数に付け替え、`triggerDifyWorkflow` プロジェクトのトリガーを削除。
4. 受け入れ確認: 手動実行で分岐両方(高確率/低確率)をモック値で確認 → 翌朝の実通知を確認。その後Difyアプリは放置(SANDBOXなので費用なし)。

## 8. Phase 4: 退役と記録

1. Make②: OFFのまま1〜2週間問題がなければ削除(その前にシナリオのblueprintをエクスポートして `gas/retired/` に保存)。
2. Makeシナリオ①を「keisen-screening→LINE通知」に改名(誤操作防止。これは設定変更のみ)。
3. Dify: 「LINE_AI_Router」「天気確認」系をアーカイブまたは放置。アカウントは削除しない(時刻表2が残る)。
4. `ONLINE_SYSTEMS_CHECKLIST.md` と `SYSTEM_MAP.md` に移設完了を追記。

## 9. エッジケース一覧(実装時のチェックリスト)

- [ ] 非テキストメッセージ(スタンプ/画像/位置情報) → スキップ、200
- [ ] 空文字・空白のみのテキスト → スキップ、200
- [ ] `events`が空配列(LINEの疎通確認「検証」ボタンはこれ) → 200(LINE Developersの「検証」が成功すること)
- [ ] 1つのwebhookに複数イベント → 全件処理
- [ ] LINEの再送(応答遅延時) → replyToken失効を握りつぶす。Notion二重登録は許容(非目標参照)
- [ ] 長文(1000字超) → そのまま処理(Claudeは問題ない。Notion titleは100字で切る)
- [ ] Claude APIのrefusal / 429 / 529 → フォールバック(§6-5)。リトライはしない(GASの6分制限内で単純に)
- [ ] エラー通知自体の失敗 → 握りつぶす

## 10. 非目標

- LINE署名(`X-Line-Signature`)のHMAC検証(GAS Webアプリの制約。URLトークンで代替)
- 重複イベントの厳密な排除(webhookEventIdのキャッシュ管理はしない。二重登録は稀で実害が小さい)
- clasp/CI による自動デプロイ(手貼り運用)
- Make①(スクリーニング通知)とGitHub Actionsの変更
- 会話の文脈保持(メモは1通完結。マルチターン化は将来の別設計)
- フォローアップトラッカー(「考えっぱなしを拾う仕組み」)の実装 — ゲートウェイが土台になるが本設計には含めない

## 10.5 将来の拡張候補(要望・未実装)

### 日記系メモを「その日の日記ページ」へ直接格納(2026-07-12 本人要望)

現状(およびPhase 2初版)は、分類結果に関わらず全メモをmydb DBに書き込む。要望は
**category=日記系のメモを、mydbではなく本来の日次日記ページに追記する**こと(メモ系・英語系は従来どおりmydb)。

Phase 2完了後の拡張(Phase 2.5)として実装するのが低リスク:
まずPhase 2で現行と同じ挙動(全件mydb)をGASに移植し、動作確認後に行き先分岐を足す。

日記DBの実体: 「記録」ページ配下の「日記」DB(`collection://7c726509-dc19-4fee-8fe3-472149577999`、database `11712ddd6e054cad970b748665f6da2a`)。スキーマは `名前`(title)+ `日付`(date型)。1日1ページ、日付プロパティで時系列管理。GASからは「今日の日付でタイトル`YYYYMMDD`のページを検索、無ければ`日付`を設定して新規作成」で追記できる。

**命名統一は完了(2026-07-12)**: DB内41件のタイトルをYYYYMMDDに一括リネーム済み(旧`0705`・`5/1`・`6/8`等→`20260705`等。各ページの`日付`プロパティを正解として使用)。「20260627USJ」のような日付+ラベルのものはラベルを残した。→ GASの「今日のページをタイトル前方一致で探す」が安定して使える状態になった。

実装時に残る決めごと:
- 追記の形式(見出し・箇条書き・タイムスタンプ付き 等)。
- ページが無い日の扱い(自動作成するか、その日はmydbにフォールバックするか)。
- **DB外の迷子ページの回収**(別作業): `0708`・`0625 広島出張`など、日記DBに入っていない独立ページが少数残存(日付プロパティ無し)。これらはリネームでなく「DBへ移動+日付設定」が必要。時系列ビューに出ないので、揃えたいなら別途回収する。

## 11. 実装順とコミット粒度

| フェーズ | 内容 | 成果物 | コミット |
|---|---|---|---|
| 0 | Make②延命(手作業) | なし(チェックリスト更新のみ) | docsのみ |
| 1 | ゲートウェイ整備 | `gas/gateway.gs`, `gas/README.md` | 1 |
| 2 | 気になりメモ移設 | `gateway.gs`拡張(analyzeMemo_/handleLineWebhook/notion書き込み) | 1 |
| 3 | 天気通知移設(任意) | `gas/weather.gs` | 1 |
| 4 | 退役 | `gas/retired/` + ドキュメント更新 | 1 |

各フェーズ完了時に本ファイル末尾へ実施記録(日付・確認結果)を追記すること。

---

## 実施記録

### Phase 0(2026-07-12 実施・ほぼ完了)

- Make②に「Store incomplete executions: Yes」を設定(※UI表記は本設計の「Allow storing of incomplete executions」から変更されている。instantトリガーは1エラーで自動停止、が公式仕様と確認)。
- Webhook直後にテキストフィルタを追加。ただし初版の「text Exists」条件は**スタンプをすり抜けさせた**(スタンプのキーワードが処理され「笑顔の記録」レコードが生成された)。条件は「`events[].message.type` Equal to `text`」にすること。
- Difyプロンプトを改善版に差し替え。その際2つの事故: (1)構造化出力ONにしたら出力ノードが`LLM.text`参照のままで空になりMakeの6番パースが「Missing value」で失敗、(2)構造化出力OFFに戻したが【重要指示】(生JSON強制)が抜けておりコードフェンス付き出力で「Source is not valid JSON」失敗→**Makeが2度自動停止**(Store incomplete executionsが当時未保存だったため)。【重要指示】+改行エスケープ指示を再追記して復旧、実メッセージ3件の貫通を確認(2026-07-11 21:52Z)。
- 残タスク: フィルタ条件を`message.type = text`へ修正後、スタンプ送信でNotionに何も生えないことを確認。

### Phase 1(2026-07-13 実施・完了)

- `gas/gateway.gs`を新設し、`無題のプロジェクト`(2026-07-08作成)を「LINEゲートウェイ」に改名。プロジェクト名変更・コード反映・デプロイはClaude in Chromeによるブラウザ操作代行(タイピングでの反映は自動インデント暴走で失敗したため、Monacoエディタの`model.setValue()`をコンソールから直接呼ぶ方式に切替)。
- スクリプトプロパティに`LINE_HOOK_TOKEN`を新規追加(ランダムhex値)。
- `testSend()`を手動実行しLINE着信を確認(本人確認済み)。
- 既存デプロイを「編集」→バージョン2として更新(URLは不変、週報中継の設定は無傷)。
- 気になりメモ(`handleLineWebhook_`)とかゆみ記録はまだ未実装のため、LINE Webhook側の実処理は次のPhaseまで動作しない(想定どおり)。Make②はまだOFFにせず稼働中のまま。

### Phase 2 + かゆみ記録拡張(2026-07-13 実施・コード反映完了、認証情報設定待ち)

- `gas/memo.gs`（気になりメモ移設）と`gas/kayumi.gs`（かゆみ記録+環境ログ日次バッチ、当初計画のPhase 3拡張分）を同時に実装し、GASエディタへ反映・デプロイ（バージョン3、URL不変）まで完了。
- Notion側は「記録」ページ配下に新規3DB作成済み: かゆみログ(`5d55acd6-a2e9-4704-acae-f1f522b60f15`)/環境ログ(`be0ea889-536b-4d9e-a87d-fb2987787869`)/かゆみ地名キャッシュ(`f5777d0c-ae0c-4a9f-b411-6996cce1b2d2`)。
- mydbのプロパティは全てtext型（名前のみtitle）と判明したため、design doc記載のselect想定から実装時にrich_textへ修正。
- **未完了（本人作業待ち）**:
  1. スクリプトプロパティ`ANTHROPIC_API_KEY`・`NOTION_TOKEN`の設定（Claudeは実際のAPIキー/トークンを代理入力しない方針のため、本人がGAS設定画面で入力）
  2. Notion内部インテグレーションの作成、対象DB（mydb/かゆみログ/環境ログ/かゆみ地名キャッシュ）への接続
  3. `installDailyTrigger()`実行（ScriptAppの新規OAuth権限承認が必要で中断中）
  4. 上記完了後、LINE Developers ConsoleでWebhook URLをMake②からゲートウェイへ切替、実メッセージでの貫通確認
  5. 確認後Make②をOFF（削除はしない）

- **2026-07-13追記**: AI分類はAnthropic Claude Haikuではなく**Gemini API（無料枠）**を使う方針に変更（本人希望、コスト回避）。`memo.gs`の`analyzeMemo_`をGemini `generateContent`エンドポイント呼び出しに書き換え済み。スクリプトプロパティは`ANTHROPIC_API_KEY`ではなく`GEMINI_API_KEY`（Google AI Studio発行）。モデルは`GEMINI_MODEL`定数（既定`gemini-2.0-flash`）。
