// 個人狀態的抽象層，存在 Firestore。每個分區一個集合，登入狀態共用：
//   paperState → 集合 userState（文件 ID = PMID）
//   videoState → 集合 videoState（文件 ID = video_id）
//
// 兩個 store 共同的介面（皆為 async，onStatesChange 除外）：
//   getState(id)                 → 該分區的布林旗標，例如 { read, later, saved }
//   getAllStates()               → Map<id, 旗標>
//   setLater(id, later, item?)   「稍後」短期佇列；item 可選，用來寫冗餘副本
//   getAllLater()                → [{ id, laterAt, item }]，依 laterAt 新到舊（item 由冗餘副本組成）
//   onStatesChange(cb)           該集合任一裝置的變更（onSnapshot）或本地樂觀更新後呼叫
//
// paperState 另有（沿用 Handoff #2～#5.5 的介面，id 即 pmid，item 即 article；
// 為了相容，清單項目同時帶 pmid／article）：
//   setRead(pmid, read, article?)    標已讀時若在「稍後細讀」佇列中，同一次寫入把 later 改 false（laterAt 保留當歷史）
//   setSaved(pmid, saved, article?)  「收藏」長期書庫，副本含書目欄位；標已讀不影響收藏
//   setNote(pmid, text)              收藏筆記，存在同一份文件的 note 欄位
//   getAllSaved()                → [{ pmid, savedAt, note, article }]，依 savedAt 新到舊
//   getAllRead()                 → [{ pmid, readAt, article }]，依 readAt 新到舊
// videoState 另有：
//   setWatched(videoId, watched, video?)  標已看時若在「稍後看」佇列中，同一次寫入把 later 改 false
//   getAllWatched()              → [{ id, watchedAt, item }]，依 watchedAt 新到舊
//
// 未登入時讀取回傳空狀態，寫入丟出 AuthRequiredError。
// 寫入採樂觀更新：先改本地快取並通知 onStatesChange，再 setDoc(merge)；失敗則回滾、再通知，並把錯誤丟回呼叫端。
//
// 登入相關（兩個分區共用）：
//   onAuthChange(cb)             cb({ status, email })，status 為 unknown | signedIn | signedOut | unavailable（SDK 載入失敗）
//   signIn(email, password) / signOutUser()

const LEGACY_KEY = "mdr.state.v1"; // Handoff #2 的 localStorage 狀態，登入後遷移一次即刪除

export class AuthRequiredError extends Error {
  constructor() {
    super("請先登入");
    this.name = "AuthRequiredError";
  }
}

let fb = null;             // ./firebase.js 模組；動態載入，CDN 失敗時文章仍可瀏覽
let auth = { status: "unknown", email: null };
const authListeners = new Set();
const stores = [];         // 所有集合；登入／登出時一起切換監聽

function emitAuth() {
  authListeners.forEach((cb) => cb({ ...auth }));
}

export function onAuthChange(cb) {
  authListeners.add(cb);
  cb({ ...auth });
  return () => authListeners.delete(cb);
}

function toIso(ts) {
  return ts?.toDate ? ts.toDate().toISOString() : null;
}

function now() {
  return fb?.Timestamp.now() ?? null;
}

// 依時間新到舊；沒有時間的（例如 #2 遷移來的已讀）排最後，同時間再依 id
function byTimeDesc(key) {
  return (a, b) => (b[key] || "").localeCompare(a[key] || "") ||
    String(b.id).localeCompare(String(a.id), "en", { numeric: true });
}

// ---------- 單一集合 ----------

