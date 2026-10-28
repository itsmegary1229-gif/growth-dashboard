// 自選文章（Handoff #11）：「＋ 加入文章」對話框。把儀表板沒抓到的論文手動加進 userState（manual: true），
// 立即產生 AI 摘要（Worker /summarize），有全文時接著跑 #10 的全文解析。
//
// 流程 A（有 PMID／DOI／網址）：/lookup → 書目預覽 → 確認 → 建立文件 → /summarize → 有附 PDF 或 oa_url 就開解析視窗自動解析
// 流程 B（只有 PDF）：直接開解析視窗（不送標題，Worker 先輸出 <biblio> 書目）→ 解析完成後 onBiblio 建立文件 → 背景跑 /summarize
// 對到 articles.json 已有的文章（PMID 或 DOI 相同）時不建立，提示「這篇已在儀表板」並開那張卡。
//
// 文件 ID：有 PMID 用 PMID；沒有 PMID 有 DOI 用 "doi_" + DOI（小寫，/ 和 . 換成 _）；都沒有用 "manual_" + 8 碼隨機。

import { paperState, onAuthChange, AuthRequiredError } from "./state.js";
import { $, esc, toast, authRequiredMessage } from "./util.js";
import { openAnalysis, workerFetch, PENDING_ID } from "./analysis.js";

const { addManual, setSummary, getManual } = paperState;
const MAX_PDF = 15_000_000; // 同 analysis.js

let hooks = null; // { findExisting({ pmid, doi }), showArticle(article) }，由 papers.js 提供
let authStatus = "unknown";

// 對話框狀態：phase = form | lookup | preview | saving | error
let st = null;

// ---------- 工具 ----------

function cleanDoi(doi) {
  return String(doi || "").trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "");
}

export function docIdFor(b) {
  if (/^\d+$/.test(b.pmid || "")) return b.pmid;
  const doi = cleanDoi(b.doi).toLowerCase();
  if (doi) return `doi_${doi.replace(/[/.]/g, "_")}`;
  const rnd = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
  return `manual_${rnd.replace(/-/g, "").slice(0, 8)}`;
}

// 已在儀表板（articles.json）或已在自選 → 回傳 { article, where }
function existing(b) {
  const inFeed = hooks.findExisting({ pmid: b.pmid, doi: cleanDoi(b.doi) });
  if (inFeed) return { article: inFeed, where: "feed" };
  if (b.pmid || b.doi) {
    const manual = getManual(docIdFor(b));
    if (manual) return { article: manual.article, where: "manual" };
  }
  return null;
}

function goTo(found, file) {
  toast(found.where === "feed" ? "這篇已在儀表板" : "這篇已在自選");
  close(true);
  hooks.showArticle(found.article);
  openAnalysis(found.article, file ? { file } : {});
}

// 產生 AI 摘要；失敗回傳錯誤訊息（文章照樣留著，卡片沒有中文 headline），成功回傳 null
async function summarize(id, b) {
  try {
    const res = await workerFetch("/summarize", {
      title: b.title, abstract: b.abstract || "", journal: b.journal || "",
      journal_full: b.journal_full || "", pub_date: b.pub_date || "", year: b.year || "",
    });
    await setSummary(id, await res.json());
    return null;
  } catch (err) {
    console.warn("AI 摘要失敗", err);
    return `AI 摘要產生失敗（${err.message}）`;
  }
}

// ---------- 流程 ----------

async function submit() {
  const query = st.query.trim();
  if (authStatus !== "signedIn") {
    toast(authRequiredMessage(authStatus));
    return;
  }
  if (!query && !st.file) return;

  // 流程 B：只有 PDF
  if (!query) {
    const file = st.file;
    close(true);
    openAnalysis({ pmid: PENDING_ID, title: "", topics: [] }, { file, onBiblio });
    return;
  }

  // 流程 A：先查本機（純 PMID 不用等 Worker）
  if (/^\d{1,9}$/.test(query)) {
    const found = existing({ pmid: query });
    if (found) return goTo(found, st.file);
  }
  const cur = st;
  cur.phase = "lookup";
  render();
  try {
    const res = await workerFetch("/lookup", { query });
    const b = await res.json();
    if (st !== cur) return;
    const found = existing(b);
    if (found) return goTo(found, cur.file);
    cur.biblio = b;
    cur.phase = "preview";
  } catch (err) {
    if (st !== cur) return;
    console.warn("書目查詢失敗", err);
    cur.phase = "error";
    cur.error = err instanceof AuthRequiredError ? authRequiredMessage(authStatus)
      : err.status === 404 ? `${err.message}。可以改成只上傳 PDF。` : err.message;
  }
  render();
}

