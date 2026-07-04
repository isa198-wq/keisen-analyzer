// 日次スクリーニング（ヘッドレス）
//   screening_data.csv を読み、アプリと同じ判定で「サインのある銘柄」を抽出し、
//   Discord/Slack へ通知＋HTMLレポートを出力します。
//   使い方:  node screen_daily.mjs        （通常は「毎日スクリーニング.bat」から実行）
import fs from "node:fs";
import { analyze, buildSeries, tfSeries } from "./src/analysis.generated.mjs";
import { upsertEntry, loadHistory, seedHistory, evaluate, classifyRegimes, evaluateByRegime, computeTrust, edgeOf, streaks, buildByCode, loadMarketGroups, buildCtx } from "./evaluate.mjs";

const ROOT = new URL(".", import.meta.url);
// ローカルで Webhook URL を入れるなら notify_config.local.json（gitignore済み）を使う。
// クラウド(GitHub Actions)では Secret を環境変数 WEBHOOK_URL で渡すので空のままでOK。
const localCfg = new URL("./notify_config.local.json", ROOT);
const cfgPath = fs.existsSync(localCfg) ? localCfg : new URL("./notify_config.json", ROOT);
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const DATA = new URL("./screening_data.csv", ROOT);

// --- 適応型の答え合わせ（信頼度）の定数。規則本体は evaluate.mjs の computeTrust ---
// 閾値は手決めの固定値（ダムに保つ）。60〜250日のサンプルで適応最適化すると必ず過学習するため。
const TRUST_ENTER = -0.003;  // 対市場edge(10日)がこれを下回ると ⚠️警戒
const TRUST_EXIT = +0.003;   // 直近窓・現レジームの両方がこれを上回ると ✅有効（間は前日維持=ヒステリシス）
const TRUST_MIN_N = 100;     // 買い/売りの判定に必要な最低サンプル数（窓・レジーム各々）
const TRUST_MIN_N_PAT = 8;   // 三尊/逆三尊の最低サンプル数
const RECENT_WINDOW = 60;    // 「直近窓」の営業日数（答えが出たシグナル日ベース）
const ADAPTIVE_MUTE = false; // 将来用の入り口のみ: ⚠️カテゴリの通知ミュート（情報を隠すと検証も止まるため未実装）

// --- シグナル遷移の追跡（張り付き対策）の定数 ---
const STALE_DAYS = 5;        // この日数以上シグナルが出続け、かつ
const STALE_ADVERSE = 0.03;  // 起点から方向逆行がこの率を超えたら「⚠外れ続けている張り付き」

// --- CSV 読み込み（縦持ち: コード:社名, 日付, 始値, 高値, 安値, 終値, 出来高） ---
if (!fs.existsSync(DATA)) {
  console.error("screening_data.csv が見つかりません。先に fetch_data.py を実行してください。");
  process.exit(1);
}
const text = fs.readFileSync(DATA, "utf8");
const groups = new Map();
for (const line of text.split(/\r?\n/).slice(1)) {
  const c = line.split(",");
  if (c.length < 6) continue;
  const sym = c[0];
  if (!sym || sym === "銘柄") continue;
  if (!groups.has(sym)) groups.set(sym, []);
  groups.get(sym).push({
    date: c[1], open: +c[2], high: +c[3], low: +c[4], close: +c[5], volume: +c[6],
  });
}

// --- データ健全性チェック：前日比1.4倍超のジャンプ＝分割未調整・データ混入の疑い ---
// （2026-06 に auto_adjust=False で分割銘柄の価格が飛び、三尊検出が壊れた事故の再発防止）
const dataWarnings = [];
for (const [sym, bars] of groups) {
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i].close / bars[i - 1].close;
    if (r > 1.4 || r < 1 / 1.4) {
      dataWarnings.push(`${sym} ${bars[i].date} 前日比×${r.toFixed(2)}`);
      break; // 1銘柄1警告で十分
    }
  }
}
if (dataWarnings.length) {
  console.warn(`⚠ データ異常の疑い ${dataWarnings.length}件: ${dataWarnings.slice(0, 5).join(" / ")}${dataWarnings.length > 5 ? " …" : ""}`);
}

