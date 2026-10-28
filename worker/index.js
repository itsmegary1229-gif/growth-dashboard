// growth-dashboard-analyze：論文全文解析的代理 Worker（Handoff #10）。
//
// 端點（皆為 POST，皆需 Authorization: Bearer <Firebase ID token>，只接受 ALLOWED_UID）：
//   /analyze    { pmid, title, journal, year, pdf_base64 }         → SSE 串流解析文字
//   /ask        { pmid, question, analysis, qa?, title?, pdf_base64 } → SSE 串流回答
//   /fetch-pdf  { url } → 代抓 OA PDF（瀏覽器直接抓會被 CORS 擋）；不是 PDF 或抓不到回 422
//   /lookup     { query } → 書目 JSON（PMID／DOI／PubMed 網址／doi.org 網址；見 lookup.js）；找不到 404
//   /summarize  { title, abstract, journal, journal_full?, pub_date?, year } → summary_zh（同 scripts/summarize.py 的結構）
// /analyze 沒有 title 時（只上傳 PDF 的自選文章）輸出最前面多一段 <biblio>{…}</biblio> 書目（見 prompt.js）。
//
// SSE 格式（前端 assets/js/analysis.js 解析）：
//   event: meta   data: { model }                    Anthropic 回應開始
//   event: text   data: { t }                        文字片段
//   event: done   data: { stop_reason, model, usage } 結束
//   event: error  data: { message }                  串流途中出錯
// 開始串流之前的錯誤一律回 JSON { error }，狀態碼 400／401／403／413／422／500／502。
//
// PDF 以 base64 document block 直接送給 Claude，不在前端抽文字；Worker 不儲存 PDF。

import { verifyIdToken, AuthError } from "./auth.js";
import { SYSTEM, analyzeText, askText } from "./prompt.js";
import { SUMMARY_SYSTEM, summaryUserText, parseSummary } from "./summary-prompt.js";
import { lookup, LookupError } from "./lookup.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";
// 安全分類器拒答時由伺服器改用其他模型重試（Sonnet 5.5 只支援 "default"）
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_BODY = 20 * 1024 * 1024;  // 請求體上限 20 MB
const MAX_PDF = 15_000_000;          // /fetch-pdf 代抓上限；base64 後約 20 MB
const FETCH_TIMEOUT = 25_000;

// ---------- 回應 ----------

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- 請求體 ----------

async function readBody(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) throw new HttpError(413, "檔案太大：請求上限 20 MB（PDF 約 15 MB）");
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY) throw new HttpError(413, "檔案太大：請求上限 20 MB（PDF 約 15 MB）");
  try {
    const body = JSON.parse(new TextDecoder().decode(buf));
    if (body && typeof body === "object") return body;
  } catch { /* 下面統一回 400 */ }
  throw new HttpError(400, "請求格式錯誤（需要 JSON）");
}

function requirePdf(b64) {
  // "%PDF-" 的 base64 是 "JVBERi0"
  if (typeof b64 !== "string" || !b64.startsWith("JVBER")) {
    throw new HttpError(400, "缺少 PDF，或檔案不是 PDF");
  }
  return b64;
}

const str = (v, max = 2000) => (typeof v === "string" ? v.slice(0, max) : v == null ? "" : String(v).slice(0, max));

// ---------- Claude ----------

function documentBlock(b64) {
  return {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: b64 },
    cache_control: { type: "ephemeral" },
  };
}

function requireKey(env) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(500,
      "Worker 尚未設定 ANTHROPIC_API_KEY：請到 Cloudflare 後台 Workers → growth-dashboard-analyze → Settings → Variables and Secrets 新增 Secret");
  }
}

async function apiError(res) {
  let msg = `HTTP ${res.status}`;
  try {
    const err = await res.json();
    msg = `${err.error?.type || res.status}: ${err.error?.message || ""}`;
  } catch { /* 保留 HTTP 狀態 */ }
  console.error("Claude API 錯誤", msg);
  return new HttpError(502, `Claude API 錯誤（${msg}）`);
}

