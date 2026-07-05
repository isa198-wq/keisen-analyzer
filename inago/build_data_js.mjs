// screening_data.csv（縦持ち: 銘柄,日付,始値,高値,安値,終値,出来高）を
// イナゴ・トレード盤の data.js（window.INAGO_DATA）形式に変換する。
// 既に fetch_data.py (yfinance, auto_adjust=True) で取得済みの日経225・5年分を流用。
import fs from "node:fs";

const SRC = new URL("../screening_data.csv", import.meta.url);
const OUT = new URL("./data.js", import.meta.url);

const text = fs.readFileSync(SRC, "utf-8");
const lines = text.split(/\r?\n/).filter(Boolean); // CRLF対応（末尾列=出来高がNaN化するバグを防ぐ）
const header = lines[0].split(",");
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const stocks = {};
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(",");
  const label = cols[idx["銘柄"]];
  const [code, ...nameParts] = label.split(":");
  const name = nameParts.join(":") || code;
  const date = cols[idx["日付"]];
  const open = +cols[idx["始値"]], high = +cols[idx["高値"]], low = +cols[idx["安値"]], close = +cols[idx["終値"]], volume = +cols[idx["出来高"]];
  if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
  if (!stocks[code]) stocks[code] = { name, candles: [] };
  stocks[code].candles.push({ date, open, high, low, close, volume });
}

let asOf = null;
for (const code of Object.keys(stocks)) {
  stocks[code].candles.sort((a, b) => a.date.localeCompare(b.date));
  const last = stocks[code].candles[stocks[code].candles.length - 1];
  if (last && (!asOf || last.date > asOf)) asOf = last.date;
}

const payload = { asOf, updated: asOf, stocks };
const js = `window.INAGO_DATA=${JSON.stringify(payload)};\n`;
fs.writeFileSync(OUT, js, "utf-8");
console.log(`data.js 出力: ${Object.keys(stocks).length} 銘柄, asOf=${asOf}`);
