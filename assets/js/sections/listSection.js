// 清單分區的共用模組：影片（videos.js）、文章（articles.js）都由 createListSection(cfg) 產生。
// 子分頁「新進」「稍後」「完成」（已看／已讀）、來源 pill（可依分類分兩層）、搜尋、時間範圍、隱藏已完成、
// 卡片（樂觀更新的完成／稍後按鈕＋開啟連結）、Firestore 狀態（state.js 的 createListStore）。
//
// cfg：
//   id             分區 id；根元素為 #section-{id}
//   prefix         分區內元素 id 前綴（"v-" → #v-list、#v-sources…，見 index.html）
//   dataUrl, listKey   資料檔與其中的陣列欄位（videos.json 的 "videos"）
//   configUrl      來源設定檔（陣列，每項有 name；可有 category）；pill 依它的順序
//   idKey          項目的唯一鍵，也是 Firestore 文件 ID
//   sourceKey      項目的來源名稱欄位（對應設定檔的 name）
//   groupKey       分類欄位（對應設定檔的 category）；null 表示不分組
//   store          state.js 的 createListStore 結果（doneFlag 為 "watched" 或 "read"）
//   prefsKey, hidePref   localStorage 偏好鍵與「隱藏已完成」的欄位名（沿用各分區原本的鍵）
//   text           { unit, noun, done, later, finished, open, notConfigured, metaNotConfigured, noData, loadError }
//   searchText(item)   搜尋比對的文字
//   urlOf(item)        「開啟」連結
//   sort(a, b)         資料檔的排序
//   cardClass          卡片額外的 class
//   renderCard(item, ctx)  卡片內容（不含 <article> 與操作列）；ctx = { open, doneLine }
//     內容裡要有 .title-btn[data-act="toggle"]，可展開的區塊也標 data-act="toggle"

import { onAuthChange, AuthRequiredError } from "../state.js";
import {
  $, DAY, esc, twDay, metaText, toast, authRequiredMessage, bindSearch, loadPrefs, savePrefs,
} from "../util.js";

const UNGROUPED = "未分類";

