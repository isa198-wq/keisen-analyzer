/**
 * 現金支出記録（LINE → スプレッドシート「支出ログ」→ LINE返信）
 * -------------------------------------------------
 * memo.gsのhandleLineEvent_から、支出らしいテキストのときに呼ばれる。
 * 「ランチ1200」「電車 480」「散髪 4500 PayPay」のような短文を受け取り、
 * 【プライベート管理】ゴルフ・英語学習・ライフ管理シートの「支出ログ」タブに1行追記する。
 *
 * ■ なぜAIを使わないか（2026-08-02の設計判断）
 *   最初はGemini Sparkに読み取らせる構成にしたが、実測で5件中1件しか着地せず、
 *   しかも失敗時に「日時・金額・カテゴリ…を追記いたしました」と実体の無い成功報告を返した。
 *   「ランチ1200」のパースに推論は要らない。正規表現と辞書で決定的に処理し、
 *   書けたかどうかは行を数えて返す。こうすれば嘘の成功報告が原理的に起きない。
 *
 * ■ 集計
 *   同スプレッドシートの「支出集計」タブがSUMIFSでカテゴリ別に集計する。
 *   支出ログのG列（年月）はG2のARRAYFORMULAが自動で埋めるので、本スクリプトはA〜F列だけ書く。
 *
 * 前提: スクリプトプロパティは不要（スプレッドシートIDは下記定数）。
 *       GASプロジェクトの実行ユーザーが当該スプレッドシートに編集権限を持っていること。
 */

const EXPENSE_SPREADSHEET_ID = '1r0iFXPfv6Xx0uy46gulVXAlHIfTtl33C5WKmucGSMhA';
const EXPENSE_SHEET_NAME = '支出ログ';

// カテゴリ判定の辞書。前方から順に見て最初に当たったものを採用する。
// 当たらなければ「その他」。増やすときはここに足すだけでよい。
const EXPENSE_CATEGORY_RULES = [
  { category: '食費',   words: ['ランチ', '昼食', '朝食', '夕食', '晩飯', '昼飯', '朝飯', '飯', 'food',
                               'コーヒー', 'カフェ', 'スタバ', '弁当', '外食', '飲み物', 'ドリンク',
                               'パン', 'ラーメン', '牛丼', 'そば', 'うどん', 'すし', '寿司', 'おやつ', '菓子'] },
  { category: '交通',   words: ['電車', 'バス', 'タクシー', '地下鉄', '新幹線', '駐車', 'ガソリン',
                               'suica', 'icoca', 'pasmo', '切符', '運賃', '高速'] },
  { category: '日用品', words: ['日用品', 'ティッシュ', '洗剤', '電池', '文房具', 'ドラッグ', '薬局',
                               '雑貨', 'シャンプー', '歯ブラシ'] },
  { category: '医療',   words: ['病院', '診察', '薬', '歯医者', '内科', '皮膚科', '処方', '医療'] },
  { category: '交際',   words: ['飲み会', '飲み', '会費', 'ご祝儀', '香典', 'プレゼント', '手土産', '接待'] },
  { category: '趣味',   words: ['ゴルフ', '本', '書籍', '映画', 'ゲーム', 'サブスク', '課金', '練習場',
                               'ジム', '英会話', 'レッスン'] },
];

// 支払手段の表記ゆれ。キーは小文字で照合する。
const EXPENSE_PAYMENT_ALIASES = {
  '現金': '現金', 'cash': '現金',
  'paypay': 'PayPay', 'ペイペイ': 'PayPay',
  '交通ic': '交通IC', 'suica': '交通IC', 'icoca': '交通IC', 'pasmo': '交通IC', 'ic': '交通IC',
};
const EXPENSE_DEFAULT_PAYMENT = '現金';

/**
 * 支出メッセージらしいか判定し、そうならパース結果を返す。違えば null。
 * memo.gsのルータがこの戻り値で振り分ける（nullなら従来どおり気になりメモ扱い）。
 *
 * 受け付ける形:
 *   「ランチ1200」「ランチ 1200」「ランチ1200円」「散髪 4500 PayPay」
 *   「支出 ランチ1200」（接頭辞つきは判定を通さず必ず支出として扱う）
 *
 * 誤爆を抑えるため、接頭辞なしの場合は
 *   ・全体が20文字以内
 *   ・数字の並びが1箇所だけ（末尾）
 *   ・金額が2〜7桁
 * を満たすものだけを支出とみなす。長い文や数字が複数ある文はメモへ流す。
 * 誤って支出になってもLINEに即返信が出るので気づける（黙って失敗しないことを優先）。
 */
function parseExpenseText_(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const forced = /^(支出|出費)[\s:：]*/.test(raw);
  const body = forced ? raw.replace(/^(支出|出費)[\s:：]*/, '').trim() : raw;
  if (!body) return null;

  if (!forced) {
    if (body.length > 20) return null;
    const digitGroups = body.match(/\d+/g) || [];
    if (digitGroups.length !== 1) return null;
  }

  // 末尾: 金額（+任意の「円」）+ 任意の支払手段
  const m = body.match(/^(.*?)[\s　]*([0-9]{2,7})[\s　]*(?:円)?[\s　]*([A-Za-zぁ-んァ-ヶー一-龠]*)$/);
  if (!m) return null;

  const label = m[1].replace(/[\s　]+$/, '').trim();
  const amount = Number(m[2]);
  const paymentRaw = (m[3] || '').trim();

  if (!label) return null;              // 金額だけの「1200」は支出と断定しない
  if (!(amount >= 10)) return null;

  let payment = EXPENSE_DEFAULT_PAYMENT;
  if (paymentRaw) {
    const hit = EXPENSE_PAYMENT_ALIASES[paymentRaw.toLowerCase()];
    if (hit) {
      payment = hit;
    } else if (!forced) {
      return null;                      // 末尾が未知語＝支出ではない可能性が高いのでメモへ流す
    } else {
      payment = 'その他';
    }
  }

  return {
    label: label,
    amount: amount,
    payment: payment,
    category: categorizeExpense_(label),
  };
}

