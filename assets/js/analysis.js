// 論文全文解析（Handoff #10）：全幅對話框，論文分區各分頁與回顧區共用。
// 取得 PDF（OA 經 Worker /fetch-pdf 代抓，或使用者選檔）→ base64 送 Worker /analyze → SSE 串流顯示 → 寫 Firestore userState/{pmid}.analysis。
// 追問送 /ask，問答接在解析下方並一起寫回。PDF 只放在這次頁面的記憶體（pdfCache），不儲存；
// 重整後追問時，OA 來源自動重抓，上傳來源請使用者再選一次檔。
// Worker 程式在 repo 的 worker/ 目錄，prompt 在 worker/prompt.js。

import { paperState, onAuthChange, getIdToken, AuthRequiredError } from "./state.js";
import { $, esc, toast, authRequiredMessage } from "./util.js";
import { renderMarkdown } from "./markdown.js";

export const WORKER_URL = "https://growth-dashboard-analyze.growth-dashboard-analyze.workers.dev";
const MAX_PDF = 15_000_000; // Worker 請求上限 20 MB，base64 後約 4/3 倍
// 完成後預設展開的段落（標題文字見 worker/prompt.js）；串流中全部展開
const OPEN_SECTIONS = ["一句話", "主要結果", "步驟拆解"];

const { getAnalysis, setAnalysis } = paperState;

const pdfCache = new Map(); // pmid → { b64, source }，只在這次頁面
let authStatus = "unknown";

// 目前對話框的狀態
let s = null;
// {
//   article, phase: choose | fetching | streaming | done | error,
//   text, model, source, error, notice, abort, reanalyze（從已有解析按「重新解析」進來）,
//   ask: null | { q, a, phase: fetching | streaming | error, error, abort },
//   pendingQuestion（等使用者選檔後再送的追問）, fileFor: "analyze" | "ask"
// }

// ---------- 對外 ----------

export function hasAnalysis(pmid) {
  return !!getAnalysis(pmid)?.markdown;
}

// 搜尋用：解析全文＋追問
export function analysisSearchText(pmid) {
  const a = getAnalysis(pmid);
  if (!a?.markdown) return "";
  return [a.markdown, ...(a.qa || []).flatMap((x) => [x.q, x.a])].join("\n");
}

export function openAnalysis(article) {
  if (authStatus !== "signedIn") {
    toast(authRequiredMessage(authStatus));
    return;
  }
  const saved = getAnalysis(article.pmid);
  s = {
    article,
    phase: saved?.markdown ? "done" : "choose",
    text: "",
    ask: null,
  };
  $("an-title").textContent = article.title || `PMID ${article.pmid}`;
  $("an-ask-input").value = "";
  render();
  const dlg = $("analysis-dialog");
  if (!dlg.open) dlg.showModal();
  document.documentElement.classList.add("an-open");
  $("an-body").scrollTop = 0;
}

// ---------- Worker ----------

async function workerFetch(path, body, signal) {
  const token = await getIdToken();
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch { /* 保留狀態碼 */ }
    if (res.status === 401) msg = `登入已過期或帳號無權使用，請重新登入（${msg}）`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res;
}

// 讀 Worker 的 SSE：onText(片段)；回傳 done 事件的資料。取消時自己 cancel reader，不只靠 fetch 的 signal
async function readStream(res, signal, onText, onMeta) {
  const reader = res.body.getReader();
  const stop = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", stop);
  const dec = new TextDecoder();
  let buffer = "";
  let done = null;
  for (;;) {
    const { value, done: end } = await reader.read().catch((err) => {
      if (signal.aborted) return { done: true };
      throw err;
    });
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    if (end) break;
    buffer += dec.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const event = raw.match(/^event: (.*)$/m)?.[1];
      const data = raw.match(/^data: (.*)$/m)?.[1];
      if (!event || !data) continue;
      const d = JSON.parse(data);
      if (event === "text") onText(d.t);
      else if (event === "meta") onMeta?.(d);
      else if (event === "done") done = d;
      else if (event === "error") throw new Error(d.message);
    }
  }
  signal.removeEventListener("abort", stop);
  if (!done) throw new Error("連線中斷，回應不完整");
  return done;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function fetchOaPdf(signal) {
  const res = await workerFetch("/fetch-pdf", { url: s.article.oa_url }, signal);
  const b64 = await blobToBase64(await res.blob());
  pdfCache.set(s.article.pmid, { b64, source: "oa" });
  return b64;
}

async function readFile(file) {
  if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) throw new Error("請選擇 PDF 檔");
  if (file.size > MAX_PDF) throw new Error(`檔案 ${(file.size / 1e6).toFixed(1)} MB，超過上限 15 MB`);
  const b64 = await blobToBase64(file);
  if (!b64.startsWith("JVBER")) throw new Error("這個檔案不是有效的 PDF");
  pdfCache.set(s.article.pmid, { b64, source: "upload" });
  return b64;
}

