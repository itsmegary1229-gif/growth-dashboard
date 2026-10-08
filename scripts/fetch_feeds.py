#!/usr/bin/env python3
"""抓取 config/feeds.json 裡各 RSS／Atom feed 的文章，合併寫入 data/feeds.json。

只用標準函式庫。由 GitHub Actions 每天在 PubMed、YouTube 抓取之後執行
（見 .github/workflows/fetch.yml），也可在本機手動執行：python3 scripts/fetch_feeds.py

feeds.json 每項 {"name": 顯示名稱, "url": feed 網址, "category": 分類（選填）}。
支援 RSS 2.0、RSS 1.0（RDF）與 Atom。單一 feed 失敗（逾時、HTTP 錯誤、XML 格式錯）只印警告、保留它的既有文章。
"""

import hashlib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

# ============================================================
# 設定區
# ============================================================

RETENTION_DAYS = 90      # feeds.json 滾動保留天數（依 added_at）；發表日早於這個天數的文章也不收
SUMMARY_CHARS = 500      # summary 保留前幾個字
MAX_PER_FEED = 50        # 每個 feed 最多取幾篇（有些 feed 一次給整個存檔）
TIMEOUT = 20             # 單次請求逾時秒數
RETRIES = 1              # 失敗後重試次數
RETRY_WAIT = 3           # 重試前等幾秒

# ============================================================

ROOT = Path(__file__).resolve().parent.parent
FEEDS = ROOT / "config" / "feeds.json"
OUTPUT = ROOT / "data" / "feeds.json"

HEADERS = {
    # 有些站擋預設的 Python-urllib UA
    "User-Agent": "Mozilla/5.0 (compatible; growth-dashboard feed fetcher; "
                  "+https://github.com/itsmegary1229-gif/growth-dashboard)",
    "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
}


class FetchError(Exception):
    pass


def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < RETRIES:
                print(f"    ! 請求失敗（{e}），{RETRY_WAIT} 秒後重試", file=sys.stderr)
                time.sleep(RETRY_WAIT)
            else:
                raise FetchError(str(e)) from e


# ---------- 文字處理 ----------

