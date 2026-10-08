// 已讀／收藏狀態的抽象層。
// 目前存在 localStorage；Handoff #3 換成 Firestore 時只改本檔內部，
// 對外介面（皆為 async）維持不變：
//   getState(pmid)               → { read, saved }
//   getAllStates()               → Map<pmid, { read, saved }>
//   setRead(pmid, read)
//   setSaved(pmid, saved, article?)  收藏時一併存文章快照，文章被 90 天滾動移出 JSON 後仍能在「稍後細讀」看到
//   getAllSaved()                → [{ pmid, savedAt, article }]（article 為收藏當下的快照，可能為 null）

const KEY = "mdr.state.v1";

let memory = null; // localStorage 不可用時（隱私模式等）退回記憶體

function load() {
  if (memory) return memory;
  try {
    memory = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    memory = {};
  }
  return memory;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // 寫不進去就只留在記憶體
  }
}

function view(entry) {
  return { read: !!entry?.read, saved: !!entry?.saved };
}

function clean(pmid) {
  const e = memory[pmid];
  if (e && !e.read && !e.saved) delete memory[pmid];
}

export async function getState(pmid) {
  return view(load()[pmid]);
}

export async function getAllStates() {
  const all = load();
  return new Map(Object.entries(all).map(([pmid, e]) => [pmid, view(e)]));
}

export async function setRead(pmid, read) {
  const all = load();
  all[pmid] = { ...all[pmid], read: !!read };
  clean(pmid);
  save();
}

export async function setSaved(pmid, saved, article = null) {
  const all = load();
  const entry = { ...all[pmid], saved: !!saved };
  if (saved) {
    entry.savedAt = new Date().toISOString();
    if (article) {
      const { pmid: _, ...snapshot } = article;
      entry.article = snapshot;
    }
  } else {
    delete entry.savedAt;
    delete entry.article;
  }
  all[pmid] = entry;
  clean(pmid);
  save();
}

export async function getAllSaved() {
  return Object.entries(load())
    .filter(([, e]) => e.saved)
    .map(([pmid, e]) => ({
      pmid,
      savedAt: e.savedAt || null,
      article: e.article ? { pmid, ...e.article } : null,
    }));
}
