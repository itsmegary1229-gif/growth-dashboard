// 論文分區：articles.json＋Firestore userState。
// 子分頁「新進」「稍後細讀」「收藏」「已讀」、主題 pill、搜尋、AI 摘要與相關度排序、收藏筆記、RIS 匯出。

import { paperState, onAuthChange, AuthRequiredError } from "../state.js";
import {
  $, DAY, esc, twDay, metaText, toast, authRequiredMessage, bindSearch, loadPrefs, savePrefs, fetchJSON,
} from "../util.js";

const {
  getAllStates, setRead, setLater, setSaved, setNote, getAllLater, getAllSaved, getAllRead, onStatesChange,
} = paperState;

const TOPICS = [
  { id: "contour", name: "輪廓與正顎" },
  { id: "wound", name: "慢性傷口" },
  { id: "eye", name: "眼周" },
  { id: "nose", name: "鼻整形" },
  { id: "rejuv", name: "年輕化" },
];
const TOPIC_NAME = Object.fromEntries(TOPICS.map((t) => [t.id, t.name]));
const JOURNALS = ["PRS", "PRS-GO", "ASJ", "APS", "IJOMS"];
const PREFS_KEY = "mdr.prefs.v1";
const NOTE_DELAY = 800;

const ui = {
  tab: "new",     // new | later（稍後細讀佇列）| saved（收藏書庫）| read
  topic: "all",   // all | topic id
  range: "7",     // 7 | 30 | all
  hideRead: false,
  sort: "rel",    // rel | time（只用在「新進」）
  query: "",      // 關鍵字搜尋；不存 localStorage，換分頁時清空
};
let articles = [];        // 來自 articles.json
let states = new Map();   // pmid → { read, later, saved }
let laterList = [];       // getAllLater() 結果（laterAt 新到舊）
let savedList = [];       // getAllSaved() 結果（savedAt 新到舊）
let readList = [];        // getAllRead() 結果（readAt 新到舊）
let authStatus = "unknown"; // unknown | signedIn | signedOut | unavailable
let loaded = false;       // articles.json 載入完成前不渲染列表
const expanded = new Set();

// 筆記編輯狀態
let editingNote = null;       // 正在編輯筆記的 pmid
let focusNote = null;         // 下次渲染後要聚焦的筆記 pmid
const noteDrafts = new Map(); // pmid → 尚未成功寫入的輸入內容（優先於 Firestore 的值）
const noteTimers = new Map(); // pmid → 停止輸入後寫入的計時器

// 筆記框聚焦時不重繪列表（避免打斷注音輸入）；在筆記框聚焦狀態下按下滑鼠／手指時，
// 也先不重繪，等這次點擊完成，免得失焦重繪把使用者要點的按鈕換掉
let renderPending = false;
let pointerHeld = false;

// ---------- 工具 ----------

// added_at 依台灣日期比「同日」，同日再比 pub_date，最後比 pmid
function compareArticles(a, b) {
  const da = twDay.format(new Date(a.added_at));
  const db = twDay.format(new Date(b.added_at));
  if (da !== db) return da < db ? 1 : -1;
  if (a.pub_date !== b.pub_date) return a.pub_date < b.pub_date ? 1 : -1;
  return Number(b.pmid) - Number(a.pmid);
}

// 尚未摘要或摘要失敗的文章沒有分數，當 3 分（中間）排，免得新文章沉到最底
const UNSCORED = 3;
function relevanceOf(a) {
  const r = a.summary_zh?.relevance;
  return Number.isInteger(r) ? r : null;
}

// 「新進」的相關度排序：relevance 高→低，同分依原本的時間排序
function compareByRelevance(a, b) {
  const d = (relevanceOf(b) ?? UNSCORED) - (relevanceOf(a) ?? UNSCORED);
  return d || compareArticles(a, b);
}

function restorePrefs() {
  const p = loadPrefs(PREFS_KEY);
  if (["7", "30", "all"].includes(p.range)) ui.range = p.range;
  if (typeof p.hideRead === "boolean") ui.hideRead = p.hideRead;
  if (["rel", "time"].includes(p.sort)) ui.sort = p.sort;
}