async function confirmAdd() {
  const cur = st;
  const b = cur.biblio;
  const id = docIdFor(b);
  cur.phase = "saving";
  render();
  try {
    await addManual(id, b);
  } catch (err) {
    cur.phase = "error";
    cur.error = err instanceof AuthRequiredError ? authRequiredMessage(authStatus) : "建立文章失敗（同步錯誤），請再試一次";
    render();
    return;
  }
  const summaryError = await summarize(id, b);
  const article = getManual(id)?.article;
  close(true);
  if (!article) return;
  hooks.showArticle(article);
  if (cur.file) openAnalysis(article, { file: cur.file });
  else if (article.oa_url) openAnalysis(article, { autoOa: true });
  if (summaryError) toast(`已加入自選，但${summaryError}`);
  else if (!cur.file && !article.oa_url) toast("已加入自選；沒有 OA 全文，要解析請在卡片按「解析」上傳 PDF");
}

// 流程 B 的解析完成後由 analysis.js 呼叫：用讀出的書目建立文章（有 DOI 時先 /lookup 補齊 PMID、卷期、OA）
async function onBiblio(raw, { fileName }) {
  let b = {
    title: String(raw.title || "").trim() || fileName.replace(/\.pdf$/i, "") || "未命名 PDF",
    authors: Array.isArray(raw.authors) ? raw.authors.map(String).filter(Boolean) : [],
    journal: String(raw.journal || "").replace(/\./g, "").trim(),
    journal_full: String(raw.journal_full || "").trim(),
    year: String(raw.year || "").match(/\d{4}/)?.[0] || "",
    doi: cleanDoi(raw.doi),
    abstract: String(raw.abstract || "").trim(),
    pmid: "",
  };
  if (b.doi) {
    try {
      const looked = await (await workerFetch("/lookup", { query: b.doi })).json();
      b = { ...looked, abstract: looked.abstract || b.abstract };
    } catch (err) {
      console.warn("PDF 書目的 DOI 查不到，改用 PDF 讀出的書目", err);
    }
  }
  const found = existing(b);
  if (found) {
    toast(found.where === "feed" ? "這篇已在儀表板，解析存到既有卡片" : "這篇已在自選，解析存到那張卡片");
    hooks.showArticle(found.article);
    return found.article;
  }
  const id = docIdFor(b);
  await addManual(id, b);
  summarize(id, b).then((msg) => msg && toast(msg)); // 不等，解析先存
  const article = getManual(id).article;
  hooks.showArticle(article);
  return article;
}

// ---------- 渲染 ----------

function fileRow() {
  if (!st.file) {
    return `<button type="button" class="an-btn add-pick" data-act="pick">選擇 PDF</button>`;
  }
  return `<div class="add-file">
    <span class="add-file-name">📄 ${esc(st.file.name)}<small>${(st.file.size / 1e6).toFixed(1)} MB</small></span>
    <button type="button" class="an-btn an-small" data-act="unpick">移除</button>
  </div>`;
}

function authorLine(authors) {
  if (!authors?.length) return "";
  return authors.length > 3 ? `${authors.slice(0, 3).join(", ")} 等 ${authors.length} 人` : authors.join(", ");
}

