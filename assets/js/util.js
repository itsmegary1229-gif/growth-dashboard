// 各分區共用的小工具：跳脫、台灣時區日期、提示訊息、搜尋框、偏好設定

export const DAY = 24 * 60 * 60 * 1000;
const SEARCH_DELAY = 200;

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export const twDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
});
const twStamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function formatUpdated(iso) {
  const parts = Object.fromEntries(
    twStamp.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

// 頁首的「N 篇 · 更新：MM/DD HH:mm」
export function metaText(count, unit, generatedAt) {
  const parts = [`${count} ${unit}`];
  if (generatedAt) parts.push(`更新：${formatUpdated(generatedAt)}`);
  return parts.join(" · ");
}

// ---------- 資料 ----------

// 同一個 JSON 由多個分區共用（articles.json：論文＋回顧）時只抓一次；失敗不快取，下次呼叫再試
const jsonCache = new Map();
export function fetchJSON(url) {
  if (!jsonCache.has(url)) {
    const p = fetch(url, { cache: "no-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        jsonCache.delete(url);
        throw err;
      });
    jsonCache.set(url, p);
  }
  return jsonCache.get(url);
}

// ---------- 提示訊息 ----------

let toastTimer = 0;
export function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

export function authRequiredMessage(status) {
  return status === "unavailable" ? "同步服務載入失敗，請重新整理頁面" : "請先登入";
}

// ---------- 搜尋框 ----------

// 200ms debounce、注音組字中不觸發、Esc 或 × 清除；onApply(value) 由分區更新自己的查詢字串並重繪。
// 回傳 clear()：換分頁時清空（不觸發 onApply，由呼叫端自行重繪）
export function bindSearch(input, clearBtn, onApply) {
  let timer = 0;
  const apply = () => {
    clearTimeout(timer);
    onApply(input.value);
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(apply, SEARCH_DELAY);
  };
  input.addEventListener("input", (e) => {
    clearBtn.hidden = !input.value;
    if (!e.isComposing) later();
  });
  input.addEventListener("compositionend", later);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      input.value = "";
      apply();
    }
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    apply();
    input.focus();
  });
  return () => {
    clearTimeout(timer);
    input.value = "";
  };
}

// ---------- 偏好設定（localStorage） ----------

export function loadPrefs(key) {
  try {
    const p = JSON.parse(localStorage.getItem(key) || "{}");
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

export function savePrefs(key, prefs) {
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch { /* 忽略 */ }
}