async function callClaude(env, text, pdf, cors) {
  requireKey(env);
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": API_VERSION,
      "anthropic-beta": FALLBACK_BETA,
    },
    body: JSON.stringify({
      model: env.MODEL,
      max_tokens: Number(env.MAX_TOKENS) || 8000,
      stream: true,
      // Sonnet 5.5 不接受非預設的 temperature；不開 extended thinking，max_tokens 全部留給輸出
      thinking: { type: "between_tools" },
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: [documentBlock(pdf), { type: "text", text }] }],
    }),
  });
  if (!res.ok) throw await apiError(res);
  return new Response(relay(res.body), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      ...cors,
    },
  });
}

// 把 Anthropic 的 SSE 轉成精簡的 meta／text／done／error 事件。
// 前端取消（關閉連線）時寫入會失敗，順手取消上游，停止計費。
function relay(upstream) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reader = upstream.getReader();
  let buffer = "";
  let model = "";
  let stop = null;
  let usage = {};

  let sent = false;
  const send = (controller, event, data) => {
    controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    sent = true;
  };

  function handle(controller, raw) {
    const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!data) return;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    switch (ev.type) {
      case "message_start":
        model = ev.message?.model || model;
        usage = { ...usage, ...ev.message?.usage };
        send(controller, "meta", { model });
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta" && ev.delta.text) send(controller, "text", { t: ev.delta.text });
        break;
      case "message_delta":
        stop = ev.delta?.stop_reason ?? stop;
        usage = { ...usage, ...ev.usage };
        break;
      case "message_stop":
        send(controller, "done", { stop_reason: stop, model, usage });
        break;
      case "error":
        send(controller, "error", { message: `${ev.error?.type || "error"}: ${ev.error?.message || ""}` });
        break;
    }
  }

  return new ReadableStream({
    // pull 沒有 enqueue 就結束的話串流不會再呼叫 pull，所以讀到至少送出一個事件（或上游結束）為止
    async pull(controller) {
      sent = false;
      while (!sent) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) handle(controller, buffer);
          controller.close();
          return;
        }
        buffer += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          handle(controller, buffer.slice(0, i));
          buffer = buffer.slice(i + 2);
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

// ---------- 端點 ----------

async function analyze(request, env, cors) {
  const body = await readBody(request);
  const pdf = requirePdf(body.pdf_base64);
  const text = analyzeText({ title: str(body.title), journal: str(body.journal, 200), year: str(body.year, 10) });
  return callClaude(env, text, pdf, cors);
}

async function ask(request, env, cors) {
  const body = await readBody(request);
  const pdf = requirePdf(body.pdf_base64);
  const question = str(body.question, 4000).trim();
  if (!question) throw new HttpError(400, "缺少問題");
  const qa = Array.isArray(body.qa)
    ? body.qa.slice(-10).map((x) => ({ q: str(x?.q, 4000), a: str(x?.a, 20000) })) : [];
  const text = askText({ title: str(body.title), analysis: str(body.analysis, 60000), qa, question });
  return callClaude(env, text, pdf, cors);
}

async function fetchWithTimeout(url) {
  return fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; growth-dashboard-analyze/1.0)",
      Accept: "application/pdf,text/html;q=0.8,*/*;q=0.5",
    },
  });
}

function isPdf(buf) {
  const head = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
  // 有些伺服器在 %PDF 前面塞空白或 BOM，看前 1 KB
  return new TextDecoder("latin1").decode(head).includes("%PDF-");
}

async function readCapped(res) {
  const len = Number(res.headers.get("Content-Length") || 0);
  if (len > MAX_PDF) throw new HttpError(413, "OA PDF 超過 15 MB，請改用選檔");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_PDF) throw new HttpError(413, "OA PDF 超過 15 MB，請改用選檔");
  return buf;
}