function storePrefs() {
  savePrefs(PREFS_KEY, { range: ui.range, hideRead: ui.hideRead, sort: ui.sort });
}

// ---------- 資料 ----------

// 目前分頁＋時間範圍內的文章（搜尋、主題、隱藏已讀之前）
// 「稍後細讀」「收藏」「已讀」以 Firestore 副本為主，articles.json 仍有該篇時改用完整資料（含摘要）；
// 三份清單在 state.js 已依各自的時間排好
const PERSONAL_LISTS = { later: () => laterList, saved: () => savedList, read: () => readList };

function scopeArticles() {
  if (PERSONAL_LISTS[ui.tab]) {
    const byPmid = new Map(articles.map((a) => [a.pmid, a]));
    return PERSONAL_LISTS[ui.tab]().map((s) => byPmid.get(s.pmid) || s.article);
  }
  if (ui.range === "all") return articles;
  const cutoff = Date.now() - Number(ui.range) * DAY;
  return articles.filter((a) => Date.parse(a.added_at) >= cutoff);
}

function noteOf(pmid) {
  if (noteDrafts.has(pmid)) return noteDrafts.get(pmid);
  return savedList.find((s) => s.pmid === pmid)?.note || "";
}

// 空白分隔多詞為 AND；比對標題＋摘要＋AI 摘要（headline、points），「收藏」另含筆記
function searchArticles(scope) {
  const terms = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return scope;
  return scope.filter((a) => {
    const s = a.summary_zh;
    let hay = `${a.title}\n${a.abstract}\n${s?.headline || ""}\n${(s?.points || []).join("\n")}`;
    if (ui.tab === "saved") hay += `\n${noteOf(a.pmid)}`;
    hay = hay.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

function visibleArticles(scope) {
  const list = scope.filter((a) =>
    (ui.topic === "all" || a.topics.includes(ui.topic)) &&
    !(ui.tab === "new" && ui.hideRead && states.get(a.pmid)?.read));
  // articles 本身已依時間排好；其他分頁維持各自的排序
  return ui.tab === "new" && ui.sort === "rel" ? list.sort(compareByRelevance) : list;
}

// ---------- 渲染 ----------

function renderControls(scope) {
  root.querySelectorAll(".tab").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab)));
  $("later-count").textContent = laterList.length ? laterList.length : "";

  const counts = { all: scope.length };
  for (const t of TOPICS) counts[t.id] = scope.filter((a) => a.topics.includes(t.id)).length;
  $("topics").innerHTML = [{ id: "all", name: "全部" }, ...TOPICS].map((t) => `
    <button type="button" class="pill" role="radio" data-topic="${t.id}"
      aria-checked="${ui.topic === t.id}">${esc(t.name)}<span class="pill-count">${counts[t.id]}</span></button>`
  ).join("");

  $("search").placeholder = ui.tab === "saved" ? "搜尋標題、摘要、筆記" : "搜尋標題、摘要";
  $("search-clear").hidden = !$("search").value;

  $("subbar").hidden = ui.tab !== "new";
  document.querySelectorAll("#range .seg").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.range === ui.range)));
  document.querySelectorAll(".sort-seg").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.sort === ui.sort)));
  $("hide-read").checked = ui.hideRead;
}

// renderAbstract／summaryOf／renderRelevance／journalClass 回顧分區也用
export function renderAbstract(text) {
  if (!text) return `<p class="muted">（PubMed 無摘要）</p>`;
  return text.split(/\n\s*\n/).map((para) => {
    const m = para.match(/^([A-Z][A-Z0-9 ,&/()-]{1,40}):\s*(.*)$/s);
    return m
      ? `<p><span class="abs-label">${esc(m[1])}</span> ${esc(m[2])}</p>`
      : `<p>${esc(para)}</p>`;
  }).join("");
}

// AI 摘要：summary_zh 不存在或是 { error } 時都不顯示
export function summaryOf(a) {
  const s = a.summary_zh;
  return s && !s.error && s.headline ? s : null;
}

