#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
grok_name.py ― 新テーマ検知で見つかった「点火クラスタ」を Grok(xAI) × X/Web で命名する。
検知→命名→watchlist昇格の「命名」を自動化する日次バッチ。

前提:
  - 環境変数 XAI_API_KEY に xAI APIキー
  - pip install openai   (xAIはOpenAI互換SDKで叩ける)

入力 clusters.json  … inago_daily.html の「全候補をJSONでコピー」で出力した配列
  [ { "members": [ {"code":"X001","name":"新規点火A"}, ... ] }, ... ]

出力 cluster_names.js  … window.INAGO_CLUSTER_NAMES = {...}
  キーは構成コードを昇順連結（例 "X001,X002,X003,X004"）。
  inago_daily.html と同じフォルダに置けば、各クラスタに命名結果が表示される。

実行: python grok_name.py  [clusters.json]
"""
import os, sys, json, time

try:
    from openai import OpenAI
except ImportError:
    sys.exit("pip install openai が必要です")

API_KEY = os.getenv("XAI_API_KEY")
if not API_KEY:
    sys.exit("環境変数 XAI_API_KEY が未設定です（PowerShell: setx XAI_API_KEY \"...\"）")

MODEL = "grok-4.3"  # xAI現行の推奨。docs.x.ai のモデルカタログで最新を確認
client = OpenAI(api_key=API_KEY, base_url="https://api.x.ai/v1")

PROMPT = """次の日本株が直近で同時に出来高急増・株価上昇（同時点火）しています：
{stocks}

これらに共通する『今』の物色テーマ（材料・カタリスト）を、X(旧Twitter)の直近投稿と最新ニュースから特定してください。
複数銘柄に共通する単一の駆動要因を重視し、無理に結びつけないこと。
出力は次のJSONのみ（前後に文章やコードフェンスを付けない）:
{{"name":"テーマ名(簡潔・日本語)","catalyst":"共通材料の説明(1-2文)","confidence":"高|中|低","core_tickers":["コード"],"sources":["URL"]}}
共通項が薄ければ confidence を「低」、name を「共通テーマ不明瞭」とすること。"""


def _extract_text(resp):
    # Responses API の出力テキストを頑健に取り出す
    t = getattr(resp, "output_text", None)
    if t:
        return t
    try:
        parts = []
        for item in resp.output:
            for cont in getattr(item, "content", []) or []:
                if getattr(cont, "text", None):
                    parts.append(cont.text)
        return "\n".join(parts)
    except Exception:
        return ""


def name_cluster(members):
    stocks = "、".join(f"{m['name']}({m['code']})" for m in members)
    try:
        resp = client.responses.create(
            model=MODEL,
            input=[{"role": "user", "content": PROMPT.format(stocks=stocks)}],
            tools=[{"type": "web_search"}],
            # X投稿を厚く拾わせたい場合は docs.x.ai/docs/guides/live-search を見て
            # X Search ツールを併記する（ツールslugは最新ドキュメントで確認）。
        )
        text = _extract_text(resp).strip()
    except Exception as e:
        return {"name": "命名失敗", "catalyst": str(e), "confidence": "低", "core_tickers": [], "sources": []}
    s, e = text.find("{"), text.rfind("}")
    if s >= 0 and e > s:
        try:
            return json.loads(text[s:e + 1])
        except Exception:
            pass
    return {"name": "解析失敗", "catalyst": text[:200], "confidence": "低", "core_tickers": [], "sources": []}


def key(members):
    return ",".join(sorted(m["code"] for m in members))


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "clusters.json"
    if not os.path.exists(path):
        sys.exit(f"{path} が見つかりません（HTMLの『全候補をJSONでコピー』で作成）")
    clusters = json.load(open(path, encoding="utf-8"))
    out = {}
    for i, c in enumerate(clusters):
        members = c["members"] if isinstance(c, dict) else c
        k = key(members)
        print(f"[{i+1}/{len(clusters)}] {k} を命名中…", flush=True)
        out[k] = name_cluster(members)
        print("   →", out[k].get("name"), "／確度", out[k].get("confidence"), flush=True)
        time.sleep(1)  # レート配慮
    with open("cluster_names.js", "w", encoding="utf-8") as f:
        f.write("window.INAGO_CLUSTER_NAMES = " + json.dumps(out, ensure_ascii=False, indent=2) + ";\n")
    print("\ncluster_names.js を書き出しました。inago_daily.html と同じフォルダに置いてください。")


if __name__ == "__main__":
    main()
