function plainInline(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/gu, "$1")
    .trim();
}

function tableCells(line) {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map(cell => plainInline(cell));
}

function isTableSeparator(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/u.test(cell.replaceAll(" ", "")));
}

export function normalizeDocumentMarkdown(title, markdown) {
  const cleanTitle = plainInline(title).slice(0, 200) || "Document";
  const content = String(markdown || "").replace(/\r\n?/gu, "\n").trim();
  const firstHeading = content.match(/^#\s+(.+)$/mu)?.[1];
  return firstHeading && plainInline(firstHeading).toLocaleLowerCase() === cleanTitle.toLocaleLowerCase()
    ? content
    : `# ${cleanTitle}\n\n${content}`.trim();
}

export function parseDocumentMarkdown(title, markdown) {
  const normalized = normalizeDocumentMarkdown(title, markdown);
  const lines = normalized.split("\n");
  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: plainInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length, text: plainInline(heading[2]) });
      continue;
    }
    const unordered = line.match(/^[-*+]\s+(.+)$/u);
    if (unordered) {
      flushParagraph();
      blocks.push({ type: "list_item", ordered: false, text: plainInline(unordered[1]) });
      continue;
    }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/u);
    if (ordered) {
      flushParagraph();
      blocks.push({ type: "list_item", ordered: true, text: plainInline(ordered[1]) });
      continue;
    }
    if (line.startsWith("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      const rows = [tableCells(line)];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "table", rows });
      continue;
    }
    if (/^```/u.test(line)) {
      flushParagraph();
      const language = line.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/u.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "code", language, text: code.join("\n") });
      continue;
    }
    if (/^>\s?/u.test(line)) {
      flushParagraph();
      blocks.push({ type: "quote", text: plainInline(line.replace(/^>\s?/u, "")) });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return { title: plainInline(title).slice(0, 200) || "Document", markdown: normalized, blocks };
}