// flags：getState／getAllStates 回傳的布林欄位
function createCollection(name, flags) {
  let cache = new Map();   // id → Firestore 文件資料
  let unsubscribe = null;
  const listeners = new Set();

  const emit = () => listeners.forEach((cb) => cb());
  const view = (e) => Object.fromEntries(flags.map((f) => [f, !!e?.[f]]));

  const c = {
    name,
    cache: () => cache,
    entry: (id) => cache.get(id),
    view,

    // 登入身分變動時由 handleUser 呼叫：先 clear（通知登入狀態前），再 listen
    clear() {
      unsubscribe?.();
      unsubscribe = null;
      cache = new Map();
    },
    listen(user) {
      emit();
      if (!user) return;
      unsubscribe = fb.onSnapshot(
        fb.collection(fb.db, name),
        (snap) => {
          cache = new Map(snap.docs.map((d) => [d.id, d.data()]));
          emit();
        },
        (err) => console.error(`Firestore 監聽失敗（${name}）`, err),
      );
    },

    onStatesChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    // flag 為 true 的文件，依 atKey（Timestamp）新到舊；build(id, entry, atIso) 組成清單項目
    list(flag, atKey, build) {
      return [...cache]
        .filter(([, e]) => e[flag])
        .map(([id, e]) => {
          const at = toIso(e[atKey]);
          return { id, [atKey]: at, ...build(id, e, at) };
        })
        .sort(byTimeDesc(atKey));
    },

    async write(id, patch) {
      if (auth.status !== "signedIn" || !fb) throw new AuthRequiredError();
      const prev = cache.get(id);
      cache.set(id, { ...prev, ...patch });
      emit();
      try {
        await fb.setDoc(fb.doc(fb.db, name, id), patch, { merge: true });
      } catch (err) {
        console.error(`Firestore 寫入失敗（${name}/${id}）`, err);
        prev ? cache.set(id, prev) : cache.delete(id);
        emit();
        throw err;
      }
    },
  };
  stores.push(c);
  return c;
}

function handleUser(user) {
  stores.forEach((c) => c.clear());
  auth = user ? { status: "signedIn", email: user.email } : { status: "signedOut", email: null };
  emitAuth();
  stores.forEach((c) => c.listen(user));
  if (user) migrateLegacy();
}

import("./firebase.js")
  .then((m) => {
    fb = m;
    fb.onAuthStateChanged(fb.auth, handleUser);
  })
  .catch((err) => {
    console.error("Firebase SDK 載入失敗", err);
    auth = { status: "unavailable", email: null };
    emitAuth();
  });

export async function signIn(email, password) {
  if (!fb) throw new Error("Firebase SDK 尚未載入");
  await fb.signInWithEmailAndPassword(fb.auth, email, password);
}

export async function signOutUser() {
  if (fb) await fb.signOut(fb.auth);
}

// ---------- 論文：userState ----------

const papers = createCollection("userState", ["read", "later", "saved"]);

// 冗餘副本只有 title／journal／url／topics（收藏、稍後細讀另有書目欄位），其餘欄位補空值讓 papers.js 能照常排序、渲染
// （#2 遷移來的已讀文件可能沒有 title，由 papers.js 顯示成「PMID xxx」；#5 之前的收藏沒有書目欄位）
function fallbackArticle(pmid, e, at) {
  return {
    pmid,
    title: e.title || "",
    journal: e.journal || "",
    journal_full: "",
    pub_date: "",
    abstract: "",
    doi: e.doi || "",
    authors: e.authors || [],
    year: e.year || "",
    volume: e.volume || "",
    issue: e.issue || "",
    pages: e.pages || "",
    topics: e.topics || [],
    url: e.url || `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    added_at: at || new Date(0).toISOString(),
  };
}

function paperItem(pmid, e, at) {
  const article = fallbackArticle(pmid, e, at);
  return { pmid, item: article, article };
}

// 收藏／稍後細讀副本多存的書目欄位（RIS 匯出用）
function biblio(article) {
  if (!article) return {};
  return {
    authors: article.authors ?? [],
    year: article.year || (article.pub_date || "").slice(0, 4),
    doi: article.doi ?? "",
    volume: article.volume ?? "",
    issue: article.issue ?? "",
    pages: article.pages ?? "",
  };
}

function paperMeta(article) {
  if (!article) return {};
  return {
    title: article.title ?? "",
    journal: article.journal ?? "",
    url: article.url ?? "",
    topics: article.topics ?? [],
  };
}

export const paperState = {
  onStatesChange: papers.onStatesChange,

  async getState(pmid) {
    return papers.view(papers.entry(pmid));
  },
  async getAllStates() {
    return new Map([...papers.cache()].map(([pmid, e]) => [pmid, papers.view(e)]));
  },

  async getAllLater() {
    return papers.list("later", "laterAt", paperItem);
  },
  async getAllSaved() {
    return papers.list("saved", "savedAt", (pmid, e, at) => ({ ...paperItem(pmid, e, at), note: e.note || "" }));
  },
  async getAllRead() {
    return papers.list("read", "readAt", paperItem);
  },

  async setRead(pmid, read, article = null) {
    await papers.write(pmid, {
      read: !!read,
      readAt: read ? now() : null,
      ...paperMeta(article),
      // 看完就離開「稍後細讀」佇列；laterAt 不清，留作歷史
      ...(read && papers.entry(pmid)?.later ? { later: false } : {}),
    });
  },
  async setLater(pmid, later, article = null) {
    await papers.write(pmid, {
      later: !!later,
      laterAt: later ? now() : null,
      ...paperMeta(article),
      ...biblio(article),
    });
  },
  async setSaved(pmid, saved, article = null) {
    await papers.write(pmid, {
      saved: !!saved,
      savedAt: saved ? now() : null,
      ...paperMeta(article),
      ...biblio(article),
    });
  },
  // 筆記存在同一份文件的 note 欄位；取消收藏時不動它，再次收藏時筆記會回來
  async setNote(pmid, text) {
    await papers.write(pmid, { note: String(text ?? "") });
  },
};

// ---------- 影片：videoState ----------

const videos = createCollection("videoState", ["watched", "later"]);

// 副本只有 title／channel_name／url／thumbnail，其餘欄位補空值讓 videos.js 能照常渲染
function videoItem(id, e, at) {
  return {
    item: {
      video_id: id,
      title: e.title || "",
      channel_name: e.channel_name || "",
      url: e.url || `https://www.youtube.com/watch?v=${id}`,
      thumbnail: e.thumbnail || "",
      published: "",
      description: "",
      added_at: at || new Date(0).toISOString(),
    },
  };
}

