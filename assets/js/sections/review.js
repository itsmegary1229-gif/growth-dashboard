// 回顧分區：每天從收藏抽幾篇重讀，看 headline、重點和當時的筆記。需登入。
// 抽選是純前端：候選池為 saved == true 的文章，排除今天已回顧的；
// 從未回顧（reviewedAt 為空）優先，其次 reviewedAt（台灣日期）最久遠；同一組內以「當天日期＋PMID」的雜湊排序，
// 同一天在任何裝置重整都看到同一篇，隔天換順序。
// 今天的進度由 Firestore 的 reviewedAt 推算（手機和電腦一致）；只有「再來一篇」加開的篇數存在這台裝置的 localStorage。

import { paperState, onAuthChange, AuthRequiredError } from "../state.js";
import { $, esc, twDay, toast, authRequiredMessage, loadPrefs, savePrefs, fetchJSON } from "../util.js";
import { renderAbstract, summaryOf, renderRelevance, journalClass } from "./papers.js";

const { getAllSaved, getAllReviewed, markReviewed, setSaved, isSynced, onStatesChange } = paperState;

const DAILY_LIMIT = 5;
const PREFS_KEY = "mdr.review.v1"; // { date, extra }：當天按「再來一篇」加開的篇數
const CLICK_LOCK = 400;            // 換篇後短暫忽略點擊，免得連點把下一篇也標掉

let articles = new Map();  // pmid → articles.json 的完整資料（含摘要）；退場的文章用 Firestore 副本
let savedList = [];        // getAllSaved()
let reviewedList = [];     // getAllReviewed()，含已取消收藏的（今天的進度要算進去）
let authStatus = "unknown";
let rereading = null;      // 按了「再讀一次」、正展開的 pmid
let shownPmid = null;      // 上次渲染的 pmid；換篇時才播淡入
let lockedUntil = 0;

// ---------- 抽選 ----------

const today = () => twDay.format(new Date());
const dayOf = (iso) => (iso ? twDay.format(new Date(iso)) : "");

