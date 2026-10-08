# CLAUDE.md — Dr. Yang的磨刀室

## 專案定位

整形外科醫師（楊佳叡醫師）的**私人每日期刊儀表板**，單一使用者使用。

- 純靜態 HTML / CSS / JavaScript，**無框架、無打包工具**
- 託管於 GitHub Pages（repo 根目錄）：`itsmegary1229-gif/growth-dashboard`
- 四個分區：**論文**（PubMed E-utilities）、**影片**（YouTube 公開 RSS）、**文章**（任意 RSS／Atom，非醫學的 newsletter、部落格），
  由 GitHub Actions 每天台灣 06:00 自動抓取；**回顧**（每天從收藏抽文章重讀，純前端）

## 檔案結構

```
growth-dashboard/
├── CLAUDE.md                     ← 本文件
├── README.md
├── .gitignore
├── .github/workflows/fetch.yml   ← 每日排程（UTC 22:00）＋可手動觸發
├── scripts/fetch_pubmed.py       ← PubMed 抓取腳本（Python 3.11，僅標準函式庫）
├── scripts/summarize.py          ← AI 中文摘要＋相關度評分（Claude API，僅標準函式庫）
├── scripts/fetch_videos.py       ← YouTube RSS 抓取腳本（僅標準函式庫）
├── scripts/fetch_feeds.py        ← 通用 RSS／Atom 抓取腳本（僅標準函式庫）
├── config/channels.json          ← 影片頻道設定（業主手動編輯；腳本會回寫 channel_id）
├── config/feeds.json             ← 文章 feed 設定（業主手動編輯）
├── data/articles.json            ← 排程產出的論文資料（勿手動編輯）
├── data/videos.json              ← 排程產出的影片資料（勿手動編輯）
├── data/feeds.json               ← 排程產出的 RSS 文章資料（勿手動編輯）
├── index.html                    ← 儀表板主頁（單頁；頂層分區「論文」「影片」「文章」「回顧」，各自的子分頁頁內切換）
├── firestore.rules               ← Firestore 安全規則（只放 repo，由業主貼到主控台）
└── assets/
    ├── css/style.css
    └── js/
        ├── app.js                ← 外殼：分區切換（URL hash）、頁首各分區篇數、登入 UI
        ├── util.js               ← 共用工具：esc、台灣日期、toast、搜尋框、localStorage 偏好、共用 JSON 抓取
        ├── state.js              ← 個人狀態抽象層（Firestore，每分區一個集合）＋登入狀態
        ├── firebase.js           ← Firebase 初始化（CDN SDK，版號只寫在這裡）
        └── sections/
            ├── papers.js         ← 論文分區：篩選／搜尋、渲染、事件、收藏筆記、RIS
            ├── listSection.js    ← 清單分區共用模組（新進／稍後／完成、來源 pill、搜尋、卡片、Firestore 狀態）
            ├── videos.js         ← 影片分區：listSection 的設定＋影片卡片
            ├── articles.js       ← 文章分區：listSection 的設定＋文章卡片
            └── review.js         ← 回顧分區：每日抽選收藏、還記得／再讀一次／移除收藏
```

## 鐵則

1. **`data/articles.json`、`data/videos.json`、`data/feeds.json` 由排程產出，勿手動編輯**。要改內容請改
   `scripts/fetch_pubmed.py` 的設定區、`config/channels.json` 或 `config/feeds.json`。
2. **不做 SEO、不接 GA4**（私人工具，不需要被搜尋或追蹤）。
3. 本地預覽須用 **Live Server**（`http://127.0.0.1:5500`），不要用 `file://` 開啟（fetch JSON / Firebase 會失敗）。
4. 抓取腳本只用 Python 標準函式庫，不引入第三方套件（Actions 不需要 pip install）。
5. 每個 handoff 完成後，更新本檔的「現況」段落。

## 分區架構

- 頁首（站名、篇數／更新時間、登入）下方一排分區 tab「論文」「影片」「文章」「回顧」；所選分區存在 URL hash
  （`#papers`／`#videos`／`#articles`／`#review`），
  重整後停在同一分區，沒有或不認得的 hash 用論文。切換分區不清各分區的狀態（子分頁、篩選、搜尋都留著）。
- `index.html` 裡每個分區是一個 `<div class="section" id="section-{id}">`，含自己的黏頂控制列與列表；
  影片分區的元素 id 一律加 `v-` 前綴、文章分區加 `a-`（論文沿用原本的 id）。
- 分區模組介面：`init({ setMeta })`，`setMeta(text)` 更新頁首該分區的「N 篇／支 · 更新：MM/DD HH:mm」，
  app.js 只顯示目前分區的那一份。分區各自 `onAuthChange`／`onStatesChange` 重繪。
- `articles.json` 由論文與回顧兩個分區共用，透過 `util.js` 的 `fetchJSON(url)` 只抓一次。
  回顧分區沿用 papers.js 匯出的 `renderAbstract`、`summaryOf`、`renderRelevance`、`journalClass`。