function videoMeta(video) {
  if (!video) return {};
  return {
    title: video.title ?? "",
    channel_name: video.channel_name ?? "",
    url: video.url ?? "",
    thumbnail: video.thumbnail ?? "",
  };
}

export const videoState = {
  onStatesChange: videos.onStatesChange,

  async getState(id) {
    return videos.view(videos.entry(id));
  },
  async getAllStates() {
    return new Map([...videos.cache()].map(([id, e]) => [id, videos.view(e)]));
  },

  async getAllLater() {
    return videos.list("later", "laterAt", videoItem);
  },
  async getAllWatched() {
    return videos.list("watched", "watchedAt", videoItem);
  },

  async setWatched(id, watched, video = null) {
    await videos.write(id, {
      watched: !!watched,
      watchedAt: watched ? now() : null,
      ...videoMeta(video),
      // 看完就離開「稍後看」佇列；laterAt 不清，留作歷史
      ...(watched && videos.entry(id)?.later ? { later: false } : {}),
    });
  },
  async setLater(id, later, video = null) {
    await videos.write(id, {
      later: !!later,
      laterAt: later ? now() : null,
      ...videoMeta(video),
    });
  },
};

// ---------- 從 localStorage 遷移（Handoff #2 遺留，只有論文） ----------

async function migrateLegacy() {
  let legacy;
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
  } catch {
    return;
  }
  if (!legacy || typeof legacy !== "object") return;

  try {
    const entries = Object.entries(legacy).filter(([, e]) => e && (e.read || e.saved));
    let migrated = 0;
    if (entries.length) {
      // 一定要問伺服器；離線時本地快取是空的，會誤以為文件不存在而覆蓋
      const snap = await fb.getDocsFromServer(fb.collection(fb.db, papers.name));
      const existing = new Set(snap.docs.map((d) => d.id));
      const batch = fb.writeBatch(fb.db);
      for (const [pmid, e] of entries) {
        if (existing.has(pmid)) continue;
        const savedAt = e.saved && e.savedAt ? new Date(e.savedAt) : null;
        batch.set(fb.doc(fb.db, papers.name, pmid), {
          read: !!e.read,
          saved: !!e.saved,
          readAt: null, // #2 沒記已讀時間
          savedAt: savedAt && !isNaN(savedAt) ? fb.Timestamp.fromDate(savedAt) : null,
          title: e.article?.title ?? "",
          journal: e.article?.journal ?? "",
          url: e.article?.url ?? "",
          topics: e.article?.topics ?? [],
        });
        migrated++;
      }
      if (migrated) await batch.commit();
    }
    localStorage.removeItem(LEGACY_KEY);
    console.info(`localStorage 舊狀態遷移完成：寫入 ${migrated} 筆`);
  } catch (err) {
    console.error("localStorage 舊狀態遷移失敗，下次登入再試", err);
  }
}
