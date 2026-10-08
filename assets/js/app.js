import { getAllStates, setRead, setSaved, getAllSaved } from "./state.js";

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

const ui = {
  tab: "new",     // new | saved
  topic: "all",   // all | topic id
  range: "7",     // 7 | 30 | all
  hideRead: false,
};
let articles = [];        // 來自 articles.json
let states = new Map();   // pmid → { read, saved }
let savedList = [];       // getAllSaved() 結果
const expanded = new Set();

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

// 目前分頁＋時間範圍內的文章（主題、隱藏已讀之前）
function scopeArticles() {
  if (ui.tab === "saved") {
    const byPmid = new Map(articles.map((a) => [a.pmid, a]));
    return savedList
      .map((s) => byPmid.get(s.pmid) || s.article)
      .filter(Boolean)
      .sort(compareArticles);
  }
  if (ui.range === "all") return articles;
  const cutoff = Date.now() - Number(ui.range) * DAY;
  return articles.filter((a) => Date.parse(a.added_at) >= cutoff);
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

function renderCard(a) {
  const st = states.get(a.pmid) || {};
  const open = expanded.has(a.pmid);
  const jClass = JOURNALS.includes(a.journal) ? `j-${a.journal.toLowerCase()}` : "j-other";
  const topics = (a.topics || []).map((t) =>
    `<span class="topic">${esc(TOPIC_NAME[t] || t)}</span>`).join("");
  return `
  <article class="card${st.read ? " is-read" : ""}${open ? " is-open" : ""}" data-pmid="${esc(a.pmid)}">
    <h2 class="card-title">
      <button type="button" class="title-btn" data-act="toggle" aria-expanded="${open}">${esc(a.title)}</button>
    </h2>
    <div class="card-meta">
      <span class="journal ${jClass}">${esc(a.journal)}</span>
      <time datetime="${esc(a.pub_date)}">${esc(a.pub_date)}</time>
    </div>
    <div class="abstract" data-act="toggle">${renderAbstract(a.abstract)}</div>
    ${topics ? `<div class="topics">${topics}</div>` : ""}
    <div class="actions">
      <button type="button" class="act act-read" data-act="read" aria-pressed="${!!st.read}">${st.read ? "✓ 已讀" : "已讀"}</button>
      <button type="button" class="act act-save" data-act="save" aria-pressed="${!!st.saved}">${st.saved ? "★ 已收藏" : "☆ 收藏"}</button>
      <a class="act act-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">看全文 ↗</a>
    </div>
  </article>`;
}

function render() {
  const scope = scopeArticles();
  const list = visibleArticles(scope);
  renderControls(scope);

  $("result-count").textContent = list.length ? `${list.length} 篇` : "";
  if (list.length) {
    $("list").innerHTML = list.map(renderCard).join("");
    return;
  }
  let msg;
  if (ui.tab === "saved" && !savedList.length) {
    msg = "還沒有收藏的文章。<br>在「新進」按下「☆ 收藏」，文章就會出現在這裡。";
  } else if (ui.tab === "new" && ui.hideRead && scope.length) {
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

// ---------- 事件 ----------

function bindEvents() {
  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b || b.dataset.tab === ui.tab) return;
    ui.tab = b.dataset.tab;
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
      case "read":
        await setRead(pmid, !st.read);
        break;
      case "save": {
        const article = articles.find((a) => a.pmid === pmid) ||
          savedList.find((s) => s.pmid === pmid)?.article || null;
        await setSaved(pmid, !st.saved, article);
        savedList = await getAllSaved();
        break;
      }
      default:
        return;
    }
    states = await getAllStates();
    render();
  });
}

// ---------- 啟動 ----------

async function init() {
  loadPrefs();
  bindEvents();
  try {
    const res = await fetch("data/articles.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    articles = (data.articles || []).slice().sort(compareArticles);
    [states, savedList] = await Promise.all([getAllStates(), getAllSaved()]);
    renderMeta(data.generated_at);
    render();
  } catch (err) {
    console.error(err);
    $("meta").textContent = "";
    $("list").innerHTML = `<p class="empty error">文章資料載入失敗（${esc(err.message)}）。<br>請稍後重新整理；本機預覽請用 Live Server，不要用 file:// 開啟。</p>`;
  }
}

init();
