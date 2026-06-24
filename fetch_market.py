# -*- coding: utf-8 -*-
"""
主要指標（市況感の把握用）の日足を取得し、アプリが起動時に自動表示する
public/market_data.csv を出力します。

事前準備（初回のみ）:  python -m pip install yfinance
使い方:               python fetch_market.py  （または「データ取得.bat」）

指標を足し引きしたいときは下の INDICES を編集してください。
"""

import csv
import os
import sys

try:
    import yfinance as yf
except ImportError:
    print("yfinance が未インストールです。先に:  python -m pip install yfinance", file=sys.stderr)
    sys.exit(1)

# (Yahooティッカー, 表示名)
INDICES = [
    ("^DJI", "NYダウ"),
    ("^IXIC", "ナスダック"),
    ("^GSPC", "S&P500"),
    ("^N225", "日経225"),
    ("JPY=X", "ドル円"),
]

PERIOD = "6mo"          # 取得期間（スパークライン用）
OUT_DIR = "public"      # アプリが /market_data.csv で読めるように public へ
OUT_FILE = os.path.join(OUT_DIR, "market_data.csv")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    rows, ok, ng = [], 0, []
    for ticker, name in INDICES:
        print(f"取得中: {name} ({ticker})")
        try:
            df = yf.download(ticker, period=PERIOD, interval="1d",
                             auto_adjust=False, progress=False)
        except Exception as e:
            print(f"  ! {name}: 取得失敗 ({e})", file=sys.stderr)
            ng.append(name)
            continue
        if df is None or df.empty:
            print(f"  ! {name}: データなし", file=sys.stderr)
            ng.append(name)
            continue
        if hasattr(df.columns, "nlevels") and df.columns.nlevels > 1:
            df.columns = df.columns.get_level_values(0)
        n0 = len(rows)
        for ts, r in df.iterrows():
            o, h, l, c, v = r.get("Open"), r.get("High"), r.get("Low"), r.get("Close"), r.get("Volume")
            if c is None or any(x != x for x in (o, h, l, c)):  # None / NaN を除外
                continue
            rows.append([
                name, ts.strftime("%Y-%m-%d"),
                round(float(o), 2), round(float(h), 2),
                round(float(l), 2), round(float(c), 2),
                int(v) if (v is not None and v == v) else 0,
            ])
        if len(rows) > n0:
            ok += 1
        else:
            ng.append(name)

    if not rows:
        print("指標データを取得できませんでした。ネット接続を確認してください。", file=sys.stderr)
        sys.exit(1)

    # 出力（Excel等でロックされていたら別名で保存）
    out_file = OUT_FILE
    try:
        f = open(out_file, "w", newline="", encoding="utf-8")
    except PermissionError:
        import time
        out_file = os.path.join(OUT_DIR, f"market_data_{time.strftime('%H%M%S')}.csv")
        print(f"※ {OUT_FILE} が開かれているため {out_file} に保存します。", file=sys.stderr)
        f = open(out_file, "w", newline="", encoding="utf-8")
    with f:
        w = csv.writer(f)
        w.writerow(["銘柄", "日付", "始値", "高値", "安値", "終値", "出来高"])
        w.writerows(rows)

    print(f"完了: {out_file} に {ok} 指標 / {len(rows)} 行を書き出しました。")
    if ng:
        print(f"取得できなかった指標: {', '.join(ng)}")


if __name__ == "__main__":
    main()
