#!/usr/bin/env python3
"""從 YouTube 公開 RSS 抓取 config/channels.json 裡各頻道的最新影片，合併寫入 data/videos.json。

只用標準函式庫，不需要 API key。由 GitHub Actions 每天在 PubMed 抓取之後執行
（見 .github/workflows/fetch.yml），也可在本機手動執行：python3 scripts/fetch_videos.py

channels.json 每項 {"name": 顯示名稱, "channel": UC 開頭的 channel_id、@handle 或頻道網址}。
給 @handle／網址時，第一次會抓頻道頁解析出 channel_id 並回寫到該項的 "channel_id" 欄位，之後直接用；
改了 "channel" 要連同 "channel_id" 一起刪掉，才會重新解析。
"""

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ============================================================
# 設定區
# ============================================================

RETENTION_DAYS = 90     # videos.json 滾動保留天數（依 added_at）
DESCRIPTION_CHARS = 500  # description 保留前幾個字
REQUEST_INTERVAL = 0.5  # 每次請求最少間隔秒數
RETRIES = 8             # 失敗後重試次數（YouTube RSS 常間歇性回 404／500，單次成功率約 3 成，重試就會好）
RETRY_WAIT = 2          # 第 n 次重試前等 n × RETRY_WAIT 秒，最多 RETRY_WAIT_MAX 秒
RETRY_WAIT_MAX = 10

# ============================================================

ROOT = Path(__file__).resolve().parent.parent
CHANNELS = ROOT / "config" / "channels.json"
OUTPUT = ROOT / "data" / "videos.json"

FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={}"
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}
CHANNEL_ID_RE = re.compile(r"^UC[\w-]{22}$")
# 頻道頁 HTML 裡 channel_id 出現的位置，依可靠程度排序
PAGE_ID_PATTERNS = [
    re.compile(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})"'),
    re.compile(r'<meta itemprop="identifier" content="(UC[\w-]{22})"'),
    re.compile(r'"externalId":"(UC[\w-]{22})"'),
    re.compile(r'"browseId":"(UC[\w-]{22})"'),
]
HEADERS = {
    # YouTube 對預設的 Python-urllib UA 常回錯誤頁
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.8",
    # 跳過歐盟 IP 的 cookie 同意頁（consent.youtube.com）
    "Cookie": "CONSENT=YES+1; SOCS=CAI",
}

_last_request = 0.0


class FetchError(Exception):
    pass


def get(url):
    """GET 並回傳 bytes；自動限速與重試，重試用盡丟 FetchError（不中止整個腳本）。"""
    global _last_request
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(RETRIES + 1):
        wait = REQUEST_INTERVAL - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        try:
            _last_request = time.monotonic()
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < RETRIES:
                delay = min(RETRY_WAIT * (attempt + 1), RETRY_WAIT_MAX)
                print(f"    ! 請求失敗（{e}），{delay} 秒後重試 {attempt + 1}/{RETRIES}",
                      file=sys.stderr)
                time.sleep(delay)
            else:
                raise FetchError(f"{url}：{e}") from e


def channel_page_url(channel):
    """@handle、youtube.com/... 網址 → 頻道頁網址。"""
    if channel.startswith("@"):
        return f"https://www.youtube.com/{urllib.parse.quote(channel)}"
    if not re.match(r"^https?://", channel):
        channel = "https://" + channel
    return channel


def resolve_channel_id(channel):
    """從 channel 設定解析出 UC… channel_id；無法解析丟 FetchError。"""
    channel = channel.strip()
    if CHANNEL_ID_RE.match(channel):
        return channel
    m = re.search(r"/channel/(UC[\w-]{22})", channel)
    if m:
        return m.group(1)
    html = get(channel_page_url(channel)).decode("utf-8", "replace")
    for pattern in PAGE_ID_PATTERNS:
        m = pattern.search(html)
        if m:
            return m.group(1)
    raise FetchError(f"頻道頁找不到 channel_id：{channel}")


def text_of(el, path):
    found = el.find(path, NS)
    return (found.text or "").strip() if found is not None else ""


def parse_feed(xml_bytes, channel_id, channel_name):
    root = ET.fromstring(xml_bytes)
    videos = []
    for entry in root.findall("atom:entry", NS):
        video_id = text_of(entry, "yt:videoId")
        if not video_id:
            continue
        link = entry.find("atom:link[@rel='alternate']", NS)
        group = entry.find("media:group", NS)
        thumbnail = ""
        description = ""
        if group is not None:
            thumbs = group.findall("media:thumbnail", NS)
            if thumbs:
                best = max(thumbs, key=lambda t: int(t.get("width") or 0) * int(t.get("height") or 0))
                thumbnail = best.get("url", "")
            description = text_of(group, "media:description")[:DESCRIPTION_CHARS]
        videos.append({
            "video_id": video_id,
            "title": text_of(entry, "atom:title"),
            "channel_name": channel_name,
            "channel_id": channel_id,
            "published": to_iso_utc(text_of(entry, "atom:published")),
            "url": link.get("href") if link is not None and link.get("href")
            else f"https://www.youtube.com/watch?v={video_id}",
            "thumbnail": thumbnail,
            "description": description,
        })
    return videos