function categorizeExpense_(label) {
  const lower = String(label).toLowerCase();
  for (let i = 0; i < EXPENSE_CATEGORY_RULES.length; i++) {
    const rule = EXPENSE_CATEGORY_RULES[i];
    for (let j = 0; j < rule.words.length; j++) {
      if (lower.indexOf(String(rule.words[j]).toLowerCase()) !== -1) {
        return rule.category;
      }
    }
  }
  return 'その他';
}

/** memo.gsのルータから呼ばれる。追記して、実際に数えた件数つきで返信する。 */
function handleExpenseEvent_(event, parsed) {
  const replyToken = event.replyToken;
  let count;

  try {
    count = appendExpenseRow_(parsed);
  } catch (err) {
    notifyError_('appendExpenseRow_', err);
    try { lineReply_(replyToken, '支出の記録に失敗しました: ' + String(err.message).slice(0, 100)); }
    catch (e2) { /* replyToken失効等は握りつぶす */ }
    return;
  }

  const reply = parsed.category + ' ¥' + Number(parsed.amount).toLocaleString('ja-JP') +
    ' ' + parsed.payment + ' ' + parsed.label + '（' + count + '件目）';
  try {
    lineReply_(replyToken, reply);
  } catch (e2) {
    // 返信に失敗しても記録は済んでいるのでデータ欠落はない
  }
}

/**
 * 支出ログへ1行追記し、追記後のデータ行数を返す。
 * 末尾行は getLastRow() ではなくA列の実データから求める。G列のARRAYFORMULAが
 * 空文字を末尾まで撒くため、getLastRow()だと大きすぎる行番号を返しうるため。
 */
function appendExpenseRow_(parsed) {
  const sheet = SpreadsheetApp.openById(EXPENSE_SPREADSHEET_ID).getSheetByName(EXPENSE_SHEET_NAME);
  if (!sheet) throw new Error('シートが見つかりません: ' + EXPENSE_SHEET_NAME);

  const maxRows = sheet.getMaxRows();
  const colA = maxRows >= 2 ? sheet.getRange(2, 1, maxRows - 1, 1).getValues() : [];
  let lastDataRow = 1; // 1行目はヘッダー
  for (let i = 0; i < colA.length; i++) {
    if (String(colA[i][0]).trim() !== '') lastDataRow = i + 2;
  }
  const targetRow = lastDataRow + 1;

  const tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');

  // A〜F列だけ書く。G列（年月）はG2のARRAYFORMULAが自動で埋めるので触らない。
  sheet.getRange(targetRow, 1, 1, 6).setValues([[
    stamp, parsed.amount, parsed.category, parsed.payment, parsed.label, '',
  ]]);
  SpreadsheetApp.flush();

  return targetRow - 1; // ヘッダーを除いたデータ件数
}

/** 「今月いくら」系の問い合わせに答える。支出集計タブのB11（合計）を読む。 */
function replyExpenseTotal_(event) {
  const ss = SpreadsheetApp.openById(EXPENSE_SPREADSHEET_ID);
  const sheet = ss.getSheetByName('支出集計');
  if (!sheet) throw new Error('シートが見つかりません: 支出集計');
  const month = sheet.getRange('B1').getDisplayValue();
  const total = Number(sheet.getRange('B11').getValue() || 0);
  const text = month + ' の支出合計: ¥' + total.toLocaleString('ja-JP');
  try { lineReply_(event.replyToken, text); } catch (e) { /* 失効は握りつぶす */ }
}

// ===== 動作確認用（スクリプトエディタから実行する） =====

/** パーサだけを検証する。シートには一切書かない。 */
function testExpenseParser() {
  const cases = [
    ['ランチ1200', '食費/1200/現金'],
    ['ランチ 1200', '食費/1200/現金'],
    ['ランチ1200円', '食費/1200/現金'],
    ['電車 480', '交通/480/現金'],
    ['散髪 4500 PayPay', 'その他/4500/PayPay'],
    ['コーヒー380', '食費/380/現金'],
    ['ゴルフ 12000', '趣味/12000/現金'],
    ['支出 なにか 300', 'その他/300/現金'],
    // 以下はメモへ流れるべきもの（null期待）
    ['1200', null],
    ['明日15時に田中さんと打ち合わせ、資料は3部', null],
    ['この記事いいな', null],
    ['かゆい3', null],
  ];
  cases.forEach(function (c) {
    const p = parseExpenseText_(c[0]);
    const got = p ? (p.category + '/' + p.amount + '/' + p.payment) : null;
    const ok = got === c[1] ? 'PASS' : 'FAIL';
    console.log(ok + '  「' + c[0] + '」 → ' + got + (ok === 'FAIL' ? '（期待: ' + c[1] + '）' : ''));
  });
}

/** シートに実際に1行書いて消す。書き込み権限と行位置の計算を検証する。 */
function testExpenseAppend() {
  const before = appendExpenseRow_({ label: '接続テスト', amount: 11, payment: '現金', category: 'その他' });
  console.log('追記しました。データ件数: ' + before);
  const sheet = SpreadsheetApp.openById(EXPENSE_SPREADSHEET_ID).getSheetByName(EXPENSE_SHEET_NAME);
  sheet.getRange(before + 1, 1, 1, 6).clearContent();
  console.log('テスト行を削除しました。');
}
