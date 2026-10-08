import {
  getAllStates, setRead, setSaved, setNote, getAllSaved, getAllRead,
  onAuthChange, onStatesChange, signIn, signOutUser, AuthRequiredError,
} from "./state.js";

const TOPICS = [
  { id: "contour", name: "輪廓與正顎" },
  { id: "wound", name: "慢性傷口" },
  { id: "eye", name: "眼周" },
  { id: "nose", name: "鼻整形" },
  { id: "rejuv", name: "年輕化" },
];
const TOPIC_NAME = Object.fromEntries(TOPICS.map((t) => [t.id, t.name]));
const JOURNALS = ["PRS", "PRS-GO", "ASJ", "APS", "IJOMS"];
const DAY = 24 * 60 * 60 * 1000;
const PREFS_KEY = "mdr.prefs.v1";
const SEARCH_DELAY = 200;
const NOTE_DELAY = 800;

const ui = {
  tab: "new",     // new | saved | read
  topic: "all",   // all | topic id
  range: "7",     // 7 | 30 | all
  hideRead: false,
  query: "",      // 關鍵字搜尋；不存 localStorage，換分頁時清空
};
let articles = [];        // 來自 articles.json
let states = new Map();   // pmid → { read, saved }
let savedList = [];       // getAllSaved() 結果
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

const $ = (id) => document.getElementById(id);

// ---------- 工具 ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

const twDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
});
const twStamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

function formatUpdated(iso) {
  const parts = Object.fromEntries(
    twStamp.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

// added_at 依台灣日期比「同日」，同日再比 pub_date，最後比 pmid
function compareArticles(a, b) {
  const da = twDay.format(new Date(a.added_at));
  const db = twDay.format(new Date(b.added_at));
  if (da !== db) return da < db ? 1 : -1;
  if (a.pub_date !== b.pub_date) return a.pub_date < b.pub_date ? 1 : -1;
  return Number(b.pmid) - Number(a.pmid);
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    if (["7", "30", "all"].includes(p.range)) ui.range = p.range;
    if (typeof p.hideRead === "boolean") ui.hideRead = p.hideRead;
  } catch { /* 用預設值 */ }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY,
      JSON.stringify({ range: ui.range, hideRead: ui.hideRead }));
  } catch { /* 忽略 */ }
}

// ---------- 資料 ----------

// 目前分頁＋時間範圍內的文章（搜尋、主題、隱藏已讀之前）
// 「稍後細讀」「已讀」以 Firestore 副本為主，articles.json 仍有該篇時改用完整資料（含摘要）
function scopeArticles() {
  if (ui.tab === "saved" || ui.tab === "read") {
    const byPmid = new Map(articles.map((a) => [a.pmid, a]));
    const list = (ui.tab === "saved" ? savedList : readList)
      .map((s) => byPmid.get(s.pmid) || s.article);
    return ui.tab === "saved" ? list.sort(compareArticles) : list; // readList 已依 readAt 排好
  }
  if (ui.range === "all") return articles;
  const cutoff = Date.now() - Number(ui.range) * DAY;
  return articles.filter((a) => Date.parse(a.added_at) >= cutoff);
}

function noteOf(pmid) {
  if (noteDrafts.has(pmid)) return noteDrafts.get(pmid);
  return savedList.find((s) => s.pmid === pmid)?.note || "";
}

// 空白分隔多詞為 AND；比對標題＋摘要，「稍後細讀」另含筆記
function searchArticles(scope) {
  const terms = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return scope;
  return scope.filter((a) => {
    let hay = `${a.title}\n${a.abstract}`;
    if (ui.tab === "saved") hay += `\n${noteOf(a.pmid)}`;
    hay = hay.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

function visibleArticles(scope) {
  return scope.filter((a) =>
    (ui.topic === "all" || a.topics.includes(ui.topic)) &&
    !(ui.tab === "new" && ui.hideRead && states.get(a.pmid)?.read));
}

// ---------- 渲染 ----------

function renderControls(scope) {
  document.querySelectorAll(".tab").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab)));
  $("saved-count").textContent = savedList.length ? savedList.length : "";

  const counts = { all: scope.length };
  for (const t of TOPICS) counts[t.id] = scope.filter((a) => a.topics.includes(t.id)).length;
  $("topics").innerHTML = [{ id: "all", name: "全部" }, ...TOPICS].map((t) => `
    <button type="button" class="pill" role="radio" data-topic="${t.id}"
      aria-checked="${ui.topic === t.id}">${esc(t.name)}<span class="pill-count">${counts[t.id]}</span></button>`
  ).join("");

  $("search").placeholder = ui.tab === "saved" ? "搜尋標題、摘要、筆記" : "搜尋標題、摘要";
  $("search-clear").hidden = !$("search").value;

  $("subbar").hidden = ui.tab !== "new";
  document.querySelectorAll(".seg").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.range === ui.range)));
  $("hide-read").checked = ui.hideRead;
}

