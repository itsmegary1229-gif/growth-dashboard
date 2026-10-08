// 已讀／收藏狀態的抽象層，存在 Firestore 集合 userState（文件 ID = PMID）。
// 原有對外介面（皆為 async）維持不變：
//   getState(pmid)               → { read, later, saved }
//   getAllStates()               → Map<pmid, { read, later, saved }>
//   setRead(pmid, read, article?)    article 可選，用來寫入 title／journal／url／topics 冗餘副本；
//                                    標已讀時若在「稍後細讀」佇列中，同一次寫入把 later 改 false（laterAt 保留當歷史）
//   setLater(pmid, later, article?)  「稍後細讀」短期佇列，副本寫法同 setSaved
//   setSaved(pmid, saved, article?)  「收藏」長期書庫，一併存文章冗餘副本（含書目欄位），文章被 90 天滾動移出 JSON 後
//                                    仍能在「收藏」看到、匯出 RIS；標已讀不影響收藏
//   getAllLater()                → [{ pmid, laterAt, article }]，依 laterAt 新到舊
//   getAllSaved()                → [{ pmid, savedAt, note, article }]，依 savedAt 新到舊（article 由冗餘副本組成）
//   getAllRead()                 → [{ pmid, readAt, article }]，依 readAt 新到舊
//   setNote(pmid, text)          收藏筆記，存在同一份文件的 note 欄位
// 未登入時讀取回傳空狀態，寫入丟出 AuthRequiredError。
// 寫入採樂觀更新：先改本地快取並通知 onStatesChange，再 setDoc(merge)；失敗則回滾、再通知，並把錯誤丟回呼叫端。
//
// 登入相關：
//   onAuthChange(cb)             cb({ status, email })，status 為 unknown | signedIn | signedOut | unavailable（SDK 載入失敗）
//   onStatesChange(cb)           任一裝置的狀態變更（onSnapshot）或本地樂觀更新後呼叫
//   signIn(email, password) / signOutUser()

const COLLECTION = "userState";
const LEGACY_KEY = "mdr.state.v1"; // Handoff #2 的 localStorage 狀態，登入後遷移一次即刪除

export class AuthRequiredError extends Error {
  constructor() {
    super("請先登入");
    this.name = "AuthRequiredError";
  }
}

let fb = null;             // ./firebase.js 模組；動態載入，CDN 失敗時文章仍可瀏覽
let auth = { status: "unknown", email: null };
let cache = new Map();     // pmid → Firestore 文件資料
let unsubscribeSnapshot = null;
const authListeners = new Set();
const changeListeners = new Set();

function emitAuth() {
  authListeners.forEach((cb) => cb({ ...auth }));
}

function emitChange() {
  changeListeners.forEach((cb) => cb());
}

export function onAuthChange(cb) {
  authListeners.add(cb);
  cb({ ...auth });
  return () => authListeners.delete(cb);
}

