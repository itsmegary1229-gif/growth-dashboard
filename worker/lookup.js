// /lookup：PMID、DOI、PubMed 網址、doi.org 網址 → 書目。
// PMID 走 PubMed efetch；DOI 先用 PubMed esearch 找 PMID（找得到就用 PubMed 的書目與摘要，較完整），
// 找不到再查 Crossref；有 DOI 時另查 Unpaywall 的 OA 連結。欄位與 data/articles.json 一致（見 scripts/fetch_pubmed.py）。
// Workers 沒有 DOMParser，PubMed XML 以正規式解析（單篇、結構固定）。

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TIMEOUT = 15_000;

// 與 scripts/fetch_pubmed.py 的 JOURNALS 相同：PubMed 期刊名（MedlineTA）→ 儀表板簡稱
const JOURNALS = {
  "PRS": "Plast Reconstr Surg",
  "PRS-GO": "Plast Reconstr Surg Glob Open",
  "ASJ": "Aesthet Surg J",
  "APS": "Aesthetic Plast Surg",
  "IJOMS": "Int J Oral Maxillofac Surg",
};
const TA_TO_ABBR = Object.fromEntries(Object.entries(JOURNALS).map(([k, v]) => [v.toLowerCase(), k]));
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export class LookupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- 輸入判斷 ----------

export function parseQuery(raw) {
  let q = String(raw || "").trim();
  try {
    q = decodeURIComponent(q);
  } catch { /* 保留原字串 */ }
  let m = q.match(/^(?:pmid\s*:?\s*)?(\d{1,9})$/i) ||
    q.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{1,9})/i) ||
    q.match(/ncbi\.nlm\.nih\.gov\/pubmed\/(\d{1,9})/i);
  if (m) return { pmid: m[1] };
  m = q.match(/(10\.\d{4,9}\/[^\s"'<>]+)/);
  if (m) return { doi: m[1].replace(/[.,;:)\]}]+$/, "").replace(/\/(full|abstract|pdf|epdf)$/i, "") };
  return null;
}

// ---------- 工具 ----------

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { Accept: accept, "User-Agent": "growth-dashboard-analyze/1.0" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return res;
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// 去標籤（含 <i>、<sup>）、解 entity、壓空白
function text(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function inner(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : "";
}

function all(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))]
    .map((m) => ({ attrs: m[1] || "", body: m[2] }));
}

const attr = (attrs, name) => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] || "";

function pad(n) {
  return String(n).padStart(2, "0");
}

// PubDate／ArticleDate → YYYY-MM-DD，缺月日補 01（同 fetch_pubmed.parse_date）
function pubmedDate(block) {
  if (!block) return "";
  let year = text(inner(block, "Year"));
  let month = text(inner(block, "Month"));
  const day = text(inner(block, "Day"));
  if (!year) {
    const parts = text(inner(block, "MedlineDate")).split(" ");
    if (!/^\d{4}/.test(parts[0] || "")) return "";
    year = parts[0].slice(0, 4);
    month = (parts[1] || "").split("-")[0];
  }
  const m = /^\d+$/.test(month) ? Number(month) : MONTHS[month.slice(0, 3).toLowerCase()] || 1;
  const d = /^\d+$/.test(day) ? Number(day) : 1;
  return `${year}-${pad(m)}-${pad(d)}`;
}

// ---------- PubMed ----------

function eutilsParams(env) {
  return `tool=growth-dashboard&email=${encodeURIComponent(env.CONTACT_EMAIL || "")}`;
}

export function parsePubmedXml(xml) {
  const node = inner(xml, "PubmedArticle");
  if (!node) return null;
  const citation = inner(node, "MedlineCitation");
  const article = inner(citation, "Article");
  const journalBlock = inner(article, "Journal");

  const ta = text(inner(citation, "MedlineTA"));
  const iso = text(inner(journalBlock, "ISOAbbreviation")).replace(/\./g, "");
  const journal = TA_TO_ABBR[ta.toLowerCase()] || TA_TO_ABBR[iso.toLowerCase()] || ta || iso;

  const pubDate = pubmedDate(inner(article, "ArticleDate")) || pubmedDate(inner(journalBlock, "PubDate"));

  const abstract = all(inner(article, "Abstract"), "AbstractText")
    .map(({ attrs, body }) => {
      const t = text(body);
      const label = decode(attr(attrs, "Label"));
      return t && (label ? `${label}: ${t}` : t);
    })
    .filter(Boolean).join("\n\n");

  let doi = all(inner(node, "PubmedData"), "ArticleId")
    .find(({ attrs }) => attr(attrs, "IdType") === "doi")?.body || "";
  if (!doi) doi = all(article, "ELocationID").find(({ attrs }) => attr(attrs, "EIdType") === "doi")?.body || "";

  const authors = all(inner(article, "AuthorList"), "Author")
    .filter(({ attrs }) => attr(attrs, "ValidYN") !== "N")
    .map(({ body }) => {
      const collective = text(inner(body, "CollectiveName"));
      if (collective) return collective;
      const last = text(inner(body, "LastName"));
      const initials = text(inner(body, "Initials"));
      return last ? (initials ? `${last} ${initials}` : last) : "";
    })
    .filter(Boolean);

  const issue = inner(journalBlock, "JournalIssue");
  const pmid = text(inner(citation, "PMID"));
  return {
    pmid,
    doi: text(doi),
    title: text(inner(article, "ArticleTitle")),
    authors,
    journal,
    journal_full: text(inner(journalBlock, "Title")),
    pub_date: pubDate,
    year: pubDate.slice(0, 4),
    volume: text(inner(issue, "Volume")),
    issue: text(inner(issue, "Issue")),
    pages: text(inner(inner(article, "Pagination"), "MedlinePgn")),
    abstract,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    source: "pubmed",
  };
}

