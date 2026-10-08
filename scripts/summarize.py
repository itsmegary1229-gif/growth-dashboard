#!/usr/bin/env python3
"""為 data/articles.json 中尚未摘要的文章產生繁體中文摘要與相關度評分（Claude API）。

只用標準函式庫。由 GitHub Actions 在抓取步驟之後執行（見 .github/workflows/fetch.yml），
API key 從環境變數 ANTHROPIC_API_KEY 讀取（GitHub Secrets），本機沒有 key 時用 --dry-run 測試：
    python3 scripts/summarize.py --dry-run [--limit N]
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from fetch_pubmed import TOPICS, iso_utc

# ============================================================
# 設定區：模型、參數、prompt 都在這裡
# ============================================================

MODEL = "claude-haiku-4-5"
MAX_TOKENS = 600
TEMPERATURE = 0
DEFAULT_LIMIT = 60      # 單次最多處理幾篇（--limit 覆蓋）
REQUEST_INTERVAL = 0.5  # 每次呼叫最少間隔秒數
RETRIES = 3             # 429／5xx／網路錯誤重試次數（指數退避）
RETRY_BASE = 2          # 第 n 次重試等 RETRY_BASE ** n 秒（有 retry-after 時取較大者）
SAVE_EVERY = 10         # 每成功幾篇先寫一次檔（Actions 逾時被砍時已完成的不會白做）

# 每個主題的中文名稱與範圍（寫進 system prompt）
TOPIC_SCOPES = {
    "contour": "正顎手術（Le Fort I、BSSO／sagittal split）、頦成形、下顎角／顴骨縮小等臉部輪廓手術",
    "wound": "糖尿病足、壓瘡、靜脈潰瘍等慢性傷口照護，清創、負壓傷口治療（NPWT）、植皮與傷口重建",
    "eye": "上下眼瞼整形、眼瞼下垂（blepharoptosis）矯正、眼周年輕化與重建",
    "nose": "美容與功能性鼻整形、鼻中膈鼻整形、鼻尖手術、鼻部重建",
    "rejuv": "臉頸部 facelift（deep plane、SMAS）、提眉、頸部拉提，以及注射、能量治療等非手術方式",
}

SYSTEM_PROMPT = f"""你是整形外科期刊的閱讀助理。讀者是台灣的整形外科醫師，臨床與研究並重，主要關注以下五個主題：
{chr(10).join(f"- {TOPICS[t]['name']}：{s}" for t, s in TOPIC_SCOPES.items())}

文章是用關鍵字從 PubMed 自動篩出來的，可能誤抓（例如乳房下垂 breast ptosis 被眼周的 ptosis 抓到、
乳房手術的 closed-incision NPWT 被 negative pressure wound 抓到）。請依文章實際內容判斷，不要因為命中主題就給高分。

請用繁體中文（台灣用語）回傳以下欄位：
- headline：一句話結論，≤ 40 字。講「這篇發現什麼」，不是「這篇研究了什麼」。
- points：3–4 條重點，每條 ≤ 60 字。優先放研究設計、樣本數、主要結果的數字、限制。
- relevance：1–5 整數，對這位讀者的相關度。
  5＝直接影響上述五個主題的臨床決策或手術技巧；
  4＝屬於五個主題、有實用價值，但影響較間接；
  3＝相關但偏背景或旁支（基礎研究、流行病學、其他部位的類似技術）；
  2＝只沾到邊；
  1＝基本無關（例如乳房手術的 ciNPWT 被 "negative pressure wound" 誤抓）。
- reason：一句話說明分數，≤ 30 字。

專有名詞保留英文原文（如 deep plane、Le Fort I、SMAS、NPWT），不要硬翻。
只依提供的內容撰寫，不要編造摘要裡沒有的數字。

只回傳一個 JSON 物件，不要 markdown 圍欄、不要任何其他文字，格式如下：
{{"headline": "…", "points": ["…", "…", "…"], "relevance": 4, "reason": "…"}}"""

USER_TEMPLATE = """期刊：{journal}（{journal_full}）
發表日期：{pub_date}
命中主題：{topics}（依關鍵字自動篩選，可能誤抓）
標題：{title}

