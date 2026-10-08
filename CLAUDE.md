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
├── index.html                    ← 儀表板主頁（單頁，「新進」／「稍後細讀」頁內切換）
├── firestore.rules               ← Firestore 安全規則（只放 repo，尚未套用到主控台）
└── assets/
    ├── css/style.css
    └── js/
        ├── app.js                ← 載入 JSON、篩選、渲染、事件、登入 UI
        ├── state.js              ← 已讀／收藏狀態抽象層（Firestore）＋登入狀態
        └── firebase.js           ← Firebase 初始化（CDN SDK，版號只寫在這裡）
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

### Firestore（`userState` 集合）
Firebase 專案 `growth-dashboard-989fb`，SDK **13.0.0**（gstatic CDN 的 ES module 版：
`https://www.gstatic.com/firebasejs/13.0.0/firebase-{app,auth,firestore}.js`）。
文件 ID = PMID，欄位：`read`（bool）、`saved`（bool）、`readAt`／`savedAt`（Timestamp｜null，用客戶端時間）、
`title`、`journal`（簡稱）、`url`、`topics`（string[]）。後四個是冗餘副本，讓收藏清單不依賴 `articles.json`。
寫入一律 `setDoc(..., { merge: true })`；取消已讀／收藏時不刪文件，只把布林改 false、時間改 null。

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
