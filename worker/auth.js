// 驗證 Firebase ID token（RS256），不依賴 firebase-admin：
// 公鑰取自 Google 的 JWK 端點，快取一小時；遇到不認得的 kid（Google 輪替金鑰）時重抓一次。

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const JWKS_TTL = 60 * 60 * 1000;
const CLOCK_SKEW = 60; // 秒

let jwks = null; // { keys: Map<kid, CryptoKey>, at }

export class AuthError extends Error {}

async function loadKeys(force = false) {
  if (!force && jwks && Date.now() - jwks.at < JWKS_TTL) return jwks.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`取得 Firebase 公鑰失敗（HTTP ${res.status}）`);
  const { keys } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    map.set(jwk.kid, key);
  }
  jwks = { keys: map, at: Date.now() };
  return map;
}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

// 成功回傳 payload；任何不符都丟 AuthError（呼叫端回 401）
export async function verifyIdToken(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
  if (!m) throw new AuthError("缺少 Authorization: Bearer token");
  const parts = m[1].split(".");
  if (parts.length !== 3) throw new AuthError("token 格式錯誤");

  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw new AuthError("token 無法解析");
  }
  if (header.alg !== "RS256" || !header.kid) throw new AuthError("token 演算法不符");

  let keys = await loadKeys();
  if (!keys.has(header.kid)) keys = await loadKeys(true);
  const key = keys.get(header.kid);
  if (!key) throw new AuthError("token 金鑰不明");

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new AuthError("token 簽章不符");

  const now = Math.floor(Date.now() / 1000);
  const project = env.FIREBASE_PROJECT_ID;
  if (payload.iss !== `https://securetoken.google.com/${project}`) throw new AuthError("token iss 不符");
  if (payload.aud !== project) throw new AuthError("token aud 不符");
  if (!(payload.exp > now)) throw new AuthError("token 已過期");
  if (payload.iat && payload.iat > now + CLOCK_SKEW) throw new AuthError("token iat 不合理");
  if (!payload.sub || payload.sub !== env.ALLOWED_UID) throw new AuthError("帳號無權使用");
  return payload;
}
