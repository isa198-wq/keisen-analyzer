/**
 * かゆみ記録 × 環境データ（LINE「かゆい」→ Open-Meteo → Notion「かゆみログ」）
 * -------------------------------------------------
 * memo.gsのhandleLineEvent_から、テキストが「かゆい」で始まるときに呼ばれる。
 *
 * 入力フォーマット:
 *   「かゆい」            → 強度2（デフォルト）
 *   「かゆい1」〜「かゆい3」 → 数字が強度
 *   「かゆい3 @東京」      → @以降は場所タグ（Open-Meteo Geocodingで緯度経度化、Notionにキャッシュ）
 *   「かゆい2 外から帰宅」  → 場所タグが無ければ残りテキストはメモ、場所は堺市固定
 *
 * 日次バッチ recordDailyEnvironmentSummary_ は堺市の前日環境サマリーを「環境ログ」に記録する。
 * トリガーは installDailyTrigger() をスクリプトエディタから一度手動実行して設置する。
 *
 * 前提: NOTION_TOKEN スクリプトプロパティに、下記3DBへ接続済みのNotion内部インテグレーション
 * トークンを設定しておくこと。
 */

const KAYUMI_DEFAULT_LOCATION = { name: '堺市', lat: 34.57, lon: 135.48 };
const KAYUMI_LOG_DATA_SOURCE_ID = '5d55acd6-a2e9-4704-acae-f1f522b60f15';
const KAYUMI_ENV_DATA_SOURCE_ID = 'be0ea889-536b-4d9e-a87d-fb2987787869';
const KAYUMI_GEOCACHE_DATA_SOURCE_ID = 'f5777d0c-ae0c-4a9f-b411-6996cce1b2d2';

/** memo.gsのhandleLineEvent_から呼ばれるエントリポイント。 */
function handleKayumiEvent_(event, text) {
  const replyToken = event.replyToken;
  const parsed = parseKayumiMessage_(text);

  let location = KAYUMI_DEFAULT_LOCATION;
  try {
    location = resolveLocation_(parsed.locationName);
  } catch (err) {
    notifyError_('resolveLocation_', err);
  }

  let env = {};
  try {
    env = fetchEnvironmentSnapshot_(location.lat, location.lon);
  } catch (err) {
    notifyError_('fetchEnvironmentSnapshot_', err);
  }

  try {
    writeKayumiLog_(parsed.intensity, location, parsed.memo, env);
  } catch (err) {
    notifyError_('writeKayumiLog_', err);
    try { lineReply_(replyToken, '記録に失敗しました'); } catch (e2) { /* replyToken失効等は握りつぶす */ }
    return;
  }

  try {
    lineReply_(replyToken, '記録しました(強度' + parsed.intensity + '・' + location.name + ')');
  } catch (e2) {
    // replyToken失効（再送等）は握りつぶす。Notionには保存済みなのでデータ欠落なし
  }
}

/** 「かゆい」メッセージを強度・場所タグ・メモに分解する。 */
function parseKayumiMessage_(text) {
  const m = text.match(/^かゆい([1-3])?\s*([\s\S]*)$/);
  const intensity = m[1] ? parseInt(m[1], 10) : 2;
  let rest = (m[2] || '').trim();
  let locationName = null;

  const locMatch = rest.match(/@(\S+)/);
  if (locMatch) {
    locationName = locMatch[1];
    rest = (rest.slice(0, locMatch.index) + rest.slice(locMatch.index + locMatch[0].length)).trim();
  }

  return { intensity: intensity, locationName: locationName, memo: rest };
}

/** 場所名から緯度経度を解決する。タグ無しは堺市固定。キャッシュ優先、無ければGeocoding APIを叩いて保存。 */
function resolveLocation_(name) {
  if (!name) {
    return KAYUMI_DEFAULT_LOCATION;
  }
  const cached = queryGeocache_(name);
  if (cached) {
    return { name: name, lat: cached.lat, lon: cached.lon };
  }
  const geocoded = geocode_(name);
  saveGeocache_(name, geocoded.lat, geocoded.lon);
  return { name: name, lat: geocoded.lat, lon: geocoded.lon };
}

function queryGeocache_(name) {
  const notionToken = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const res = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + KAYUMI_GEOCACHE_DATA_SOURCE_ID + '/query', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + notionToken,
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      filter: { property: '地名', title: { equals: name } },
      page_size: 1
    })
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Notion query ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const data = JSON.parse(res.getContentText());
  if (!data.results || data.results.length === 0) {
    return null;
  }
  const props = data.results[0].properties;
  return { lat: props['緯度'].number, lon: props['経度'].number };
}

