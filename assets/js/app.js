// 外殼：分區切換（URL hash #papers / #videos）、頁首各分區的篇數／更新時間、登入 UI。
// 各分區的子分頁、篩選、卡片都在 sections/*.js；共用工具在 util.js，個人狀態在 state.js。

import { onAuthChange, signIn, signOutUser } from "./state.js";
import { $, toast } from "./util.js";
import * as papers from "./sections/papers.js";
import * as videos from "./sections/videos.js";

const SECTIONS = { papers, videos };
const DEFAULT_SECTION = "papers";

let current = null;
const metas = { papers: "載入中…", videos: "載入中…" };

// ---------- 分區 ----------

function sectionFromHash() {
  const id = location.hash.slice(1);
  return SECTIONS[id] ? id : DEFAULT_SECTION;
}

function showSection(id) {
  if (id === current) return;
  const first = current === null;
  current = id;
  for (const key of Object.keys(SECTIONS)) $(`section-${key}`).hidden = key !== id;
  document.querySelectorAll(".section-tab").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.section === id)));
  $("meta").textContent = metas[id];
  if (!first) window.scrollTo({ top: 0 });
}

function bindSections() {
  document.querySelector(".section-tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".section-tab");
    if (!b) return;
    // 預設分區不留 hash 也行，但統一寫上，重整後一定停在同一分區
    if (location.hash !== `#${b.dataset.section}`) location.hash = b.dataset.section;
  });
  window.addEventListener("hashchange", () => showSection(sectionFromHash()));
  showSection(sectionFromHash());
}

function setMeta(id, text) {
  metas[id] = text;
  if (id === current) $("meta").textContent = text;
}

// ---------- 登入 ----------

function loginErrorMessage(err) {
  switch (err?.code) {
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
    case "auth/user-disabled":
      return "Email 或密碼不正確";
    case "auth/too-many-requests":
      return "嘗試次數過多，請稍後再試";
    case "auth/network-request-failed":
      return "網路連線失敗，請稍後再試";
    default:
      return "登入失敗，請稍後再試";
  }
}

function setLoginOpen(open) {
  $("login-form").hidden = !open;
  $("login-btn").setAttribute("aria-expanded", String(open));
  if (open) {
    $("login-error").textContent = "";
    $("login-email").focus();
  }
}

function renderAccount({ status, email }) {
  $("login-btn").hidden = status !== "signedOut";
  $("logout-btn").hidden = status !== "signedIn";
  $("logout-btn").title = email ? `已登入：${email}` : "";
  if (status !== "signedOut") setLoginOpen(false);
}

function bindAuth() {
  $("login-btn").addEventListener("click", () => setLoginOpen($("login-form").hidden));

  $("logout-btn").addEventListener("click", async () => {
    try {
      await signOutUser();
    } catch (err) {
      console.error(err);
      toast("登出失敗，請稍後再試");
    }
  });

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) {
      $("login-error").textContent = "請輸入 Email 和密碼";
      return;
    }
    const submit = $("login-submit");
    submit.disabled = true;
    submit.textContent = "登入中…";
    $("login-error").textContent = "";
    try {
      await signIn(email, password);
      $("login-password").value = "";
      setLoginOpen(false);
    } catch (err) {
      console.error("登入失敗", err);
      $("login-error").textContent = loginErrorMessage(err);
    } finally {
      submit.disabled = false;
      submit.textContent = "送出";
    }
  });

  // Esc 或點表單外面就收起來
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("login-form").hidden) {
      setLoginOpen(false);
      $("login-btn").focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!$("login-form").hidden && !e.target.closest("#account")) setLoginOpen(false);
  });

  onAuthChange(renderAccount);
}

// ---------- 啟動 ----------

bindSections();
bindAuth();
for (const [id, section] of Object.entries(SECTIONS)) {
  section.init({ setMeta: (text) => setMeta(id, text) });
}
