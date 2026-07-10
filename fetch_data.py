# -*- coding: utf-8 -*-
"""
Yahoo Finance(yfinance) から複数銘柄の日足を取得し、keisen-analyzer が
そのまま読める縦持ちCSV（銘柄, 日付, 始値, 高値, 安値, 終値, 出来高）を
1枚にまとめて出力します。

事前準備（初回のみ）:
    python -m pip install yfinance

使い方:
    1. 取得したい銘柄を決める
       - 同じフォルダの  nikkei225.txt（日経225）と nasdaq100.txt（ナスダック100）
         があれば、その銘柄を自動で取得します（1行1銘柄「コード,社名」）
       - どちらも無ければ、下の SYMBOLS の銘柄を取得します
    2. このフォルダで:  python fetch_data.py   （または「データ取得.bat」をダブルクリック）
    3. 出来た screening_data.csv を、アプリの「データ取込」で読み込む

銘柄を足し引きしたいとき:
    - nikkei225.txt / nasdaq100.txt をメモ帳で開き、コードを足す/消す（# で始まる行はコメント）
    - 数字で始まるコード（例 7203, 285A）は東証（.T）、英字のみ（例 AAPL）は米国株として扱います
"""

import csv
import os
import sys

try:
    import yfinance as yf
except ImportError:
    print("yfinance が未インストールです。先に:  python -m pip install yfinance", file=sys.stderr)
    sys.exit(1)

# 銘柄リストが1つも無いときに使う銘柄（日本株: コード.T / 米国株: ティッカー）
SYMBOLS = [
    "7203.T",  # トヨタ自動車
    "6758.T",  # ソニーグループ
    "9984.T",  # ソフトバンクG
]

LIST_FILES = ["nikkei225.txt", "nasdaq100.txt"]   # あれば優先して使う銘柄リスト（存在するものを全部読む）
PERIOD = "5y"                  # 取得期間（パターン完成イベントの統計を厚くするため5年。"1y","2y","max" なども可）
CHUNK = 40                     # 一度にまとめて取得する銘柄数
OUT_FILE = "screening_data.csv"


def to_ticker(code):
    """コード→Yahooティッカー。数字始まり（7203, 285A など）は東証（.T）、英字は米国株そのまま。"""
    if "." in code:
        return code                # 既にサフィックス付き（例 7203.T）はそのまま
    return code + ".T" if code[:1].isdigit() else code


def load_symbols():
    """nikkei225.txt / nasdaq100.txt があるものを全部読み、無ければ SYMBOLS を返す。"""
    out = []
    for list_file in LIST_FILES:
        if not os.path.exists(list_file):
            continue
        n0 = len(out)
        with open(list_file, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                parts = s.split(",", 1)             # "コード,社名"（社名は省略可）
                code = parts[0].strip()
                name = parts[1].strip() if len(parts) > 1 else ""
                label = f"{code}:{name}" if name else code      # 出力銘柄列は コード:社名
                out.append((to_ticker(code), label))
        print(f"{list_file} から {len(out) - n0} 銘柄を読み込みました。")
    if out:
        return out
    print(f"銘柄リスト（{' / '.join(LIST_FILES)}）が無いので SYMBOLS（{len(SYMBOLS)}銘柄）を使います。")
    return [(s, s.split(".")[0]) for s in SYMBOLS]


def rows_from_df(label, df):
    """1銘柄ぶんの DataFrame → [銘柄,日付,始値,高値,安値,終値,出来高] 行リスト。"""
    out = []
    for ts, row in df.iterrows():
        o, h, l, c, v = row.get("Open"), row.get("High"), row.get("Low"), row.get("Close"), row.get("Volume")
        if o is None or any(x != x for x in (o, h, l, c)):  # None / NaN を除外
            continue
        out.append([
            label, ts.strftime("%Y-%m-%d"),
            round(float(o), 2), round(float(h), 2),
            round(float(l), 2), round(float(c), 2),
            int(v) if v == v else 0,
        ])
    return out


def main():
    syms = load_symbols()
    rows_out = []
    ok, ng = 0, []

    # まとめて高速ダウンロード（CHUNK 銘柄ずつ）
    for i in range(0, len(syms), CHUNK):
        chunk = syms[i:i + CHUNK]                 # [(ticker, label), ...]
        tickers = [t for t, _ in chunk]
        print(f"取得中: {i + 1}〜{i + len(chunk)} / {len(syms)} 銘柄 ...")
        # auto_adjust=True: 株式分割・配当で調整済みの連続した価格にする。
        # （False だと分割日に価格が飛び、三尊検出やネックライン/目標が壊れる。
        #   例: 2026-06-18 に 5802/5801/8053/4452 が分割し未調整だと偽の暴落になる）
        data = yf.download(tickers, period=PERIOD, interval="1d",
                           auto_adjust=True, progress=False,
                           group_by="ticker", threads=True)
        for ticker, label in chunk:
            try:
                df = data[ticker] if len(tickers) > 1 else data
            except Exception:
                ng.append(label)
                continue
            df = df.dropna(how="all")
            rows = rows_from_df(label, df)
            if len(rows) >= 30:
                rows_out.extend(rows)
                ok += 1
            else:
                ng.append(label)

    if not rows_out:
        print("有効なデータを取得できませんでした。ネット接続や銘柄コードを確認してください。", file=sys.stderr)
        sys.exit(1)

    # 出力（Excel等で開いていてロックされていたら別名で保存）
    out_file = OUT_FILE
    try:
        f = open(out_file, "w", newline="", encoding="utf-8")
    except PermissionError:
        import time
        out_file = f"screening_data_{time.strftime('%H%M%S')}.csv"
        print(f"※ {OUT_FILE} が開かれているため、{out_file} に保存します（Excelを閉じれば次回は元の名前で保存できます）。")
        f = open(out_file, "w", newline="", encoding="utf-8")
    with f:
        w = csv.writer(f)
        w.writerow(["銘柄", "日付", "始値", "高値", "安値", "終値", "出来高"])
        w.writerows(rows_out)

    print(f"\n完了: {out_file} に {ok} 銘柄 / {len(rows_out)} 行を書き出しました。")
    if ng:
        print(f"取得できなかった銘柄（{len(ng)}件）: {', '.join(ng)}")
    print("→ アプリの「データ取込」→「CSVファイルを選択」で読み込んでください。")


if __name__ == "__main__":
    main()
