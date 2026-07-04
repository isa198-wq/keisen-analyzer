// 退出規則（逃げ時）の定義 — exit_check.mjs（検証）と screen_daily.mjs（フェーズF・警告表示）が共有する。
// 判定材料は当日までの集計値のみ（未来は見ない）。ヒステリシス（退出条件≠復帰条件）でバタつきを抑える。
// ここは「手で列挙した固定セット」。追加・変更は 設計_次期改良v3.md §3(E-2) の手順に従い、
// 理由をコミットメッセージに書くこと（グリッド探索・後出しの基準変更は過学習）。

// ref: true の規則は参考計測のみ（採否判定の対象外。データ期間が短い等の理由）
export const RULES = [
  {
    key: "regimeDown", label: "レジームdown（等ウェイト指数 vs SMA25）", ref: false,
    ready: (m) => m.regime != null,
    exitTest: (m) => m.regime === "down",
    resumeTest: (m) => m.regime === "up",
  },
  {
    key: "maBreak3", label: "SMA25を3日連続で割れ", ref: false,
    ready: (m) => m.belowRun != null,
    exitTest: (m) => m.belowRun >= 3,
    resumeTest: (m) => m.aboveRun >= 3,
  },
  {
    key: "breadth50", label: "トレンド下向き銘柄が過半数", ref: false,
    ready: (m) => m.breadthDownPct != null,
    exitTest: (m) => m.breadthDownPct >= 0.5,
    resumeTest: (m) => m.breadthDownPct <= 0.35,
  },
  {
    key: "newLows10", label: "60日新安値銘柄が1割超（5日平均）", ref: false,
    ready: (m) => m.newLowPct5d != null,
    exitTest: (m) => m.newLowPct5d >= 0.10,
    resumeTest: (m) => m.newLowPct5d <= 0.03,
  },
  {
    key: "ddStop5", label: "250日高値から5%下落", ref: false,
    ready: (m) => m.ddPct != null,
    exitTest: (m) => m.ddPct >= 5,
    resumeTest: (m) => m.ddPct <= 2,
  },
  {
    key: "vixRef", label: "VIX>=25（参考・採否対象外）", ref: true,
    ready: (m) => m.vix != null,
    exitTest: (m) => m.vix >= 25,
    resumeTest: (m) => m.vix < 20,
  },
];

// metrics（日付昇順の集計値配列）を規則に沿って状態遷移させる。
// 開始状態は "in"（市場に乗っている）。未整備日（ready=false）は前の状態を維持する。
// 戻り値: metrics と同じ長さの配列。値は "in" | "out"。
export function simulateStates(rule, metrics) {
  let state = "in";
  const out = [];
  for (const m of metrics) {
    if (rule.ready(m)) {
      if (state === "in") { if (rule.exitTest(m)) state = "out"; }
      else if (rule.resumeTest(m)) state = "in";
    }
    out.push(state);
  }
  return out;
}