// --- #5 ミニ・ローソク足チャート（出来高バー＋利確/損切りゾーン＋ネックライン＋価格ラベル） ---
function miniChart(series, p) {
  const W = 360, H = 168, padL = 6, padR = 42, padT = 8;       // 右側は価格ラベル用に広め
  const priceB = 116;                                          // 価格エリア下端
  const volT = 126, volB = 162;                                // 出来高エリア
  const start = Math.max(0, p.p1.i - 5);
  const end = series.length - 1;
  const win = series.slice(start, end + 1);
  if (win.length < 3) return "";
  const col = p.kind === "inverse" ? "#ef5a4d" : "#3f8fd6";    // 逆三尊=赤(上昇) / 三尊=青(下落)
  let lo = Infinity, hi = -Infinity, vmax = 0;
  for (const b of win) { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); vmax = Math.max(vmax, b.volume || 0); }
  lo = Math.min(lo, p.target, p.stop); hi = Math.max(hi, p.target, p.stop);
  const span = (hi - lo) * 1.04 || 1; const mid = (hi + lo) / 2; const lo2 = mid - span / 2;
  const x = (i) => padL + ((i - start) / Math.max(1, end - start)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo2) / span) * (priceB - padT);
  const vy = (v) => volB - (vmax ? (v / vmax) : 0) * (volB - volT);
  const cw = Math.max(1.2, (W - padL - padR) / win.length * 0.62);
  const RX = W - padR + 2;
  // 利確ゾーン（ネック→目標）と損切りゾーン（ネック→損切り）を淡く塗る
  const yN = y(p.neckLevel), yT = y(p.target), yS = y(p.stop);
  const band = (y1, y2, c) => `<rect x="${padL}" y="${Math.min(y1, y2).toFixed(1)}" width="${(W - padR - padL).toFixed(1)}" height="${Math.abs(y2 - y1).toFixed(1)}" fill="${c}" opacity="0.10"/>`;
  const zones = band(yN, yT, "#3fb27f") + band(yN, yS, "#c4543f");
  let candles = "", vols = "";
  for (let k = 0; k < win.length; k++) {
    const b = win[k], cx = x(start + k);
    const up = b.close >= b.open, c = up ? "#3fb27f" : "#c4543f";
    candles += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(b.high).toFixed(1)}" y2="${y(b.low).toFixed(1)}" stroke="${c}" stroke-width="0.8"/>`;
    const yo = y(b.open), yc = y(b.close), top = Math.min(yo, yc), h = Math.max(1, Math.abs(yo - yc));
    candles += `<rect x="${(cx - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${h.toFixed(1)}" fill="${c}"/>`;
    vols += `<rect x="${(cx - cw / 2).toFixed(1)}" y="${vy(b.volume || 0).toFixed(1)}" width="${cw.toFixed(1)}" height="${(volB - vy(b.volume || 0)).toFixed(1)}" fill="${c}" opacity="0.5"/>`;
  }
  const volBase = `<line x1="${padL}" x2="${W - padR}" y1="${volB}" y2="${volB}" stroke="#243049" stroke-width="0.6"/><text x="${RX}" y="${volT + 6}" fill="#56627d" font-size="7">出来高</text>`;
  const neck = `<line x1="${x(start).toFixed(1)}" y1="${y(p.neckAt(start)).toFixed(1)}" x2="${x(end).toFixed(1)}" y2="${y(p.neckAt(end)).toFixed(1)}" stroke="#c8a24a" stroke-width="1" stroke-dasharray="3 2"/>`;
  const hline = (yv, c) => `<line x1="${padL}" x2="${W - padR}" y1="${yv.toFixed(1)}" y2="${yv.toFixed(1)}" stroke="${c}" stroke-width="0.8" stroke-dasharray="2 3" opacity="0.85"/>`;
  // 右側の価格ラベル
  const fmtL = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1));
  const lab = (yv, c, t) => `<text x="${RX}" y="${(yv + 3).toFixed(1)}" fill="${c}" font-size="8" font-family="monospace">${t}</text>`;
  const lines = hline(yT, "#3fb27f") + hline(yS, "#c4543f") +
    lab(yT, "#3fb27f", fmtL(p.target)) + lab(yS, "#c4543f", fmtL(p.stop)) + lab(yN, "#c8a24a", fmtL(p.neckLevel));
  const labels = ["左", "頭", "右"];
  const marks = [p.p1, p.p2, p.p3].map((pt, idx) =>
    `<circle cx="${x(pt.i).toFixed(1)}" cy="${y(pt.price).toFixed(1)}" r="2" fill="${col}"/>` +
    `<text x="${x(pt.i).toFixed(1)}" y="${(y(pt.price) + (p.kind === "inverse" ? 11 : -5)).toFixed(1)}" fill="${col}" font-size="8" text-anchor="middle">${labels[idx]}</text>`
  ).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="background:#0e1422;border:1px solid #243049;border-radius:4px">${zones}${vols}${volBase}${candles}${neck}${lines}${marks}</svg>`;
}

// --- クリック拡大用の週足/月足チャート（出来高・現値ライン付きのプレーンなローソク足） ---
function tfChart(daily, tf, accent, label) {
  const series = buildSeries(tfSeries(daily, tf));
  const n = series.length;
  if (n < 3) return "";
  const W = 720, H = 300, padL = 8, padR = 54, padT = 12, priceB = 212, volT = 226, volB = 290;
  const fp = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1));
  let lo = Infinity, hi = -Infinity, vmax = 0;
  for (const b of series) { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); vmax = Math.max(vmax, b.volume || 0); }
  const span = (hi - lo) * 1.05 || 1, lo2 = (hi + lo) / 2 - span / 2;
  const x = (i) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo2) / span) * (priceB - padT);
  const vy = (v) => volB - (vmax ? v / vmax : 0) * (volB - volT);
  const cw = Math.max(1.5, ((W - padL - padR) / n) * 0.66);
  let cs = "", vs = "";
  for (let i = 0; i < n; i++) {
    const b = series[i], cx = x(i), up = b.close >= b.open, c = up ? "#3fb27f" : "#c4543f";
    cs += `<line x1="${cx.toFixed(0)}" x2="${cx.toFixed(0)}" y1="${y(b.high).toFixed(0)}" y2="${y(b.low).toFixed(0)}" stroke="${c}" stroke-width="1"/>`;
    const yo = y(b.open), yc = y(b.close), top = Math.min(yo, yc), h = Math.max(1, Math.abs(yo - yc));
    cs += `<rect x="${(cx - cw / 2).toFixed(0)}" y="${top.toFixed(0)}" width="${cw.toFixed(1)}" height="${h.toFixed(0)}" fill="${c}"/>`;
    vs += `<rect x="${(cx - cw / 2).toFixed(0)}" y="${vy(b.volume || 0).toFixed(0)}" width="${cw.toFixed(1)}" height="${(volB - vy(b.volume || 0)).toFixed(0)}" fill="${c}" opacity="0.5"/>`;
  }
  const last = series[n - 1].close, yl = y(last);
  const lastLine = `<line x1="${padL}" x2="${W - padR}" y1="${yl.toFixed(0)}" y2="${yl.toFixed(0)}" stroke="${accent}" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.85"/>` +
    `<text x="${W - padR + 3}" y="${(yl + 3).toFixed(0)}" fill="${accent}" font-size="11" font-family="monospace">${fp(last)}</text>`;
  const hi2 = `<text x="${W - padR + 3}" y="${(padT + 4).toFixed(0)}" fill="#56627d" font-size="9" font-family="monospace">${fp(hi)}</text>`;
  const lo3 = `<text x="${W - padR + 3}" y="${(priceB - 1).toFixed(0)}" fill="#56627d" font-size="9" font-family="monospace">${fp(lo)}</text>`;
  const vlab = `<line x1="${padL}" x2="${W - padR}" y1="${volB}" y2="${volB}" stroke="#243049" stroke-width="0.6"/><text x="${W - padR + 3}" y="${volT + 8}" fill="#56627d" font-size="9">出来高</text>`;
  return `<figure class="zchart"><figcaption>${label}（${n}本）</figcaption>` +
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="background:#0e1422;border:1px solid #243049;border-radius:6px">${vs}${vlab}${cs}${lastLine}${hi2}${lo3}</svg></figure>`;
}

// --- 全銘柄を判定 ---
const wantAll = (process.env.SIGNALS || cfg.signals) === "all";
const buys = [], sells = [], tops = [], invs = [];
for (const [sym, bars] of groups) {
  if (bars.length < 80) continue;
  const ci = sym.indexOf(":");
  const code = ci >= 0 ? sym.slice(0, ci) : sym;
  const name = ci >= 0 ? sym.slice(ci + 1) : sym;
  const series = buildSeries(tfSeries(bars, "D"));
  const a = analyze(series, "日");
  const row = { code, name, verdict: a.verdict, vIdx: a.vIdx, score: a.score, trend: a.trend, rsi: a.last.rsi, close: a.last.close, spark: series.slice(-24).map((b) => b.close) };
  const isBuy = wantAll ? a.vIdx >= 3 : a.vIdx === 4;   // strong: 強い買いのみ / all: 買い系
  const isSell = wantAll ? a.vIdx <= 1 : a.vIdx === 0;  // strong: 強い売りのみ / all: 売り系
  if (isBuy) buys.push(row);
  else if (isSell) sells.push(row);

  // 三尊（天井=top）／逆三尊（底=inverse）は買い/売り判定に関わらず拾う。
  // 形成中は常に、完成（ネックライン抜け済み）は直近10営業日以内に抜けた“今効いている”ものだけ。
  const p = a.pattern;
  if (p && (p.kind === "top" || p.kind === "inverse")) {
    const brokeBarsAgo = p.broke ? series.length - 1 - p.breakI : null;
    const recentBreak = brokeBarsAgo != null && brokeBarsAgo <= 10;
    if (p.status === "forming" || recentBreak) {
      // #4 週足でも同種の三尊/逆三尊が出ているか（出ていれば信頼度UP）
      let weekly = false;
      if (bars.length >= 200) {
        const wp = analyze(buildSeries(tfSeries(bars, "W")), "週").pattern;
        weekly = !!(wp && wp.kind === p.kind);
      }
      // 完成（ネックライン抜け）まで現値があと何%動けばよいか。三尊は下落・逆三尊は上昇で完成。
      const neckPct = p.kind === "top"
        ? ((a.last.close - p.neckLevel) / a.last.close) * 100
        : ((p.neckLevel - a.last.close) / a.last.close) * 100;
      const accent = p.kind === "top" ? "#3f8fd6" : "#ef5a4d";
      const rec = {
        code, name, close: a.last.close,
        status: p.status,                         // forming / confirmed
        brokeBarsAgo,                             // 何営業日前にネックを抜けたか
        neck: p.neckLevel, target: p.target,
        stop: p.stop, rr: p.rr,                   // #3 損切りライン・リスクリワード比
        neckPct,                                  // 完成までに必要な値動き（%）。形成中の近さゲージ用
        profile: p.vol ? p.vol.profile : null,    // ideal / partial / weak（出来高の理想度）
        weekly,                                   // #4 週足でも同型が出ているか
        quality: p.quality,
        svg: miniChart(series, p),                // #5 ミニ・ローソク足チャート（ネックライン付き）
        wSvg: tfChart(bars, "W", accent, "週足"), // クリック拡大用：週足
        mSvg: tfChart(bars, "M", accent, "月足"), // クリック拡大用：月足
      };
      if (p.kind === "top") tops.push(rec);
      else invs.push(rec);
    }
  }
}
// 完成（ネックライン抜け）を上に、未完成（形成中）を下に。各内では信頼度(quality)順。
// 実際の並べ替えは下の「新規優先」ソートでまとめて行う。
// 完成を上に。完成どうしは信頼度(quality)順、形成中どうしはネックラインに近い順（あと少しで完成）。
const byStatus = (a, b) => (a.status === b.status ? (a.status === "forming" ? a.neckPct - b.neckPct : b.quality - a.quality) : a.status === "confirmed" ? -1 : 1);

const today = new Date().toISOString().slice(0, 10);
const total = groups.size;

// --- 自動答え合わせ: 本日のシグナルを履歴(history.jsonl)に記録 ---
// 履歴はコードのみ保存し、成績は毎回最新CSV（分割調整済み）から日付で引くので分割にも安全。
// 🆕判定・継続日数・解除もすべて history から導出する（state_*.json の読み書きは廃止）。
const dataDate = [...groups.values()][0].at(-1).date;   // データの最終営業日（=シグナルの基準日）
// 市況コンテキスト（VIX・BTC等）。public/market_data.csv が無ければ null＝市況表示・記録なしで正常動作
const marketGroups = loadMarketGroups();
if (loadHistory().length < 30) {
  // 初回やCIキャッシュ消失時は過去250営業日ぶんを自動補完（その日までのデータだけで再現＝未来は見ない）。
  // 250日なのはレジーム別（上昇/下落/もみ合い）のサンプルを確保するため。数分かかるが初回のみ。
  const added = seedHistory(groups, 250, marketGroups);
  if (added) console.log(`検証履歴が薄いため過去 ${added} 営業日分を自動補完しました。`);
}
const todayEntry = {
  date: dataDate,
  buys: buys.map((r) => r.code),
  sells: sells.map((r) => r.code),
  topsNew: tops.filter((r) => r.brokeBarsAgo === 0).map((r) => r.code),
  invsNew: invs.filter((r) => r.brokeBarsAgo === 0).map((r) => r.code),
  // パターンの全状態（🆕・昇格判定用）。s: "f"=forming / "c"=confirmed
  tops: tops.map((r) => ({ c: r.code, s: r.status === "confirmed" ? "c" : "f" })),
  invs: invs.map((r) => ({ c: r.code, s: r.status === "confirmed" ? "c" : "f" })),
};
{
  const ctx = buildCtx(marketGroups, dataDate);          // 市況コンテキストを記録（表示・将来の条件付き検証用）
  if (ctx) todayEntry.ctx = ctx;
}
upsertEntry(todayEntry);                                // ※先に書き込む＝streaksが「今日を含む連続日数」になる
const evalHistory = loadHistory();

// --- #1 シグナル遷移の追跡: 継続日数(days)・起点比(sinceRet)・🆕 ---
const prevEntry = evalHistory.length >= 2 ? evalHistory.at(-2) : null;   // 前営業日のエントリ
const byCodeIdx = buildByCode(groups);
const retSince = (code, startDate) => {
  const v = byCodeIdx.get(code);
  const i = v ? v.idx.get(startDate) : null;
  return i == null ? null : v.closes.at(-1) / v.closes[i] - 1;
};
const attachStreak = (rows, key) => {
  const st = streaks(evalHistory, key);
  for (const r of rows) {
    const s = st.get(r.code);
    r.days = s ? s.days : 1;                 // そのシグナルが何営業日連続で出ているか
    r.sinceRet = s ? retSince(r.code, s.start) : null;  // シグナル初日終値→現在の騰落率
    r.isNew = r.days === 1;                  // 🆕 = 前営業日エントリに無い
  }
};
attachStreak(buys, "buys");
attachStreak(sells, "sells");
// パターンは「初出」または「形成中→完成（昇格）」を新規とする。本日抜け(0日前)は確実に新規扱い。
// （旧スキーマの履歴には tops/invs が無い→全件🆕になるが、CI欠落時と同じ1日限りのノイズで許容）
const prevPat = (key) => new Map((prevEntry?.[key] || []).map((x) => [x.c, x.s]));
const pTops = prevPat("tops"), pInvs = prevPat("invs");
const markPat = (rows, pmap) => rows.forEach((r) => {
  const was = pmap.get(r.code);
  r.isNew = !was || (was === "f" && r.status === "confirmed") || r.brokeBarsAgo === 0;
});
markPat(tops, pTops);
markPat(invs, pInvs);
// 新規を上に出す（パターンは新規→完成→形成中→quality順）
const newFirst = (base) => (a, b) => (a.isNew !== b.isNew ? (a.isNew ? -1 : 1) : base(a, b));
tops.sort(newFirst(byStatus));
invs.sort(newFirst(byStatus));

// 「パターンとの方向一致」マーク：買いは逆三尊(上昇)、売りは三尊(下落)が同じ銘柄に出ていれば整合。
// あくまで参考情報。直近10営業日の答え合わせでは強い買い/強い売り単独はほぼ無エッジだったため、
// このマークが付いた銘柄を並び順でも優先する（週足◎は複合条件の根拠として未検証のため対象外）。
const invCodes = new Set(invs.map((r) => r.code));
const topCodes = new Set(tops.map((r) => r.code));
for (const r of buys) r.patternAligned = invCodes.has(r.code);
for (const r of sells) r.patternAligned = topCodes.has(r.code);
// 並び順：🆕新規 → ◆一致 → スコア順
const alignFirst = (base) => (a, b) => (a.isNew !== b.isNew ? (a.isNew ? -1 : 1) : a.patternAligned !== b.patternAligned ? (a.patternAligned ? -1 : 1) : base(a, b));
buys.sort(alignFirst((a, b) => b.score - a.score));
sells.sort(alignFirst((a, b) => a.score - b.score));

// --- #1 張り付き警告と本日解除リスト ---
// 張り付き = STALE_DAYS 日以上出続けているのに起点から方向逆行が STALE_ADVERSE 超（例: 9984 が買いのまま-14%）
const staleList = [
  ...buys.filter((r) => r.days >= STALE_DAYS && r.sinceRet != null && r.sinceRet <= -STALE_ADVERSE).map((r) => ({ ...r, side: "買い" })),
  ...sells.filter((r) => r.days >= STALE_DAYS && r.sinceRet != null && r.sinceRet >= STALE_ADVERSE).map((r) => ({ ...r, side: "売り" })),
].slice(0, 5);
// 解除 = 昨日買い/売りにあって今日消えた銘柄。パターンの解除は検出器のフリッカーでノイズになるため対象外。
const nameByCode = new Map();
for (const sym of groups.keys()) {
  const ci = sym.indexOf(":");
  nameByCode.set(ci >= 0 ? sym.slice(0, ci) : sym, ci >= 0 ? sym.slice(ci + 1) : sym);
}
const removedOf = (key, label) => {
  const todaySet = new Set(todayEntry[key]);
  const st = streaks(evalHistory.slice(0, -1), key);            // 昨日時点の連続日数
  return (prevEntry?.[key] || []).filter((c) => !todaySet.has(c)).map((c) => {
    const s = st.get(c);
    return { code: c, name: nameByCode.get(c) || "", label, days: s ? s.days : null, ret: s ? retSince(c, s.start) : null };
  });
};
const removedList = prevEntry ? [...removedOf("buys", "買い解除"), ...removedOf("sells", "売り解除")].slice(0, 10) : [];

const nNew = (rows) => rows.filter((r) => r.isNew).length;
console.log(`判定完了: ${total}銘柄中  買い系 ${buys.length}(新${nNew(buys)}) / 売り系 ${sells.length}(新${nNew(sells)})  三尊 ${tops.length}(新${nNew(tops)}) / 逆三尊 ${invs.length}(新${nNew(invs)})  ⚠張り付き ${staleList.length} / 🔚解除 ${removedList.length}`);

// --- 過去シグナルの成績を集計（履歴は上で upsert 済み） ---
const evalStats = evaluate(groups, evalHistory);
const evalDays = evalHistory.length;
{
  const w10 = (cat) => { const st = evalStats[cat][10]; return st.n ? `${(st.win / st.n * 100).toFixed(0)}%(n=${st.n})` : "-"; };
  console.log(`答え合わせ(10日後勝率): 買い${w10("buys")} 売り${w10("sells")} 三尊${w10("topsNew")} 逆三尊${w10("invsNew")} ／ 蓄積${evalDays}日`);
}

// --- 適応型の答え合わせ: 直近窓・レジーム別の成績と信頼度状態（表示と優先度のみ。シグナルは全件出す） ---
const REGIME_JA = { up: "上昇", down: "下落", range: "もみ合い" };
const regimes = classifyRegimes(groups);
const currentRegime = regimes.get(dataDate) || (regimes.size ? [...regimes.values()].at(-1) : "range");
const windowStats = evaluate(groups, evalHistory, { lastN: RECENT_WINDOW });
const regimeStats = evaluateByRegime(groups, evalHistory, regimes);
const regimeCur = Object.fromEntries(Object.keys(regimeStats).map((c) => [c, regimeStats[c][currentRegime]]));
// 前日状態＝昨日のエントリの trust（今日は upsert 済みなので at(-2) が昨日。再実行しても日付上書きで冪等）
const prevTrust = evalHistory.length >= 2 ? evalHistory.at(-2).trust || null : null;
const trust = computeTrust(prevTrust, windowStats, regimeCur, { TRUST_ENTER, TRUST_EXIT, TRUST_MIN_N, TRUST_MIN_N_PAT });
todayEntry.trust = trust;                               // 翌日のヒステリシス入力として今日のエントリに保存
upsertEntry(todayEntry);
{
  const tj = { ok: "✅", warn: "⚠️", hold: "❔" };
  console.log(`地合い: ${REGIME_JA[currentRegime]}レジーム ／ 信頼度: 買${tj[trust.buys]} 売${tj[trust.sells]} 三尊${tj[trust.topsNew]} 逆三尊${tj[trust.invsNew]}`);
}

// --- HTMLレポート（ダッシュボード風） ---
const UP = "#ef5a4d", DOWN = "#3f8fd6", GREEN = "#3fb27f", AMBER = "#c8a24a", RED = "#c4543f";
const fmtPrice = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1));
const NEW = (r) => (r.isNew ? '<span class="new">🆕</span>' : "");
const WK = (r) => (r.weekly ? '<span class="wk">週足◎</span>' : "");
const profileLabel = (p) => (p === "ideal" ? "理想的" : p === "partial" ? "やや伴う" : p === "weak" ? "弱い" : "—");

// 上部サマリーのスタットカード
const stat = (label, n, nn, col) =>
  `<div class="stat" style="--c:${col}"><div class="slabel">${label}</div><div class="snum">${n}</div>` +
  `<div class="snew">${nn > 0 ? `🆕 ${nn} 新規` : '<span class="muted">新規なし</span>'}</div></div>`;

// 地合いバー：買い／売り／中立の比率を1本の横バーで
const breadthBar = () => {
  const neu = Math.max(0, total - buys.length - sells.length);
  const pct = (x) => ((x / total) * 100).toFixed(1);
  return `<div class="breadth"><div class="bbar">` +
    `<span style="width:${pct(buys.length)}%;background:${UP}" title="買い ${buys.length}"></span>` +
    `<span style="width:${pct(neu)}%;background:#2b3550" title="中立 ${neu}"></span>` +
    `<span style="width:${pct(sells.length)}%;background:${DOWN}" title="売り ${sells.length}"></span></div>` +
    `<div class="blabels"><span style="color:${UP}">買い ${buys.length}（${pct(buys.length)}%）</span>` +
    `<span class="muted">中立 ${neu}</span>` +
    `<span style="color:${DOWN}">売り ${sells.length}（${pct(sells.length)}%）</span></div></div>`;
};

// 値動きスパークライン（直近24本の終値）
const sparkline = (closes) => {
  if (!closes || closes.length < 2) return "";
  const w = 64, h = 18, lo = Math.min(...closes), hi = Math.max(...closes), sp = hi - lo || 1;
  const X = (i) => (i / (closes.length - 1)) * (w - 2) + 1;
  const Y = (v) => h - 2 - ((v - lo) / sp) * (h - 4);
  const d = closes.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const col = closes[closes.length - 1] >= closes[0] ? GREEN : RED;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${d}" fill="none" stroke="${col}" stroke-width="1.2"/></svg>`;
};

