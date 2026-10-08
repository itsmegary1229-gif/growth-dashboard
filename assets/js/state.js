// 已讀／收藏狀態的抽象層，存在 Firestore 集合 userState（文件 ID = PMID）。
// 原有對外介面（皆為 async）維持不變：
//   getState(pmid)               → { read, saved }
//   getAllStates()               → Map<pmid, { read, saved }>
//   setRead(pmid, read, article?)    article 可選，用來寫入 title／journal／url／topics 冗餘副本
//   setSaved(pmid, saved, article?)  收藏時一併存文章冗餘副本，文章被 90 天滾動移出 JSON 後仍能在「稍後細讀」看到
//   getAllSaved()                → [{ pmid, savedAt, article }]（article 由冗餘副本組成，可能為 null）
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
  return { read: !!entry?.read, saved: !!entry?.saved };
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

export async function getAllSaved() {
  return [...cache]
    .filter(([, e]) => e.saved)
    .map(([pmid, e]) => {
      const savedAt = toIso(e.savedAt);
      // 冗餘副本只有 title／journal／url／topics，其餘欄位補空值讓 app.js 能照常排序、渲染
      const article = e.title ? {
        pmid,
        title: e.title,
        journal: e.journal || "",
        journal_full: "",
        pub_date: "",
        abstract: "",
        doi: "",
        topics: e.topics || [],
        url: e.url || `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        added_at: savedAt || new Date(0).toISOString(),
      } : null;
      return { pmid, savedAt, article };
    });
}

// ---------- 寫入 ----------

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
  });
}

export async function setSaved(pmid, saved, article = null) {
  await write(pmid, {
    saved: !!saved,
    savedAt: saved ? fb?.Timestamp.now() ?? null : null,
    ...meta(article),
  });
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
