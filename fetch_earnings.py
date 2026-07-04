# -*- coding: utf-8 -*-
"""
決算日の取得（フェーズ6: 決算接近の警告用）。

signals/earnings_dates.json（{"7203": "YYYY-MM-DD", ...}）を読み、
「日付が過去 or 未登録」の銘柄だけ yfinance の get_earnings_dates で更新します。
- 1回の実行で最大40銘柄・呼び出し間0.2秒スリープ（レート制限対策。初回は約6日で全銘柄が埋まる）
- 失敗した銘柄は既存値を維持（グレースフル）
- yfinance の決算APIは品質が不安定なため、この日付は「警告表示」にのみ使い判定には使わない

使い方:  python fetch_earnings.py   （CIでは データ取得 の後に実行）
"""

import json
import os
import sys
import time
from datetime import date

try:
    import yfinance as yf
except ImportError:
    print("yfinance が未インストールです。先に:  python -m pip install yfinance", file=sys.stderr)
    sys.exit(1)

LIST_FILE = "nikkei225.txt"
OUT_FILE = os.path.join("signals", "earnings_dates.json")
MAX_PER_RUN = 40      # レート制限対策（初回は数日かけて全銘柄が埋まる）
SLEEP_SEC = 0.2


def load_codes():
    codes = []
    if os.path.exists(LIST_FILE):
        with open(LIST_FILE, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                codes.append(s.split(",", 1)[0].strip())
    return codes


def main():
    codes = load_codes()
    if not codes:
        print(f"{LIST_FILE} が見つからないため対象銘柄がありません。", file=sys.stderr)
        sys.exit(1)

    os.makedirs("signals", exist_ok=True)
    dates = {}
    if os.path.exists(OUT_FILE):
        try:
            with open(OUT_FILE, encoding="utf-8") as f:
                dates = json.load(f)
        except Exception as e:
            print(f"既存 {OUT_FILE} を読めません（作り直します）: {e}", file=sys.stderr)

    today = date.today().isoformat()
    # 「未登録 or 日付が過去」だけを更新対象にする（未来日はそのまま使う）
    targets = [c for c in codes if not dates.get(c) or dates[c] < today][:MAX_PER_RUN]
    print(f"対象 {len(codes)} 銘柄中、今回更新するのは {len(targets)} 銘柄（最大{MAX_PER_RUN}）")

    ok, ng = 0, 0
    for i, code in enumerate(targets, 1):
        try:
            df = yf.Ticker(f"{code}.T").get_earnings_dates(limit=8)
            new_date = None
            if df is not None and len(df) > 0:
                ds = sorted(ts.date().isoformat() for ts in df.index)
                future = [d for d in ds if d >= today]
                new_date = future[0] if future else ds[-1]   # 未来があれば直近未来、無ければ最新の過去
            if new_date:
                dates[code] = new_date
                ok += 1
            else:
                ng += 1                                       # データなし: 既存値を維持
        except Exception:
            ng += 1                                           # 失敗: 既存値を維持
        if i % 10 == 0:
            print(f"  {i}/{len(targets)} ...")
        time.sleep(SLEEP_SEC)

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(dates, f, ensure_ascii=False, indent=0, sort_keys=True)

    filled = sum(1 for c in codes if dates.get(c))
    print(f"完了: 更新 {ok} / 失敗・データなし {ng} ／ 登録済み {filled}/{len(codes)} 銘柄 → {OUT_FILE}")


if __name__ == "__main__":
    main()