// OA 落地頁（例如 doi.org 轉到期刊網站）常有 <meta name="citation_pdf_url">，照著再抓一次
function citationPdfUrl(html, base) {
  const m = html.match(/<meta[^>]+name=["']citation_pdf_url["'][^>]*>/i);
  const content = m?.[0].match(/content=["']([^"']+)["']/i)?.[1];
  if (!content) return null;
  try {
    return new URL(content.replace(/&amp;/g, "&"), base).href;
  } catch {
    return null;
  }
}

async function fetchPdf(request, env, cors) {
  const body = await readBody(request);
  let url;
  try {
    url = new URL(str(body.url));
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new HttpError(400, "網址格式錯誤");
  }

  let res;
  try {
    res = await fetchWithTimeout(url.href);
  } catch (err) {
    throw new HttpError(422, `抓取失敗（${err.name === "TimeoutError" ? "逾時" : err.message}）`);
  }
  if (!res.ok) throw new HttpError(422, `抓取失敗（HTTP ${res.status}）`);
  let buf = await readCapped(res);

  if (!isPdf(buf)) {
    const next = (res.headers.get("Content-Type") || "").includes("html") &&
      citationPdfUrl(new TextDecoder().decode(buf), res.url || url.href);
    if (!next) throw new HttpError(422, "這個連結不是 PDF（多半是期刊落地頁）");
    try {
      res = await fetchWithTimeout(next);
    } catch (err) {
      throw new HttpError(422, `抓取失敗（${err.message}）`);
    }
    if (!res.ok) throw new HttpError(422, `抓取失敗（HTTP ${res.status}）`);
    buf = await readCapped(res);
    if (!isPdf(buf)) throw new HttpError(422, "期刊網站沒有直接給 PDF");
  }

  return new Response(buf, {
    headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store", ...cors },
  });
}

async function lookupRoute(request, env, cors) {
  const body = await readBody(request);
  try {
    return json(await lookup(str(body.query, 500), env), 200, cors);
  } catch (err) {
    if (err instanceof LookupError) throw new HttpError(err.status, err.message);
    if (err.name === "TimeoutError") throw new HttpError(504, "書目查詢逾時，請稍後再試");
    throw err;
  }
}

// 自選文章的 AI 摘要：非串流、Haiku 等級（MODEL_SUMMARY），回傳 summary_zh（含 model、at、basis）
async function summarize(request, env, cors) {
  const body = await readBody(request);
  const meta = {
    title: str(body.title, 1000).trim(),
    abstract: str(body.abstract, 20000).trim(),
    journal: str(body.journal, 200),
    journal_full: str(body.journal_full, 300),
    pub_date: str(body.pub_date, 20),
    year: str(body.year, 10),
  };
  if (!meta.title) throw new HttpError(400, "缺少標題");
  requireKey(env);
  const model = env.MODEL_SUMMARY || "claude-haiku-4-5";
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": API_VERSION,
    },
    // summarize.py 送 temperature 0（舊版 API）；2026-10-21 版 API 不接受 temperature，這裡不送
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: SUMMARY_SYSTEM,
      messages: [{ role: "user", content: summaryUserText(meta) }],
    }),
  });
  if (!res.ok) throw await apiError(res);
  const msg = await res.json();
  if (msg.stop_reason === "refusal") throw new HttpError(502, "模型拒絕摘要這篇");
  const raw = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let summary;
  try {
    summary = parseSummary(raw);
  } catch (err) {
    throw new HttpError(502, `摘要格式不合格（${err.message}）`);
  }
  return json({
    ...summary,
    model: msg.model || model,
    at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    basis: meta.abstract ? "abstract" : "title",
  }, 200, cors);
}

const ROUTES = { "/analyze": analyze, "/ask": ask, "/fetch-pdf": fetchPdf, "/lookup": lookupRoute, "/summarize": summarize };

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("Origin");
    // 沒有 Origin（curl 等）照樣要過 token 驗證；有 Origin 但不在白名單一律擋
    if (origin && !cors["Access-Control-Allow-Origin"]) return json({ error: "Origin 不允許" }, 403, {});

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(request.url);
    const route = ROUTES[pathname];
    if (!route) return json({ error: "Not found" }, 404, cors);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    try {
      await verifyIdToken(request, env);
    } catch (err) {
      if (err instanceof AuthError) return json({ error: `未授權：${err.message}` }, 401, cors);
      console.error("驗證 token 時出錯", err);
      return json({ error: "驗證服務暫時無法使用" }, 502, cors);
    }

    try {
      return await route(request, env, cors);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, cors);
      console.error(err);
      return json({ error: `Worker 內部錯誤：${err.message}` }, 500, cors);
    }
  },
};