function renderPreview(b) {
  const next = st.file ? "加入後用你附的 PDF 做全文解析。"
    : b.oa_url ? `有 OA 全文${b.oa_pdf ? "（PDF）" : ""}，加入後自動抓全文解析。`
      : "沒有 OA 全文；加入後可在卡片按「解析」上傳 PDF。";
  return `
    <div class="add-preview">
      <p class="add-preview-title">${esc(b.title)}</p>
      ${b.authors?.length ? `<p class="add-preview-meta">${esc(authorLine(b.authors))}</p>` : ""}
      <p class="add-preview-meta">${[b.journal_full || b.journal, b.year, b.volume && `${b.volume}${b.issue ? `(${b.issue})` : ""}`, b.pages].filter(Boolean).map(esc).join(" · ")}</p>
      <p class="add-preview-meta">${[b.pmid && `PMID ${b.pmid}`, b.doi && `DOI ${b.doi}`].filter(Boolean).map(esc).join(" · ")}</p>
      ${b.abstract ? `<p class="add-preview-abs">${esc(b.abstract)}</p>` : `<p class="add-preview-meta">（沒有摘要，AI 摘要會只依標題）</p>`}
    </div>
    <p class="an-notice">${esc(next)}</p>
    <div class="an-choose">
      <button type="button" class="an-btn an-primary" data-act="confirm">確認加入</button>
      <button type="button" class="an-btn" data-act="back">返回修改</button>
    </div>`;
}

function render() {
  if (!st) return;
  let html;
  switch (st.phase) {
    case "form":
      html = `
        <form class="add-form" id="add-form" novalidate>
          <label class="add-label" for="add-query">PMID、DOI 或 PubMed 網址</label>
          <input class="add-input" id="add-query" type="text" value="${esc(st.query)}" autocomplete="off"
            autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go"
            placeholder="例如 38123456、10.1097/PRS.…">
          <p class="add-label">PDF 全文（選填）</p>
          ${fileRow()}
          <p class="an-notice">兩項至少填一項。只給 PDF 也可以：會從全文讀出書目。</p>
          <div class="an-choose">
            <button type="submit" class="an-btn an-primary" id="add-submit"${st.query.trim() || st.file ? "" : " disabled"}>下一步</button>
          </div>
        </form>`;
      break;
    case "lookup":
      html = `<div class="an-row"><span class="an-status">查詢書目中…</span></div>`;
      break;
    case "preview":
      html = renderPreview(st.biblio);
      break;
    case "saving":
      html = `<div class="an-row"><span class="an-status">建立文章、產生 AI 摘要中…</span></div>`;
      break;
    case "error":
      html = `<p class="an-error">${esc(st.error)}</p>
        <div class="an-choose"><button type="button" class="an-btn" data-act="back">返回修改</button></div>`;
      break;
  }
  $("add-body").innerHTML = html;
}

// ---------- 事件 ----------

export function openAddArticle() {
  if (authStatus !== "signedIn") {
    toast(authRequiredMessage(authStatus));
    return;
  }
  st = { phase: "form", query: "", file: null };
  render();
  $("add-dialog").showModal();
  document.documentElement.classList.add("an-open");
  // 手機上自動聚焦會跳出鍵盤蓋住「選擇 PDF」，只在寬螢幕聚焦
  if (matchMedia("(min-width: 640px)").matches) $("add-query")?.focus();
}

function close(force = false) {
  if (!st) return;
  if (!force && st.phase === "saving") return; // 建立中不要關（文件寫一半）
  st = null;
  $("add-dialog").close();
  if (!$("analysis-dialog").open) document.documentElement.classList.remove("an-open");
}

export function initAddArticle(h) {
  hooks = h;
  const dlg = $("add-dialog");
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) return close();
    const el = e.target.closest("[data-act]");
    if (!el || !st) return;
    switch (el.dataset.act) {
      case "close": return close();
      case "pick": {
        const input = $("add-file");
        input.value = "";
        return input.click();
      }
      case "unpick":
        st.file = null;
        return render();
      case "back":
        st.phase = "form";
        return render();
      case "confirm":
        return confirmAdd();
    }
  });
  dlg.addEventListener("input", (e) => {
    if (e.target.id !== "add-query" || !st) return;
    st.query = e.target.value;
    $("add-submit").disabled = !(st.query.trim() || st.file);
  });
  dlg.addEventListener("submit", (e) => {
    e.preventDefault();
    if (st?.phase === "form") submit();
  });
  $("add-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file || !st) return;
    if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
      toast("請選擇 PDF 檔");
      return;
    }
    if (file.size > MAX_PDF) {
      toast(`檔案 ${(file.size / 1e6).toFixed(1)} MB，超過上限 15 MB`);
      return;
    }
    st.file = file;
    render();
  });
  onAuthChange(({ status }) => {
    authStatus = status;
    if (status !== "signedIn" && st) close(true);
  });
}