function renderAbstract(text) {
  if (!text) return `<p class="muted">（PubMed 無摘要）</p>`;
  return text.split(/\n\s*\n/).map((para) => {
    const m = para.match(/^([A-Z][A-Z0-9 ,&/()-]{1,40}):\s*(.*)$/s);
    return m
      ? `<p><span class="abs-label">${esc(m[1])}</span> ${esc(m[2])}</p>`
      : `<p>${esc(para)}</p>`;
  }).join("");
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
  const withNote = ui.tab === "saved";
  const pdf = a.oa_url ? `<a class="act act-link act-pdf" href="${esc(a.oa_url)}" target="_blank" rel="noopener noreferrer">PDF ↗</a>` : "";
  const jClass = JOURNALS.includes(a.journal) ? `j-${a.journal.toLowerCase()}` : "j-other";
  const topics = (a.topics || []).map((t) =>
    `<span class="topic">${esc(TOPIC_NAME[t] || t)}</span>`).join("");
  return `
  <article class="card${st.read && ui.tab !== "read" ? " is-read" : ""}${open ? " is-open" : ""}" data-pmid="${esc(a.pmid)}">
    <h2 class="card-title">
      <button type="button" class="title-btn" data-act="toggle" aria-expanded="${open}">${esc(a.title || `PMID ${a.pmid}`)}</button>
    </h2>
    <div class="card-meta">
      ${a.journal ? `<span class="journal ${jClass}">${esc(a.journal)}</span>` : ""}
      <time datetime="${esc(a.pub_date)}">${esc(a.pub_date)}</time>
    </div>
    ${ui.tab === "read" ? `<p class="read-at">${readAt ? `已讀於 ${twDay.format(new Date(readAt))}` : "已讀日期不明"}</p>` : ""}
    <div class="abstract" data-act="toggle">${renderAbstract(a.abstract)}</div>
    ${topics ? `<div class="topics">${topics}</div>` : ""}
    ${withNote ? renderNote(a.pmid) : ""}
    <div class="actions${withNote ? " has-note" : ""}${pdf ? " has-pdf" : ""}">
      <button type="button" class="act act-read" data-act="read" aria-pressed="${!!st.read}">${st.read ? "✓ 已讀" : "已讀"}</button>
      <button type="button" class="act act-save" data-act="save" aria-pressed="${!!st.saved}">${st.saved ? "★ 已收藏" : "☆ 收藏"}</button>
      ${withNote ? `<button type="button" class="act act-note" data-act="note" aria-expanded="${editingNote === a.pmid}">✎ 筆記</button>` : ""}
      <a class="act act-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">看全文 ↗</a>
      ${pdf}
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
  const personal = ui.tab !== "new"; // 「稍後細讀」「已讀」需登入
  let msg;
  if (personal && authStatus === "unknown") {
    msg = "載入中…";
  } else if (personal && authStatus === "unavailable") {
    msg = "同步服務載入失敗，請重新整理頁面。";
  } else if (personal && authStatus !== "signedIn") {
    msg = ui.tab === "saved" ? "登入後才能看到收藏。" : "登入後才能看到已讀紀錄。";
  } else if (ui.tab === "saved" && !savedList.length) {
    msg = "還沒有收藏的文章。<br>在「新進」按下「☆ 收藏」，文章就會出現在這裡。";
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
  const parts = [`${articles.length} 篇`];
  if (generatedAt) parts.push(`更新：${formatUpdated(generatedAt)}`);
  $("meta").textContent = parts.join(" · ");
}

// ---------- RIS 匯出 ----------

// 「稍後細讀」目前篩選條件下列出的文章（scopeArticles 已優先用 articles.json 的完整資料）
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

// ---------- 提示訊息 ----------

let toastTimer = 0;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function authRequiredMessage() {
  return authStatus === "unavailable" ? "同步服務載入失敗，請重新整理頁面" : "請先登入";
}

// ---------- 登入 ----------

function loginErrorMessage(err) {
  switch (err?.code) {
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
    case "auth/user-disabled":
      return "Email 或密碼不正確";
    case "auth/too-many-requests":
      return "嘗試次數過多，請稍後再試";
    case "auth/network-request-failed":
      return "網路連線失敗，請稍後再試";
    default:
      return "登入失敗，請稍後再試";
  }
}

function setLoginOpen(open) {
  $("login-form").hidden = !open;
  $("login-btn").setAttribute("aria-expanded", String(open));
  if (open) {
    $("login-error").textContent = "";
    $("login-email").focus();
  }
}

function renderAccount({ status, email }) {
  authStatus = status;
  $("login-btn").hidden = status !== "signedOut";
  $("logout-btn").hidden = status !== "signedIn";
  $("logout-btn").title = email ? `已登入：${email}` : "";
  if (status !== "signedOut") setLoginOpen(false);
}

function bindAuth() {
  $("login-btn").addEventListener("click", () => setLoginOpen($("login-form").hidden));

  $("logout-btn").addEventListener("click", async () => {
    try {
      await signOutUser();
    } catch (err) {
      console.error(err);
      toast("登出失敗，請稍後再試");
    }
  });

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) {
      $("login-error").textContent = "請輸入 Email 和密碼";
      return;
    }
    const submit = $("login-submit");
    submit.disabled = true;
    submit.textContent = "登入中…";
    $("login-error").textContent = "";
    try {
      await signIn(email, password);
      $("login-password").value = "";
      setLoginOpen(false);
    } catch (err) {
      console.error("登入失敗", err);
      $("login-error").textContent = loginErrorMessage(err);
    } finally {
      submit.disabled = false;
      submit.textContent = "送出";
    }
  });

  // Esc 或點表單外面就收起來
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("login-form").hidden) {
      setLoginOpen(false);
      $("login-btn").focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!$("login-form").hidden && !e.target.closest("#account")) setLoginOpen(false);
  });

  onAuthChange((a) => {
    renderAccount(a);
    render();
  });
  onStatesChange(async () => {
    await refreshStates();
    render();
  });
}

async function refreshStates() {
  [states, savedList, readList] = await Promise.all([getAllStates(), getAllSaved(), getAllRead()]);
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
    toast(err instanceof AuthRequiredError ? authRequiredMessage() : "筆記同步失敗，內容已保留");
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

function bindSearch() {
  const input = $("search");
  let timer = 0;
  const apply = () => {
    clearTimeout(timer);
    ui.query = input.value;
    render();
  };
  input.addEventListener("input", (e) => {
    $("search-clear").hidden = !input.value;
    if (e.isComposing) return;
    clearTimeout(timer);
    timer = setTimeout(apply, SEARCH_DELAY);
  });
  input.addEventListener("compositionend", () => {
    clearTimeout(timer);
    timer = setTimeout(apply, SEARCH_DELAY);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      input.value = "";
      apply();
    }
  });
  $("search-clear").addEventListener("click", () => {
    input.value = "";
    apply();
    input.focus();
  });
}

function clearSearch() {
  $("search").value = "";
  ui.query = "";
}

// ---------- 事件 ----------

function bindEvents() {
  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b || b.dataset.tab === ui.tab) return;
    ui.tab = b.dataset.tab;
    clearSearch();
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
    savePrefs();
    render();
  });

  $("export-ris").addEventListener("click", exportRis);

  $("hide-read").addEventListener("change", (e) => {
    ui.hideRead = e.target.checked;
    savePrefs();
    render();
  });

  $("list").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    const card = e.target.closest(".card");
    if (!el || !card) return;
    const pmid = card.dataset.pmid;
    const st = states.get(pmid) || { read: false, saved: false };

    switch (el.dataset.act) {
      case "toggle": {
        // 在摘要上選取文字時不要收合
        if (el.classList.contains("abstract") && String(window.getSelection())) return;
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
      case "save":
        break;
      default:
        return;
    }
    if (authStatus !== "signedIn") {
      toast(authRequiredMessage());
      return;
    }
    // 樂觀更新：state.js 先改本地快取並觸發 onStatesChange 重繪，寫入失敗會自行回滾
    const article = articles.find((a) => a.pmid === pmid) ||
      savedList.find((s) => s.pmid === pmid)?.article ||
      readList.find((r) => r.pmid === pmid)?.article || null;
    try {
      if (el.dataset.act === "read") await setRead(pmid, !st.read, article);
      else await setSaved(pmid, !st.saved, article);
    } catch (err) {
      toast(err instanceof AuthRequiredError ? authRequiredMessage() : "同步失敗，已還原");
    }
  });
}

// ---------- 啟動 ----------

async function init() {
  loadPrefs();
  bindEvents();
  bindSearch();
  bindNotes();
  bindAuth();
  try {
    const res = await fetch("data/articles.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    articles = (data.articles || []).slice().sort(compareArticles);
    await refreshStates();
    loaded = true;
    renderMeta(data.generated_at);
    render();
  } catch (err) {
    console.error(err);
    $("meta").textContent = "";
    $("list").innerHTML = `<p class="empty error">文章資料載入失敗（${esc(err.message)}）。<br>請稍後重新整理；本機預覽請用 Live Server，不要用 file:// 開啟。</p>`;
  }
}

init();
