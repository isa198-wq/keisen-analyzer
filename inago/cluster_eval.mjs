// v6 フェーズL-2/L-3: クラスタ履歴の記録・答え合わせ集計。
//   screen_daily.mjs から import して使う。単体実行時は蓄積済みの signals/cluster_history.jsonl の
//   集計結果を表示するだけ（検知は行わない）。
// 不変条件: 履歴はコードのみ保存し、価格・名前は保存しない（history.jsonlと同じ。リターンは
//   常に最新CSVから日付で引く）。
// 実行: node inago/cluster_eval.mjs（リポジトリ直下からでもinago配下からでも可）
import fs from "node:fs";

const ROOT = new URL("../", import.meta.url); // リポジトリ直下（signals/はここにある）
const HISTORY_PATH = new URL("./signals/cluster_history.jsonl", ROOT);
const CSV_PATH = new URL("./screening_data.csv", ROOT);

function loadClusterHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  const out = [];
  for (const line of fs.readFileSync(HISTORY_PATH, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 壊れた行は無視 */ }
  }
  return out;
}

function saveClusterHistory(records) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(HISTORY_PATH, sorted.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// クラスタ検知が実行された日（clusters.jsonの読込・パースに成功した日）のみ呼ぶこと。
// 検知失敗の日は呼ばない＝欠測として扱い、「クラスタゼロだった日」と区別する（§9-4）。
// 冪等: 同一dateの行があれば上書き（upsert）。クラスタ0件の日も {date, clusters:[]} として記録する。
function recordClusterHistory(date, themeClusters) {
  const entry = { date, clusters: (themeClusters || []).map((c) => ({ codes: c.members.map((m) => m.code) })) };
  const records = loadClusterHistory();
  const idx = records.findIndex((r) => r.date === date);
  if (idx >= 0) records[idx] = entry; else records.push(entry);
  saveClusterHistory(records);
}

// --- 答え合わせ用データ読み込み（screening_data.csvから直接。screen_daily.mjsのgroupsに依存しない）---
function loadReturnIndex() {
  const byCode = new Map(); // code -> {dates:[], closes:[]}
  if (!fs.existsSync(CSV_PATH)) return byCode;
  const text = fs.readFileSync(CSV_PATH, "utf8");
  const tmp = new Map(); // code -> [{date, close}]
  for (const line of text.split(/\r?\n/).slice(1)) {
    const c = line.split(",");
    if (c.length < 6) continue;
    const sym = c[0];
    if (!sym || sym === "銘柄") continue;
    const ci = sym.indexOf(":");
    const code = ci >= 0 ? sym.slice(0, ci) : sym;
    if (!/^[0-9]/.test(code)) continue; // 東証のみ（米国株除外。フェーズL-1と同じ規則）
    const date = c[1], close = +c[5];
    if (!Number.isFinite(close)) continue;
    if (!tmp.has(code)) tmp.set(code, []);
    tmp.get(code).push({ date, close });
  }
  for (const [code, rows] of tmp) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    byCode.set(code, { dates: rows.map((r) => r.date), closes: rows.map((r) => r.close) });
  }
  return byCode;
}

function retBetween(byCode, code, dateFrom, dateTo) {
  const v = byCode.get(code);
  if (!v) return null;
  const iFrom = v.dates.indexOf(dateFrom), iTo = v.dates.indexOf(dateTo);
  if (iFrom < 0 || iTo < 0) return null;
  return (v.closes[iTo] / v.closes[iFrom] - 1) * 100;
}

// 記録日dateのN営業日後の日付を、実データの日付系列から解決する（休場ズレに強い。配列位置合わせはしない）。
function resolveDateAfter(byCode, date, n) {
  for (const v of byCode.values()) {
    const i = v.dates.indexOf(date);
    if (i >= 0 && i + n < v.dates.length) return v.dates[i + n];
  }
  return null;
}

function universeAvgReturn(byCode, dateFrom, dateTo) {
  let sum = 0, n = 0;
  for (const code of byCode.keys()) {
    const r = retBetween(byCode, code, dateFrom, dateTo);
    if (r != null) { sum += r; n++; }
  }
  return n ? sum / n : null;
}

function jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
}

// history: loadClusterHistory()の戻り値。byCode省略時はCSVから自前で読む。
function evaluateClusterHistory(history, byCode = loadReturnIndex(), { horizons = [5, 10] } = {}) {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const perHorizon = Object.fromEntries(horizons.map((n) => [n, { n: 0, sumExcess: 0 }]));

  for (const day of sorted) {
    for (const cl of day.clusters) {
      if (!cl.codes || cl.codes.length < 2) continue;
      for (const n of horizons) {
        const dateTo = resolveDateAfter(byCode, day.date, n);
        if (!dateTo) continue; // 答えがまだ出ていないクラスタは集計しない
        const memberRets = cl.codes.map((c) => retBetween(byCode, c, day.date, dateTo)).filter((r) => r != null);
        if (!memberRets.length) continue;
        const avgMember = memberRets.reduce((s, r) => s + r, 0) / memberRets.length;
        const avgUniverse = universeAvgReturn(byCode, day.date, dateTo);
        if (avgUniverse == null) continue;
        perHorizon[n].n++;
        perHorizon[n].sumExcess += (avgMember - avgUniverse);
      }
    }
  }

  // 持続日数（総日数=初出日を含む）。§9-6: 記録上の「次の日」との突き合わせで、既に前日からの
  // 継続としてカウント済みのクラスタは新規の起点として数え直さない（二重計上防止）。
  // 欠測(記録が飛んでいる)日をまたぐ場合はその先を判定できないため、そこで打ち切る。
  const consumed = new Set(); // `${dayIndex}-${clusterIndex}`
  let persistN = 0, persistDaysSum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const day = sorted[i];
    for (let k = 0; k < day.clusters.length; k++) {
      const key = `${i}-${k}`;
      if (consumed.has(key)) continue;
      const cl = day.clusters[k];
      if (!cl.codes || cl.codes.length < 2) continue;
      let days = 1, curCodes = cl.codes, j = i;
      while (j + 1 < sorted.length) {
        const nxt = sorted[j + 1];
        const mIdx = nxt.clusters.findIndex((c2) => c2.codes && c2.codes.length >= 2 && jaccard(curCodes, c2.codes) >= 0.5);
        if (mIdx < 0) break;
        consumed.add(`${j + 1}-${mIdx}`);
        curCodes = nxt.clusters[mIdx].codes;
        days++; j++;
      }
      persistN++; persistDaysSum += days;
    }
  }

  return {
    horizons: Object.fromEntries(horizons.map((n) => [n, {
      n: perHorizon[n].n,
      avgExcess: perHorizon[n].n ? perHorizon[n].sumExcess / perHorizon[n].n : null,
    }])),
    persistence: { n: persistN, avgDays: persistN ? persistDaysSum / persistN : null },
  };
}

// HTML表示用の1行（§3 L-3の例に合わせる）。答えが出たクラスタがまだ無ければnull。
function clusterEvalSummaryLine(evalResult) {
  const h10 = evalResult.horizons[10];
  if (!h10 || !h10.n) return null;
  const pers = evalResult.persistence;
  const excess = h10.avgExcess;
  const persTxt = pers.n ? `${pers.avgDays.toFixed(1)}日` : "—";
  return `クラスタのその後: n=${h10.n} / 10日後対市場${excess >= 0 ? "+" : ""}${excess.toFixed(1)}% / 平均持続${persTxt}（蓄積中・参考値）`;
}

export { loadClusterHistory, saveClusterHistory, recordClusterHistory, loadReturnIndex, evaluateClusterHistory, clusterEvalSummaryLine };

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("cluster_eval.mjs")) {
  const history = loadClusterHistory();
  console.log(`記録日数: ${history.length}`);
  if (history.length) {
    const result = evaluateClusterHistory(history);
    console.log(JSON.stringify(result, null, 2));
    const line = clusterEvalSummaryLine(result);
    console.log(line || "（答えが出たクラスタはまだありません）");
  }
}