export function renderRelevance(a) {
  const r = relevanceOf(a);
  if (r === null || summaryOf(a) === null) return "";
  const level = r >= 4 ? "high" : r <= 2 ? "low" : "mid";
  const reason = a.summary_zh.reason ? ` title="${esc(a.summary_zh.reason)}"` : "";
  return `<span class="rel rel-${level}"${reason}>相關 ${r}/5</span>`;
}

export function journalClass(journal) {
  return JOURNALS.includes(journal) ? `j-${journal.toLowerCase()}` : "j-other";
}

function renderPoints(s) {
  if (!s?.points?.length) return "";
  return `<ul class="points" data-act="toggle">${s.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
}

function renderNote(pmid) {
  const note = noteOf(pmid);
  if (editingNote === pmid) {
    return `<textarea class="note-input" rows="3" aria-label="筆記"
      placeholder="為什麼存這篇、想用在哪…">${esc(note)}</textarea>`;
  }
  if (!note.trim()) return "";
  return `<button type="button" class="note" data-act="note-edit" title="點擊編輯筆記">${esc(note)}</button>`;
}

function renderCard(a) {
  const st = states.get(a.pmid) || {};
  const open = expanded.has(a.pmid);
  const readAt = ui.tab === "read" ? readList.find((r) => r.pmid === a.pmid)?.readAt : null;
  const saved = ui.tab === "saved" ? savedList.find((s) => s.pmid === a.pmid) : null;
  const withNote = ui.tab === "saved";
  // Unpaywall 有 PDF 直連才標「PDF」，否則是 OA 落地頁
  const oa = a.oa_url ? `<a class="act act-link act-oa" href="${esc(a.oa_url)}" target="_blank" rel="noopener noreferrer">${a.oa_pdf ? "PDF ↗" : "OA 全文 ↗"}</a>` : "";
  const summary = summaryOf(a);
  const topics = (a.topics || []).map((t) =>
    `<span class="topic">${esc(TOPIC_NAME[t] || t)}</span>`).join("");
  return `
  <article class="card${st.read && ui.tab !== "read" ? " is-read" : ""}${open ? " is-open" : ""}" data-pmid="${esc(a.pmid)}">
    <h2 class="card-title">
      <button type="button" class="title-btn" data-act="toggle" aria-expanded="${open}">${esc(a.title || `PMID ${a.pmid}`)}</button>
    </h2>
    ${summary ? `<p class="headline">${esc(summary.headline)}</p>` : ""}
    <div class="card-meta">
      ${a.journal ? `<span class="journal ${journalClass(a.journal)}">${esc(a.journal)}</span>` : ""}
      ${renderRelevance(a)}
      <time datetime="${esc(a.pub_date)}">${esc(a.pub_date)}</time>
    </div>
    ${ui.tab === "read" ? `<p class="read-at">${readAt ? `已讀於 ${twDay.format(new Date(readAt))}` : "已讀日期不明"}</p>` : ""}
    ${saved?.reviewCount ? `<p class="review-stat">回顧 ${saved.reviewCount} 次${saved.reviewedAt ? ` · 上次 ${twDay.format(new Date(saved.reviewedAt))}` : ""}</p>` : ""}
    ${renderPoints(summary)}
    <div class="abstract" data-act="toggle">${renderAbstract(a.abstract)}</div>
    ${topics ? `<div class="topics">${topics}</div>` : ""}
    ${withNote ? renderNote(a.pmid) : ""}
    <div class="actions">
      <div class="act-group">
        <button type="button" class="act act-read" data-act="read" aria-pressed="${!!st.read}">${st.read ? "✓ 已讀" : "已讀"}</button>
        <button type="button" class="act act-later" data-act="later" aria-pressed="${!!st.later}">${st.later ? "✓ 稍後細讀" : "稍後細讀"}</button>
        <button type="button" class="act act-save" data-act="save" aria-pressed="${!!st.saved}">${st.saved ? "★ 已收藏" : "☆ 收藏"}</button>
      </div>
      <div class="act-group act-group-links">
        ${withNote ? `<button type="button" class="act act-note" data-act="note" aria-expanded="${editingNote === a.pmid}">✎ 筆記</button>` : ""}
        <a class="act act-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">看全文 ↗</a>
        ${oa}
      </div>
    </div>
  </article>`;
}

function noteFocused() {
  return !!document.activeElement?.classList.contains("note-input");
}

function render() {
  if (!loaded) return;
  if (pointerHeld || noteFocused()) {
    renderPending = true;
    return;
  }
  renderPending = false;

  const scope = scopeArticles();
  const searched = searchArticles(scope);
  const list = visibleArticles(searched);
  renderControls(searched);

  const searching = !!ui.query.trim();
  $("export-ris").hidden = !(ui.tab === "saved" && list.length);
  $("result-count").textContent =
    searching ? `符合 ${list.length} 篇` : list.length ? `${list.length} 篇` : "";
  if (list.length) {
    $("list").innerHTML = list.map(renderCard).join("");
    if (focusNote) {
      const ta = $("list").querySelector(`.card[data-pmid="${focusNote}"] .note-input`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
      focusNote = null;
    }
    return;
  }
  const personal = ui.tab !== "new"; // 「稍後細讀」「收藏」「已讀」需登入
  let msg;
  if (personal && authStatus === "unknown") {
    msg = "載入中…";
  } else if (personal && authStatus === "unavailable") {
    msg = "同步服務載入失敗，請重新整理頁面。";
  } else if (personal && authStatus !== "signedIn") {
    msg = { later: "登入後才能看到稍後細讀佇列。", saved: "登入後才能看到收藏。", read: "登入後才能看到已讀紀錄。" }[ui.tab];
  } else if (ui.tab === "later" && !laterList.length) {
    msg = "佇列是空的。<br>按下「稍後細讀」，文章就會排進這裡；標成已讀後自動離開。";
  } else if (ui.tab === "saved" && !savedList.length) {
    msg = "還沒有收藏的文章。<br>按下「☆ 收藏」，文章就會長期留在這裡，可以寫筆記、匯出 RIS。";
  } else if (ui.tab === "read" && !readList.length) {
    msg = "還沒有已讀的文章。<br>在「新進」按下「已讀」，文章就會依時間出現在這裡。";
  } else if (searching && !searched.length) {
    msg = `沒有符合「${esc(ui.query.trim())}」的文章。`;
  } else if (ui.tab === "new" && ui.hideRead && searched.length) {
    msg = "這個範圍的文章都讀完了 👏";
  } else {
    msg = "這個條件下沒有文章。";
  }
  $("list").innerHTML = `<p class="empty">${msg}</p>`;
}

function renderMeta(generatedAt) {
  setMeta(metaText(articles.length, "篇", generatedAt));
}

// ---------- RIS 匯出 ----------

// 「收藏」目前篩選條件下列出的文章（scopeArticles 已優先用 articles.json 的完整資料）
function exportArticles() {
  return visibleArticles(searchArticles(scopeArticles()));
}

// "Yang JR" → "Yang, J. R."（EndNote 依逗號拆姓名）；不是「姓 縮寫」格式的視為團體作者，
// 結尾加逗號讓 EndNote 當成機構名稱，不拆姓名
function risAuthor(name) {
  const m = name.match(/^(.+) (\p{Lu}{1,4})$/u);
  return m ? `${m[1]}, ${[...m[2]].map((c) => `${c}.`).join(" ")}` : `${name},`;
}

// "123-130" → SP/EP；PubMed 會省略結束頁的共同前綴（"1234-45" = 1234–1245），這裡補回；
// e 開頭的電子頁碼或其他格式整串放 SP
function risPages(pages) {
  const m = pages.match(/^(\d+)-(\d+)$/);
  if (!m) return [["SP", pages]];
  const [, sp, ep] = m;
  const full = ep.length < sp.length ? sp.slice(0, sp.length - ep.length) + ep : ep;
  return [["SP", sp], ["EP", full]];
}

function risRecord(a) {
  const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const fields = [["TY", "JOUR"]];
  for (const au of a.authors || []) fields.push(["AU", risAuthor(au)]);
  fields.push(
    ["TI", a.title],
    ["T2", a.journal],
    ["PY", a.year || (a.pub_date || "").slice(0, 4)],
    ["VL", a.volume],
    ["IS", a.issue],
    ...(a.pages ? risPages(a.pages) : []),
    ["DO", a.doi],
    ["AB", a.abstract],
    ["UR", a.url],
    ["AN", a.pmid],
    ["N1", noteOf(a.pmid)],
  );
  return fields
    .map(([tag, v]) => [tag, oneLine(v)])
    .filter(([, v]) => v)
    .map(([tag, v]) => `${tag}  - ${v}`)
    .concat("ER  - ")
    .join("\r\n");
}

function exportRis() {
  const list = exportArticles();
  if (!list.length) return;
  const text = list.map(risRecord).join("\r\n\r\n") + "\r\n";
  const blob = new Blob([text], { type: "application/x-research-info-systems;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `growth-dashboard_saved_${twDay.format(new Date()).replaceAll("-", "")}.ris`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已匯出 ${list.length} 篇`);
}

