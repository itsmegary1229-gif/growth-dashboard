#!/usr/bin/env python3
"""每日從 PubMed 抓取指定期刊 × 主題的新文章，合併寫入 data/articles.json。

只用標準函式庫。由 GitHub Actions 每天執行（見 .github/workflows/fetch.yml），
也可在本機手動執行：python3 scripts/fetch_pubmed.py
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ============================================================
# 設定區：要調整期刊、主題、關鍵字，改這裡就好
# ============================================================

TOOL = "growth-dashboard"
EMAIL = "your-email@example.com"  # TODO: 換成真實 email（NCBI 用來聯絡濫用情況）

RELDATE_DAYS = 7       # 每次往回抓幾天（依進入 PubMed 的日期 edat）
RETENTION_DAYS = 90    # articles.json 滾動保留天數（依 added_at）
EFETCH_BATCH = 200     # efetch 每批最多幾筆
REQUEST_INTERVAL = 0.4  # 每次請求最少間隔秒數（NCBI 無 key 上限 3 次/秒）
RETRIES = 3            # 失敗後重試次數
RETRY_WAIT = 2         # 重試間隔秒數

# 簡稱 → PubMed 期刊名稱（[ta] 欄位，等同 MedlineTA）
# 注意：APS 是 Aesthetic Plastic Surgery，不是 Archives of Plastic Surgery
JOURNALS = {
    "PRS": "Plast Reconstr Surg",
    "PRS-GO": "Plast Reconstr Surg Glob Open",
    "ASJ": "Aesthet Surg J",
    "APS": "Aesthetic Plast Surg",
    "IJOMS": "Int J Oral Maxillofac Surg",
}

# 主題 id → 分頁名稱與關鍵字（關鍵字以 [tiab] 搜尋、OR 串接；多字詞會自動加引號）
TOPICS = {
    "contour": {
        "name": "輪廓與正顎",
        "keywords": [
            "orthognathic", "Le Fort", "sagittal split", "genioplasty",
            "facial contouring", "mandibular angle", "zygoma reduction",
            "malarplasty", "jaw surgery",
        ],
    },
    "wound": {
        "name": "慢性傷口",
        "keywords": [
            "chronic wound", "diabetic foot", "pressure ulcer", "pressure injury",
            "venous ulcer", "negative pressure wound", "debridement",
            "skin graft", "wound reconstruction",
        ],
    },
    "eye": {
        "name": "眼周",
        "keywords": [
            "blepharoplasty", "upper eyelid", "lower eyelid", "ptosis",
            "eyelid surgery", "periorbital",
        ],
    },
    "nose": {
        "name": "鼻整形",
        "keywords": [
            "rhinoplasty", "septorhinoplasty", "nasal reconstruction", "nasal tip",
        ],
    },
    "rejuv": {
        "name": "年輕化",
        "keywords": [
            "facelift", "rhytidectomy", "facial rejuvenation", "brow lift",
            "neck lift", "SMAS", "deep plane",
        ],
    },
}

# ============================================================

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "articles.json"

MONTHS = {
    m: i for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun",
         "jul", "aug", "sep", "oct", "nov", "dec"], start=1)
}
TA_TO_ABBR = {v.lower(): k for k, v in JOURNALS.items()}

_last_request = 0.0


def request(endpoint, params):
    """呼叫 E-utilities（POST），自動限速與重試；重試用盡則結束程式（exit 1）。"""
    global _last_request
    params = dict(params, tool=TOOL, email=EMAIL)
    data = urllib.parse.urlencode(params).encode()
    url = f"{EUTILS}/{endpoint}"
    for attempt in range(RETRIES + 1):
        wait = REQUEST_INTERVAL - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        try:
            _last_request = time.monotonic()
            with urllib.request.urlopen(url, data=data, timeout=60) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < RETRIES:
                print(f"  ! {endpoint} 失敗（{e}），{RETRY_WAIT} 秒後重試 "
                      f"{attempt + 1}/{RETRIES}", file=sys.stderr)
                time.sleep(RETRY_WAIT)
            else:
                print(f"✗ {endpoint} 連續失敗 {RETRIES + 1} 次，中止：{e}",
                      file=sys.stderr)
                sys.exit(1)


def term(word, field):
    return f'"{word}"[{field}]' if " " in word else f"{word}[{field}]"


def build_query(keywords):
    journals = " OR ".join(f'"{name}"[ta]' for name in JOURNALS.values())
    topic = " OR ".join(term(k, "tiab") for k in keywords)
    return f"({journals}) AND ({topic})"


def esearch(query):
    raw = request("esearch.fcgi", {
        "db": "pubmed",
        "term": query,
        "datetype": "edat",
        "reldate": RELDATE_DAYS,
        "retmax": 10000,
        "retmode": "json",
    })
    result = json.loads(raw)["esearchresult"]
    if "ERROR" in result:
        print(f"✗ esearch 錯誤：{result['ERROR']}", file=sys.stderr)
        sys.exit(1)
    return result.get("idlist", [])


def text_of(el):
    """取元素內全部文字（含 <i>、<sup> 等行內標籤），並壓縮空白。"""
    if el is None:
        return ""
    return " ".join("".join(el.itertext()).split())


def parse_date(el):
    """從 PubDate / ArticleDate 元素組出 YYYY-MM-DD，缺月日補 01。"""
    if el is None:
        return ""
    year = el.findtext("Year")
    month = el.findtext("Month") or ""
    day = el.findtext("Day") or ""
    if not year:
        # 例如 <MedlineDate>2026 Sep-Oct</MedlineDate>
        parts = (el.findtext("MedlineDate") or "").split()
        if not parts or not parts[0][:4].isdigit():
            return ""
        year = parts[0][:4]
        month = parts[1].split("-")[0] if len(parts) > 1 else ""
    if month.isdigit():
        m = int(month)
    else:
        m = MONTHS.get(month[:3].lower(), 1)
    d = int(day) if day.isdigit() else 1
    return f"{int(year):04d}-{m:02d}-{d:02d}"


def parse_article(node):
    citation = node.find("MedlineCitation")
    article = citation.find("Article")
    pmid = citation.findtext("PMID")

    ta = citation.findtext("MedlineJournalInfo/MedlineTA") or ""
    abbr = TA_TO_ABBR.get(ta.lower())
    if abbr is None:
        iso = (article.findtext("Journal/ISOAbbreviation") or "").replace(".", "")
        abbr = TA_TO_ABBR.get(iso.lower(), ta or iso)

    # 優先用線上發表日（ArticleDate），沒有才用期刊卷期日（PubDate）
    pub_date = parse_date(article.find("ArticleDate")) or \
        parse_date(article.find("Journal/JournalIssue/PubDate"))

    paragraphs = []
    for at in article.findall("Abstract/AbstractText"):
        txt = text_of(at)
        if not txt:
            continue
        label = at.get("Label")
        paragraphs.append(f"{label}: {txt}" if label else txt)

    doi = ""
    for aid in node.findall("PubmedData/ArticleIdList/ArticleId"):
        if aid.get("IdType") == "doi":
            doi = (aid.text or "").strip()
            break
    if not doi:
        for loc in article.findall("ELocationID"):
            if loc.get("EIdType") == "doi":
                doi = (loc.text or "").strip()
                break

    return {
        "pmid": pmid,
        "title": text_of(article.find("ArticleTitle")),
        "journal": abbr,
        "journal_full": text_of(article.find("Journal/Title")),
        "pub_date": pub_date,
        "abstract": "\n\n".join(paragraphs),
        "doi": doi,
    }


def efetch(pmids):
    results = {}
    for i in range(0, len(pmids), EFETCH_BATCH):
        batch = pmids[i:i + EFETCH_BATCH]
        raw = request("efetch.fcgi", {
            "db": "pubmed",
            "id": ",".join(batch),
            "rettype": "xml",
            "retmode": "xml",
        })
        root = ET.fromstring(raw)
        for node in root.findall("PubmedArticle"):
            art = parse_article(node)
            results[art["pmid"]] = art
    return results


def iso_utc(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def main():
    now = datetime.now(timezone.utc)
    now_str = iso_utc(now)

    # 1. 各主題 esearch，記錄每篇命中哪些主題
    hits = {}  # pmid -> [topic ids]
    for tid, cfg in TOPICS.items():
        ids = esearch(build_query(cfg["keywords"]))
        print(f"  esearch {tid:8s} {len(ids):4d} 篇")
        for pmid in ids:
            hits.setdefault(pmid, []).append(tid)

    # 2. 聯集後批次 efetch
    fetched = efetch(sorted(hits, key=int)) if hits else {}
    missing = set(hits) - set(fetched)
    if missing:
        print(f"  ! efetch 未回傳 {len(missing)} 篇：{', '.join(sorted(missing))}",
              file=sys.stderr)

    # 3. 與既有檔案合併
    existing = {}
    old_articles = []
    if OUTPUT.exists():
        old_articles = json.loads(OUTPUT.read_text(encoding="utf-8")).get("articles", [])
        existing = {a["pmid"]: a for a in old_articles}

    merged = dict(existing)
    new_pmids = []
    for pmid, art in fetched.items():
        old = existing.get(pmid)
        topics = [t for t in TOPICS if t in hits[pmid]
                  or (old and t in old.get("topics", []))]
        merged[pmid] = dict(
            art,
            topics=topics,
            url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            added_at=old["added_at"] if old else now_str,
        )
        if not old:
            new_pmids.append(pmid)

    # 4. 滾動保留 90 天、依 added_at 新到舊排序（同時間再依 pub_date）
    cutoff = now - timedelta(days=RETENTION_DAYS)
    articles = [a for a in merged.values() if parse_iso(a["added_at"]) >= cutoff]
    articles.sort(key=lambda a: (a["added_at"], a["pub_date"], int(a["pmid"])),
                  reverse=True)

    # 5. 文章內容有變才寫檔（避免每天只因 generated_at 不同而產生 commit）
    if articles != old_articles:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        payload = {"generated_at": now_str, "articles": articles}
        OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
        written = True
    else:
        written = False

    # 6. 摘要
    removed = len(merged) - len(articles)
    print()
    print(f"=== PubMed 抓取摘要（{now_str}，近 {RELDATE_DAYS} 天）===")
    print(f"本次抓到 {len(fetched)} 篇，其中新增 {len(new_pmids)} 篇；"
          f"超過 {RETENTION_DAYS} 天移除 {removed} 篇")
    print("各主題（本次抓到 / 其中新增）：")
    for tid, cfg in TOPICS.items():
        n = sum(1 for p in fetched if tid in hits[p])
        n_new = sum(1 for p in new_pmids if tid in hits[p])
        print(f"  {tid:8s} {cfg['name']:<6s} {n:4d} / {n_new}")
    print("各期刊（本次抓到 / 其中新增）：")
    for abbr in JOURNALS:
        n = sum(1 for a in fetched.values() if a["journal"] == abbr)
        n_new = sum(1 for p in new_pmids if fetched[p]["journal"] == abbr)
        print(f"  {abbr:8s} {n:4d} / {n_new}")
    others = {a["journal"] for a in fetched.values()} - set(JOURNALS)
    if others:
        print(f"  ! 有無法對應簡稱的期刊：{', '.join(sorted(others))}")
    print(f"articles.json 總共保留 {len(articles)} 篇"
          f"（{'已更新' if written else '無變更，未寫檔'}）")


if __name__ == "__main__":
    main()