- 新增分區：寫 `sections/xxx.js`、在 `index.html` 加 `#section-xxx` 與分區 tab、在 app.js 的 `SECTIONS` 登記；
  需要個人狀態就在 `state.js` 用 `createCollection` 開一個集合，並把集合名加進 `firestore.rules`。
  「新進／稍後／完成」型的清單分區直接用 `listSection.js`（見下）＋ `state.js` 的 `createListStore`，複製 `#section-articles` 的 HTML 換前綴。

### 清單分區共用模組（`sections/listSection.js`）
`createListSection(cfg)` 回傳 `{ init }`。影片、文章兩個分區只提供設定物件與卡片內容函式：

| 設定 | 影片（videos.js） | 文章（articles.js） |
|---|---|---|
| `id`／`prefix` | `videos`／`v-` | `articles`／`a-` |
| `dataUrl`／`listKey` | `data/videos.json`／`videos` | `data/feeds.json`／`items` |
| `configUrl` | `config/channels.json` | `config/feeds.json` |
| `idKey`（＝Firestore 文件 ID） | `video_id` | `key`（sha1(id)） |
| `sourceKey`／`groupKey` | `channel_name`／null | `feed_name`／`category` |
| `store` | `videoState`（doneFlag `watched`） | `feedState`（doneFlag `read`） |
| `prefsKey`／`hidePref` | `mdr.prefs.videos.v1`／`hideWatched` | `mdr.prefs.articles.v1`／`hideRead` |
| `text`（完成／稍後／開啟） | 已看／稍後看／在 YouTube 開啟 ↗ | 已讀／稍後讀／開啟 ↗ |
| `renderCard` | 縮圖＋標題＋頻道／日期＋說明 2 行 | 標題＋feed／日期＋summary 3 行（`.clamp-3`） |

另有 `searchText`、`urlOf`、`sort`、`cardClass`，與空狀態／錯誤文字（`notConfigured`、`metaNotConfigured`、`noData`、`loadError`）。
其他文字（佇列空、登入提示、都讀完了…）由 `text.noun`／`done`／`later`／`finished`／`unit` 組成，影片的字句與重構前一致。
子分頁 `data-tab` 為 `new`／`later`／`done`；元素 id：`{p}sources`、`{p}subsources`（選填）、`{p}search`、`{p}search-clear`、
`{p}subbar`、`{p}range`、`{p}hide-done`、`{p}later-count`、`{p}result-count`、`{p}list`；卡片 `data-id`。
- 來源 pill：`groupKey` 為 null，或設定檔與資料都沒有分類 → 一排「全部＋各來源」。有分類 → 第一排「全部＋各分類」
  （設定檔順序，沒填分類的來源歸「未分類」），點分類後第二排（`{p}subsources`）列「全部{分類}＋該分類的來源」。
  分類以設定檔為準（Firestore 副本沒有分類），其次是資料裡的 `category`。

## 資料層說明

### 期刊（`[ta]`）
PRS（Plast Reconstr Surg）、PRS-GO（Plast Reconstr Surg Glob Open）、ASJ（Aesthet Surg J）、
APS（Aesthetic Plast Surg —— **不是** Archives of Plastic Surgery）、IJOMS（Int J Oral Maxillofac Surg）

### 主題（關鍵字 `[tiab]`）
`contour` 輪廓與正顎、`wound` 慢性傷口、`eye` 眼周、`nose` 鼻整形、`rejuv` 年輕化。
關鍵字清單在 `scripts/fetch_pubmed.py` 頂端設定區。

### 抓取流程
每主題一次 esearch（5 本期刊 AND 主題關鍵字，`datetype=edat`、`reldate=7`，可用 `--days N` 覆蓋）→ PMID 取聯集 →
efetch 批次（≤200）→ 與既有 JSON 以 pmid 合併（舊文保留 `added_at`、`oa_url`、`oa_checked_at`、`summary_zh`，其餘欄位以新抓的為準）→
依 `added_at` 保留 90 天 → 新到舊排序 → Unpaywall 查 OA → 文章有變才寫檔。

### Unpaywall（OA 全文連結）
對有 `doi` 的文章 GET `https://api.unpaywall.org/v2/{doi}?email=…`（無 key），取 `best_oa_location.url_for_pdf`，
沒有則取 `.url`，寫進 `oa_url`（無 OA 為 null）、`oa_pdf`（取到的是 `url_for_pdf` 才 true）並記 `oa_checked_at`。
只查「沒有 `oa_checked_at`」或「`oa_url` 為 null 且 `oa_checked_at` 超過 30 天」的文章（embargo 解除後會變 OA），
外加「有 `oa_url` 但沒有 `oa_pdf` 欄位」的（#5 首版資料，查一次補上）。
請求間隔 ≥ 0.2 秒；DOI 不在 Unpaywall（HTTP 404）視同無 OA；其他錯誤印警告、不寫 `oa_checked_at`（下次排程再查），
連續失敗 5 次就放棄本次剩下的（Unpaywall 整個掛掉時不拖慢 Actions）。OA 查詢失敗永遠不會讓腳本 exit 1。
設定在腳本頂端 `OA_INTERVAL`／`OA_RECHECK_DAYS`／`OA_MAX_STREAK`。