async function pubmedByPmid(pmid, env) {
  const res = await get(`${EUTILS}/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml&${eutilsParams(env)}`, "application/xml");
  if (!res.ok) throw new LookupError(502, `PubMed 查詢失敗（HTTP ${res.status}）`);
  return parsePubmedXml(await res.text());
}

async function pmidForDoi(doi, env) {
  const term = encodeURIComponent(`${doi}[doi]`);
  const res = await get(`${EUTILS}/esearch.fcgi?db=pubmed&term=${term}&retmode=json&${eutilsParams(env)}`, "application/json");
  if (!res.ok) return null;
  const ids = (await res.json())?.esearchresult?.idlist || [];
  return ids.length === 1 ? ids[0] : null;
}

// ---------- Crossref ----------

function initials(given) {
  return String(given || "").split(/[\s.-]+/).filter(Boolean).map((p) => p[0].toUpperCase()).join("");
}

export function parseCrossref(msg) {
  const parts = msg.issued?.["date-parts"]?.[0] || msg.published?.["date-parts"]?.[0] || [];
  const pubDate = parts[0] ? `${parts[0]}-${pad(parts[1] || 1)}-${pad(parts[2] || 1)}` : "";
  const full = text((msg["container-title"] || [])[0]);
  const short = text((msg["short-container-title"] || [])[0]);
  const ta = short.replace(/\./g, "");
  return {
    pmid: "",
    doi: msg.DOI || "",
    title: text((msg.title || [])[0]),
    authors: (msg.author || []).map((a) => (a.family ? `${text(a.family)} ${initials(a.given)}`.trim() : text(a.name))).filter(Boolean),
    journal: TA_TO_ABBR[ta.toLowerCase()] || ta || full,
    journal_full: full,
    pub_date: pubDate,
    year: pubDate.slice(0, 4),
    volume: msg.volume || "",
    issue: msg.issue || "",
    pages: msg.page || "",
    // Crossref 的摘要是 JATS XML（不一定有）
    abstract: text(String(msg.abstract || "").replace(/<jats:title>[\s\S]*?<\/jats:title>/g, "")),
    url: `https://doi.org/${msg.DOI}`,
    source: "crossref",
  };
}

async function crossref(doi, env) {
  const res = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(env.CONTACT_EMAIL || "")}`, "application/json");
  if (res.status === 404) return null;
  if (!res.ok) throw new LookupError(502, `Crossref 查詢失敗（HTTP ${res.status}）`);
  return parseCrossref((await res.json()).message || {});
}

// ---------- Unpaywall ----------

async function unpaywall(doi, env) {
  try {
    const res = await get(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(env.CONTACT_EMAIL || "")}`, "application/json");
    if (!res.ok) return { oa_url: null, oa_pdf: false };
    const loc = (await res.json()).best_oa_location;
    if (loc?.url_for_pdf) return { oa_url: loc.url_for_pdf, oa_pdf: true };
    return { oa_url: loc?.url || null, oa_pdf: false };
  } catch {
    return { oa_url: null, oa_pdf: false }; // OA 查不到不影響書目
  }
}

// ---------- 對外 ----------

export async function lookup(query, env) {
  const q = parseQuery(query);
  if (!q) throw new LookupError(400, "看不出 PMID 或 DOI，請貼 PMID、DOI、PubMed 或 doi.org 網址");
  let bib = null;
  if (q.pmid) {
    bib = await pubmedByPmid(q.pmid, env);
  } else {
    const pmid = await pmidForDoi(q.doi, env).catch(() => null);
    if (pmid) bib = await pubmedByPmid(pmid, env);
    if (!bib) bib = await crossref(q.doi, env);
  }
  if (!bib || !bib.title) throw new LookupError(404, q.pmid ? `PubMed 找不到 PMID ${q.pmid}` : `找不到 DOI ${q.doi}`);
  Object.assign(bib, bib.doi ? await unpaywall(bib.doi, env) : { oa_url: null, oa_pdf: false });
  return bib;
}