{abstract_block}"""

NO_ABSTRACT_NOTE = ("摘要：（PubMed 沒有這篇的摘要，只能依標題判斷。headline 與 points 請保守，"
                    "不要推測具體數字；points 可以只寫 1–2 條，並在其中一條註明「無摘要，依標題判斷」。）")

# ============================================================

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "articles.json"

_last_request = 0.0


class FatalAPIError(Exception):
    """模型不存在、key 無效等，每篇都會一樣失敗的錯誤：停止本次執行。"""


class RetryableError(Exception):
    def __init__(self, msg, retry_after=0.0):
        super().__init__(msg)
        self.retry_after = retry_after


def needs_summary(a):
    s = a.get("summary_zh")
    if not s or "error" in s:
        return True
    # 摘要時 PubMed 還沒有 abstract、現在有了：重做一次
    return s.get("basis") == "title" and bool(a.get("abstract"))


def build_user_prompt(a):
    topics = "、".join(TOPICS[t]["name"] for t in a.get("topics", []) if t in TOPICS) or "（無）"
    abstract_block = f"摘要：\n{a['abstract']}" if a.get("abstract") else NO_ABSTRACT_NOTE
    return USER_TEMPLATE.format(
        journal=a.get("journal", ""),
        journal_full=a.get("journal_full", ""),
        pub_date=a.get("pub_date", ""),
        topics=topics,
        title=a.get("title", ""),
        abstract_block=abstract_block,
    )


def api_error_message(e):
    """從 HTTPError 取出 API 回傳的錯誤類型與訊息（不含任何 header，不會帶出 key）。"""
    try:
        err = json.loads(e.read()).get("error", {})
        return f"HTTP {e.code} {err.get('type', '')}: {err.get('message', '')}".strip()
    except Exception:
        return f"HTTP {e.code}"


def call_api(api_key, user_prompt):
    """呼叫一次 Messages API，回傳解析後的 JSON 回應。"""
    global _last_request
    wait = REQUEST_INTERVAL - (time.monotonic() - _last_request)
    if wait > 0:
        time.sleep(wait)
    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "temperature": TEMPERATURE,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_prompt}],
    }).encode()
    req = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "x-api-key": api_key,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
    })
    _last_request = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        msg = api_error_message(e)
        if e.code == 429 or e.code >= 500:
            try:
                retry_after = float(e.headers.get("retry-after") or 0)
            except ValueError:
                retry_after = 0.0
            raise RetryableError(msg, retry_after) from None
        # 400（參數錯誤）、401／403（key）、404（模型不存在）：每篇都會一樣失敗
        raise FatalAPIError(msg) from None
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise RetryableError(f"連線失敗：{e}") from None


def call_with_retry(api_key, user_prompt):
    for attempt in range(RETRIES + 1):
        try:
            return call_api(api_key, user_prompt)
        except RetryableError as e:
            if attempt == RETRIES:
                raise
            wait = max(RETRY_BASE ** (attempt + 1), e.retry_after)
            print(f"    ! {e}，{wait:.0f} 秒後重試 {attempt + 1}/{RETRIES}", file=sys.stderr)
            time.sleep(wait)


def strip_fences(text):
    text = re.sub(r"^\s*```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```\s*$", "", text)
    start, end = text.find("{"), text.rfind("}")
    return text[start:end + 1] if start != -1 and end > start else text


def parse_summary(text):
    """解析模型回傳的 JSON 並檢查欄位；不合格丟 ValueError。"""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = json.loads(strip_fences(text))  # 再失敗就讓 JSONDecodeError（ValueError 子類）往外丟
    if not isinstance(data, dict):
        raise ValueError("回傳的不是 JSON 物件")
    headline = data.get("headline")
    points = data.get("points")
    reason = data.get("reason")
    relevance = data.get("relevance")
    if isinstance(relevance, str) and relevance.strip().isdigit():
        relevance = int(relevance.strip())
    if not isinstance(headline, str) or not headline.strip():
        raise ValueError("缺少 headline")
    if not isinstance(points, list) or not points or \
            not all(isinstance(p, str) and p.strip() for p in points):
        raise ValueError("points 格式錯誤")
    if isinstance(relevance, bool) or not isinstance(relevance, int) or not 1 <= relevance <= 5:
        raise ValueError(f"relevance 不是 1–5 整數：{relevance!r}")
    if not isinstance(reason, str):
        raise ValueError("缺少 reason")
    return {
        "headline": headline.strip(),
        "points": [p.strip() for p in points],
        "relevance": relevance,
        "reason": reason.strip(),
    }


def save(payload):
    payload["generated_at"] = iso_utc(datetime.now(timezone.utc))
    DATA.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def dry_run(targets, total_pending):
    print(f"=== dry-run（不呼叫 API）===")
    print(f"模型 {MODEL}，max_tokens {MAX_TOKENS}，temperature {TEMPERATURE}")
    print(f"待摘要 {total_pending} 篇，本次會處理 {len(targets)} 篇"
          f"（其中無摘要、只給標題 {sum(1 for a in targets if not a.get('abstract'))} 篇）")
    print("\n--- system prompt ---")
    print(SYSTEM_PROMPT)
    if targets:
        print(f"\n--- user prompt（第 1 篇，PMID {targets[0]['pmid']}）---")
        print(build_user_prompt(targets[0]))
        no_abs = next((a for a in targets if not a.get("abstract")), None)
        if no_abs:
            print(f"\n--- user prompt（無摘要範例，PMID {no_abs['pmid']}）---")
            print(build_user_prompt(no_abs))
    print("\n--- 將處理的文章 ---")
    for a in targets:
        print(f"  {a['pmid']}  {a.get('journal', ''):7s} {a.get('title', '')[:80]}")


def main():
    parser = argparse.ArgumentParser(description="為 articles.json 產生中文摘要與相關度評分")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                        help=f"本次最多處理幾篇（預設 {DEFAULT_LIMIT}）")
    parser.add_argument("--dry-run", action="store_true",
                        help="不呼叫 API，只印出會送的 prompt 與將處理的篇數")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit 必須是正整數")

    payload = json.loads(DATA.read_text(encoding="utf-8"))
    pending = [a for a in payload.get("articles", []) if needs_summary(a)]
    targets = pending[:args.limit]  # 檔案已依 added_at 新到舊排序，先處理新的

    if args.dry_run:
        dry_run(targets, len(pending))
        return

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print("✗ 沒有設定 ANTHROPIC_API_KEY（本機測試請用 --dry-run）", file=sys.stderr)
        sys.exit(1)

    print(f"待摘要 {len(pending)} 篇，本次處理 {len(targets)} 篇（模型 {MODEL}）")
    ok = failed = unsaved = 0
    tokens_in = tokens_out = 0
    fatal = None
    processed = 0
    try:
        for i, a in enumerate(targets, 1):
            prompt = build_user_prompt(a)
            try:
                resp = call_with_retry(api_key, prompt)
            except FatalAPIError as e:
                fatal = e
                break
            except RetryableError as e:
                processed += 1
                failed += 1
                print(f"  [{i}/{len(targets)}] ✗ {a['pmid']} API 失敗：{e}", file=sys.stderr)
                a["summary_zh"] = {"error": f"API：{e}", "at": iso_utc(datetime.now(timezone.utc))}
                unsaved += 1
                continue
            processed += 1
            usage = resp.get("usage", {})
            tokens_in += usage.get("input_tokens", 0)
            tokens_out += usage.get("output_tokens", 0)
            text = "".join(b.get("text", "") for b in resp.get("content", [])
                           if b.get("type") == "text")
            now = iso_utc(datetime.now(timezone.utc))
            try:
                summary = parse_summary(text)
            except ValueError as e:
                failed += 1
                reason = f"解析失敗（stop_reason={resp.get('stop_reason')}）：{e}"
                print(f"  [{i}/{len(targets)}] ✗ {a['pmid']} {reason}", file=sys.stderr)
                a["summary_zh"] = {"error": reason, "at": now}
                unsaved += 1
                continue
            a["summary_zh"] = dict(summary, model=resp.get("model", MODEL), at=now,
                                   basis="abstract" if a.get("abstract") else "title")
            ok += 1
            unsaved += 1
            print(f"  [{i}/{len(targets)}] ✓ {a['pmid']} 相關 {summary['relevance']}/5  {summary['headline']}")
            if unsaved >= SAVE_EVERY:
                save(payload)
                unsaved = 0
    finally:
        if unsaved:
            save(payload)

    print()
    print(f"=== AI 摘要（{MODEL}）===")
    print(f"本次處理 {processed} 篇、成功 {ok} 篇、失敗 {failed} 篇"
          + (f"；剩 {len(pending) - ok} 篇待摘要" if len(pending) > ok else ""))
    print(f"tokens：input {tokens_in:,}、output {tokens_out:,}")
    if fatal:
        print(f"✗ API 錯誤，停止本次執行：{fatal}", file=sys.stderr)
        if "not_found" in str(fatal):
            print(f"  （模型 {MODEL} 可能不存在，請確認腳本頂端的 MODEL 設定）", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