### `articles.json` 欄位
`generated_at`（最後一次內容變動的 UTC 時間）、`articles[]`：
`pmid`、`title`、`journal`（簡稱）、`journal_full`、`pub_date`（YYYY-MM-DD，優先用線上發表日 ArticleDate，
否則用卷期 PubDate，缺月日補 01）、`abstract`（多段以空行分隔，結構式摘要帶 `BACKGROUND:` 等標籤）、
`doi`、`authors`（陣列，每位 "LastName Initials"，例 "Yang JR"；團體作者照原文；沒有 Initials 時只有姓）、
`year`（pub_date 的年）、`volume`、`issue`、`pages`（MedlinePgn 原樣，如 "123-30"、"e7923"；
線上搶先刊出的文章這三欄為空字串）、`topics`（主題 id 陣列）、`url`、`added_at`（首次進入本檔的 UTC 時間）、
`oa_url`（OA 全文連結或 null）、`oa_pdf`（bool，`oa_url` 是否為 PDF 直連）、`oa_checked_at`（最後一次成功查 Unpaywall 的 UTC 時間）、
`summary_zh`（AI 摘要，見下；尚未摘要的文章沒有這個欄位）。

### AI 摘要（`scripts/summarize.py`）
fetch.yml 在抓取之後執行（`continue-on-error: true`，失敗不擋 commit；`timeout-minutes: 40`）。API key 只在 GitHub Secrets
`ANTHROPIC_API_KEY`，**本機沒有 key**，本機只能 `python3 scripts/summarize.py --dry-run [--limit N]`（印 prompt 與篇數）。
- 對象：沒有 `summary_zh`、`summary_zh.error` 存在、或 `basis == "title"` 但現在有摘要的文章；依檔案順序（新到舊）取前 `--limit` 篇
  （預設 60；workflow_dispatch 的 `summarize_limit` 可填 200 做補跑）。
- 呼叫 `POST https://api.anthropic.com/v1/messages`，模型 `MODEL = "claude-haiku-4-5"`、max_tokens 600、temperature 0；
  prompt（system＋user 模板）在腳本頂端設定區。輸入 title、journal、pub_date、命中主題、abstract（無摘要時只給標題並說明）。
- 回傳要求純 JSON；解析失敗剝除 ``` 圍欄再試，仍失敗或欄位不合格記 `{"error", "at"}`（下次重試）。
- 間隔 ≥ 0.5 秒；429／5xx／網路錯誤指數退避重試 3 次，仍失敗記 error；400／401／403／404（參數、key、模型不存在）
  每篇都會一樣失敗，直接停止並 exit 1。每成功 10 篇先寫一次檔，寫檔時更新 `generated_at`。
- stdout 摘要：處理／成功／失敗篇數與 input／output tokens 總計。
- `fetch_pubmed.py` 合併時沿用舊文的 `summary_zh`。
- `summary_zh` 結構：`{headline, points[], relevance(1–5 int), reason, model, at, basis}`，`basis` 為 `"abstract"` 或 `"title"`（無摘要時）；
  失敗時是 `{error, at}`。
- 費用（Haiku 4.5，$1／$5 每百萬 input／output token）：每篇約 1–1.5k input＋300 output tokens ≈ US$0.003；
  172 篇補跑約 US$0.5，每天新文章 5–15 篇約 US$0.05 以下。實際用量看 Actions log 的 tokens 行。

### 影片（`scripts/fetch_videos.py`）
`config/channels.json` 是陣列，每項 `{ "name": 顯示名稱, "channel": 頻道 }`，`channel` 可以是 `UC…` 的 channel_id、
`@handle` 或頻道網址，例：
```json
[
  { "name": "某頻道", "channel": "@somehandle" },
  { "name": "另一頻道", "channel": "UCxxxxxxxxxxxxxxxxxxxxxx" }
]
```
- 給 `@handle`／網址時，第一次抓頻道頁 HTML 解析出 channel_id（canonical link → `itemprop=identifier` → `externalId`），
  回寫成該項的 `channel_id` 欄位，之後直接用。**改了 `channel` 要連同 `channel_id` 一起刪掉**才會重新解析。
- 每頻道抓 `https://www.youtube.com/feeds/videos.xml?channel_id=UC…`（公開 RSS、無 key，最新 15 支，含 Shorts）。
- YouTube RSS 常**間歇性回 404／500**（2026-10 實測單次成功率約 3 成，curl 也一樣，換 `playlist_id` 或加參數無效），
  所以每個請求重試 8 次、第 n 次等 min(2n, 10) 秒；某頻道全部失敗就印警告、保留它的既有影片，全部頻道都失敗才 exit 1。
  fetch.yml 這步 `continue-on-error: true`、`timeout-minutes: 20`。
- 合併：video_id 去重、舊影片保留 `added_at`、其餘欄位以新抓的為準；依 `added_at` 保留 90 天；`added_at` 新到舊排序；有變才寫檔。
- `channels.json` 為空時印「未設定頻道」直接結束（不動 `videos.json`）。repo 裡的 `videos.json` 是空殼
  `{"generated_at": null, "videos": []}`，避免前端抓 404 在 console 留錯誤。
- 前端：`channels.json` 為空且沒有影片 → 「尚未設定頻道」空狀態；兩個檔案 404 也當成空的，不報錯。