// 🌍 市況ストリップ（CSVにある指標を全部・動的に。VIXは水準バッジ＋前日比の色反転）
const marketStrip = (() => {
  if (!marketGroups) return "";
  const cards = [];
  for (const [name, bars] of marketGroups) {
    if (bars.length < 2) continue;
    const lastB = bars.at(-1), prevB = bars.at(-2);
    const chg = lastB.close / prevB.close - 1;
    const isVix = name.includes("VIX");
    const chgCol = (isVix ? chg <= 0 : chg >= 0) ? GREEN : RED;   // VIXは上昇=リスク悪化=赤
    let badge = "";
    if (isVix) {
      const [t, c] = lastB.close < 20 ? ["平穏", GREEN] : lastB.close < 30 ? ["警戒", AMBER] : ["恐怖", RED];
      badge = ` <span class="mbadge" style="border-color:${c};color:${c}">${t}</span>`;
    }
    // 鮮度: 最終日付が基準日より5暦日超古い指標は日付を明示（休場・取得失敗の可視化）
    const staleDays = (new Date(dataDate) - new Date(lastB.date)) / 86400000;
    const staleTag = staleDays > 5 ? ` <span class="muted">(${lastB.date.slice(5).replace("-", "/")})</span>` : "";
    const fmtV = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1));
    cards.push(
      `<div class="mcard"><div class="mname">${name}${badge}</div>` +
      `<div class="mval mono">${fmtV(lastB.close)}${staleTag}</div>` +
      `<div class="mchg mono" style="color:${chgCol}">${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}%</div>` +
      `${sparkline(bars.slice(-30).map((b) => b.close))}</div>`
    );
  }
  return cards.length ? `<div class="mstrip">${cards.join("")}</div>` : "";
})();

