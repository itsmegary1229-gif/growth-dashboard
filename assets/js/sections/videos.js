// 影片分區：videos.json（scripts/fetch_videos.py 由 YouTube RSS 產生）＋Firestore videoState。
// 子分頁「新進」「稍後看」「已看」、頻道 pill、搜尋（標題＋說明）——共用 listSection.js，這裡只有設定與卡片內容。
// config/channels.json 為空且 videos.json 沒有影片（或不存在）時顯示「尚未設定頻道」。

import { videoState } from "../state.js";
import { esc, twDay } from "../util.js";
import { createListSection } from "./listSection.js";

function publishedDay(v) {
  return v.published ? twDay.format(new Date(v.published)) : "";
}

function renderCard(v, { open, doneLine }) {
  const day = publishedDay(v);
  return `
    <a class="thumb" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">
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
      ${doneLine}
      ${v.description ? `<div class="description" data-act="toggle">${esc(v.description)}</div>` : ""}
    </div>`;
}

export const { init } = createListSection({
  id: "videos",
  prefix: "v-",
  dataUrl: "data/videos.json",
  listKey: "videos",
  configUrl: "config/channels.json",
  idKey: "video_id",
  sourceKey: "channel_name",
  groupKey: null,
  store: videoState,
  prefsKey: "mdr.prefs.videos.v1",
  hidePref: "hideWatched",
  text: {
    unit: "支",
    noun: "影片",
    done: "已看",
    later: "稍後看",
    finished: "看完",
    open: "在 YouTube 開啟 ↗",
    notConfigured: "尚未設定頻道。<br>在 <code>config/channels.json</code> 加入 YouTube 頻道，下次排程就會抓進來。",
    metaNotConfigured: "尚未設定頻道",
    noData: "還沒有影片。<br>頻道已設定，等下次排程抓取。",
    loadError: "影片資料載入失敗",
  },
  searchText: (v) => `${v.title}\n${v.description}`,
  urlOf: (v) => v.url,
  sort: (a, b) => b.added_at.localeCompare(a.added_at) || (b.published || "").localeCompare(a.published || ""),
  cardClass: "vcard",
  renderCard,
});