// ---------- 狀態 ----------

function bindState() {
  onAuthChange(({ status }) => {
    authStatus = status;
    render();
  });
  onStatesChange(async () => {
    await refreshStates();
    render();
  });
}

async function refreshStates() {
  [states, laterList, savedList, readList] = await Promise.all([
    getAllStates(), getAllLater(), getAllSaved(), getAllRead(),
  ]);
}

// ---------- 筆記 ----------

function storedNote(pmid) {
  return savedList.find((s) => s.pmid === pmid)?.note || "";
}

async function saveNote(pmid) {
  clearTimeout(noteTimers.get(pmid));
  noteTimers.delete(pmid);
  if (!noteDrafts.has(pmid)) return;
  const text = noteDrafts.get(pmid);
  if (text === storedNote(pmid)) {
    noteDrafts.delete(pmid);
    return;
  }
  try {
    await setNote(pmid, text);
    // 寫入期間又有新輸入的話留著草稿，等下一次寫入
    if (noteDrafts.get(pmid) === text) noteDrafts.delete(pmid);
  } catch (err) {
    // state.js 已回滾快取；草稿保留，重新打開編輯框讓使用者看到內容
    toast(err instanceof AuthRequiredError ? authRequiredMessage(authStatus) : "筆記同步失敗，內容已保留");
    if (!noteFocused()) editingNote = pmid;
    render();
  }
}