// 買い/売りテーブル：スコアを横バーで可視化
const maxAbs = Math.max(5, ...buys.map((r) => Math.abs(r.score)), ...sells.map((r) => Math.abs(r.score)));
const scoreCell = (s) => {
  const w = Math.min(100, (Math.abs(s) / maxAbs) * 100);
  const col = s > 0 ? UP : DOWN;
  return `<div class="swrap"><span class="sval">${s > 0 ? "+" : ""}${s.toFixed(1)}</span>` +
    `<div class="sbar"><i style="width:${w.toFixed(0)}%;background:${col}"></i></div></div>`;
};
// RSIヒート：買われすぎ(>70)=暖色／売られすぎ(<30)=寒色。過熱度を背景＋文字色で可視化。
const rsiHeat = (v) => {
  if (v == null || isNaN(v)) return '<span class="rsi" style="color:#56627d">—</span>';
  let bg = "transparent", fg = "#aab4c6", tag = "";
  if (v >= 70) { bg = "rgba(224,112,58,.30)"; fg = "#f0a878"; tag = "買われ"; }
  else if (v >= 60) { bg = "rgba(224,112,58,.15)"; fg = "#e0b090"; }
  else if (v <= 30) { bg = "rgba(63,143,214,.32)"; fg = "#84baea"; tag = "売られ"; }
  else if (v <= 40) { bg = "rgba(63,143,214,.16)"; fg = "#9ec2e2"; }
  return `<span class="rsi" style="background:${bg};color:${fg}">${v.toFixed(0)}${tag ? `<i>${tag}</i>` : ""}</span>`;
};
// パターン一致マーク：買い×逆三尊、売り×三尊が同じ銘柄に出ている＝方向が重なる参考情報。
const ALIGN = (r) => (r.patternAligned ? '<span class="align" title="同じ銘柄に方向が一致するパターンあり">◆一致</span>' : "");
// 継続列: シグナルが何日連続か＋初日からの騰落率（買いは+緑/-赤、売りは逆）。逆行張り付きは⚠付き
const streakCell = (r, dir) => {
  const ret = r.sinceRet;
  const good = ret != null && (dir > 0 ? ret >= 0 : ret <= 0);
  const retTxt = ret == null ? "" : ` <span style="color:${good ? GREEN : RED}">${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(1)}%</span>`;
  const warn = r.days >= STALE_DAYS && ret != null && (dir > 0 ? ret <= -STALE_ADVERSE : ret >= STALE_ADVERSE) ? "⚠" : "";
  return `<td class="mono" style="white-space:nowrap">${warn}${r.days}日目${retTxt}</td>`;
};
const tableRows = (rows, dir) => rows.map((r) =>
  `<tr><td>${NEW(r)}<b>${r.code}</b></td><td>${r.name} ${ALIGN(r)}</td><td>${r.verdict}</td><td class="scell">${scoreCell(r.score)}</td>` +
  `<td>${rsiHeat(r.rsi)}</td>${streakCell(r, dir)}<td class="spk">${sparkline(r.spark)}</td><td style="text-align:right" class="mono">${fmtPrice(r.close)}</td></tr>`
).join("");