### `videos.json` 欄位
`generated_at`、`videos[]`：`video_id`、`title`、`channel_name`（channels.json 的 `name`）、`channel_id`、
`published`（UTC ISO，`…Z`）、`url`（RSS 的 alternate link，Shorts 是 `/shorts/…`）、`thumbnail`（media:thumbnail 最大尺寸，
實際上 RSS 只給 480×360 的 hqdefault）、`description`（前 500 字）、`added_at`（首次進入本檔的 UTC 時間）。

### 影片分區畫面
- 子分頁「新進」「稍後看」（tab 上顯示佇列數）「已看」；頻道 pill（全部＋channels.json 順序的頻道，其次是只出現在資料裡的）；
  「新進」有時間範圍（依 `added_at`）與「隱藏已看」，選擇記在 localStorage `mdr.prefs.videos.v1`；搜尋 title＋description。
- 卡片：縮圖（手機滿版在上、桌機 200px 在左，點擊開 YouTube）、標題（點擊展開）、頻道名＋發布日（台灣日期）、
  說明收合時 2 行；操作列 已看｜稍後看｜在 YouTube 開啟 ↗。已看淡化（「已看」分頁不淡化，多一行「已看於」）。
- 「稍後看」「已看」以 Firestore 副本為主、`videos.json` 仍有時用完整資料，依 `laterAt`／`watchedAt` 新到舊。

### 文章（`scripts/fetch_feeds.py`）
`config/feeds.json` 是陣列，每項 `{ "name": 顯示名稱, "url": feed 網址, "category": 分類（選填） }`，例：
```json
[
  { "name": "某電子報", "url": "https://example.com/feed", "category": "生產力" },
  { "name": "某部落格", "url": "https://example.org/atom.xml" }
]
```
- 支援 RSS 2.0、RSS 1.0（RDF）、Atom（以 local name 解析，不管命名空間前綴）。
- 每篇：`id`（RSS guid 或 link；Atom id 或 link）、`key`（sha1(id) hex，前端與 Firestore 的文件 ID）、`title`（去 HTML）、`link`、
  `published`（RSS pubDate／dc:date、Atom published／updated → UTC ISO；缺或無法解析用抓取時間）、
  `summary`（description／content:encoded 或 Atom summary／content，去 HTML 標籤與 entity、壓空白、前 500 字，超過加「…」）、
  `feed_name`、`category`（沒填是空字串）、`added_at`。
- 每個 feed 最多取 50 篇（`MAX_PER_FEED`），發表日早於 90 天的不收（避免第一次抓到整個存檔都變成「新進」）。
- 單一 feed 失敗（逾時 20 秒、HTTP 錯誤、XML 錯、不認得的格式）重試 1 次後印警告、保留它的既有文章；全部失敗才 exit 1。
  fetch.yml 這步 `continue-on-error: true`、`timeout-minutes: 10`。
- 合併：`id` 去重、保留原 `added_at`、其餘以新抓的為準；依 `added_at` 保留 90 天；`added_at` 新到舊（同時再依 `published`）；有變才寫檔。
- `feeds.json` 為空時印「未設定 feed」直接結束（不動 `data/feeds.json`）。repo 裡的 `data/feeds.json` 是空殼 `{"generated_at": null, "items": []}`。
- stdout 摘要：各 feed「本次抓到 / 其中新增」、總抓到／新增／移除、保留篇數。

### 文章分區畫面
- 子分頁「新進」「稍後讀」（tab 上顯示佇列數）「已讀」；來源 pill（有分類時兩層，見上）；「新進」有時間範圍與「隱藏已讀」
  （localStorage `mdr.prefs.articles.v1`）；搜尋 title＋summary。
- 卡片：標題（點擊展開）、feed 名＋發表日（台灣日期）、summary 收合時 3 行；操作列 已讀｜稍後讀｜開啟 ↗。
- `feeds.json` 設定為空且沒有資料 → 「尚未設定 feed」。

### 回顧分區（`sections/review.js`）
- 需登入。候選池：`userState` 中 `saved == true`、且今天（台灣日期）還沒回顧的文章。
- 抽選順序：從未回顧（沒有 `reviewedAt`）> `reviewedAt` 的台灣日期最久遠；同一組內依 FNV-1a(`"YYYY-MM-DD:pmid"`) 排序，
  同一天任何裝置重整都看到同一篇，隔天換順序。目前出的是佇列第一篇。
- 每天上限 5 篇。**今天已回顧篇數由 Firestore 的 `reviewedAt` 推算**（所有 reviewedAt 是今天的文件，含之後取消收藏的），
  手機和電腦進度一致；只有完成畫面「再來一篇」加開的篇數存 localStorage `mdr.review.v1`（`{date, extra}`，隔天失效、只限這台裝置）。
  「移除收藏」不算進今天的篇數。
- 卡片：上方小字「今天第 N / 上限 篇 · 收藏共 M 篇 · 上次回顧」；headline（大字；沒有 AI 摘要時改以英文標題當主標）、英文標題、
  期刊＋年份＋相關度、重點條列、筆記（暖色底「你當時寫的 · 收藏於 …」）。