export function onStatesChange(cb) {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

function handleUser(user) {
  unsubscribeSnapshot?.();
  unsubscribeSnapshot = null;
  cache = new Map();
  auth = user ? { status: "signedIn", email: user.email } : { status: "signedOut", email: null };
  emitAuth();
  emitChange();
  if (!user) return;

  unsubscribeSnapshot = fb.onSnapshot(
    fb.collection(fb.db, COLLECTION),
    (snap) => {
      cache = new Map(snap.docs.map((d) => [d.id, d.data()]));
      emitChange();
    },
    (err) => console.error("Firestore 監聽失敗", err),
  );
  migrateLegacy();
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

// ---------- 讀取 ----------

function view(entry) {
  return { read: !!entry?.read, later: !!entry?.later, saved: !!entry?.saved };
}

function toIso(ts) {
  return ts?.toDate ? ts.toDate().toISOString() : null;
}

export async function getState(pmid) {
  return view(cache.get(pmid));
}

export async function getAllStates() {
  return new Map([...cache].map(([pmid, e]) => [pmid, view(e)]));
}

// 冗餘副本只有 title／journal／url／topics（收藏、稍後細讀另有書目欄位），其餘欄位補空值讓 app.js 能照常排序、渲染
// （#2 遷移來的已讀文件可能沒有 title，由 app.js 顯示成「PMID xxx」；#5 之前的收藏沒有書目欄位）
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

// 依時間新到舊；沒有時間的（例如 #2 遷移來的已讀）排最後
function byTimeDesc(key) {
  return (a, b) => (b[key] || "").localeCompare(a[key] || "") || Number(b.pmid) - Number(a.pmid);
}

export async function getAllLater() {
  return [...cache]
    .filter(([, e]) => e.later)
    .map(([pmid, e]) => {
      const laterAt = toIso(e.laterAt);
      return { pmid, laterAt, article: fallbackArticle(pmid, e, laterAt) };
    })
    .sort(byTimeDesc("laterAt"));
}

export async function getAllSaved() {
  return [...cache]
    .filter(([, e]) => e.saved)
    .map(([pmid, e]) => {
      const savedAt = toIso(e.savedAt);
      return { pmid, savedAt, note: e.note || "", article: fallbackArticle(pmid, e, savedAt) };
    })
    .sort(byTimeDesc("savedAt"));
}

export async function getAllRead() {
  return [...cache]
    .filter(([, e]) => e.read)
    .map(([pmid, e]) => {
      const readAt = toIso(e.readAt);
      return { pmid, readAt, article: fallbackArticle(pmid, e, readAt) };
    })
    .sort(byTimeDesc("readAt"));
}

// ---------- 寫入 ----------

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

function meta(article) {
  if (!article) return {};
  return {
    title: article.title ?? "",
    journal: article.journal ?? "",
    url: article.url ?? "",
    topics: article.topics ?? [],
  };
}

async function write(pmid, patch) {
  if (auth.status !== "signedIn" || !fb) throw new AuthRequiredError();
  const prev = cache.get(pmid);
  cache.set(pmid, { ...prev, ...patch });
  emitChange();
  try {
    await fb.setDoc(fb.doc(fb.db, COLLECTION, pmid), patch, { merge: true });
  } catch (err) {
    console.error(`Firestore 寫入失敗（${pmid}）`, err);
    prev ? cache.set(pmid, prev) : cache.delete(pmid);
    emitChange();
    throw err;
  }
}

export async function setRead(pmid, read, article = null) {
  await write(pmid, {
    read: !!read,
    readAt: read ? fb?.Timestamp.now() ?? null : null,
    ...meta(article),
    // 看完就離開「稍後細讀」佇列；laterAt 不清，留作歷史
    ...(read && cache.get(pmid)?.later ? { later: false } : {}),
  });
}

export async function setLater(pmid, later, article = null) {
  await write(pmid, {
    later: !!later,
    laterAt: later ? fb?.Timestamp.now() ?? null : null,
    ...meta(article),
    ...biblio(article),
  });
}

export async function setSaved(pmid, saved, article = null) {
  await write(pmid, {
    saved: !!saved,
    savedAt: saved ? fb?.Timestamp.now() ?? null : null,
    ...meta(article),
    ...biblio(article),
  });
}

// 筆記存在同一份文件的 note 欄位；取消收藏時不動它，再次收藏時筆記會回來
export async function setNote(pmid, text) {
  await write(pmid, { note: String(text ?? "") });
}

// ---------- 從 localStorage 遷移（Handoff #2 遺留） ----------

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
      const snap = await fb.getDocsFromServer(fb.collection(fb.db, COLLECTION));
      const existing = new Set(snap.docs.map((d) => d.id));
      const batch = fb.writeBatch(fb.db);
      for (const [pmid, e] of entries) {
        if (existing.has(pmid)) continue;
        const savedAt = e.saved && e.savedAt ? new Date(e.savedAt) : null;
        batch.set(fb.doc(fb.db, COLLECTION, pmid), {
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