// 檔案不存在（尚未設定來源、排程還沒跑過）回傳 fallback，不當成錯誤
async function fetchJson(url, fallback) {
  const res = await fetch(url, { cache: "no-cache" });
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function createListSection(cfg) {
  const { prefix: p, idKey, sourceKey, groupKey, store, text: t } = cfg;
  const doneAtKey = `${store.doneFlag}At`;

  const ui = {
    tab: "new",       // new | later | done
    group: "all",     // all | 分類（有分類時）
    source: "all",    // all | 來源名稱
    range: "7",       // 7 | 30 | all
    hideDone: false,
    query: "",        // 不存 localStorage，換分頁時清空
  };
  let items = [];           // 資料檔，cfg.sort 排序
  let sources = [];         // 設定檔的來源名稱（pill 順序）
  const sourceGroup = new Map(); // 來源名稱 → 設定檔的分類
  let states = new Map();   // id → { [doneFlag], later }
  let laterList = [];       // getAllLater()（laterAt 新到舊）
  let doneList = [];        // getAllDone()（完成時間新到舊）
  let authStatus = "unknown";
  let loaded = false;
  const expanded = new Set();
  let root = null;

  function restorePrefs() {
    const prefs = loadPrefs(cfg.prefsKey);
    if (["7", "30", "all"].includes(prefs.range)) ui.range = prefs.range;
    if (typeof prefs[cfg.hidePref] === "boolean") ui.hideDone = prefs[cfg.hidePref];
  }

  function storePrefs() {
    savePrefs(cfg.prefsKey, { range: ui.range, [cfg.hidePref]: ui.hideDone });
  }

  // ---------- 資料 ----------

  // 「稍後」「完成」以 Firestore 副本為主，資料檔仍有該項時改用完整資料
  const PERSONAL_LISTS = { later: () => laterList, done: () => doneList };

  function scopeItems() {
    if (PERSONAL_LISTS[ui.tab]) {
      const byId = new Map(items.map((it) => [it[idKey], it]));
      return PERSONAL_LISTS[ui.tab]().map((s) => byId.get(s.id) || s.item);
    }
    if (ui.range === "all") return items;
    const cutoff = Date.now() - Number(ui.range) * DAY;
    return items.filter((it) => Date.parse(it.added_at) >= cutoff);
  }

  // 空白分隔多詞為 AND
  function searchItems(scope) {
    const terms = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return scope;
    return scope.filter((it) => {
      const hay = cfg.searchText(it).toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }

  // 分類以設定檔為準（Firestore 副本沒有分類），其次是項目自己的；都沒有歸「未分類」
  function groupOf(it) {
    return sourceGroup.get(it[sourceKey]) || (groupKey && it[groupKey]) || UNGROUPED;
  }

  function visibleItems(scope) {
    return scope.filter((it) =>
      (ui.group === "all" || groupOf(it) === ui.group) &&
      (ui.source === "all" || it[sourceKey] === ui.source) &&
      !(ui.tab === "new" && ui.hideDone && states.get(it[idKey])?.[store.doneFlag]));
  }

  // 依設定檔順序，其次是只出現在資料／副本裡的來源（例如已從設定移除的）；group 有值時只列該分類
  function sourceNames(scope, group = null) {
    const names = group ? sources.filter((n) => (sourceGroup.get(n) || UNGROUPED) === group) : [...sources];
    for (const it of scope) {
      const n = it[sourceKey];
      if (n && !names.includes(n) && (!group || groupOf(it) === group)) names.push(n);
    }
    return names;
  }

  // 設定檔或資料裡有任何分類才分兩層；否則回傳 []
  function groupNames(scope) {
    if (!groupKey) return [];
    if (!sourceGroup.size && !scope.some((it) => it[groupKey])) return [];
    const names = [...new Set(sourceGroup.values())];
    if (sources.some((n) => !sourceGroup.has(n))) names.push(UNGROUPED);
    for (const it of scope) if (!names.includes(groupOf(it))) names.push(groupOf(it));
    return names;
  }

  // ---------- 渲染 ----------

  function pills(kind, entries, selected) {
    return entries.map(([key, label, count]) => `
      <button type="button" class="pill" role="radio" data-${kind}="${esc(key)}"
        aria-checked="${selected === key}">${esc(label)}<span class="pill-count">${count}</span></button>`
    ).join("");
  }

  const count = (scope, pred) => scope.filter(pred).length;

  // 沒有分類：一排來源 pill。有分類：第一排是分類，選了分類後第二排列出該分類的來源
  function renderSources(scope) {
    const box = $(`${p}sources`);
    const sub = $(`${p}subsources`);
    const groups = groupNames(scope);
    if (!groups.length) {
      ui.group = "all";
      const names = sourceNames(scope);
      if (ui.source !== "all" && !names.includes(ui.source)) ui.source = "all";
      box.innerHTML = pills("source", [["all", "全部", scope.length],
        ...names.map((n) => [n, n, count(scope, (it) => it[sourceKey] === n)])], ui.source);
      if (sub) sub.hidden = true;
      return;
    }
    if (ui.group !== "all" && !groups.includes(ui.group)) ui.group = "all";
    box.innerHTML = pills("group", [["all", "全部", scope.length],
      ...groups.map((g) => [g, g, count(scope, (it) => groupOf(it) === g)])], ui.group);
    if (ui.group === "all") {
      ui.source = "all";
      sub.hidden = true;
      return;
    }
    const inGroup = scope.filter((it) => groupOf(it) === ui.group);
    const names = sourceNames(inGroup, ui.group);
    if (ui.source !== "all" && !names.includes(ui.source)) ui.source = "all";
    sub.innerHTML = pills("source", [["all", `全部${ui.group}`, inGroup.length],
      ...names.map((n) => [n, n, count(inGroup, (it) => it[sourceKey] === n)])], ui.source);
    sub.hidden = false;
  }

  function renderControls(scope) {
    root.querySelectorAll(".tab").forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab)));
    $(`${p}later-count`).textContent = laterList.length ? laterList.length : "";
    renderSources(scope);
    $(`${p}search-clear`).hidden = !$(`${p}search`).value;
    $(`${p}subbar`).hidden = ui.tab !== "new";
    root.querySelectorAll(`#${p}range .seg`).forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.range === ui.range)));
    $(`${p}hide-done`).checked = ui.hideDone;
  }

  function renderItem(it) {
    const id = it[idKey];
    const st = states.get(id) || {};
    const done = !!st[store.doneFlag];
    const open = expanded.has(id);
    let doneLine = "";
    if (ui.tab === "done") {
      const at = doneList.find((d) => d.id === id)?.[doneAtKey];
      doneLine = `<p class="read-at">${at ? `${t.done}於 ${twDay.format(new Date(at))}` : `${t.done}日期不明`}</p>`;
    }
    return `
    <article class="card${cfg.cardClass ? ` ${cfg.cardClass}` : ""}${done && ui.tab !== "done" ? " is-read" : ""}${open ? " is-open" : ""}" data-id="${esc(id)}">
      ${cfg.renderCard(it, { open, doneLine })}
      <div class="actions">
        <div class="act-group">
          <button type="button" class="act act-read" data-act="done" aria-pressed="${done}">${done ? `✓ ${t.done}` : t.done}</button>
          <button type="button" class="act act-later" data-act="later" aria-pressed="${!!st.later}">${st.later ? `✓ ${t.later}` : t.later}</button>
        </div>
        <div class="act-group act-group-links">
          <a class="act act-link" href="${esc(cfg.urlOf(it))}" target="_blank" rel="noopener noreferrer">${t.open}</a>
        </div>
      </div>
    </article>`;
  }

  function emptyMessage(personal, searching, searched) {
    if (!sources.length && !items.length && !personal) return t.notConfigured;
    if (personal && authStatus === "unknown") return "載入中…";
    if (personal && authStatus === "unavailable") return "同步服務載入失敗，請重新整理頁面。";
    if (personal && authStatus !== "signedIn") {
      return ui.tab === "later" ? `登入後才能看到${t.later}佇列。` : `登入後才能看到${t.done}紀錄。`;
    }
    if (ui.tab === "later" && !laterList.length) {
      return `佇列是空的。<br>按下「${t.later}」，${t.noun}就會排進這裡；標成${t.done}後自動離開。`;
    }
    if (ui.tab === "done" && !doneList.length) {
      return `還沒有${t.done}的${t.noun}。<br>在「新進」按下「${t.done}」，${t.noun}就會依時間出現在這裡。`;
    }
    if (!items.length && !personal) return t.noData;
    if (searching && !searched.length) return `沒有符合「${esc(ui.query.trim())}」的${t.noun}。`;
    if (ui.tab === "new" && ui.hideDone && searched.length) return `這個範圍的${t.noun}都${t.finished}了 👏`;
    return `這個條件下沒有${t.noun}。`;
  }

  function render() {
    if (!loaded) return;
    const scope = scopeItems();
    const searched = searchItems(scope);
    renderControls(searched);
    const list = visibleItems(searched);

    const searching = !!ui.query.trim();
    $(`${p}result-count`).textContent =
      searching ? `符合 ${list.length} ${t.unit}` : list.length ? `${list.length} ${t.unit}` : "";
    $(`${p}list`).innerHTML = list.length
      ? list.map(renderItem).join("")
      : `<p class="empty">${emptyMessage(ui.tab !== "new", searching, searched)}</p>`;
  }

  // ---------- 事件 ----------

  let clearSearch = () => {};

  function bindEvents() {
    clearSearch = bindSearch($(`${p}search`), $(`${p}search-clear`), (value) => {
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

    const onPill = (e) => {
      const b = e.target.closest(".pill");
      if (!b) return;
      if (b.dataset.group !== undefined) {
        ui.group = b.dataset.group;
        ui.source = "all";
      } else {
        ui.source = b.dataset.source;
      }
      render();
    };
    $(`${p}sources`).addEventListener("click", onPill);
    $(`${p}subsources`)?.addEventListener("click", onPill);

    $(`${p}range`).addEventListener("click", (e) => {
      const b = e.target.closest(".seg");
      if (!b) return;
      ui.range = b.dataset.range;
      storePrefs();
      render();
    });

    $(`${p}hide-done`).addEventListener("change", (e) => {
      ui.hideDone = e.target.checked;
      storePrefs();
      render();
    });

    $(`${p}list`).addEventListener("click", async (e) => {
      const el = e.target.closest("[data-act]");
      const card = e.target.closest(".card");
      if (!el || !card) return;
      const id = card.dataset.id;
      const st = states.get(id) || {};

      if (el.dataset.act === "toggle") {
        // 在說明上選取文字時不要收合
        if (!el.classList.contains("title-btn") && String(window.getSelection())) return;
        const open = !expanded.has(id);
        open ? expanded.add(id) : expanded.delete(id);
        card.classList.toggle("is-open", open);
        card.querySelector(".title-btn").setAttribute("aria-expanded", String(open));
        return;
      }
      if (el.dataset.act !== "done" && el.dataset.act !== "later") return;
      if (authStatus !== "signedIn") {
        toast(authRequiredMessage(authStatus));
        return;
      }
      // 樂觀更新：state.js 先改本地快取並觸發 onStatesChange 重繪，寫入失敗會自行回滾
      const item = items.find((it) => it[idKey] === id) ||
        laterList.find((l) => l.id === id)?.item ||
        doneList.find((d) => d.id === id)?.item || null;
      try {
        if (el.dataset.act === "done") await store.setDone(id, !st[store.doneFlag], item);
        else await store.setLater(id, !st.later, item);
      } catch (err) {
        toast(err instanceof AuthRequiredError ? authRequiredMessage(authStatus) : "同步失敗，已還原");
      }
    });

    onAuthChange(({ status }) => {
      authStatus = status;
      render();
    });
    store.onStatesChange(async () => {
      await refreshStates();
      render();
    });
  }

  async function refreshStates() {
    [states, laterList, doneList] = await Promise.all([
      store.getAllStates(), store.getAllLater(), store.getAllDone(),
    ]);
  }

  // ---------- 啟動 ----------

  // ctx.setMeta(text)：更新頁首這個分區的「N 支／篇 · 更新時間」
  async function init(ctx) {
    root = $(`section-${cfg.id}`);
    restorePrefs();
    bindEvents();
    try {
      const [conf, data] = await Promise.all([
        fetchJson(cfg.configUrl, []),
        fetchJson(cfg.dataUrl, { [cfg.listKey]: [] }),
      ]);
      for (const c of Array.isArray(conf) ? conf : []) {
        const name = String(c?.name || "").trim();
        if (!name) continue;
        sources.push(name);
        const group = groupKey && String(c[groupKey] || "").trim();
        if (group) sourceGroup.set(name, group);
      }
      items = (data[cfg.listKey] || []).slice().sort(cfg.sort);
      await refreshStates();
      loaded = true;
      ctx.setMeta(sources.length || items.length ? metaText(items.length, t.unit, data.generated_at) : t.metaNotConfigured);
      render();
    } catch (err) {
      console.error(err);
      ctx.setMeta("");
      $(`${p}list`).innerHTML = `<p class="empty error">${t.loadError}（${esc(err.message)}）。<br>請稍後重新整理。</p>`;
    }
  }

  return { init };
}
