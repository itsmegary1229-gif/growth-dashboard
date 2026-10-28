// 輕量 Markdown → HTML（全文解析用，不引入套件）。先跳脫 HTML，只支援解析會用到的語法：
// ### 小標、- / * / 1. 清單（以縮排巢狀）、> 引用、| 表格 |、段落；行內 **粗體**、*斜體*、`code`、[文字](http 連結)。
// ## 段落標題由 analysis.js 先切成可收合的區塊，這裡遇到的 ## 當小標處理。

import { esc } from "./util.js";

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (s) => s.replace(/\t/g, "  ").length;

// 連續清單行 → 巢狀 ul/ol；縮排較深的項目掛在上一個項目底下，不是清單符號開頭的行接在上一項
function renderList(lines) {
  const items = [];
  for (const line of lines) {
    const m = line.match(LIST);
    if (m) items.push({ indent: indentOf(m[1]), ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
    else if (items.length) items[items.length - 1].text += ` ${line.trim()}`;
  }
  let i = 0;
  function build(indent) {
    const first = items[i];
    const tag = first.ordered ? "ol" : "ul";
    const start = first.ordered && first.start > 1 ? ` start="${first.start}"` : "";
    let html = `<${tag}${start}>`;
    while (i < items.length && items[i].indent >= indent) {
      const it = items[i++];
      html += `<li>${inline(it.text)}`;
      if (i < items.length && items[i].indent > it.indent) html += build(items[i].indent);
      html += "</li>";
    }
    return `${html}</${tag}>`;
  }
  let html = "";
  while (i < items.length) html += build(items[i].indent);
  return html;
}

const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function renderTable(lines) {
  const [head, , ...body] = lines;
  return `<div class="md-table"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
    `<tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function renderMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<h4 class="md-h">${inline(h[2].replace(/\s*#+\s*$/, ""))}</h4>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    if (/^\s*>/.test(line)) {
      const block = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) block.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(block.join("\n"))}</blockquote>`);
      continue;
    }

    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const block = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++]);
      out.push(renderTable(block));
      continue;
    }

    if (LIST.test(line)) {
      const block = [];
      // 清單內的空行不打斷清單（模型常在項目間空一行）
      while (i < lines.length) {
        const l = lines[i];
        if (LIST.test(l) || (block.length && /^\s+\S/.test(l))) block.push(lines[i++]);
        else if (!l.trim() && LIST.test(lines[i + 1] || "")) i++;
        else break;
      }
      out.push(renderList(block));
      continue;
    }

    // 第一行一定收進來（例如不成表格的 | 開頭行），避免卡住
    const para = [lines[i++].trim()];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*\|)/.test(lines[i]) && !LIST.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}