// 三尊/逆三尊：チャート付きの大きめカード
const patStatusText = (r, breakWord) => (r.status === "confirmed" ? `ネックライン${breakWord}（${r.brokeBarsAgo === 0 ? "本日" : r.brokeBarsAgo + "日前"}）` : "形成中");
const patCard = (r, breakWord, kind) => {
  const accent = kind === "top" ? DOWN : UP;
  const badge = r.status === "confirmed"
    ? `<span class="badge" style="background:${accent};color:#0b101c">${breakWord}完成 ${r.brokeBarsAgo === 0 ? "本日" : r.brokeBarsAgo + "日前"}</span>`
    : `<span class="badge out" style="border-color:${accent};color:${accent}">形成中</span>`;
  const rr = r.rr;
  const rrCol = rr >= 2 ? GREEN : rr >= 1 ? AMBER : RED;
  const rrW = Math.min(100, ((rr || 0) / 3) * 100);
  // 形成中だけ「ネックラインまであと何%」ゲージ。近いほどバーが伸び、1%以内は色を強調。
  let gauge = "";
  if (r.status === "forming") {
    const near = Math.max(0, r.neckPct);                 // 完成に必要な値動き(%)
    const fill = Math.max(4, Math.min(100, (1 - Math.min(near, 5) / 5) * 100));
    const arrow = kind === "top" ? "▼" : "▲";            // 三尊=下落で完成 / 逆三尊=上昇で完成
    const gcol = near <= 1 ? accent : near <= 3 ? AMBER : "#56627d";
    gauge = `<div class="gauge"><span>完成まで</span><div class="gbar"><i style="width:${fill.toFixed(0)}%;background:${gcol}"></i></div>` +
      `<b style="color:${gcol}">${arrow}${near.toFixed(1)}%</b></div>`;
  }
  return `<div class="card" style="border-top:3px solid ${accent}" data-code="${r.code}" data-name="${r.name}">` +
    `<div class="chartwrap" title="クリックで拡大（日足・週足・月足）">${r.svg}<span class="zhint">⤢ 拡大</span></div>` +
    `<div class="zoom" hidden>${r.wSvg}${r.mSvg}</div><div class="cbody">` +
    `<div class="ctitle">${NEW(r)}<b>${r.code}</b> ${r.name} ${WK(r)}</div>` +
    `<div class="crow">${badge}<span class="prof">出来高 ${profileLabel(r.profile)}</span></div>` +
    `<div class="cstats"><div><span>目標</span><b style="color:${GREEN}" class="mono">${fmtPrice(r.target)}</b></div>` +
    `<div><span>損切</span><b style="color:${RED}" class="mono">${fmtPrice(r.stop)}</b></div>` +
    `<div><span>現値</span><b class="mono">${fmtPrice(r.close)}</b></div></div>` +
    gauge +
    `<div class="rr"><span>RR ${rr != null ? rr.toFixed(1) : "—"}</span><div class="rrbar"><i style="width:${rrW.toFixed(0)}%;background:${rrCol}"></i></div></div>` +
    `</div></div>`;
};
const cards = (rows, breakWord, kind) => rows.length
  ? `<div class="cards">${rows.map((r) => patCard(r, breakWord, kind)).join("")}</div>`
  : '<p class="muted">該当なし</p>';

const buyTable = (rows, dir) => `<table><tr><th>コード</th><th>銘柄</th><th>判定</th><th>スコア</th><th>RSI</th><th>継続</th><th>推移(24日)</th><th>終値</th></tr>` +
  `${tableRows(rows, dir) || '<tr><td colspan=8 class="muted">該当なし</td></tr>'}</table>`;

// ⚠ 張り付き警告（買い/売り表の直前）と 🔚 本日解除（🆕ブロック相当の位置）
const fmtSince = (ret) => (ret == null ? "" : `${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(1)}%`);
const staleBlock = staleList.length
  ? `<div class="caveat" style="border-left-color:${RED}">⚠ <b>外れ続けている張り付き</b>（${STALE_DAYS}日以上継続・${(STALE_ADVERSE * 100).toFixed(0)}%超の逆行。シグナルが機能していない可能性）: ` +
    staleList.map((r) => `${r.side} ${r.code} ${r.name}（${r.days}日目 ${fmtSince(r.sinceRet)}）`).join(" ／ ") + `</div>`
  : "";
const removedBlock = removedList.length
  ? `<div class="caveat">🔚 <b>本日解除</b>: ` +
    removedList.map((r) => `${r.label} ${r.code} ${r.name}${r.days ? `（${r.days}日間 ${fmtSince(r.ret)}）` : ""}`).join(" ／ ") + `</div>`
  : "";

// 自動答え合わせの成績表（過去シグナルの5/10/20営業日後の成績。対市場プラス=市場平均より優位）
const evalLabels = { buys: "🔴 買い（強い買い）", sells: "🔵 売り（強い売り）", topsNew: "⛰️ 三尊（当日完成）", invsNew: "🛡 逆三尊（当日完成）" };
const evalCell = (st) => {
  if (!st.n) return '<td class="muted">蓄積中</td>';
  const win = st.win / st.n, avgR = st.sum / st.n, edge = st.baseN ? st.edgeSum / st.baseN : null;
  const col = edge == null ? "var(--mut)" : edge > 0.002 ? GREEN : edge < -0.002 ? RED : AMBER;
  return `<td><b style="color:${col}" class="mono">${(win * 100).toFixed(0)}%</b> <span class="muted mono">平均${(avgR * 100).toFixed(1)}%・対市場${edge != null ? (edge >= 0 ? "+" : "") + (edge * 100).toFixed(1) + "%" : "—"}・n=${st.n}</span></td>`;
};
// 直近窓と全期間の比較矢印: 直近の対市場edge(10日)が全期間より+0.5%pt以上良ければ↗、悪ければ↘
const trendArrow = (c) => {
  const allE = edgeOf(evalStats[c][10]), recE = edgeOf(windowStats[c][10]);
  if (allE == null || recE == null) return "";
  const d = recE - allE;
  const [sym, col] = d >= 0.005 ? ["↗", GREEN] : d <= -0.005 ? ["↘", RED] : ["→", "var(--mut)"];
  return ` <b style="color:${col}" title="全期間比${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}%pt">${sym}</b>`;
};
const evalTable = `<table><tr><th>シグナル</th><th>5日後</th><th>10日後</th><th>直近${RECENT_WINDOW}日窓(10日後)</th><th>20日後</th></tr>` +
  Object.keys(evalLabels).map((c) =>
    `<tr><td>${evalLabels[c]}</td>${evalCell(evalStats[c][5])}${evalCell(evalStats[c][10])}` +
    `${evalCell(windowStats[c][10]).replace("</td>", trendArrow(c) + "</td>")}${evalCell(evalStats[c][20])}</tr>`
  ).join("") + `</table>`;