def iso_utc(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def to_iso_utc(s):
    """RSS 的 2026-10-07T12:00:00+00:00 → 2026-10-07T12:00:00Z；解析失敗原樣保留。"""
    try:
        return iso_utc(parse_iso(s).astimezone(timezone.utc))
    except ValueError:
        return s


def load_channels():
    if not CHANNELS.exists():
        return []
    data = json.loads(CHANNELS.read_text(encoding="utf-8") or "[]")
    if not isinstance(data, list):
        raise SystemExit("✗ config/channels.json 必須是陣列")
    return data


def main():
    channels = load_channels()
    if not channels:
        print("未設定頻道（config/channels.json 為空），略過影片抓取")
        return

    now = datetime.now(timezone.utc)
    now_str = iso_utc(now)

    # 1. 解析 channel_id（有快取就用），抓各頻道 RSS
    fetched = {}         # video_id -> video
    per_channel = []     # (name, 抓到幾支 or 錯誤訊息)
    channels_changed = False
    failed = 0
    for cfg in channels:
        name = str(cfg.get("name") or cfg.get("channel") or "").strip()
        channel = str(cfg.get("channel") or "").strip()
        try:
            # channel 本身就是 UC… 直接用；否則用快取，沒有快取才去抓頻道頁
            channel_id = channel if CHANNEL_ID_RE.match(channel) else str(cfg.get("channel_id") or "")
            if not CHANNEL_ID_RE.match(channel_id):
                if not channel:
                    raise FetchError("沒有填 channel")
                channel_id = resolve_channel_id(channel)
                if cfg.get("channel_id") != channel_id:
                    cfg["channel_id"] = channel_id
                    channels_changed = True
                    print(f"  解析 {name}：{channel} → {channel_id}")
            videos = parse_feed(get(FEED_URL.format(channel_id)), channel_id, name or channel_id)
        except (FetchError, ET.ParseError) as e:
            print(f"  ! {name or channel}：抓取失敗（{e}），保留既有影片", file=sys.stderr)
            per_channel.append((name or channel, None))
            failed += 1
            continue
        for v in videos:
            fetched[v["video_id"]] = v
        per_channel.append((name, len(videos)))

    if channels_changed:
        CHANNELS.write_text(json.dumps(channels, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 2. 與既有檔案合併：保留原 added_at，其餘欄位以新抓的為準
    old_videos = []
    if OUTPUT.exists():
        old_videos = json.loads(OUTPUT.read_text(encoding="utf-8")).get("videos", [])
    existing = {v["video_id"]: v for v in old_videos}
    merged = dict(existing)
    new_ids = []
    for vid, v in fetched.items():
        old = existing.get(vid)
        merged[vid] = dict(v, added_at=old["added_at"] if old else now_str)
        if not old:
            new_ids.append(vid)

    # 3. 滾動保留 90 天、依 added_at 新到舊（同時間再依 published）
    cutoff = now - timedelta(days=RETENTION_DAYS)
    videos = [v for v in merged.values() if parse_iso(v["added_at"]) >= cutoff]
    videos.sort(key=lambda v: (v["added_at"], v["published"], v["video_id"]), reverse=True)

    # 4. 內容有變才寫檔
    written = videos != old_videos
    if written:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        payload = {"generated_at": now_str, "videos": videos}
        OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 5. 摘要
    new_by_channel = {}
    for vid in new_ids:
        new_by_channel[fetched[vid]["channel_name"]] = new_by_channel.get(fetched[vid]["channel_name"], 0) + 1
    print()
    print(f"=== YouTube 抓取摘要（{now_str}）===")
    print("各頻道（本次抓到 / 其中新增）：")
    for name, n in per_channel:
        print(f"  {name}：" + ("失敗" if n is None else f"{n} / {new_by_channel.get(name, 0)}"))
    print(f"本次抓到 {len(fetched)} 支，新增 {len(new_ids)} 支；"
          f"超過 {RETENTION_DAYS} 天移除 {len(merged) - len(videos)} 支")
    print(f"videos.json 總共保留 {len(videos)} 支（{'已更新' if written else '無變更，未寫檔'}）")
    if channels_changed:
        print("channels.json 已回寫 channel_id")

    # 全部頻道都失敗才算失敗（workflow 這步 continue-on-error，不擋 commit）
    if failed == len(channels):
        sys.exit(1)


if __name__ == "__main__":
    main()