- 按鈕：「還記得」→ `markReviewed`；「再讀一次」→ 展開英文摘要＋看全文／PDF 連結，按鈕換成「完成」（同樣 `markReviewed`）；
  「移除收藏」→ `setSaved(false)`（筆記保留）。皆樂觀更新、重繪成下一篇；換篇後 400ms 內忽略點擊（防連點）。
  手機版按鈕列黏在畫面底部。
- 完成畫面：今天回顧 N 篇・收藏共 M 篇・從未回顧 K 篇；還有候選時顯示「再來一篇」，收藏都回顧過時顯示「明天再來」。
- 文章在 `articles.json` 時用完整資料，否則用 Firestore 副本（見 `reviewCopy`）。

### 個人狀態的三個概念（互相獨立，一篇可以同時具備）
- **稍後細讀**（`later`）：短期待讀佇列。標已讀時自動離開佇列。
- **收藏**（`saved`）：長期書庫。筆記、RIS 匯出都在這裡；標已讀不影響收藏。
- **已讀**（`read`）：閱讀紀錄。

### Firestore（論文：`userState` 集合）
Firebase 專案 `growth-dashboard-989fb`，SDK **13.0.0**（gstatic CDN 的 ES module 版：
`https://www.gstatic.com/firebasejs/13.0.0/firebase-{app,auth,firestore}.js`）。
文件 ID = PMID，欄位：`read`、`later`、`saved`（bool）、`readAt`／`laterAt`／`savedAt`（Timestamp｜null，用客戶端時間）、
`title`、`journal`（簡稱）、`url`、`topics`（string[]）、`note`（string，收藏筆記），
收藏、加入稍後細讀時另存書目 `authors`、`year`、`doi`、`volume`、`issue`、`pages`（#5 起；之前的收藏沒有，不回填）。
收藏與回顧（`markReviewed`）時另存 `summary_zh`（`{headline, points, relevance, reason}`）、`abstract`、`pub_date`、`oa_url`、`oa_pdf`
（#8 起，`reviewCopy`；只寫有值的欄位，不會用空值蓋掉舊副本；#8 之前的收藏在第一次回顧時補上——前提是文章還在 `articles.json`）。
`title`～`oa_pdf` 是冗餘副本，讓收藏／已讀清單、回顧與 RIS 匯出不依賴 `articles.json`（90 天後退場）。
回顧：`reviewedAt`（Timestamp，最後一次「還記得／完成」）、`reviewCount`（number，沒有視為 0；以本地快取 +1 寫入，不用 `increment()`）。
寫入一律 `setDoc(..., { merge: true })`；取消已讀／稍後細讀／收藏時不刪文件，只把布林改 false、時間改 null；
例外：`setRead(pmid, true)` 時若 `later` 為 true，同一次寫入把 `later` 改 false，但 `laterAt` 保留當歷史；`note` 只由 `setNote` 改，
取消收藏不動它（再次收藏時筆記會回來）。

### Firestore（影片：`videoState` 集合）
文件 ID = video_id，欄位：`watched`、`later`（bool）、`watchedAt`／`laterAt`（Timestamp｜null）、
`title`、`channel_name`、`url`、`thumbnail`（冗餘副本）。寫法同 `userState`：`setDoc(merge)`、取消時布林改 false、時間改 null；
`setDone(id, true)`（已看）時若 `later` 為 true，同一次寫入把 `later` 改 false（`laterAt` 保留）。

### Firestore（文章：`feedState` 集合）
文件 ID = `feeds.json` 的 `key`（sha1(id) 的 40 字 hex；guid／網址含 `/` 不能當文件 ID），欄位：`read`、`later`（bool）、
`readAt`／`laterAt`（Timestamp｜null）、`title`、`feed_name`、`link`（冗餘副本）。寫法與 `videoState` 相同。

### `state.js`
`createCollection(name, flags)` 是單一集合的核心（快取、onSnapshot、樂觀寫入與回滾）；登入／登出時所有集合一起切換監聽。
對外匯出 `paperState`（userState；沿用 #2～#5.5 的函式名稱與回傳格式）、`videoState`、`feedState`，共同介面：
`getState`、`getAllStates`、`setLater`、`getAllLater`、`onStatesChange`。paperState 另有 `setRead`／`setSaved`／`setNote`／
`getAllSaved`／`getAllRead`。videoState、feedState 由 `createListStore(name, doneFlag, meta, item)` 產生，另有
`doneFlag`（`"watched"`／`"read"`）、`setDone(id, bool, item?)`、`getAllDone()`（項目帶 `{doneFlag}At`）——#9 起取代 `setWatched`／`getAllWatched`。paperState 另有 #8 的 `markReviewed(pmid, article?)`、
`getAllReviewed()`（有 `reviewedAt` 的文件，含已取消收藏的）、`isSynced()`（登入後第一次 onSnapshot 是否已到，回顧區用來避免閃出空狀態）；
`getAllSaved()` 項目多 `reviewedAt`（ISO）、`reviewCount`。清單項目一律有 `id`、`item`（論文另帶 `pmid`、`article`）。
登入相關 `onAuthChange`、`signIn`、`signOutUser`、`AuthRequiredError` 各分區共用。

