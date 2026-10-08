// 影片分區：videos.json（scripts/fetch_videos.py 由 YouTube RSS 產生）＋Firestore videoState。
// 子分頁「新進」「稍後看」「已看」、頻道 pill、搜尋（標題＋說明）。
// config/channels.json 為空或 videos.json 不存在時顯示「尚未設定頻道」。

import { videoState, onAuthChange, AuthRequiredError } from "../state.js";
import {
  $, DAY, esc, twDay, metaText, toast, authRequiredMessage, bindSearch, loadPrefs, savePrefs,
} from "../util.js";

const { getAllStates, setWatched, setLater, getAllLater, getAllWatched, onStatesChange } = videoState;

const PREFS_KEY = "mdr.prefs.videos.v1";

const ui = {
  tab: "new",       // new | later（稍後看佇列）| watched
  channel: "all",   // all | channel_name
  range: "7",       // 7 | 30 | all
  hideWatched: false,
  query: "",        // 不存 localStorage，換分頁時清空
};
let videos = [];          // 來自 videos.json，added_at 新到舊
let channels = [];        // config/channels.json 的顯示名稱（決定 pill 順序）
let states = new Map();   // video_id → { watched, later }
let laterList = [];       // getAllLater() 結果（laterAt 新到舊）
let watchedList = [];     // getAllWatched() 結果（watchedAt 新到舊）
let authStatus = "unknown";
let loaded = false;
const expanded = new Set();
let root = null;

function restorePrefs() {
  const p = loadPrefs(PREFS_KEY);
  if (["7", "30", "all"].includes(p.range)) ui.range = p.range;
  if (typeof p.hideWatched === "boolean") ui.hideWatched = p.hideWatched;
}

function storePrefs() {
  savePrefs(PREFS_KEY, { range: ui.range, hideWatched: ui.hideWatched });
}

// ---------- 資料 ----------

// 「稍後看」「已看」以 Firestore 副本為主，videos.json 仍有該支時改用完整資料（含說明、發布日期）
const PERSONAL_LISTS = { later: () => laterList, watched: () => watchedList };

function scopeVideos() {
  if (PERSONAL_LISTS[ui.tab]) {
    const byId = new Map(videos.map((v) => [v.video_id, v]));
    return PERSONAL_LISTS[ui.tab]().map((s) => byId.get(s.id) || s.item);
  }
  if (ui.range === "all") return videos;
  const cutoff = Date.now() - Number(ui.range) * DAY;
  return videos.filter((v) => Date.parse(v.added_at) >= cutoff);
}