// 「いまのレジームでの過去成績」＝過去の答えを今の文脈で読み替える1行
const regimeLine = (() => {
  const cell = (cat, label) => {
    const st = regimeCur[cat] && regimeCur[cat][10];
    if (!st || !st.n) return `${label} —`;
    const e = edgeOf(st);
    return `${label} 勝率${(st.win / st.n * 100).toFixed(0)}%(対市場${e != null ? (e >= 0 ? "+" : "") + (e * 100).toFixed(1) + "%" : "—"}, n=${st.n})`;
  };
  return `<p class="regimeline">現在は<b>${REGIME_JA[currentRegime]}レジーム</b> ｜ ${REGIME_JA[currentRegime]}時の成績(10日後): ` +
    `${cell("buys", "買い")} / ${cell("sells", "売り")} / ${cell("topsNew", "三尊")} / ${cell("invsNew", "逆三尊")}</p>`;
})();

// セクション見出しの信頼度チップ（⚠️は目立たせ、✅は控えめに。❔はサンプル不足の正直な表示）
const trustChip = (cat) => {
  const t = trust[cat];
  if (t === "warn") return ` <span class="tchip warn">⚠️ 直近効いていません</span>`;
  if (t === "ok") return ` <span class="tchip ok">✅ 有効</span>`;
  return ` <span class="tchip hold">❔ 判定保留</span>`;
};

