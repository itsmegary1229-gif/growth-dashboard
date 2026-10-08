// Firebase 初始化。純靜態站無打包工具，直接用 gstatic CDN 的 ES module 版 SDK。
// SDK 版號只寫在本檔；其他檔案需要的 Firebase 函式一律從這裡 re-export。
// config 是公開設定（不是機密），存取控制靠 Firestore 安全規則（見 firestore.rules）。

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDocsFromServer, onSnapshot, setDoc, writeBatch,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBsYxwwt_cEJpfq0bHBB9l1Xkbi3sjYid4",
  authDomain: "growth-dashboard-989fb.firebaseapp.com",
  projectId: "growth-dashboard-989fb",
  storageBucket: "growth-dashboard-989fb.firebasestorage.app",
  messagingSenderId: "387024769645",
  appId: "1:387024769645:web:2b62d5a7f04dd7aa602564",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app); // 預設 browserLocalPersistence：關掉瀏覽器再開仍是登入狀態
export const db = getFirestore(app);

export {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  collection, doc, getDocsFromServer, onSnapshot, setDoc, writeBatch, Timestamp,
};