const isAbort = (err) => err?.name === "AbortError";

// ---------- 解析 ----------

function articleYear(a) {
  return a.year || (a.pub_date || "").slice(0, 4);
}

function parseType(md) {
  return md.match(/文章類型\s*[:：]\s*\**\s*([^\n*]+)/)?.[1].trim() || "";
}

async function runAnalyze(source, file = null) {
  const cur = s;
  const pmid = cur.article.pmid;
  // 重新解析時保留舊的問答（只換解析本文）
  const keepQa = cur.reanalyze ? currentAnalysis()?.qa || [] : [];
  const ctrl = new AbortController();
  Object.assign(cur, { phase: source === "oa" ? "fetching" : "streaming", text: "", error: "", notice: "", abort: ctrl, source, model: "" });
  render();
  try {
    let b64;
    if (source === "oa") {
      try {
        // 這次頁面已抓過同一篇的 OA PDF（例如重新解析）就直接用
        const cached = pdfCache.get(pmid);
        b64 = cached?.source === "oa" ? cached.b64 : await fetchOaPdf(ctrl.signal);
      } catch (err) {
        if (isAbort(err) || err.status === 401 || err instanceof AuthRequiredError) throw err;
        throw Object.assign(new Error(`OA 全文抓不到：${err.message}。請改用「選擇 PDF」。`), { oaFailed: true });
      }
    } else {
      b64 = await readFile(file);
    }
    if (s !== cur) return;
    cur.phase = "streaming";
    render();
    const a = cur.article;
    const res = await workerFetch("/analyze", {
      pmid, title: a.title, journal: a.journal, year: articleYear(a), pdf_base64: b64,
    }, ctrl.signal);
    const done = await readStream(res, ctrl.signal, (t) => {
      cur.text += t;
      scheduleStreamPaint();
    }, (m) => {
      cur.model = m.model;
      if (s === cur) render();
    });
    if (done.stop_reason === "refusal") throw new Error("模型拒絕回答這篇（安全分類器）。可以換一個 PDF 版本再試。");
    const analysis = {
      markdown: cur.text,
      type: parseType(cur.text),
      model: done.model || cur.model,
      source,
      at: new Date().toISOString(),
      truncated: done.stop_reason === "max_tokens",
      qa: keepQa,
    };
    cur.phase = "done";
    cur.abort = null;
    cur.unsaved = analysis;
    render();
    await save(cur, analysis);
  } catch (err) {
    cur.abort = null;
    if (isAbort(err)) {
      cur.phase = cur.reanalyze ? "done" : "choose";
      cur.notice = "已取消";
    } else {
      console.warn("解析失敗", err);
      cur.phase = "error";
      cur.error = err instanceof AuthRequiredError ? authRequiredMessage(authStatus) : err.message;
      cur.oaFailed = !!err.oaFailed;
    }
    if (s === cur) render();
  }
}

async function save(cur, analysis) {
  try {
    await setAnalysis(cur.article.pmid, analysis, cur.article);
    cur.unsaved = null;
    cur.reanalyze = false;
  } catch (err) {
    toast(err instanceof AuthRequiredError ? authRequiredMessage(authStatus) : "解析已完成，但同步失敗；請按「重試儲存」");
  }
  if (s === cur) render();
}

// ---------- 追問 ----------

async function runAsk(question, file = null) {
  const cur = s;
  const analysis = currentAnalysis();
  if (!analysis) return;
  const pmid = cur.article.pmid;
  const ctrl = new AbortController();
  cur.ask = { q: question, a: "", phase: "fetching", abort: ctrl };
  render();
  try {
    let b64 = pdfCache.get(pmid)?.b64;
    if (!b64) b64 = file ? await readFile(file) : await fetchOaPdf(ctrl.signal);
    cur.ask.phase = "streaming";
    render();
    const res = await workerFetch("/ask", {
      pmid, question, title: cur.article.title, analysis: analysis.markdown, qa: analysis.qa || [], pdf_base64: b64,
    }, ctrl.signal);
    const done = await readStream(res, ctrl.signal, (t) => {
      cur.ask.a += t;
      scheduleStreamPaint();
    });
    if (done.stop_reason === "refusal") throw new Error("模型拒絕回答這個問題");
    const next = { ...analysis, qa: [...(analysis.qa || []), { q: question, a: cur.ask.a, at: new Date().toISOString() }] };
    cur.ask = null;
    cur.unsaved = next;
    if (s === cur) $("an-ask-input").value = "";
    render();
    await save(cur, next);
  } catch (err) {
    if (isAbort(err)) {
      cur.ask = null;
    } else {
      console.warn("追問失敗", err);
      cur.ask.phase = "error";
      cur.ask.error = err instanceof AuthRequiredError ? authRequiredMessage(authStatus) : err.message;
    }
    if (s === cur) render();
  }
}