function saveGeocache_(name, lat, lon) {
  const notionToken = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + notionToken,
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      parent: { data_source_id: KAYUMI_GEOCACHE_DATA_SOURCE_ID },
      properties: {
        '地名': { title: [{ text: { content: name } }] },
        '緯度': { number: lat },
        '経度': { number: lon }
      }
    })
  });
}

function geocode_(name) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name) + '&language=ja&count=1';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('Geocoding API ' + res.getResponseCode());
  }
  const data = JSON.parse(res.getContentText());
  if (!data.results || data.results.length === 0) {
    throw new Error('地名が見つかりません: ' + name);
  }
  return { lat: data.results[0].latitude, lon: data.results[0].longitude };
}

/** 指定地点の直近1時間の気温/湿度/気圧とPM2.5/PM10/dustを取得する。粗大粒子=PM10-PM2.5を付与。 */
function fetchEnvironmentSnapshot_(lat, lon) {
  const forecastUrl = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + lat + '&longitude=' + lon
    + '&hourly=temperature_2m,relative_humidity_2m,surface_pressure'
    + '&past_hours=1&forecast_hours=0&timezone=Asia%2FTokyo';
  const airUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality'
    + '?latitude=' + lat + '&longitude=' + lon
    + '&hourly=pm2_5,pm10,dust'
    + '&past_hours=1&forecast_hours=0&timezone=Asia%2FTokyo';

  const result = {};

  const forecastRes = UrlFetchApp.fetch(forecastUrl, { muteHttpExceptions: true });
  if (forecastRes.getResponseCode() === 200) {
    const f = JSON.parse(forecastRes.getContentText()).hourly;
    const i = f.time.length - 1;
    result.temperature = f.temperature_2m[i];
    result.humidity = f.relative_humidity_2m[i];
    result.pressure = f.surface_pressure[i];
  }

  const airRes = UrlFetchApp.fetch(airUrl, { muteHttpExceptions: true });
  if (airRes.getResponseCode() === 200) {
    const a = JSON.parse(airRes.getContentText()).hourly;
    const i = a.time.length - 1;
    result.pm25 = a.pm2_5[i];
    result.pm10 = a.pm10[i];
    result.dust = a.dust[i];
    if (result.pm10 != null && result.pm25 != null) {
      result.coarse = result.pm10 - result.pm25;
    }
  }

  return result;
}

/** 「かゆみログ」に1行書き込む。環境値は取得できたものだけ書く。 */
function writeKayumiLog_(intensity, location, memo, env) {
  const notionToken = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const now = new Date();
  const isoNow = Utilities.formatDate(now, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
  const label = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') + ' ' + location.name;

  const properties = {
    '名前': { title: [{ text: { content: label } }] },
    '日時': { date: { start: isoNow } },
    '強度': { number: intensity },
    '場所名': { rich_text: [{ text: { content: location.name } }] },
    '緯度': { number: location.lat },
    '経度': { number: location.lon },
    'メモ': { rich_text: [{ text: { content: memo || '' } }] }
  };
  if (env.temperature != null) properties['気温'] = { number: env.temperature };
  if (env.humidity != null) properties['湿度'] = { number: env.humidity };
  if (env.pressure != null) properties['気圧'] = { number: env.pressure };
  if (env.pm25 != null) properties['PM2.5'] = { number: env.pm25 };
  if (env.pm10 != null) properties['PM10'] = { number: env.pm10 };
  if (env.dust != null) properties['dust'] = { number: env.dust };
  if (env.coarse != null) properties['粗大粒子'] = { number: env.coarse };

  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + notionToken,
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      parent: { data_source_id: KAYUMI_LOG_DATA_SOURCE_ID },
      properties: properties
    })
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Notion API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
}

/**
 * 日次バッチ: 前日(JST)の堺市の環境サマリーを「環境ログ」に1行記録する。
 * installDailyTrigger()で設置した時刻トリガーから呼ばれる想定。
 */
function recordDailyEnvironmentSummary_() {
  try {
    recordDailyEnvironmentSummaryInner_();
  } catch (err) {
    notifyError_('recordDailyEnvironmentSummary_', err);
  }
}