### 安全規則（`firestore.rules`）
只允許 uid `caItxfEfasaJYMCLCnhEd7OGRMl1` 讀寫 `userState`、`videoState`、`feedState` 三個集合。**檔案已更新（#9 加 `feedState`）、尚未套用**，
業主要貼到主控台發佈；新規則套用前，主控台規則沒涵蓋的集合（影片 `videoState`、文章 `feedState`）會寫入失敗，
console 會有該集合監聽失敗的錯誤。

## 現況

- [x] **Handoff #1 資料層**（2026-10-08）：`fetch_pubmed.py`、`fetch.yml`、首版 `articles.json` 完成。
  - `EMAIL` 已填入 itsmegary1229@gmail.com。
- [x] **Handoff #1.5 補抓初始資料**（2026-10-08）：`fetch_pubmed.py` 新增 `--days N`（預設 7，覆蓋 esearch 的 `reldate`；
  `fetch.yml` 不帶參數，維持每天 7 天）。本機執行 `--days 90` 補抓，`articles.json` 共 172 篇
  （原 8 篇保留 `added_at`，新增 164 篇 `added_at` 為 2026-10-08T01:19:39Z，約 2027-01-06 起依 90 天保留規則陸續移除）。
- [x] **Handoff #2 儀表板畫面**（2026-10-08）：`index.html`、`assets/css/style.css`、`assets/js/app.js`、`assets/js/state.js`。
  - 強調色深青 `#0e6466`；系統字型、基礎字級 17px、寬度上限 760px、手機優先；不做深色模式。
  - 篩選：主題 pill（單選，顯示篇數）、時間範圍（依 `added_at`，近 7／30 天／全部）、隱藏已讀（僅「新進」分頁）。
    時間範圍與隱藏已讀的選擇記在 localStorage `mdr.prefs.v1`。
  - 排序：`added_at` 的台灣日期新到舊，同日再依 `pub_date` 新到舊。
  - `state.js` 介面（皆 async）：`getState(pmid)`、`getAllStates()`、`setRead(pmid, bool)`、
    `setSaved(pmid, bool, article?)`、`getAllSaved()`。目前存 localStorage `mdr.state.v1`；
    收藏時存文章快照，文章被 90 天滾動移出 JSON 後仍會留在「稍後細讀」。Handoff #3 只需改寫 `state.js` 內部。
  - `fetch.yml` 的 actions 升到 `checkout@v7`、`setup-python@v7`（Node 24）。
- [x] **Handoff #3 Firebase 登入與同步**（2026-10-08）：`assets/js/firebase.js`、`state.js` 改寫、`app.js` 加登入 UI、`firestore.rules`。
  - SDK 13.0.0（2026-10-07 發佈的大版本，npm `latest`）。`state.js` 動態 `import("./firebase.js")`，CDN 掛掉時文章仍可瀏覽。
  - Email／密碼登入，預設 local 持久化。頁首右上「登入」（展開小表單）／「登出」；錯誤訊息轉成中文，原始錯誤寫 console。
  - 未登入：已讀／收藏按鈕只跳「請先登入」提示；「稍後細讀」顯示「登入後才能看到收藏」。
  - 登入後 `onSnapshot` 監聽整個 `userState`；按鈕樂觀更新（先改本地快取並重繪，寫入失敗則回滾並提示「同步失敗，已還原」）。
  - `state.js` 介面不變，另加 `onAuthChange`、`onStatesChange`、`signIn`、`signOutUser`、`AuthRequiredError`；
    `setRead` 多一個可選的 `article` 參數，用來寫冗餘副本。
  - localStorage 遷移：登入後若有 `mdr.state.v1`，向伺服器確認哪些 PMID 尚無文件，用 batch 寫入，成功後刪掉 `mdr.state.v1`
    （失敗則保留，下次登入再試）。UI 偏好 `mdr.prefs.v1` 仍留在 localStorage。
  - ⚠️ **安全規則尚未套用**：Firestore 目前是測試模式（任何人可讀寫），業主驗證讀寫成功後要把 `firestore.rules`
    的內容貼到主控台發佈（只允許 uid `caItxfEfasaJYMCLCnhEd7OGRMl1`）。
- [x] **Handoff #4 已讀分頁、關鍵字搜尋、收藏筆記**（2026-10-08）：`index.html`、`app.js`、`state.js`、`style.css`。
  - 「已讀」分頁：`read == true` 的文章依 `readAt` 新到舊（#2 遷移來、沒有 `readAt` 的排最後，顯示「已讀日期不明」）；
    卡片不淡化，多一行「已讀於 YYYY-MM-DD」（台灣日期）。和「稍後細讀」一樣以 Firestore 副本為主、JSON 仍有時補摘要；
    副本沒有標題時顯示「PMID xxx」。需登入。只有主題 pill，沒有時間範圍／隱藏已讀。
  - 搜尋框在主題 pill 下方（三個分頁共用）：title＋abstract（「稍後細讀」另含筆記），不分大小寫，空白分隔為 AND，
    200ms debounce（注音組字中不觸發），與分頁／主題／時間範圍／隱藏已讀疊加；主題 pill 篇數也反映搜尋結果；
    搜尋時篇數顯示「符合 N 篇」。不存 localStorage，換分頁清空；Esc 或 × 清除。
  - 收藏筆記（只在「稍後細讀」）：操作列「✎ 筆記」展開 textarea；有筆記時卡片直接顯示，點擊編輯。
    停止輸入 800ms 或失焦時寫入（樂觀更新）；失敗時提示「筆記同步失敗，內容已保留」，草稿留在記憶體、編輯框重新打開，下次失焦再試。
  - `state.js` 新增 `getAllRead()`、`setNote(pmid, text)`；`getAllSaved()` 多回傳 `note`，`article` 一律有值（不再是 null）。
  - 筆記框聚焦時列表不重繪（避免打斷注音輸入、保住游標），失焦後補繪；在筆記框聚焦狀態下點其他按鈕時，
    重繪延到這次 click 處理完，免得按鈕被換掉要點兩次。
  - 手機：三個分頁等寬；「稍後細讀」卡片有四顆按鈕，窄螢幕改依文字寬度分配並縮小字級（320px 寬可排下）。