// Firestore 的解析；剛完成但還沒同步成功的以本地為準
function currentAnalysis() {
  return s.unsaved || getAnalysis(s.article.pmid);
}

// ---------- 渲染 ----------

// 「## 標題」切段，可收合；第一行「文章類型：X」改成標籤
function renderAnalysisMd(md, streaming) {
  const lines = md.split("\n");
  const pre = [];
  const sections = [];
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) sections.push({ title: h[1].replace(/^\d+[.、]\s*/, "").trim(), body: [] });
    else if (sections.length) sections[sections.length - 1].body.push(line);
    else if (!/文章類型\s*[:：]/.test(line)) pre.push(line);
  }
  const type = parseType(md);
  return [
    type ? `<p class="an-type">${esc(type)}</p>` : "",
    pre.join("\n").trim() ? `<div class="md">${renderMarkdown(pre.join("\n"))}</div>` : "",
    ...sections.map((sec) => {
      const open = streaming || OPEN_SECTIONS.some((t) => sec.title.includes(t));
      return `<details class="an-sec"${open ? " open" : ""}>
        <summary>${esc(sec.title)}</summary>
        <div class="md">${renderMarkdown(sec.body.join("\n"))}</div>
      </details>`;
    }),
  ].join("");
}

function sourceButtons() {
  const a = s.article;
  return `<div class="an-choose">
    ${a.oa_url ? `<button type="button" class="an-btn an-primary" data-act="oa">用 OA 全文解析</button>` : ""}
    <button type="button" class="an-btn${a.oa_url ? "" : " an-primary"}" data-act="pick">選擇 PDF</button>
  </div>`;
}

function renderQa(analysis) {
  const items = (analysis?.qa || []).map((x) => `
    <div class="an-qa">
      <p class="an-q">${esc(x.q)}</p>
      <div class="an-a md">${renderMarkdown(x.a)}</div>
    </div>`);
  const k = s.ask;
  if (k) {
    const status = k.phase === "error"
      ? `<p class="an-error">${esc(k.error)}</p>
         <div class="an-row"><button type="button" class="an-btn" data-act="ask-retry">重試</button>
         <button type="button" class="an-btn" data-act="ask-dismiss">不問了</button></div>`
      : `<div class="an-row"><span class="an-status">${k.phase === "fetching" ? "取得全文中…" : "回答中…"}</span>
         <button type="button" class="an-btn an-small" data-act="ask-cancel">取消</button></div>`;
    items.push(`
    <div class="an-qa">
      <p class="an-q">${esc(k.q)}</p>
      <div class="an-a md" id="an-stream-ask">${renderMarkdown(k.a)}</div>
      ${status}
    </div>`);
  }
  return items.length ? `<h3 class="an-qa-title">追問</h3>${items.join("")}` : "";
}

function metaLine(a) {
  const when = a.at ? new Date(a.at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "short", timeStyle: "short" }) : "";
  return [a.source === "oa" ? "OA 全文" : "上傳 PDF", a.model, when].filter(Boolean).map(esc).join(" · ");
}

function render() {
  if (!s) return;
  const body = $("an-body");
  const analysis = currentAnalysis();
  let html = "";
  const notice = s.notice ? `<p class="an-notice">${esc(s.notice)}</p>` : "";

  switch (s.phase) {
    case "choose":
      html = `${notice}
        <p class="an-intro">用 Claude 讀全文，整理研究設計、主要結果、圖表重點、手術步驟、限制與臨床意義。
        PDF 只送去解析，不會儲存；上限 15 MB。</p>
        ${sourceButtons()}
        ${s.reanalyze ? `<div class="an-row"><button type="button" class="an-btn an-small" data-act="back">返回解析</button></div>` : ""}`;
      break;
    case "fetching":
      html = `<div class="an-row"><span class="an-status">正在取得 OA 全文…</span>
        <button type="button" class="an-btn an-small" data-act="cancel">取消</button></div>`;
      break;
    case "streaming":
      html = `<div class="an-row an-sticky"><span class="an-status">解析中…${s.model ? `（${esc(s.model)}）` : ""}</span>
        <button type="button" class="an-btn an-small" data-act="cancel">取消</button></div>
        <div id="an-stream">${s.text ? renderAnalysisMd(s.text, true) : `<p class="an-status">讀取全文中，通常 1–2 分鐘…</p>`}</div>`;
      break;
    case "error":
      html = `<p class="an-error">${esc(s.error)}</p>
        ${s.text ? `<div class="an-partial">${renderAnalysisMd(s.text, true)}</div>` : ""}
        ${s.oaFailed ? `<div class="an-choose"><button type="button" class="an-btn an-primary" data-act="pick">選擇 PDF</button></div>` : sourceButtons()}
        ${s.reanalyze ? `<div class="an-row"><button type="button" class="an-btn an-small" data-act="back">返回解析</button></div>` : ""}`;
      break;
    case "done":
      html = `${notice}
        <div class="an-row an-meta-row"><p class="an-meta">${metaLine(analysis)}</p>
          <button type="button" class="an-btn an-small" data-act="reanalyze">重新解析</button></div>
        ${analysis.truncated ? `<p class="an-notice">輸出達到長度上限，最後一段可能不完整；可以按「重新解析」重跑。</p>` : ""}
        ${s.unsaved && !s.ask ? `<div class="an-row"><span class="an-error">尚未同步到雲端</span>
          <button type="button" class="an-btn an-small" data-act="save-retry">重試儲存</button></div>` : ""}
        ${renderAnalysisMd(analysis.markdown, false)}
        ${renderQa(analysis)}`;
      break;
  }
  body.innerHTML = html;
  // 追問框只在有解析時顯示；追問進行中停用
  const form = $("an-ask");
  form.hidden = s.phase !== "done";
  const busy = !!s.ask && s.ask.phase !== "error";
  $("an-ask-input").disabled = busy;
  $("an-ask-send").disabled = busy;
}

