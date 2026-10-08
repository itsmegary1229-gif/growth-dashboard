# CLAUDE.md — Dr. Yang的磨刀室

## 專案定位

整形外科醫師（楊佳叡醫師）的**私人每日期刊儀表板**，單一使用者使用。

- 純靜態 HTML / CSS / JavaScript，**無框架、無打包工具**
- 託管於 GitHub Pages（repo 根目錄）：`itsmegary1229-gif/growth-dashboard`
- 資料來源：PubMed E-utilities，由 GitHub Actions 每天台灣 06:00 自動抓取

## 檔案結構

```
growth-dashboard/
├── CLAUDE.md                     ← 本文件
├── README.md
├── .gitignore
├── .github/workflows/fetch.yml   ← 每日排程（UTC 22:00）＋可手動觸發
├── scripts/fetch_pubmed.py       ← PubMed 抓取腳本（Python 3.11，僅標準函式庫）
├── data/articles.json            ← 排程產出的文章資料（勿手動編輯）
├── index.html                    ← 儀表板主頁（尚未建立）
├── assets/                       ← CSS / JS / 圖片（尚未建立）
│   ├── css/
│   └── js/
└── firebase.js                   ← Firebase 設定（尚未建立）
```

## 鐵則

1. **`data/articles.json` 由排程產出，勿手動編輯**。要改內容請改 `scripts/fetch_pubmed.py` 的設定區。
2. **不做 SEO、不接 GA4**（私人工具，不需要被搜尋或追蹤）。
3. 本地預覽須用 **Live Server**（`http://127.0.0.1:5500`），不要用 `file://` 開啟（fetch JSON / Firebase 會失敗）。
4. 抓取腳本只用 Python 標準函式庫，不引入第三方套件（Actions 不需要 pip install）。
5. 每個 handoff 完成後，更新本檔的「現況」段落。

## 資料層說明

### 期刊（`[ta]`）
PRS（Plast Reconstr Surg）、PRS-GO（Plast Reconstr Surg Glob Open）、ASJ（Aesthet Surg J）、
APS（Aesthetic Plast Surg —— **不是** Archives of Plastic Surgery）、IJOMS（Int J Oral Maxillofac Surg）

### 主題（關鍵字 `[tiab]`）
`contour` 輪廓與正顎、`wound` 慢性傷口、`eye` 眼周、`nose` 鼻整形、`rejuv` 年輕化。
關鍵字清單在 `scripts/fetch_pubmed.py` 頂端設定區。

### 抓取流程
每主題一次 esearch（5 本期刊 AND 主題關鍵字，`datetype=edat`、`reldate=7`，可用 `--days N` 覆蓋）→ PMID 取聯集 →
efetch 批次（≤200）→ 與既有 JSON 以 pmid 合併（舊文保留 `added_at`）→ 依 `added_at` 保留 90 天 →
新到舊排序 → 文章有變才寫檔。

### `articles.json` 欄位
`generated_at`（最後一次內容變動的 UTC 時間）、`articles[]`：
`pmid`、`title`、`journal`（簡稱）、`journal_full`、`pub_date`（YYYY-MM-DD，優先用線上發表日 ArticleDate，
否則用卷期 PubDate，缺月日補 01）、`abstract`（多段以空行分隔，結構式摘要帶 `BACKGROUND:` 等標籤）、
`doi`、`topics`（主題 id 陣列）、`url`、`added_at`（首次進入本檔的 UTC 時間）。

## 現況

- [x] **Handoff #1 資料層**（2026-10-08）：`fetch_pubmed.py`、`fetch.yml`、首版 `articles.json` 完成。
  - `EMAIL` 已填入 itsmegary1229@gmail.com。
- [x] **Handoff #1.5 補抓初始資料**（2026-10-08）：`fetch_pubmed.py` 新增 `--days N`（預設 7，覆蓋 esearch 的 `reldate`；
  `fetch.yml` 不帶參數，維持每天 7 天）。本機執行 `--days 90` 補抓，`articles.json` 共 172 篇
  （原 8 篇保留 `added_at`，新增 164 篇 `added_at` 為 2026-10-08T01:19:39Z，約 2027-01-06 起依 90 天保留規則陸續移除）。
- [ ] Handoff #2：儀表板畫面（index.html / assets/）
- [ ] Handoff #3：Firebase 相關功能