// FNV-1a 32-bit
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 今天還沒回顧的收藏，依抽選順序；第一篇就是現在要出的
function queue(day) {
  return savedList
    .filter((s) => dayOf(s.reviewedAt) !== day)
    .map((s) => ({ s, group: dayOf(s.reviewedAt), rnd: hash(`${day}:${s.pmid}`) }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.rnd - b.rnd ||
      a.s.pmid.localeCompare(b.s.pmid, "en", { numeric: true }))
    .map((x) => x.s);
}

function doneToday(day) {
  return reviewedList.filter((r) => dayOf(r.reviewedAt) === day).length;
}

function extraToday(day) {
  const p = loadPrefs(PREFS_KEY);
  return p.date === day && Number.isInteger(p.extra) ? p.extra : 0;
}

function addExtra(day) {
  savePrefs(PREFS_KEY, { date: day, extra: extraToday(day) + 1 });
}

const articleOf = (s) => articles.get(s.pmid) || s.article;

// ---------- 渲染 ----------

function renderCard(s, n, limit) {
  const a = articleOf(s);
  const sum = summaryOf(a);
  const open = rereading === s.pmid;
  const year = a.year || (a.pub_date || "").slice(0, 4);
  const last = s.reviewedAt ? twDay.format(new Date(s.reviewedAt)) : "從未";
  const fresh = shownPmid !== s.pmid;
  shownPmid = s.pmid;
  const points = sum?.points?.length
    ? `<ul class="review-points">${sum.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
  const note = s.note.trim() ? `
    <div class="review-note">
      <p class="review-note-label">你當時寫的${s.savedAt ? ` · 收藏於 ${twDay.format(new Date(s.savedAt))}` : ""}</p>
      <p class="review-note-text">${esc(s.note)}</p>
    </div>` : "";
  const oa = a.oa_url
    ? `<a class="act act-link" href="${esc(a.oa_url)}" target="_blank" rel="noopener noreferrer">${a.oa_pdf ? "PDF ↗" : "OA 全文 ↗"}</a>` : "";
  const more = open ? `
    <div class="review-more">
      <div class="review-abstract">${renderAbstract(a.abstract)}</div>
      <div class="review-links">
        <a class="act act-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">看全文 ↗</a>
        ${oa}
      </div>
    </div>` : "";
  const main = open
    ? `<button type="button" class="rv-btn rv-primary" data-act="done">完成</button>`
    : `<button type="button" class="rv-btn rv-primary" data-act="remember">還記得</button>
       <button type="button" class="rv-btn" data-act="reread">再讀一次</button>`;
  return `
  <p class="review-progress">今天第 ${n} / ${limit} 篇 · 收藏共 ${savedList.length} 篇 · 上次回顧：${last}</p>
  <article class="review-card${fresh ? " is-fresh" : ""}" data-pmid="${esc(s.pmid)}">
    ${sum ? `<p class="review-headline">${esc(sum.headline)}</p>` : ""}
    <h2 class="review-title${sum ? "" : " is-main"}">${esc(a.title || `PMID ${s.pmid}`)}</h2>
    <div class="card-meta">
      ${a.journal ? `<span class="journal ${journalClass(a.journal)}">${esc(a.journal)}</span>` : ""}
      ${year ? `<span>${esc(year)}</span>` : ""}
      ${renderRelevance(a)}
    </div>
    ${points}
    ${note}
    ${more}
  </article>
  <div class="review-actions${open ? " is-open" : ""}" data-pmid="${esc(s.pmid)}">
    ${main}
    <button type="button" class="rv-btn rv-remove" data-act="unsave">移除收藏</button>
  </div>`;
}

function renderDone(done, remaining) {
  shownPmid = null;
  const never = savedList.filter((s) => !s.reviewedAt).length;
  const title = remaining ? "今天的回顧完成了 ✓" : "收藏都回顧過一輪了 ✓";
  return `
  <div class="review-done">
    <p class="review-done-title">${title}</p>
    <p class="review-done-stat">今天回顧 ${done} 篇 · 收藏共 ${savedList.length} 篇${never ? ` · 從未回顧 ${never} 篇` : ""}</p>
    ${remaining ? `<button type="button" class="rv-btn" data-act="more">再來一篇</button>` : `<p class="review-done-stat">明天再來。</p>`}
  </div>`;
}

function empty(msg) {
  shownPmid = null;
  return `<p class="empty">${msg}</p>`;
}

function render() {
  const day = today();
  const done = doneToday(day);
  const limit = DAILY_LIMIT + extraToday(day);
  setMeta(authStatus === "signedIn" && isSynced() ? `收藏 ${savedList.length} 篇 · 今天回顧 ${done} 篇` : "");

  let html;
  if (authStatus === "unknown" || (authStatus === "signedIn" && !isSynced())) {
    html = empty("載入中…");
  } else if (authStatus === "unavailable") {
    html = empty("同步服務載入失敗，請重新整理頁面。");
  } else if (authStatus !== "signedIn") {
    html = empty("登入後，這裡每天會從收藏抽文章讓你重讀。");
  } else if (!savedList.length && !done) {
    html = empty("收藏幾篇文章後，這裡每天會抽一篇讓你重讀。");
  } else {
    const q = queue(day);
    html = q.length && done < limit ? renderCard(q[0], done + 1, limit) : renderDone(done, q.length);
  }
  $("review").innerHTML = html;
}

// ---------- 事件 ----------

function bindEvents() {
  $("review").addEventListener("click", async (e) => {
    const el = e.target.closest("button[data-act]");
    if (!el || Date.now() < lockedUntil) return;
    const act = el.dataset.act;
    const day = today();

    if (act === "more") {
      addExtra(day);
      render();
      return;
    }
    if (act === "reread") {
      rereading = el.closest("[data-pmid]").dataset.pmid;
      render();
      return;
    }
    if (authStatus !== "signedIn") {
      toast(authRequiredMessage(authStatus));
      return;
    }
    const pmid = el.closest("[data-pmid]").dataset.pmid;
    const s = savedList.find((x) => x.pmid === pmid);
    if (!s) return;
    lockedUntil = Date.now() + CLICK_LOCK;
    rereading = null;
    // 「完成」時使用者可能捲到摘要下方，換篇後回到頂端
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
    // 樂觀更新：state.js 先改快取並觸發 onStatesChange 重繪成下一篇，寫入失敗會回滾
    try {
      if (act === "unsave") {
        await setSaved(pmid, false, articleOf(s));
        toast("已移除收藏（筆記保留）");
      } else {
        await markReviewed(pmid, articleOf(s));
      }
    } catch (err) {
      toast(err instanceof AuthRequiredError ? authRequiredMessage(authStatus) : "同步失敗，已還原");
    }
  });
}

async function refresh() {
  [savedList, reviewedList] = await Promise.all([getAllSaved(), getAllReviewed()]);
}

// ---------- 啟動 ----------

let setMeta = () => {};

export async function init(ctx) {
  setMeta = ctx.setMeta;
  bindEvents();
  onAuthChange(({ status }) => {
    authStatus = status;
    render();
  });
  onStatesChange(async () => {
    await refresh();
    render();
  });
  // 跨過午夜（台灣時間）時換成新的一天；切回分頁時也重算
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) render();
  });
  try {
    const data = await fetchJSON("data/articles.json");
    articles = new Map((data.articles || []).map((a) => [a.pmid, a]));
  } catch (err) {
    // 論文分區會顯示錯誤；回顧區仍可用 Firestore 副本
    console.warn("回顧區：articles.json 載入失敗，改用收藏副本", err);
  }
  await refresh();
  render();
}