const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>罫線シグナル ${today}</title>
<style>
:root{--bg:#0b101c;--panel:#131a2b;--line:#243049;--ink:#e8edf5;--mut:#8090a8}
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);margin:0;padding:24px;max-width:1180px;margin:0 auto}
.mono{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
h1{font-size:22px;margin:0 0 2px}h2{font-size:16px;margin:30px 0 6px;padding-left:10px;border-left:4px solid var(--line)}
h2.buy{border-color:${UP}}h2.sell{border-color:${DOWN}}
.muted{color:var(--mut);font-size:12px}.sub{color:var(--mut);font-size:12px;margin:0 0 4px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 4px}
.chip{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:2px 9px;color:var(--mut)}
.new{margin-right:3px}.wk{color:${AMBER};font-size:11px;border:1px solid ${AMBER};border-radius:3px;padding:0 4px;margin-left:4px}
/* サマリー */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0 8px}
.stat{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--c);border-radius:10px;padding:12px 14px}
.slabel{font-size:12px;color:var(--mut)}.snum{font-size:30px;font-weight:700;line-height:1.1;color:var(--c)}
.snew{font-size:12px;margin-top:2px}
/* テーブル */
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px}
th,td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left}th{color:var(--mut);font-weight:600;font-size:12px}
tr:hover td{background:rgba(255,255,255,.02)}
.scell{width:170px}.swrap{display:flex;align-items:center;gap:8px}.sval{width:42px;text-align:right;font-variant-numeric:tabular-nums}
.sbar{flex:1;height:7px;background:#1c2536;border-radius:4px;overflow:hidden}.sbar i{display:block;height:100%}
.spk{width:72px}.spark{display:block}
.rsi{display:inline-block;min-width:26px;text-align:center;padding:1px 6px;border-radius:5px;font-variant-numeric:tabular-nums;font-size:12px}
.rsi i{font-style:normal;font-size:9px;margin-left:3px;opacity:.85}
.align{font-size:10px;color:${AMBER};border:1px solid ${AMBER};border-radius:3px;padding:0 4px;margin-left:2px}
.caveat{background:rgba(200,162,74,.08);border:1px solid var(--line);border-left:3px solid ${AMBER};border-radius:6px;padding:8px 12px;font-size:12px;color:var(--mut);margin:10px 0}
/* 🌍 市況ストリップ */
.mstrip{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 0}
.mcard{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:118px}
.mname{font-size:11px;color:var(--mut);white-space:nowrap}
.mbadge{font-size:10px;border:1px solid;border-radius:4px;padding:0 4px;font-weight:700}
.mval{font-size:15px;font-weight:700;margin:1px 0}
.mchg{font-size:11px;margin-bottom:2px}
/* 地合いバー・レジーム・信頼度チップ */
.regimebar{font-size:13px;margin:8px 0 2px}.regimebar .muted{margin-left:8px}
.regimeline{font-size:12px;color:var(--mut);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:7px 12px;margin:8px 0 0}
.regimeline b{color:var(--ink)}
.tchip{font-size:11px;border-radius:5px;padding:1px 8px;font-weight:600;vertical-align:2px;margin-left:6px}
.tchip.warn{background:rgba(196,84,63,.20);color:#f0a878;border:1px solid ${RED}}
.tchip.ok{color:${GREEN};border:1px solid rgba(63,178,127,.45)}
.tchip.hold{color:var(--mut);border:1px solid var(--line);font-weight:400}
.breadth{margin:6px 0 4px}
.bbar{display:flex;height:14px;border-radius:7px;overflow:hidden;border:1px solid var(--line)}.bbar span{display:block;height:100%}
.blabels{display:flex;justify-content:space-between;font-size:11px;margin-top:4px}
/* カード */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-top:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.card svg{width:100%;height:auto;display:block;border:0;border-bottom:1px solid var(--line);border-radius:0}
.cbody{padding:10px 12px 12px}.ctitle{font-size:14px;margin-bottom:6px}.ctitle b{font-size:15px}
.crow{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.badge{font-size:11px;font-weight:700;border-radius:5px;padding:2px 8px}.badge.out{background:transparent;border:1px solid}
.prof{font-size:11px;color:var(--mut)}
.cstats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px}
.cstats div{background:#0e1422;border-radius:6px;padding:5px 8px}.cstats span{display:block;font-size:10px;color:var(--mut)}.cstats b{font-size:14px}
.rr{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--mut)}.rr span{width:54px}
.rrbar{flex:1;height:6px;background:#1c2536;border-radius:4px;overflow:hidden}.rrbar i{display:block;height:100%}
.gauge{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--mut);margin-bottom:8px}.gauge span{width:54px}.gauge b{width:48px;text-align:right;font-variant-numeric:tabular-nums}
.gbar{flex:1;height:6px;background:#1c2536;border-radius:4px;overflow:hidden}.gbar i{display:block;height:100%}
/* クリック拡大 */
.chartwrap{position:relative;cursor:zoom-in}
.zhint{position:absolute;top:6px;right:6px;font-size:10px;color:#cdd6e6;background:rgba(11,16,28,.7);border:1px solid var(--line);border-radius:5px;padding:1px 6px;pointer-events:none}
.chartwrap:hover .zhint{background:rgba(40,52,80,.9)}
.modal{position:fixed;inset:0;background:rgba(4,8,16,.82);display:flex;align-items:flex-start;justify-content:center;padding:28px 16px;overflow:auto;z-index:50}
.modal[hidden]{display:none}
.mbox{background:var(--panel);border:1px solid var(--line);border-radius:12px;max-width:780px;width:100%;padding:14px 16px 18px}
.mhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.mhead b{font-size:16px}.mclose{background:transparent;border:1px solid var(--line);color:var(--ink);border-radius:6px;font-size:16px;width:30px;height:30px;cursor:pointer}
.mbody .zchart{margin:0 0 14px}.mbody figcaption{font-size:12px;color:var(--mut);margin-bottom:3px}
.mbody svg{width:100%;height:auto;display:block;border-radius:6px}
@media(max-width:560px){.stats{grid-template-columns:repeat(2,1fr)}}
</style>
<h1>罫線スクリーニング</h1>
<p class="sub">${today}　／　対象 ${total} 銘柄　／　通知条件: ${cfg.signals === "all" ? "買い系・売り系すべて" : "強い買い・強い売りのみ"}</p>
<div class="chips"><span class="chip">🆕 前回比の新規</span><span class="chip">週足◎ 週足でも同型</span><span class="chip" style="color:${GREEN}">目標</span><span class="chip" style="color:${RED}">損切</span><span class="chip">RR リスクリワード比</span><span class="chip"><span style="color:#f0a878">RSI70+買われすぎ</span>／<span style="color:#84baea">30-売られすぎ</span></span></div>
${marketStrip}
<div class="stats">
${stat("🔴 買いサイン", buys.length, nNew(buys), UP)}
${stat("🔵 売りサイン", sells.length, nNew(sells), DOWN)}
${stat("⛰️ 三尊（天井）", tops.length, nNew(tops), DOWN)}
${stat("🛡 逆三尊（大底）", invs.length, nNew(invs), UP)}
</div>
${breadthBar()}
<div class="regimebar">現在の地合い: <b style="color:${currentRegime === "up" ? GREEN : currentRegime === "down" ? RED : AMBER}">${currentRegime === "up" ? "📈" : currentRegime === "down" ? "📉" : "➡"} ${REGIME_JA[currentRegime]}レジーム</b><span class="muted">（全${total}銘柄の等ウェイト指数 vs 25日線で機械判定）</span></div>
${dataWarnings.length ? `<div class="caveat" style="border-left-color:${RED}">🚨 データ異常の疑い ${dataWarnings.length}件（分割未調整・混入の可能性。シグナルが壊れているかも）: ${dataWarnings.slice(0, 5).join(" ／ ")}${dataWarnings.length > 5 ? " …" : ""}</div>` : ""}
${removedBlock}
<h2>📈 自動答え合わせ（過去シグナルのその後・蓄積${evalDays}営業日）</h2>
<p class="muted">勝率＝シグナルの方向どおりに動いた割合。対市場＝同じ期間の全銘柄平均に対する優位性（＋なら市場より良い）。毎日自動で蓄積・更新されます。同じ銘柄が連日カウントされるため n は延べ数。<br>
「直近${RECENT_WINDOW}日窓」は答えが出たシグナル日の直近${RECENT_WINDOW}日分（10日後成績は最短でも10日前のシグナルまでしか反映されない構造的ラグあり）。矢印は全期間との比較: ↗改善 ／ →横ばい ／ ↘悪化。</p>
${evalTable}
${regimeLine}
<h2 class="sell">⛰️ 三尊（ヘッドアンドショルダー天井）（${tops.length}）${trustChip("topsNew")}</h2>
<p class="muted">買い／売り判定に関わらず抽出。終値がネックラインを割ると「完成」＝下落シグナル。</p>
${cards(tops, "割れ", "top")}
<h2 class="buy">🛡 逆三尊（インバースH&S・大底）（${invs.length}）${trustChip("invsNew")}</h2>
<p class="muted">買い／売り判定に関わらず抽出。終値がネックラインを上抜けると「完成」＝上昇シグナル。</p>
${cards(invs, "抜け", "inverse")}
<div class="caveat">⚠ 買い/売り単独シグナルの実際の成績は上部「📈 自動答え合わせ」を参照（毎日自動更新）。<span class="align" style="margin-left:0">◆一致</span>（方向が一致するパターンが同じ銘柄に出ている）付きの銘柄を優先的に見てください。</div>
${staleBlock}
<h2 class="buy">🔴 買いサイン（${buys.length}）${trustChip("buys")}</h2>
${buyTable(buys, +1)}
<h2 class="sell">🔵 売りサイン（${sells.length}）${trustChip("sells")}</h2>
${buyTable(sells, -1)}
<div id="modal" class="modal" hidden><div class="mbox"><div class="mhead"><b id="mtitle"></b><button class="mclose" id="mclose" aria-label="閉じる">×</button></div><div id="mbody" class="mbody"></div></div></div>
<script>
(function(){
  var modal=document.getElementById('modal'),mtitle=document.getElementById('mtitle'),mbody=document.getElementById('mbody');
  function close(){modal.hidden=true;mbody.innerHTML='';}
  document.addEventListener('click',function(e){
    var w=e.target.closest('.chartwrap');
    if(w){var card=w.closest('.card');
      mtitle.textContent=card.dataset.code+' '+card.dataset.name;
      mbody.innerHTML='';
      var d=document.createElement('figure');d.className='zchart';
      d.innerHTML='<figcaption>日足（パターン）</figcaption>'+w.querySelector('svg').outerHTML;
      mbody.appendChild(d);
      card.querySelectorAll('.zoom > figure').forEach(function(f){mbody.appendChild(f.cloneNode(true));});
      modal.hidden=false;return;}
    if(e.target===modal||e.target.id==='mclose'){close();}
  });
  document.addEventListener('keydown',function(e){if(e.key==='Escape')close();});
})();
</script>
</html>`;
const outDir = new URL("./signals/", ROOT);
fs.mkdirSync(outDir, { recursive: true });
const reportPath = new URL(`./signals_${today}.html`, outDir);
fs.writeFileSync(reportPath, html);
console.log("レポート: signals/signals_" + today + ".html");

// クラウド(GitHub Actions)では signals/ をキャッシュで引き継ぐため、肥大化しないよう
// state とレポートを直近14日分だけ残す。ローカルは履歴を残したいので間引かない。
if (process.env.GITHUB_ACTIONS) {
  const keepLast = (re, n) => {
    const files = fs.readdirSync(outDir).filter((f) => re.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - n))) fs.rmSync(new URL(f, outDir));
  };
  keepLast(/^state_\d{4}-\d{2}-\d{2}\.json$/, 14);
  keepLast(/^signals_\d{4}-\d{2}-\d{2}\.html$/, 14);
}

// --- 通知（LINE Messaging API / Discord / Slack Webhook） ---
async function notify() {
  // クラウド(GitHub Actions)では Secret を環境変数で渡す。なければ設定ファイル。
  const lineToken = (process.env.LINE_TOKEN || cfg.line_token || "").trim();
  const url = (process.env.WEBHOOK_URL || cfg.webhook_url || "").trim();
  // レポート形式の本文（1銘柄1行：コード 社名 スコア / トレンド RSI / 終値）
  const shortTrend = (t) => (t.includes("上昇") ? "上昇" : t.includes("下降") ? "下降" : "レンジ");
  // (Nd) = シグナルが N 営業日連続。1日目は🆕が既にあるので付けない
  const tag = (r) => (r.isNew ? "🆕" : "") + (r.weekly ? "週" : "") + (r.patternAligned ? "◆" : "") + (r.days > 1 ? `(${r.days}d)` : "");
  const reportLines = (rows) => {
    const cap = 20;  // LINE本文(4900字)に買い・売り両方を収めるため各20件まで（全件はHTMLレポート参照。フェーズ1の行追加に伴い25→20）
    const lines = rows.slice(0, cap).map((r) =>
      `${tag(r)}${r.code} ${r.name} ${r.score > 0 ? "+" : ""}${r.score.toFixed(1)} / ${shortTrend(r.trend)} RSI${r.rsi != null ? r.rsi.toFixed(0) : "-"} / ${fmtPrice(r.close)}`
    );
    if (rows.length > cap) lines.push(`…他${rows.length - cap}件（詳細はレポート）`);
    return lines.join("\n") || "なし";
  };
  const patLines = (rows, breakWord, arrow) => {
    const cap = 50;
    const lines = rows.slice(0, cap).map((r) => {
      const state = r.status === "confirmed"
        ? `${breakWord}(${r.brokeBarsAgo === 0 ? "本日" : r.brokeBarsAgo + "日前"})`
        : `形成中 完成まで${arrow}${Math.max(0, r.neckPct).toFixed(1)}%`;
      return `${tag(r)}${r.code} ${r.name} ${state} / ネック${fmtPrice(r.neck)} 目標${fmtPrice(r.target)} 損切${fmtPrice(r.stop)} RR${r.rr != null ? r.rr.toFixed(1) : "-"} / ${fmtPrice(r.close)}`;
    });
    if (rows.length > cap) lines.push(`…他${rows.length - cap}件`);
    return lines.join("\n") || "なし";
  };
  // 🆕 本日の新規だけを抜き出したハイライト（最優先で先頭に出す）。
  // ⚠️警戒カテゴリの行には行頭に⚠を付ける（載せるのはやめない＝情報は隠さない）。
  const warnMark = (cat) => (trust[cat] === "warn" ? "⚠" : "");
  const newLine = (r, kind) => `${kind}${r.code} ${r.name}`;
  const newHi = [
    ...buys.filter((r) => r.isNew).map((r) => newLine(r, warnMark("buys") + "🔴買 ")),
    ...sells.filter((r) => r.isNew).map((r) => newLine(r, warnMark("sells") + "🔵売 ")),
    ...tops.filter((r) => r.isNew).map((r) => newLine(r, warnMark("topsNew") + "⛰️三尊 ")),
    ...invs.filter((r) => r.isNew).map((r) => newLine(r, warnMark("invsNew") + "🛡逆三尊 ")),
  ];
  const newBlock = newHi.length
    ? ["", `🆕 本日の新規（${newHi.length}）`, newHi.slice(0, 30).join("\n") + (newHi.length > 30 ? `\n…他${newHi.length - 30}件` : "")]
    : [];
  // 🔚 本日解除（🆕ブロックの直後）と ⚠ 張り付き（パターンの後・買いリストの前）
  const removedLines = removedList.length
    ? ["", `🔚 本日解除（${removedList.length}）`,
       removedList.map((r) => `${r.label} ${r.code} ${r.name}${r.days ? `（${r.days}日間 ${fmtSince(r.ret)}）` : ""}`).join("\n")]
    : [];
  const staleLines = staleList.length
    ? ["", `⚠ 外れ続けている張り付き（${staleList.length}）`,
       staleList.map((r) => `${r.side} ${r.code} ${r.name} ${r.days}日目 ${fmtSince(r.sinceRet)}`).join("\n")]
    : [];
  // 自動答え合わせの1行サマリ（10日後成績。カッコ内は対市場の優位性）
  const eLine = (cat) => {
    const st = evalStats[cat][10];
    if (!st.n) return "蓄積中";
    const edge = st.baseN ? st.edgeSum / st.baseN : null;
    return `${(st.win / st.n * 100).toFixed(0)}%${edge != null ? `(${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%)` : ""}`;
  };
  // LINEは本文を4900字で切るため、注目度の高い順に並べる：
  // 新規ハイライト → 三尊/逆三尊（今回の主目的）→ 買い/売りリスト（件数が多く長い）。
  const tMark = { ok: "✅", warn: "⚠️", hold: "❔" };
  // 🌍 市況1行（長さ節約のため4指標に限定: 日経・ドル円・VIX・BTC）
  const marketLine = (() => {
    if (!marketGroups) return [];
    const g = (n) => { const b = marketGroups.get(n); return b && b.length >= 2 ? { last: b.at(-1).close, chg: b.at(-1).close / b.at(-2).close - 1 } : null; };
    const parts = [];
    const nk = g("日経225"); if (nk) parts.push(`日経${nk.chg >= 0 ? "+" : ""}${(nk.chg * 100).toFixed(1)}%`);
    const fx = g("ドル円"); if (fx) parts.push(`ドル円${fx.last.toFixed(1)}`);
    const vx = g("VIX恐怖指数"); if (vx) parts.push(`VIX${vx.last.toFixed(1)}${vx.last >= 30 ? "🚨" : vx.last >= 20 ? "⚠" : ""}`);
    const bt = g("ビットコイン"); if (bt) parts.push(`BTC$${(bt.last / 1000).toFixed(1)}k${bt.chg >= 0 ? "+" : ""}${(bt.chg * 100).toFixed(1)}%`);
    return parts.length ? [`🌍 ${parts.join(" ")}`] : [];
  })();
  let msg = [
    `📊 罫線スクリーニング ${today}`,
    `対象${total}銘柄 ｜ 🔴買い ${buys.length} ｜ 🔵売り ${sells.length} ｜ ⛰️三尊 ${tops.length} ｜ 🛡逆三尊 ${invs.length} ｜ 地合い ${REGIME_JA[currentRegime]}`,
    ...marketLine,
    `📈 答え合わせ10日後勝率: 買${eLine("buys")} 売${eLine("sells")} 三尊${eLine("topsNew")} 逆三尊${eLine("invsNew")}（蓄積${evalDays}日・カッコ内=対市場）`,
    `信頼度: 買${tMark[trust.buys]} 売${tMark[trust.sells]} 三尊${tMark[trust.topsNew]} 逆三尊${tMark[trust.invsNew]}（直近${RECENT_WINDOW}日と現レジームの成績で機械判定）`,
    ...(dataWarnings.length ? [`🚨 データ異常疑い ${dataWarnings.length}件（レポート参照）`] : []),
    ...newBlock,
    ...removedLines,
    "",
    `⛰️ 三尊・天井（${tops.length}）`,
    patLines(tops, "割れ", "▼"),
    "",
    `🛡 逆三尊・大底（${invs.length}）`,
    patLines(invs, "抜け", "▲"),
    ...staleLines,
    "",
    `◆＝方向一致パターンあり（成績詳細はレポートの📈自動答え合わせ）`,
    `🔴 買いサイン（${buys.length}）`,
    reportLines(buys),
    "",
    `🔵 売りサイン（${sells.length}）`,
    reportLines(sells),
  ].join("\n");
  // 本文長は送信の有無に関わらず常に確認できるようにする（4900字制限の監視）
  console.log(`LINE想定本文: ${msg.length}字${msg.length > 4900 ? "（⚠4900字超のため末尾切り詰め）" : ""}`);

  if (!lineToken && !url) {
    console.log("通知先が未設定（LINE_TOKEN も webhook_url も空）のため、通知はスキップしました（レポートのみ）。");
    return;
  }
  if (buys.length === 0 && sells.length === 0 && tops.length === 0 && invs.length === 0) {
    console.log("サイン該当なし。通知はスキップしました。");
    return;
  }

  try {
    if (lineToken) {
      // LINE Messaging API：友だち全員へブロードキャスト（テキストは最大5000字）
      const text = msg.length > 4900 ? msg.slice(0, 4900) + " …(省略)" : msg;
      const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + lineToken },
        body: JSON.stringify({ messages: [{ type: "text", text }] }),
      });
      if (res.ok) console.log("通知を送信しました（LINE）。");
      else console.error(`LINE通知の送信に失敗: HTTP ${res.status} ${await res.text()}`);
    } else {
      // Webhook（URLで自動判別）。Make/Zapier等の汎用Webhookには構造化JSONを送る。
      const clip = (s, n) => (s.length > n ? s.slice(0, n) + " …(省略)" : s);
      const isSlack = /hooks\.slack\.com/.test(url);
      const isDiscord = /discord(app)?\.com/.test(url);
      const brief = (rows) => rows.map((r) => ({ code: r.code, name: r.name, score: +r.score.toFixed(1), close: r.close, is_new: !!r.isNew, pattern_aligned: !!r.patternAligned }));
      let payload, label;
      if (isSlack) { payload = { text: clip(msg, 2900) }; label = "Slack"; }
      else if (isDiscord) { payload = { content: clip(msg, 1900) }; label = "Discord"; }
      else {
        const briefPat = (rows) => rows.map((r) => ({ code: r.code, name: r.name, status: r.status, broke_bars_ago: r.brokeBarsAgo, neck: r.neck, target: r.target, stop: r.stop, rr: r.rr != null ? +r.rr.toFixed(2) : null, weekly: !!r.weekly, is_new: !!r.isNew, close: r.close }));
        const newCount = [buys, sells, tops, invs].reduce((s, rows) => s + rows.filter((r) => r.isNew).length, 0);
        payload = {
          content: clip(msg, 4900),          // LINE等へ転送する本文（Makeで content を使う）
          date: today,
          buy_count: buys.length,
          sell_count: sells.length,
          top_count: tops.length,
          inverse_count: invs.length,
          new_count: newCount,
          buys: brief(buys),
          sells: brief(sells),
          tops: briefPat(tops),
          inverses: briefPat(invs),
        };
        label = "Webhook(Make等)";
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) console.log(`通知を送信しました（${label}）。`);
      else console.error(`通知の送信に失敗: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (e) {
    console.error("通知の送信に失敗:", e.message);
  }
}
await notify();