// 串流時每個畫面只重繪一次，而且只換串流區塊（不動捲動位置、不重畫按鈕）
let paintQueued = false;
function scheduleStreamPaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (!s) return;
    if (s.ask) {
      const el = $("an-stream-ask");
      if (el) el.innerHTML = renderMarkdown(s.ask.a);
    } else if (s.phase === "streaming") {
      const el = $("an-stream");
      if (el) el.innerHTML = renderAnalysisMd(s.text, true);
    }
  });
}

// ---------- 事件 ----------

function busy() {
  return s && (s.phase === "fetching" || s.phase === "streaming" || (s.ask && s.ask.phase !== "error"));
}

function close(force = false) {
  if (!s) return;
  if (!force && busy() && !confirm("解析進行中，關閉會取消。確定關閉？")) return;
  s.abort?.abort();
  s.ask?.abort?.abort();
  s = null;
  $("analysis-dialog").close();
  document.documentElement.classList.remove("an-open");
}

function pickFile(forWhat) {
  s.fileFor = forWhat;
  const input = $("an-file");
  input.value = "";
  input.click();
}

function submitAsk() {
  const q = $("an-ask-input").value.trim();
  if (!q || !s || s.ask) return;
  const cached = pdfCache.get(s.article.pmid);
  const analysis = currentAnalysis();
  // 沒有這次頁面的 PDF：OA 來源自動重抓；上傳來源要使用者再選一次（click 必須在使用者操作的同一個事件內）
  if (!cached && !(analysis?.source === "oa" && s.article.oa_url)) {
    s.pendingQuestion = q;
    toast("追問需要全文，請再選一次 PDF");
    pickFile("ask");
    return;
  }
  runAsk(q);
}

function bind() {
  const dlg = $("analysis-dialog");
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault(); // Esc：交給 close() 決定要不要確認
    close();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) return close(); // 點背景
    const el = e.target.closest("[data-act]");
    if (!el || !s) return;
    switch (el.dataset.act) {
      case "close": return close();
      case "oa": return runAnalyze("oa");
      case "pick": return pickFile("analyze");
      case "cancel": return s.abort?.abort();
      case "back":
        s.phase = "done";
        s.reanalyze = false;
        return render();
      case "reanalyze":
        if (!confirm("重新解析會取代目前的解析（追問會保留）。確定？")) return;
        s.reanalyze = true;
        s.notice = "";
        s.phase = "choose";
        return render();
      case "save-retry": return save(s, s.unsaved);
      case "ask-cancel": return s.ask?.abort?.abort();
      case "ask-retry": {
        const q = s.ask.q;
        s.ask = null;
        $("an-ask-input").value = q;
        return submitAsk();
      }
      case "ask-dismiss":
        s.ask = null;
        return render();
    }
  });
  $("an-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file || !s) return;
    if (s.fileFor === "ask") {
      const q = s.pendingQuestion;
      s.pendingQuestion = null;
      if (q) runAsk(q, file);
    } else {
      runAnalyze("upload", file);
    }
  });
  $("an-ask").addEventListener("submit", (e) => {
    e.preventDefault();
    submitAsk();
  });
  // Enter 換行；⌘／Ctrl+Enter 送出
  $("an-ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      submitAsk();
    }
  });
  onAuthChange(({ status }) => {
    authStatus = status;
    if (status !== "signedIn" && s) close(true);
  });
}

bind();
