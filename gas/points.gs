/**
 * ポイント失効管理: 毎朝Notion「ポイント管理」DBを読み、失効間近のレコードをLINEにまとめてpushする。
 * -------------------------------------------------
 * 対象外(失効日が空欄。PayPay等)はスキップする。
 * 通知は「未通知→30日前通知済→7日前通知済」の一方向のみ進み、同じ段階で二重通知しない。
 * スクショ反映で失効日が更新されたら、チャット側で「通知済み段階」を未通知にリセットする運用
 * (GAS側での自動リセットは行わない。設計はHANDOFF_ポイント失効管理.md参照)。
 *
 * トリガーは installPointsDailyTrigger() をスクリプトエディタから一度手動実行して設置する。
 */

const POINTS_DATA_SOURCE_ID = 'c0591366-1dc4-4d84-9d7a-88b34654f3a9';

const POINTS_STAGE_NONE = '未通知';
const POINTS_STAGE_30D = '30日前通知済';
const POINTS_STAGE_7D = '7日前通知済';

/** 日次バッチ本体。installPointsDailyTrigger()で設置した時刻トリガーから呼ばれる想定。 */
function checkPointsExpiry_() {
  try {
    checkPointsExpiryInner_();
  } catch (err) {
    notifyError_('checkPointsExpiry_', err);
  }
}

function checkPointsExpiryInner_() {
  const records = queryPointsRecords_();
  const today = dateOnly_(new Date());

  const urgent = [];
  const warning = [];

  records.forEach(function (r) {
    if (!r.expiryDate) {
      return;
    }
    const daysLeft = Math.round((dateOnly_(r.expiryDate) - today) / (24 * 60 * 60 * 1000));

    if (daysLeft <= 7 && r.stage !== POINTS_STAGE_7D) {
      urgent.push({ record: r, daysLeft: daysLeft });
    } else if (daysLeft <= 30 && r.stage === POINTS_STAGE_NONE) {
      warning.push({ record: r, daysLeft: daysLeft });
    }
  });

  if (urgent.length === 0 && warning.length === 0) {
    return;
  }

  const lines = ['⚠️ ポイント失効アラート'];
  urgent.concat(warning).forEach(function (item) {
    lines.push('・' + formatPointsLine_(item.record, item.daysLeft));
  });
  linePush_(lines.join('\n'));

  urgent.forEach(function (item) {
    updatePointsStage_(item.record.pageId, POINTS_STAGE_7D);
  });
  warning.forEach(function (item) {
    updatePointsStage_(item.record.pageId, POINTS_STAGE_30D);
  });
}

function formatPointsLine_(record, daysLeft) {
  const dateStr = Utilities.formatDate(record.expiryDate, 'Asia/Tokyo', 'M/d');
  const pt = record.expiringPt != null ? record.expiringPt.toLocaleString() + 'pt' : '(pt未記録)';
  return record.name + ': ' + pt + ' が ' + dateStr + ' に失効(残り' + daysLeft + '日)';
}

/** 「ポイント管理」DBの全レコードを取得する。 */
function queryPointsRecords_() {
  const notionToken = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const res = UrlFetchApp.fetch('https://api.notion.com/v1/data_sources/' + POINTS_DATA_SOURCE_ID + '/query', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + notionToken,
      'Notion-Version': '2025-09-03'
    },
    payload: JSON.stringify({ page_size: 100 })
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Notion query ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const data = JSON.parse(res.getContentText());
  return data.results.map(function (page) {
    const props = page.properties;
    return {
      pageId: page.id,
      name: props['ポイント名'].title.map(function (t) { return t.plain_text; }).join(''),
      expiryDate: props['失効日'].date ? new Date(props['失効日'].date.start) : null,
      expiringPt: props['失効予定pt'] ? props['失効予定pt'].number : null,
      stage: props['通知済み段階'].select ? props['通知済み段階'].select.name : POINTS_STAGE_NONE
    };
  });
}

function updatePointsStage_(pageId, stage) {
  const notionToken = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, {
    method: 'patch',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + notionToken,
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      properties: {
        '通知済み段階': { select: { name: stage } }
      }
    })
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Notion update ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
}

/** 日付部分だけのDateに正規化する(JST日単位の差分計算用)。 */
function dateOnly_(d) {
  const s = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
  return new Date(s + 'T00:00:00+09:00');
}

/**
 * セットアップ用: スクリプトエディタから一度手動実行して、毎朝8時(JST)の日次バッチトリガーを設置する。
 * 既に設置済みなら重複させず張り替える。
 */
function installPointsDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkPointsExpiry_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('checkPointsExpiry_')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .create();
}

/** 動作確認用: スクリプトエディタから直接実行してロジックを1回走らせる。 */
function testCheckPointsExpiry() {
  checkPointsExpiryInner_();
}