// 空白分隔多詞為 AND；比對標題＋說明
function searchVideos(scope) {
  const terms = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return scope;
  return scope.filter((v) => {
    const hay = `${v.title}\n${v.description}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

function visibleVideos(scope) {
  return scope.filter((v) =>
    (ui.channel === "all" || v.channel_name === ui.channel) &&
    !(ui.tab === "new" && ui.hideWatched && states.get(v.video_id)?.watched));
}

// pill 依 channels.json 的順序，其次是只出現在影片／副本裡的頻道（例如已從設定移除的）
function channelNames(scope) {
  const names = [...channels];
  for (const v of scope) if (v.channel_name && !names.includes(v.channel_name)) names.push(v.channel_name);
  return names;
}

// ---------- 渲染 ----------

function renderControls(scope) {
  root.querySelectorAll(".tab").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab)));
  $("v-later-count").textContent = laterList.length ? laterList.length : "";

  const names = channelNames(scope);
  if (ui.channel !== "all" && !names.includes(ui.channel)) ui.channel = "all";
  $("v-channels").innerHTML = [["all", "全部", scope.length],
    ...names.map((n) => [n, n, scope.filter((v) => v.channel_name === n).length])]
    .map(([key, label, count]) => `
    <button type="button" class="pill" role="radio" data-channel="${esc(key)}"
      aria-checked="${ui.channel === key}">${esc(label)}<span class="pill-count">${count}</span></button>`
    ).join("");

  $("v-search-clear").hidden = !$("v-search").value;
  $("v-subbar").hidden = ui.tab !== "new";
  root.querySelectorAll("#v-range .seg").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.range === ui.range)));
  $("v-hide-watched").checked = ui.hideWatched;
}

function publishedDay(v) {
  return v.published ? twDay.format(new Date(v.published)) : "";
}

function renderCard(v) {
  const st = states.get(v.video_id) || {};
  const open = expanded.has(v.video_id);
  const watchedAt = ui.tab === "watched" ? watchedList.find((w) => w.id === v.video_id)?.watchedAt : null;
  const day = publishedDay(v);
  const href = esc(v.url);
  return `
  <article class="card vcard${st.watched && ui.tab !== "watched" ? " is-read" : ""}${open ? " is-open" : ""}" data-vid="${esc(v.video_id)}">
    <a class="thumb" href="${href}" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">
      ${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}
    </a>
    <div class="vbody">
      <h2 class="card-title">
        <button type="button" class="title-btn" data-act="toggle" aria-expanded="${open}">${esc(v.title || v.video_id)}</button>
      </h2>
      <div class="card-meta">
        ${v.channel_name ? `<span class="channel">${esc(v.channel_name)}</span>` : ""}
        ${day ? `<time datetime="${esc(v.published)}">${day}</time>` : ""}
      </div>
      ${ui.tab === "watched" ? `<p class="read-at">${watchedAt ? `已看於 ${twDay.format(new Date(watchedAt))}` : "已看日期不明"}</p>` : ""}
      ${v.description ? `<div class="description" data-act="toggle">${esc(v.description)}</div>` : ""}
    </div>
    <div class="actions">
      <div class="act-group">
        <button type="button" class="act act-read" data-act="watched" aria-pressed="${!!st.watched}">${st.watched ? "✓ 已看" : "已看"}</button>
        <button type="button" class="act act-later" data-act="later" aria-pressed="${!!st.later}">${st.later ? "✓ 稍後看" : "稍後看"}</button>
      </div>
      <div class="act-group act-group-links">
        <a class="act act-link" href="${href}" target="_blank" rel="noopener noreferrer">在 YouTube 開啟 ↗</a>
      </div>
    </div>
  </article>`;
}

function render() {
  if (!loaded) return;
  const scope = scopeVideos();
  const searched = searchVideos(scope);
  const list = visibleVideos(searched);
  renderControls(searched);

  const searching = !!ui.query.trim();
  $("v-result-count").textContent =
    searching ? `符合 ${list.length} 支` : list.length ? `${list.length} 支` : "";
  if (list.length) {
    $("v-list").innerHTML = list.map(renderCard).join("");
    return;
  }
  const personal = ui.tab !== "new";
  let msg;
  if (!channels.length && !videos.length && !personal) {
    msg = "尚未設定頻道。<br>在 <code>config/channels.json</code> 加入 YouTube 頻道，下次排程就會抓進來。";
  } else if (personal && authStatus === "unknown") {
    msg = "載入中…";
  } else if (personal && authStatus === "unavailable") {
    msg = "同步服務載入失敗，請重新整理頁面。";
  } else if (personal && authStatus !== "signedIn") {
    msg = { later: "登入後才能看到稍後看佇列。", watched: "登入後才能看到已看紀錄。" }[ui.tab];
  } else if (ui.tab === "later" && !laterList.length) {
    msg = "佇列是空的。<br>按下「稍後看」，影片就會排進這裡；標成已看後自動離開。";
  } else if (ui.tab === "watched" && !watchedList.length) {
    msg = "還沒有已看的影片。<br>在「新進」按下「已看」，影片就會依時間出現在這裡。";
  } else if (!videos.length && !personal) {
    msg = "還沒有影片。<br>頻道已設定，等下次排程抓取。";
  } else if (searching && !searched.length) {
    msg = `沒有符合「${esc(ui.query.trim())}」的影片。`;
  } else if (ui.tab === "new" && ui.hideWatched && searched.length) {
    msg = "這個範圍的影片都看完了 👏";
  } else {
    msg = "這個條件下沒有影片。";
  }
  $("v-list").innerHTML = `<p class="empty">${msg}</p>`;
}

// ---------- 事件 ----------

let clearSearch = () => {};

function bindEvents() {
  clearSearch = bindSearch($("v-search"), $("v-search-clear"), (value) => {
    ui.query = value;
    render();
  });

  root.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b || b.dataset.tab === ui.tab) return;
    ui.tab = b.dataset.tab;
    clearSearch();
    ui.query = "";
    render();
    window.scrollTo({ top: 0 });
  });

  $("v-channels").addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (!b) return;
    ui.channel = b.dataset.channel;
    render();
  });

  $("v-range").addEventListener("click", (e) => {
    const b = e.target.closest(".seg");
    if (!b) return;
    ui.range = b.dataset.range;
    storePrefs();
    render();
  });

  $("v-hide-watched").addEventListener("change", (e) => {
    ui.hideWatched = e.target.checked;
    storePrefs();
    render();
  });

  $("v-list").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    const card = e.target.closest(".card");
    if (!el || !card) return;
    const id = card.dataset.vid;
    const st = states.get(id) || { watched: false, later: false };

    if (el.dataset.act === "toggle") {
      // 在說明上選取文字時不要收合
      if (!el.classList.contains("title-btn") && String(window.getSelection())) return;
      const open = !expanded.has(id);
      open ? expanded.add(id) : expanded.delete(id);
      card.classList.toggle("is-open", open);
      card.querySelector(".title-btn").setAttribute("aria-expanded", String(open));
      return;
    }
    if (el.dataset.act !== "watched" && el.dataset.act !== "later") return;
    if (authStatus !== "signedIn") {
      toast(authRequiredMessage(authStatus));
      return;
    }
    // 樂觀更新：state.js 先改本地快取並觸發 onStatesChange 重繪，寫入失敗會自行回滾
    const video = videos.find((v) => v.video_id === id) ||
      laterList.find((l) => l.id === id)?.item ||
      watchedList.find((w) => w.id === id)?.item || null;
    try {
      if (el.dataset.act === "watched") await setWatched(id, !st.watched, video);
      else await setLater(id, !st.later, video);
    } catch (err) {
      toast(err instanceof AuthRequiredError ? authRequiredMessage(authStatus) : "同步失敗，已還原");
    }
  });

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
  [states, laterList, watchedList] = await Promise.all([
    getAllStates(), getAllLater(), getAllWatched(),
  ]);
}

// ---------- 啟動 ----------

// 檔案不存在（尚未設定頻道、排程還沒跑過）回傳 fallback，不當成錯誤
async function fetchJson(url, fallback) {
  const res = await fetch(url, { cache: "no-cache" });
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ctx.setMeta(text)：更新頁首這個分區的「N 支 · 更新時間」
export async function init(ctx) {
  root = $("section-videos");
  restorePrefs();
  bindEvents();
  try {
    const [cfg, data] = await Promise.all([
      fetchJson("config/channels.json", []),
      fetchJson("data/videos.json", { videos: [] }),
    ]);
    channels = (Array.isArray(cfg) ? cfg : []).map((c) => c?.name).filter(Boolean);
    videos = (data.videos || []).slice()
      .sort((a, b) => b.added_at.localeCompare(a.added_at) || (b.published || "").localeCompare(a.published || ""));
    await refreshStates();
    loaded = true;
    ctx.setMeta(channels.length || videos.length ? metaText(videos.length, "支", data.generated_at) : "尚未設定頻道");
    render();
  } catch (err) {
    console.error(err);
    ctx.setMeta("");
    $("v-list").innerHTML = `<p class="empty error">影片資料載入失敗（${esc(err.message)}）。<br>請稍後重新整理。</p>`;
  }
}
