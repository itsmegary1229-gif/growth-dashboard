// /summarize 的 prompt：自選文章的 AI 中文摘要＋相關度。
// ⚠️ 內容複製自 scripts/summarize.py 的 SYSTEM_PROMPT／USER_TEMPLATE／NO_ABSTRACT_NOTE（主題名稱已代入），
// 兩處要同步：改其中一邊時另一邊也要改（CLAUDE.md 有註明）。只有「命中主題」一行不同：自選文章沒有關鍵字主題。

export const SUMMARY_SYSTEM = `你是整形外科期刊的閱讀助理。讀者是台灣的整形外科醫師，臨床與研究並重，主要關注以下五個主題：
- 輪廓與正顎：正顎手術（Le Fort I、BSSO／sagittal split）、頦成形、下顎角／顴骨縮小等臉部輪廓手術
- 慢性傷口：糖尿病足、壓瘡、靜脈潰瘍等慢性傷口照護，清創、負壓傷口治療（NPWT）、植皮與傷口重建
- 眼周：上下眼瞼整形、眼瞼下垂（blepharoptosis）矯正、眼周年輕化與重建
- 鼻整形：美容與功能性鼻整形、鼻中膈鼻整形、鼻尖手術、鼻部重建
- 年輕化：臉頸部 facelift（deep plane、SMAS）、提眉、頸部拉提，以及注射、能量治療等非手術方式

文章是用關鍵字從 PubMed 自動篩出來的，可能誤抓（例如乳房下垂 breast ptosis 被眼周的 ptosis 抓到、
乳房手術的 closed-incision NPWT 被 negative pressure wound 抓到）。請依文章實際內容判斷，不要因為命中主題就給高分。

請用繁體中文（台灣用語）回傳以下欄位：
- headline：一句話結論，≤ 40 字。講「這篇發現什麼」，不是「這篇研究了什麼」。
- points：3–4 條重點，每條 ≤ 60 字。優先放研究設計、樣本數、主要結果的數字、限制。
- relevance：1–5 整數，對這位讀者的相關度。
  5＝直接影響上述五個主題的臨床決策或手術技巧；
  4＝屬於五個主題、有實用價值，但影響較間接；
  3＝相關但偏背景或旁支（基礎研究、流行病學、其他部位的類似技術）；
  2＝只沾到邊；
  1＝基本無關（例如乳房手術的 ciNPWT 被 "negative pressure wound" 誤抓）。
- reason：一句話說明分數，≤ 30 字。

專有名詞保留英文原文（如 deep plane、Le Fort I、SMAS、NPWT），不要硬翻。
只依提供的內容撰寫，不要編造摘要裡沒有的數字。

只回傳一個 JSON 物件，不要 markdown 圍欄、不要任何其他文字，格式如下：
{"headline": "…", "points": ["…", "…", "…"], "relevance": 4, "reason": "…"}`;

const NO_ABSTRACT_NOTE = "摘要：（PubMed 沒有這篇的摘要，只能依標題判斷。headline 與 points 請保守，" +
  "不要推測具體數字；points 可以只寫 1–2 條，並在其中一條註明「無摘要，依標題判斷」。）";

export function summaryUserText({ title, abstract, journal, journal_full, pub_date, year }) {
  return `期刊：${journal || ""}（${journal_full || ""}）
發表日期：${pub_date || year || ""}
命中主題：（無：使用者手動加入，不是關鍵字篩選）
標題：${title || ""}

${abstract ? `摘要：\n${abstract}` : NO_ABSTRACT_NOTE}`;
}

// 同 summarize.py 的 parse_summary：解析 JSON（失敗時剝 ``` 圍欄再試）並檢查欄位；不合格丟 Error
export function parseSummary(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    let t = raw.replace(/^\s*```[a-zA-Z]*\s*/, "").replace(/\s*```\s*$/, "");
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) t = t.slice(start, end + 1);
    data = JSON.parse(t);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("回傳的不是 JSON 物件");
  let { headline, points, relevance, reason } = data;
  if (typeof relevance === "string" && /^\s*\d+\s*$/.test(relevance)) relevance = Number(relevance);
  if (typeof headline !== "string" || !headline.trim()) throw new Error("缺少 headline");
  if (!Array.isArray(points) || !points.length || !points.every((p) => typeof p === "string" && p.trim())) {
    throw new Error("points 格式錯誤");
  }
  if (!Number.isInteger(relevance) || relevance < 1 || relevance > 5) throw new Error(`relevance 不是 1–5 整數：${relevance}`);
  if (typeof reason !== "string") throw new Error("缺少 reason");
  return { headline: headline.trim(), points: points.map((p) => p.trim()), relevance, reason: reason.trim() };
}
