// 文章分區：feeds.json（scripts/fetch_feeds.py 由任意 RSS／Atom 產生）＋Firestore feedState。
// 子分頁「新進」「稍後讀」「已讀」、來源 pill（feeds.json 設定了 category 時先分類、再列該分類的 feed）、
// 搜尋（標題＋摘要）——共用 listSection.js，這裡只有設定與卡片內容。

import { feedState } from "../state.js";
import { esc, twDay } from "../util.js";
import { createListSection } from "./listSection.js";

function renderCard(it, { open, doneLine }) {
  const day = it.published ? twDay.format(new Date(it.published)) : "";
  return `
    <h2 class="card-title">
      <button type="button" class="title-btn" data-act="toggle" aria-expanded="${open}">${esc(it.title || it.link || "（無標題）")}</button>
    </h2>
    <div class="card-meta">
      ${it.feed_name ? `<span class="channel">${esc(it.feed_name)}</span>` : ""}
      ${day ? `<time datetime="${esc(it.published)}">${day}</time>` : ""}
    </div>
    ${doneLine}
    ${it.summary ? `<div class="description clamp-3" data-act="toggle">${esc(it.summary)}</div>` : ""}`;
}

export const { init } = createListSection({
  id: "articles",
  prefix: "a-",
  dataUrl: "data/feeds.json",
  listKey: "items",
  configUrl: "config/feeds.json",
  idKey: "key",
  sourceKey: "feed_name",
  groupKey: "category",
  store: feedState,
  prefsKey: "mdr.prefs.articles.v1",
  hidePref: "hideRead",
  text: {
    unit: "篇",
    noun: "文章",
    done: "已讀",
    later: "稍後讀",
    finished: "讀完",
    open: "開啟 ↗",
    notConfigured: "尚未設定 feed。<br>在 <code>config/feeds.json</code> 加入 RSS／Atom 網址，下次排程就會抓進來。",
    metaNotConfigured: "尚未設定 feed",
    noData: "還沒有文章。<br>feed 已設定，等下次排程抓取。",
    loadError: "文章資料載入失敗",
  },
  searchText: (it) => `${it.title}\n${it.summary}`,
  urlOf: (it) => it.link,
  sort: (a, b) => b.added_at.localeCompare(a.added_at) || (b.published || "").localeCompare(a.published || ""),
  cardClass: "",
  renderCard,
});