function scheduleNoteSave(pmid) {
  clearTimeout(noteTimers.get(pmid));
  noteTimers.set(pmid, setTimeout(() => saveNote(pmid), NOTE_DELAY));
}

function openNote(pmid) {
  editingNote = pmid;
  focusNote = pmid;
  render();
}

function bindNotes() {
  const list = $("list");
  const pmidOf = (el) => el.closest(".card")?.dataset.pmid;

  list.addEventListener("input", (e) => {
    if (!e.target.classList.contains("note-input")) return;
    const pmid = pmidOf(e.target);
    noteDrafts.set(pmid, e.target.value);
    if (!e.isComposing) scheduleNoteSave(pmid);
  });
  list.addEventListener("compositionend", (e) => {
    if (e.target.classList.contains("note-input")) scheduleNoteSave(pmidOf(e.target));
  });
  list.addEventListener("focusout", (e) => {
    if (!e.target.classList.contains("note-input")) return;
    const pmid = pmidOf(e.target);
    saveNote(pmid);
    if (editingNote === pmid) editingNote = null;
    render();
  });
  list.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target.classList.contains("note-input")) e.target.blur();
  });
  // 編輯中按「筆記」是要收起：不讓按鈕搶走焦點，交給 click 處理
  list.addEventListener("mousedown", (e) => {
    if (noteFocused() && e.target.closest('[data-act="note"]')) e.preventDefault();
  });

  document.addEventListener("pointerdown", () => { pointerHeld = noteFocused(); }, true);
  const release = () => {
    if (!pointerHeld) return;
    // 等這次 click 事件處理完再補重繪
    setTimeout(() => {
      pointerHeld = false;
      if (renderPending) render();
    }, 0);
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  window.addEventListener("blur", release);
}

