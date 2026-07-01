/* Ward — tiny markdown renderer. Escapes raw HTML, supports the subset the
   generators emit: #..###### headings, **bold**, *italic*, `code`, > quotes,
   -/* and 1. lists, | tables |, ![alt](url), [text](url), --- rules, and
   leaves @@FIG0@@ figure placeholders untouched for the app to swap in. */
(function () {
  "use strict";
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  function inline(s) {
    // escape first, then apply inline markdown on the escaped text
    s = esc(s);
    // images ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, a, u) =>
      `<img src="${u}" alt="${a}" loading="lazy">`);
    // links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t, u) =>
      `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    // inline code
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    // bold then italic
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    return s;
  }

  function tableRow(line) {
    return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  }

  function render(md) {
    const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
    let html = "", i = 0;
    const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l);
    while (i < lines.length) {
      let ln = lines[i];

      if (!ln.trim()) { i++; continue; }

      // horizontal rule
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { html += "<hr>"; i++; continue; }

      // heading
      const h = ln.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) { const n = h[1].length; html += `<h${n}>${inline(h[2].trim())}</h${n}>`; i++; continue; }

      // blockquote (consume consecutive > lines)
      if (/^\s*>\s?/.test(ln)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        html += `<blockquote>${inline(buf.join(" ").trim())}</blockquote>`;
        continue;
      }

      // table: a header row followed by a --- separator row
      if (ln.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
        const head = tableRow(ln);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(tableRow(lines[i])); i++; }
        html += "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>";
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(ln)) {
        html += "<ul>";
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          html += `<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, "").trim())}</li>`; i++;
        }
        html += "</ul>"; continue;
      }

      // ordered list
      if (/^\s*\d+[.)]\s+/.test(ln)) {
        html += "<ol>";
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          html += `<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, "").trim())}</li>`; i++;
        }
        html += "</ol>"; continue;
      }

      // figure placeholder on its own line — leave as-is for the app to swap
      if (/^@@FIG\d+@@$/.test(ln.trim())) { html += `<p>${ln.trim()}</p>`; i++; continue; }

      // paragraph (gather until blank or next block)
      const para = [];
      while (i < lines.length && lines[i].trim() &&
        !/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|-{3,}\s*$|\*{3,}\s*$)/.test(lines[i]) &&
        !/^@@FIG\d+@@$/.test(lines[i].trim())) {
        para.push(lines[i].trim()); i++;
      }
      if (para.length) html += `<p>${inline(para.join(" "))}</p>`;
    }
    return html;
  }

  window.MD = { render };
})();