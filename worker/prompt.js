// 論文解析的 prompt。調整內容只改這個檔案，再 npx wrangler deploy。
//
// system 由 /analyze 與 /ask 共用，PDF 的 document block 緊接在後並標 cache_control：
// 解析完幾分鐘內追問，「system＋PDF」這段前綴會命中 prompt cache，不用重新計整份 PDF 的 input 費用。
// 任務說明（解析或追問）放在 PDF 之後的文字區塊。

// 前端用這些標題辨識段落（「步驟拆解」預設展開），改標題時要一併改 assets/js/analysis.js 的 OPEN_SECTIONS
export const TYPES = ["手術技巧", "臨床研究", "系統性回顧或統合分析", "個案系列", "其他"];

export const SYSTEM = `你是協助整形外科醫師讀論文的研究夥伴。讀者是台灣的整形外科主治醫師，臨床與研究並重，熟悉解剖與手術，不需要基礎名詞解釋。

寫作規則：
- 一律使用繁體中文（台灣用語）；解剖、術式、器械、藥物、統計方法等專有名詞保留英文原文。
- 只根據使用者提供的 PDF 全文作答。全文沒有寫的內容不要補，必要時明說「文中未提及」。
- 數字照原文保留（樣本數、劑量、角度、距離、追蹤時間、效應量、p 值、信賴區間），不要四捨五入或改寫單位。
- 用 Markdown 輸出：段落標題用 ##，條列用 -，必要時可用 ### 小標或表格；不要使用 HTML。
- 各段落的內容直接切入重點，不要重複該段的標題（例如「## 主要結果」底下不要再寫「主要結果：」或「主要結果如下」，也不要再加同名的 ### 小標）。`;

// 沒有標題＝使用者只上傳 PDF（自選文章，Handoff #11）：先輸出 <biblio> JSON 書目，前端解析後存成文章書目
const BIBLIO = `這份 PDF 沒有附書目。輸出的最開頭先寫一段書目，格式固定為（<biblio> 標籤內是一個合法 JSON 物件，字串內的雙引號要跳脫）：
<biblio>{"title": "英文原標題", "authors": ["Yang JR", "Chen YH"], "journal": "Plast Reconstr Surg", "journal_full": "Plastic and Reconstructive Surgery", "year": "2026", "doi": "10.xxxx/xxxx", "abstract": "…"}</biblio>
- authors：每位寫成「姓 名字縮寫」（例如 Yang JR），依原文順序，最多 20 位。
- journal：期刊的 PubMed／NLM 縮寫（不加句點）；看不出縮寫就用全名。journal_full 是期刊全名。
- year：四位數字；doi：文中找不到就寫空字串。
- abstract：論文原文 Abstract 照抄（英文）；論文沒有 Abstract 就用英文寫 150 words 內的摘要。
書目之後換行，再照下面的格式輸出解析。

`;

export function analyzeText({ title, journal, year }) {
  const meta = [title && `標題：${title}`, journal && `期刊：${journal}`, year && `年份：${year}`]
    .filter(Boolean).join("\n");
  return `${meta ? `${meta}\n\n` : BIBLIO}請完整解析上面這篇論文的全文。

先判斷文章類型，${title ? "輸出的第一行" : "書目之後的第一行"}固定寫成「文章類型：X」，X 只能是以下其一：${TYPES.join("、")}。
接著依序輸出下列段落，每段以「## 標題」開頭，標題文字照抄：

## 一句話
這篇在問什麼、答案是什麼（一到兩句）。

## 研究設計與樣本
文章類型與研究設計；樣本數、納入與排除條件、追蹤期。
- 系統性回顧或統合分析：搜尋策略與資料庫、納入研究數與設計、總樣本數、異質性、偏差風險評估。
- 手術技巧或個案系列：病人數、適應症、追蹤期、評估方式。

## 主要結果
帶數字：效應量、p 值、信賴區間、併發症率等；主要與次要結果分開列。

## 圖表重點
每個 Figure 與 Table 各一行：「Figure 1：它證明了什麼」。沒有圖表就寫「無」。

## 步驟拆解
手術技巧類一定要有這段；其他類型若文中有具體術式描述也要寫，沒有則整段省略（連標題都不要）。
依手術順序逐步編號，每一步包含：關鍵解剖標記、器械或材料、作者強調的技巧要點、常見陷阱。劑量、角度、距離、尺寸等數字一律保留。

## 限制
分兩部分：「作者承認的」與「作者沒講、但讀得出來的」（例如設計偏差、選樣、追蹤不足、利益衝突、外推性）。

## 臨床意義
與既有做法的差異；什麼情況下會改變臨床做法、什麼情況下不會。具體到病人類型或情境。

## 值得引用的原文
2–3 句英文原文照抄（用 > 引用），每句後面標頁碼或段落位置（例如「p. 4, Discussion 第 2 段」）。`;
}

export function askText({ title, analysis, qa, question }) {
  const history = (qa || [])
    .map((x) => `問：${x.q}\n答：${x.a}`).join("\n\n");
  return `${title ? `標題：${title}\n\n` : ""}以下是先前對這篇論文的解析：

<analysis>
${analysis || "（尚無解析）"}
</analysis>
${history ? `\n先前的追問：\n<qa>\n${history}\n</qa>\n` : ""}
請以上面的 PDF 全文與解析為依據，回答這個追問：

${question}

回答規則：引用全文時標出頁碼或段落位置；全文與解析都找不到依據時，直接說「文中找不到依據」，不要推測或編造。回答用 Markdown，長度視問題而定，不需要重複解析已有的內容。`;
}