- [x] **Handoff #5 書目欄位、Unpaywall OA 連結、RIS 匯出**（2026-10-08）：`fetch_pubmed.py`、`articles.json`、`index.html`、
  `app.js`、`state.js`、`style.css`。
  - 本機 `--days 90` 重跑：172 篇全部補上書目與 OA 查詢（`added_at` 全數保留），有 OA 80 篇（PDF 直連 12 篇、
    68 篇是 PRS-GO 等只給 doi.org 落地頁）；90 篇是線上搶先刊出，尚無卷期頁碼。
  - 卡片：有 `oa_url` 時「看全文 ↗」旁多一顆連結（三個分頁都有）：`oa_pdf` 為 true 顯示「PDF ↗」，否則「OA 全文 ↗」。
    手機版：「稍後細讀」五顆按鈕時兩個連結換到第二列；其他分頁四顆按鈕在 < 400px 寬時排成 2×2。
  - 修正：`check_oa` 會就地改文章，原本會連帶改到用來比對的 `old_articles`，導致只有 OA 欄位變動時誤判「無變更」不寫檔；
    現在合併前先複製一份。
  - `state.js`：`setSaved` 多寫書目欄位；`fallbackArticle` 也帶這些欄位（避免在已退場的收藏上取消收藏時被空值覆蓋）。
  - 「稍後細讀」結果列右側「匯出 RIS」（有文章才顯示），匯出目前主題 pill＋搜尋下列出的文章；資料優先 `articles.json`，
    退場的用 Firestore 副本。檔名 `growth-dashboard_saved_YYYYMMDD.ris`（台灣日期），UTF-8 無 BOM、CRLF。
    AU 轉成 "Yang, J. R."（EndNote 靠逗號拆姓名）；不是「姓＋1–4 個大寫縮寫」的視為團體作者，結尾加逗號。
    PubMed 省略寫法的頁碼（"1234-45"）會補成 EP 1245；e 開頭或其他格式整串放 SP。AB／N1 的換行壓成空白（RIS 一欄一行）。
- [x] **Handoff #5.5 拆分「稍後細讀」與「收藏」**（2026-10-08）：`index.html`、`app.js`、`state.js`、`style.css`。
  - 原本「收藏」按鈕就是把文章放進「稍後細讀」分頁，現在拆成兩個獨立概念（見「資料層說明」），Firestore 多 `later`／`laterAt`，
    既有資料不遷移（業主已清空收藏）。安全規則不用改。
  - 分頁：新進｜稍後細讀（`ui.tab = "later"`，依 `laterAt` 新到舊，tab 上顯示佇列篇數）｜收藏（`"saved"`，依 `savedAt` 新到舊）｜已讀。
    三個個人分頁都以 Firestore 副本為主、JSON 有時用完整版；主題 pill＋搜尋適用；未登入各自顯示提示。
  - 筆記、「匯出 RIS」、搜尋含筆記：從「稍後細讀」搬到「收藏」（#5 段落提到的「稍後細讀」現在都指「收藏」）。
  - `state.js` 新增 `setLater(pmid, bool, article?)`（副本＋書目寫法同 `setSaved`）、`getAllLater()`；`getState`／`getAllStates`
    多回傳 `later`；`getAllSaved()` 改為依 `savedAt` 新到舊。手動取消稍後細讀會清 `laterAt`（同取消收藏）。
  - 卡片操作列分兩組：狀態（已讀｜稍後細讀｜收藏）＋內容（✎ 筆記〔僅收藏分頁〕｜看全文｜PDF／OA 全文）。
    手機兩組各一列，桌機同一列左右分開；取代 #5 的 `has-note`／`has-oa` 換列規則。320px 寬（含全部按下、六顆按鈕、兩位數篇數）排得下。
