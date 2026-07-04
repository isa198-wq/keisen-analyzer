// 複合条件（コンボ）の定義 — combo_check.mjs（検証）と screen_daily.mjs（⭐表示）が共有する。
// 判定材料は analyze() の戻り値と当日のレジームのみ（未来は見ない。レジームは当日終値までで決定的）。
// ここは「手で列挙した固定セット」。追加・変更は 設計_次期改良v2.md §4 の手順に従い、
// 理由をコミットメッセージに書くこと（自動探索・後出しの基準変更は過学習）。

// ファクター k が指定方向の s で出ているか
export const hasF = (a, k, sign) => (a.factors || []).some((f) => f.k === k && (sign > 0 ? f.s > 0 : f.s < 0));
// パターンが完成（ネックライン抜け済み）しているか
export const confirmedPat = (a, kind) => !!(a.pattern && a.pattern.kind === kind && a.pattern.broke);

// dir: +1=買い方向（上昇で勝ち） / -1=売り方向（下落で勝ち）
export const COMBOS = [
  { key: "strongBuy",      dir: +1, label: "強い買い(現行条件)",             test: (a) => a.vIdx === 4 },
  { key: "strongSell",     dir: -1, label: "強い売り(現行条件)",             test: (a) => a.vIdx === 0 },
  { key: "trendCross",     dir: +1, label: "トレンド上昇×クロス買い",        test: (a) => hasF(a, "トレンド", +1) && hasF(a, "クロス", +1) },
  { key: "trendCrossBear", dir: -1, label: "トレンド下降×クロス売り",        test: (a) => hasF(a, "トレンド", -1) && hasF(a, "クロス", -1) },
  { key: "trendCrossUp",   dir: +1, label: "トレンド×クロス買い×上昇レジーム", test: (a, regime) => regime === "up" && hasF(a, "トレンド", +1) && hasF(a, "クロス", +1) },
  { key: "invTrend",       dir: +1, label: "逆三尊完成×トレンド上昇",        test: (a) => confirmedPat(a, "inverse") && hasF(a, "トレンド", +1) },
  { key: "topTrendBear",   dir: -1, label: "三尊完成×トレンド下降",          test: (a) => confirmedPat(a, "top") && hasF(a, "トレンド", -1) },
  { key: "strongBuyDown",  dir: +1, label: "強い買い×下落レジーム(仮説検証用)", test: (a, regime) => regime === "down" && a.vIdx === 4 },
];