// ---------- 搜尋 ----------

let clearSearch = () => {};

function bindSearchBox() {
  clearSearch = bindSearch($("search"), $("search-clear"), (value) => {
    ui.query = value;
    render();
  });
}

// ---------- 事件 ----------

function bindEvents() {
  root.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b || b.dataset.tab === ui.tab) return;
    ui.tab = b.dataset.tab;
    clearSearch();
    ui.query = "";
    render();
    window.scrollTo({ top: 0 });
  });

  $("topics").addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (!b) return;
    ui.topic = b.dataset.topic;
    render();
  });

  $("range").addEventListener("click", (e) => {
    const b = e.target.closest(".seg");
    if (!b) return;
    ui.range = b.dataset.range;
    storePrefs();
    render();
  });

  $("sort").addEventListener("click", (e) => {
    const b = e.target.closest(".sort-seg");
    if (!b) return;
    ui.sort = b.dataset.sort;
    storePrefs();
    render();
  });

  $("export-ris").addEventListener("click", exportRis);

  $("hide-read").addEventListener("change", (e) => {
    ui.hideRead = e.target.checked;
    storePrefs();
    render();
  });

  $("list").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    const card = e.target.closest(".card");
    if (!el || !card) return;
    const pmid = card.dataset.pmid;
    const st = states.get(pmid) || { read: false, later: false, saved: false };

    switch (el.dataset.act) {
      case "toggle": {
        // 在摘要／重點上選取文字時不要收合
        if (!el.classList.contains("title-btn") && String(window.getSelection())) return;
        const open = !expanded.has(pmid);
        open ? expanded.add(pmid) : expanded.delete(pmid);
        card.classList.toggle("is-open", open);
        card.querySelector(".title-btn").setAttribute("aria-expanded", String(open));
        return;
      }
      case "note":
        if (editingNote === pmid) {
          // 收起：失焦時會寫入並重繪；焦點不在框內時直接收
          const ta = card.querySelector(".note-input");
          if (ta && document.activeElement === ta) ta.blur();
          else { editingNote = null; render(); }
        } else {
          openNote(pmid);
        }
        return;
      case "note-edit":
        openNote(pmid);
        return;
      case "read":
      case "later":
      case "save":
        break;
      default:
        return;
    }
    if (authStatus !== "signedIn") {
      toast(authRequiredMessage(authStatus));
      return;
    }
    // 樂觀更新：state.js 先改本地快取並觸發 onStatesChange 重繪，寫入失敗會自行回滾
    const article = articles.find((a) => a.pmid === pmid) ||
      laterList.find((l) => l.pmid === pmid)?.article ||
      savedList.find((s) => s.pmid === pmid)?.article ||
      readList.find((r) => r.pmid === pmid)?.article || null;
    try {
      if (el.dataset.act === "read") await setRead(pmid, !st.read, article);
      else if (el.dataset.act === "later") await setLater(pmid, !st.later, article);
      else await setSaved(pmid, !st.saved, article);
    } catch (err) {
      toast(err instanceof AuthRequiredError ? authRequiredMessage(authStatus) : "同步失敗，已還原");
    }
  });
}

// ---------- 啟動 ----------

let root = null;
let setMeta = () => {};

// ctx.setMeta(text)：更新頁首這個分區的「N 篇 · 更新時間」
export async function init(ctx) {
  root = $("section-papers");
  setMeta = ctx.setMeta;
  restorePrefs();
  bindEvents();
  bindSearchBox();
  bindNotes();
  bindState();
  try {
    const data = await fetchJSON("data/articles.json");
    articles = (data.articles || []).slice().sort(compareArticles);
    await refreshStates();
    loaded = true;
    renderMeta(data.generated_at);
    render();
  } catch (err) {
    console.error(err);
    setMeta("");
    $("list").innerHTML = `<p class="empty error">文章資料載入失敗（${esc(err.message)}）。<br>請稍後重新整理；本機預覽請用 Live Server，不要用 file:// 開啟。</p>`;
  }
}