- [x] **Handoff #6 AI 中文摘要＋相關度評分**（2026-10-08）：`scripts/summarize.py`（新）、`fetch_pubmed.py`、`fetch.yml`、
  `index.html`、`app.js`、`style.css`。細節見「資料層說明 → AI 摘要」。
  - 模型改用 `claude-haiku-4-5`（handoff 寫的 `claude-haiku-5-5` 不存在，業主同意改）。
  - 卡片：標題下方顯示 headline（強調色、略小於標題）；期刊標籤旁「相關 N/5」（4–5 強調色、3 灰底、1–2 淡灰框），滑過顯示 reason；
    展開時英文摘要上方顯示 points 條列，收合時只有 headline＋英文摘要前 3 行。沒有 `summary_zh` 或是 error 的卡片照舊。
    三個個人分頁的文章仍在 JSON 時也會顯示（Firestore 副本沒有摘要，不寫入）。
  - 「新進」排序切換「相關度｜時間」（預設相關度，存 `mdr.prefs.v1` 的 `sort`）：relevance 高→低，同分依原時間排序；
    沒有分數的文章當 3 分排（避免新文章在摘要前沉底）。其他分頁維持原排序。
  - 搜尋範圍加入 headline 與 points。
  - 本機 dry-run：待摘要 172 篇（無摘要 16 篇），未實際呼叫 API；**業主尚未手動觸發 workflow 驗收**。
- [x] **Handoff #7 頂層分區架構＋影片分區**（2026-10-08）：`index.html`、`app.js`（改為外殼）、`util.js`（新）、
  `sections/papers.js`（原 app.js 的論文邏輯）、`sections/videos.js`（新）、`state.js`（改成每分區一個集合）、`style.css`、
  `scripts/fetch_videos.py`（新）、`config/channels.json`（新，空陣列）、`data/videos.json`（新，空殼）、`fetch.yml`、`firestore.rules`。
  細節見「分區架構」與「資料層說明 → 影片」。
  - 論文分區的行為不變（四個分頁、主題 pill、搜尋、時間範圍／排序／隱藏已讀與其 localStorage、AI 摘要與相關度、
    筆記、RIS、未登入提示、樂觀更新）。頁首「N 篇 · 更新」改成依分區顯示。
  - fetch.yml：PubMed 抓取後加「Fetch YouTube videos」（continue-on-error）；commit 步驟改成一併提交
    `data/articles.json`、`data/videos.json`、`config/channels.json`，訊息改為 `chore: update data YYYY-MM-DD`。
  - 本機以 TED、YouTube（@handle／網址，解析並回寫 channel_id 成功）、Google for Developers（UC id）測試，
    `videos.json` 結構正確；測完 `channels.json` 清回 `[]`、`videos.json` 清回空殼。
  - ⚠️ **新安全規則待業主套用**（見「安全規則」）；**業主尚未填頻道、尚未驗收影片同步**。
- [x] **Handoff #8 回顧區——今天重讀一篇**（2026-10-08）：`sections/review.js`（新）、`index.html`、`app.js`、`state.js`、
  `util.js`、`papers.js`、`style.css`。細節見「資料層說明 → 回顧分區」。
  - 「收藏」分頁卡片多一行小字「回顧 N 次 · 上次 YYYY-MM-DD」（沒回顧過不顯示）。
  - 與 handoff 的差異：今天的回顧篇數改由 Firestore `reviewedAt` 推算（handoff 寫 localStorage；那樣手機和電腦進度不一致），
    localStorage 只存「再來一篇」的加開數。另在收藏／回顧時多存 AI 摘要等副本（`reviewCopy`），否則文章 90 天退場後回顧卡只剩英文標題。
  - 安全規則不用改（同一集合加欄位）。本機以假 Firestore 驗證抽選、上限、再來一篇、移除收藏、收藏分頁回顧次數、手機／桌機版面；
    **業主尚未以真實帳號驗收**。
- [x] **Handoff #9 通用 RSS「文章」分區＋清單分區共用模組**（2026-10-08）：`sections/listSection.js`（新）、`sections/articles.js`（新）、
  `sections/videos.js`（改用共用模組）、`state.js`（`createListStore`、`feedState`）、`index.html`、`app.js`、`style.css`、
  `scripts/fetch_feeds.py`（新）、`config/feeds.json`（新，空陣列）、`data/feeds.json`（新，空殼）、`fetch.yml`、`firestore.rules`。
  細節見「清單分區共用模組」「文章」「Firestore（文章）」。
  - 影片分區重構：`videos.js` 只剩設定＋卡片；元素 id `v-channels` → `v-sources`、`v-hide-watched` → `v-hide-done`，子分頁 `watched` → `done`；
    `videoState.setWatched`／`getAllWatched` → `setDone`／`getAllDone`。Firestore 欄位、localStorage 偏好鍵與欄位、畫面字句都不變。
  - 分類兩層 pill 已實作（不是只有 feed 層級）。
  - fetch.yml 在影片之後加「Fetch RSS feeds」（continue-on-error）；commit 一併提交 `data/feeds.json`。
  - 本機以 Hacker News（RSS 2.0）、Simon Willison（Atom）、Cal Newport（RSS 2.0，WordPress）加一個不存在的網址測試：三個解析成功、
    壞的那個跳過；重跑無變更不寫檔。前端以假 Firestore 驗證文章分區（分類／來源 pill、稍後讀、已讀、已讀分頁、未登入提示）
    與影片分區重構後行為（頻道 pill、搜尋、時間範圍偏好沿用、已看／稍後看、隱藏已看、展開）。測完 `feeds.json` 清回 `[]`、`data/feeds.json` 清回空殼。
  - ⚠️ **新安全規則（含 `feedState`）待業主套用**；**業主尚未填 feed、尚未以真實帳號驗收**。
