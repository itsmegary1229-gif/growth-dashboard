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
├── index.html                    ← 儀表板主頁（單頁，「新進」／「稍後細讀」／「收藏」／「已讀」頁內切換）
├── firestore.rules               ← Firestore 安全規則（只放 repo，尚未套用到主控台）
└── assets/
    ├── css/style.css
    └── js/
        ├── app.js                ← 載入 JSON、篩選／搜尋、渲染、事件、登入 UI、收藏筆記
        ├── state.js              ← 已讀／收藏／筆記狀態抽象層（Firestore）＋登入狀態
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
efetch 批次（≤200）→ 與既有 JSON 以 pmid 合併（舊文保留 `added_at`、`oa_url`、`oa_checked_at`，其餘欄位以新抓的為準）→
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
`oa_url`（OA 全文連結或 null）、`oa_pdf`（bool，`oa_url` 是否為 PDF 直連）、`oa_checked_at`（最後一次成功查 Unpaywall 的 UTC 時間）。

### 個人狀態的三個概念（互相獨立，一篇可以同時具備）
- **稍後細讀**（`later`）：短期待讀佇列。標已讀時自動離開佇列。
- **收藏**（`saved`）：長期書庫。筆記、RIS 匯出都在這裡；標已讀不影響收藏。
- **已讀**（`read`）：閱讀紀錄。

### Firestore（`userState` 集合）
Firebase 專案 `growth-dashboard-989fb`，SDK **13.0.0**（gstatic CDN 的 ES module 版：
`https://www.gstatic.com/firebasejs/13.0.0/firebase-{app,auth,firestore}.js`）。
文件 ID = PMID，欄位：`read`、`later`、`saved`（bool）、`readAt`／`laterAt`／`savedAt`（Timestamp｜null，用客戶端時間）、
`title`、`journal`（簡稱）、`url`、`topics`（string[]）、`note`（string，收藏筆記），
收藏、加入稍後細讀時另存書目 `authors`、`year`、`doi`、`volume`、`issue`、`pages`（#5 起；之前的收藏沒有，不回填）。
`title`～`pages` 是冗餘副本，讓收藏／已讀清單與 RIS 匯出不依賴 `articles.json`。
寫入一律 `setDoc(..., { merge: true })`；取消已讀／稍後細讀／收藏時不刪文件，只把布林改 false、時間改 null；
例外：`setRead(pmid, true)` 時若 `later` 為 true，同一次寫入把 `later` 改 false，但 `laterAt` 保留當歷史；`note` 只由 `setNote` 改，
取消收藏不動它（再次收藏時筆記會回來）。

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