function recordDailyEnvironmentSummaryInner_() {
  const tz = 'Asia/Tokyo';
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateStr = Utilities.formatDate(yesterday, tz, 'yyyy-MM-dd');
  const lat = KAYUMI_DEFAULT_LOCATION.lat;
  const lon = KAYUMI_DEFAULT_LOCATION.lon;

  const forecastUrl = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + lat + '&longitude=' + lon
    + '&hourly=temperature_2m,surface_pressure'
    + '&past_days=2&forecast_days=1&timezone=Asia%2FTokyo';
  const airUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality'
    + '?latitude=' + lat + '&longitude=' + lon
    + '&hourly=pm2_5,pm10,dust'
    + '&past_days=2&forecast_days=1&timezone=Asia%2FTokyo';

  const forecast = JSON.parse(UrlFetchApp.fetch(forecastUrl, { muteHttpExceptions: true }).getContentText()).hourly;
  const air = JSON.parse(UrlFetchApp.fetch(airUrl, { muteHttpExceptions: true }).getContentText()).hourly;

  const temps = [];
  const pressures = [];
  forecast.time.forEach(function (t, i) {
    if (t.indexOf(dateStr) === 0) {
      temps.push(forecast.temperature_2m[i]);
      pressures.push(forecast.surface_pressure[i]);
    }
  });

  const pm25s = [];
  const pm10s = [];
  const dusts = [];
  air.time.forEach(function (t, i) {
    if (t.indexOf(dateStr) === 0) {
      pm25s.push(air.pm2_5[i]);
      pm10s.push(air.pm10[i]);
      dusts.push(air.dust[i]);
    }
  });

  const maxTemp = temps.length ? Math.max.apply(null, temps) : null;
  const minTemp = temps.length ? Math.min.apply(null, temps) : null;
  const avgPressure = average_(pressures);
  const avgPm25 = average_(pm25s);
  const avgPm10 = average_(pm10s);
  const maxDust = dusts.length ? Math.max.apply(null, dusts) : null;
  const coarse = (avgPm10 != null && avgPm25 != null) ? avgPm10 - avgPm25 : null;

  const prev = fetchPreviousEnvLogRow_(dateStr);
  const tempDiff = (prev && prev.maxTemp != null && maxTemp != null) ? maxTemp - prev.maxTemp : null;
  const pressureDiff = (prev && prev.avgPressure != null && avgPressure != null) ? avgPressure - prev.avgPressure : null;

  writeEnvLog_(dateStr, maxTemp, minTemp, tempDiff, avgPressure, pressureDiff, avgPm25, avgPm10, maxDust, coarse);
}

function average_(arr) {
  const valid = arr.filter(function (v) { return v != null; });
  if (valid.length === 0) return null;
  return valid.reduce(function (a, b) { return a + b; }, 0) / valid.length;
}

/** 「環境ログ」の直前行(指定日より前で最新)を取得し、前日比計算に使う。 */
function fetchPreviousEnvLogRow_(beforeDateStr) {
  const notionToken = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const res = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + KAYUMI_ENV_DATA_SOURCE_ID + '/query', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + notionToken,
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      filter: { property: '日付', date: { before: beforeDateStr } },
      sorts: [{ property: '日付', direction: 'descending' }],
      page_size: 1
    })
  });
  if (res.getResponseCode() >= 300) {
    return null;
  }
  const data = JSON.parse(res.getContentText());
  if (!data.results || data.results.length === 0) {
    return null;
  }
  const props = data.results[0].properties;
  return {
    maxTemp: props['最高気温'] ? props['最高気温'].number : null,
    avgPressure: props['平均気圧'] ? props['平均気圧'].number : null
  };
}

function writeEnvLog_(dateStr, maxTemp, minTemp, tempDiff, avgPressure, pressureDiff, avgPm25, avgPm10, maxDust, coarse) {
  const notionToken = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  const label = dateStr.replace(/-/g, '');
  const properties = {
    '名前': { title: [{ text: { content: label } }] },
    '日付': { date: { start: dateStr } }
  };
  if (maxTemp != null) properties['最高気温'] = { number: maxTemp };
  if (minTemp != null) properties['最低気温'] = { number: minTemp };
  if (tempDiff != null) properties['前日比気温差'] = { number: tempDiff };
  if (avgPressure != null) properties['平均気圧'] = { number: avgPressure };
  if (pressureDiff != null) properties['前日比気圧変化'] = { number: pressureDiff };
  if (avgPm25 != null) properties['PM2.5平均'] = { number: avgPm25 };
  if (avgPm10 != null) properties['PM10平均'] = { number: avgPm10 };
  if (maxDust != null) properties['dust最大'] = { number: maxDust };
  if (coarse != null) properties['粗大粒子'] = { number: coarse };

  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + notionToken,
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify({
      parent: { data_source_id: KAYUMI_ENV_DATA_SOURCE_ID },
      properties: properties
    })
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Notion API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
}

/**
 * セットアップ用: スクリプトエディタから一度手動実行して、毎朝7時(JST)の日次バッチトリガーを設置する。
 * 既に設置済みなら重複させず張り替える。
 */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'recordDailyEnvironmentSummary_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('recordDailyEnvironmentSummary_')
    .timeBased()
    .atHour(7)
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .create();
}