class _TextExtractor(HTMLParser):
    BLOCK = {"p", "br", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def strip_html(s):
    """HTML → 純文字：去標籤、解 entity、空白壓成一格。"""
    if not s:
        return ""
    p = _TextExtractor()
    try:
        p.feed(s)
        p.close()
        text = "".join(p.parts)
    except Exception:  # 壞掉的 HTML 退回粗略的 regex
        text = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", " ", text).strip()


def truncate(s, n):
    return s if len(s) <= n else s[:n].rstrip() + "…"


# ---------- XML ----------

def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def ns(tag):
    return tag[1:].split("}", 1)[0] if isinstance(tag, str) and tag.startswith("{") else ""


def child(el, name, namespace=None):
    """第一個 local name 相符的子元素；namespace 給了就要相符。"""
    for c in el:
        if local(c.tag) == name and (namespace is None or ns(c.tag) == namespace):
            return c
    return None


def inner(el):
    """元素內容：純文字，或 Atom type="xhtml" 的子元素序列化。"""
    if el is None:
        return ""
    if len(el):
        return (el.text or "") + "".join(ET.tostring(c, encoding="unicode") for c in el)
    return el.text or ""


def text(el, *names):
    """依序找 names 裡第一個有內容的子元素（"content:encoded" 這種寫法限定命名空間）。
    同名元素會逐一看過，例如 RSS item 裡沒有文字的 atom:link 不會擋住真正的 <link>。"""
    for name in names:
        want_ns = None
        if ":" in name:
            prefix, name = name.split(":", 1)
            want_ns = NAMESPACES[prefix]
        for c in el:
            if local(c.tag) == name and (want_ns is None or ns(c.tag) == want_ns):
                value = inner(c).strip()
                if value:
                    return value
    return ""


NAMESPACES = {
    "content": "http://purl.org/rss/1.0/modules/content/",
    "dc": "http://purl.org/dc/elements/1.1/",
}


# ---------- 日期 ----------

def iso_utc(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def parse_date(s):
    """RFC 822（RSS）或 ISO 8601（Atom、dc:date）→ aware datetime；解析失敗回傳 None。"""
    s = (s or "").strip()
    if not s:
        return None
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError, IndexError):
        try:
            dt = parse_iso(s)
        except ValueError:
            return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ---------- 解析 ----------

def atom_link(entry):
    """rel="alternate"（或沒有 rel）的 href，沒有就取第一個 link。"""
    links = [c for c in entry if local(c.tag) == "link" and c.get("href")]
    for link in links:
        if (link.get("rel") or "alternate") == "alternate":
            return link.get("href").strip()
    return links[0].get("href").strip() if links else ""


def parse_entries(root):
    """回傳 [(id, title, link, published_str, summary_html)]。"""
    kind = local(root.tag)
    out = []
    if kind == "feed":  # Atom
        for e in root:
            if local(e.tag) != "entry":
                continue
            link = atom_link(e)
            out.append((
                text(e, "id") or link,
                text(e, "title"),
                link,
                text(e, "published", "updated"),
                text(e, "summary", "content"),
            ))
    elif kind in ("rss", "RDF"):  # RSS 2.0／RSS 1.0
        container = child(root, "channel") if kind == "rss" else root
        if container is None:
            raise ValueError("找不到 <channel>")
        for it in container:
            if local(it.tag) != "item":
                continue
            link = text(it, "link")
            guid = text(it, "guid")
            if not link and guid.startswith(("http://", "https://")):
                link = guid
            out.append((
                guid or link,
                text(it, "title"),
                link,
                text(it, "pubDate", "dc:date", "date"),
                text(it, "description", "content:encoded", "summary"),
            ))
    else:
        raise ValueError(f"不認得的 feed 格式 <{kind}>")
    return out


def parse_feed(xml_bytes, cfg, now, cutoff):
    root = ET.fromstring(xml_bytes.lstrip())
    items = []
    for item_id, title, link, published, summary in parse_entries(root):
        if not item_id:
            continue
        dt = parse_date(published)
        if dt and dt < cutoff:
            continue
        items.append({
            "id": item_id,
            "key": hashlib.sha1(item_id.encode("utf-8")).hexdigest(),
            "title": strip_html(title),
            "link": link,
            "published": iso_utc(dt or now),
            "summary": truncate(strip_html(summary), SUMMARY_CHARS),
            "feed_name": cfg["name"],
            "category": cfg["category"],
        })
        if len(items) >= MAX_PER_FEED:
            break
    return items


def load_feeds():
    if not FEEDS.exists():
        return []
    data = json.loads(FEEDS.read_text(encoding="utf-8") or "[]")
    if not isinstance(data, list):
        raise SystemExit("✗ config/feeds.json 必須是陣列")
    feeds = []
    for f in data:
        url = str((f or {}).get("url") or "").strip()
        if not url:
            print(f"  ! 略過沒有 url 的設定：{f}", file=sys.stderr)
            continue
        feeds.append({
            "name": str(f.get("name") or url).strip(),
            "url": url,
            "category": str(f.get("category") or "").strip(),
        })
    return feeds


def main():
    feeds = load_feeds()
    if not feeds:
        print("未設定 feed（config/feeds.json 為空），略過文章抓取")
        return

    now = datetime.now(timezone.utc).replace(microsecond=0)
    now_str = iso_utc(now)
    cutoff = now - timedelta(days=RETENTION_DAYS)

    # 1. 抓各 feed
    fetched = {}      # id -> item
    per_feed = []     # (name, items or None)
    failed = 0
    for cfg in feeds:
        try:
            items = parse_feed(get(cfg["url"]), cfg, now, cutoff)
        except (FetchError, ET.ParseError, ValueError) as e:
            print(f"  ! {cfg['name']}：抓取失敗（{e}），保留既有文章", file=sys.stderr)
            per_feed.append((cfg["name"], None))
            failed += 1
            continue
        for it in items:
            fetched[it["id"]] = it
        per_feed.append((cfg["name"], items))

    # 2. 與既有檔案合併：保留原 added_at，其餘欄位以新抓的為準
    old_items = []
    if OUTPUT.exists():
        old_items = json.loads(OUTPUT.read_text(encoding="utf-8")).get("items", [])
    existing = {it["id"]: it for it in old_items}
    merged = dict(existing)
    new_ids = set()
    for item_id, it in fetched.items():
        old = existing.get(item_id)
        merged[item_id] = dict(it, added_at=old["added_at"] if old else now_str)
        if not old:
            new_ids.add(item_id)

    # 3. 滾動保留 90 天、依 added_at 新到舊（同時間再依 published）
    items = [it for it in merged.values() if parse_iso(it["added_at"]) >= cutoff]
    items.sort(key=lambda it: (it["added_at"], it["published"], it["key"]), reverse=True)

    # 4. 內容有變才寫檔
    written = items != old_items
    if written:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        payload = {"generated_at": now_str, "items": items}
        OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 5. 摘要
    print()
    print(f"=== RSS 抓取摘要（{now_str}）===")
    print("各 feed（本次抓到 / 其中新增）：")
    for name, got in per_feed:
        if got is None:
            print(f"  {name}：失敗")
        else:
            print(f"  {name}：{len(got)} / {sum(1 for it in got if it['id'] in new_ids)}")
    print(f"本次抓到 {len(fetched)} 篇，新增 {len(new_ids)} 篇；"
          f"超過 {RETENTION_DAYS} 天移除 {len(merged) - len(items)} 篇")
    print(f"feeds.json 總共保留 {len(items)} 篇（{'已更新' if written else '無變更，未寫檔'}）")

    # 全部 feed 都失敗才算失敗（workflow 這步 continue-on-error，不擋 commit）
    if failed == len(feeds):
        sys.exit(1)


if __name__ == "__main__":
    main()
