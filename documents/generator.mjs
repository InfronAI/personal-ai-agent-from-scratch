import { existsSync } from "node:fs";

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";
import PDFDocument from "pdfkit";

import { parseDocumentMarkdown } from "./markdown.mjs";

const HEADING_LEVELS = {
  1: HeadingLevel.TITLE,
  2: HeadingLevel.HEADING_1,
  3: HeadingLevel.HEADING_2,
  4: HeadingLevel.HEADING_3,
  5: HeadingLevel.HEADING_4,
  6: HeadingLevel.HEADING_5
};

function pdfFontPath() {
  const candidates = [
    process.env.COPILOT_DOCUMENT_FONT_PATH,
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
  ].filter(Boolean);
  return candidates.find(path => existsSync(path)) || null;
}

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function renderPdfTable(doc, rows) {
  const widths = rows.reduce((max, row) => Math.max(max, row.length), 1);
  for (const [index, row] of rows.entries()) {
    const prefix = index === 0 ? "" : "";
    doc.fontSize(9).fillColor(index === 0 ? "#111111" : "#333333")
      .text(`${prefix}${row.map(cell => cell || " ").join("  |  ")}`, { width: 470 });
    if (index === 0) doc.moveTo(doc.x, doc.y).lineTo(doc.x + 470, doc.y).strokeColor("#d9d9d9").stroke();
    if (row.length < widths) doc.moveDown(0.1);
  }
  doc.moveDown(0.5);
}

export async function renderPdf({ title, markdown }) {
  const parsed = parseDocumentMarkdown(title, markdown);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 54, right: 58, bottom: 54, left: 58 },
    info: { Title: parsed.title, Author: "Personal Copilot", Creator: "Personal Copilot Document Generator" },
    bufferPages: true
  });
  const result = collectPdf(doc);
  const font = pdfFontPath();
  if (font) {
    try { doc.font(font); } catch { doc.font("Helvetica"); }
  } else doc.font("Helvetica");
  doc.fillColor("#171717");
  let orderedIndex = 0;
  for (const block of parsed.blocks) {
    if (block.type !== "list_item" || !block.ordered) orderedIndex = 0;
    if (block.type === "heading") {
      const sizes = { 1: 24, 2: 17, 3: 14, 4: 12, 5: 11, 6: 10 };
      doc.moveDown(block.level === 1 ? 0 : 0.5).fontSize(sizes[block.level] || 11).fillColor("#111111").text(block.text, { lineGap: 2 });
      doc.moveDown(0.35);
    } else if (block.type === "paragraph") {
      doc.fontSize(10.5).fillColor("#262626").text(block.text, { lineGap: 3, align: "left" }).moveDown(0.65);
    } else if (block.type === "list_item") {
      orderedIndex = block.ordered ? orderedIndex + 1 : 0;
      const marker = block.ordered ? `${orderedIndex}.` : "•";
      doc.fontSize(10.5).fillColor("#262626").text(`${marker} ${block.text}`, { indent: 12, lineGap: 2 }).moveDown(0.25);
    } else if (block.type === "quote") {
      doc.fontSize(10).fillColor("#555555").text(`“${block.text}”`, { indent: 16, lineGap: 2 }).moveDown(0.5);
    } else if (block.type === "code") {
      doc.fontSize(8.5).fillColor("#242424").text(block.text, { indent: 10, lineGap: 1 }).moveDown(0.6);
    } else if (block.type === "table") renderPdfTable(doc, block.rows);
  }
  const pageRange = doc.bufferedPageRange();
  for (let index = 0; index < pageRange.count; index += 1) {
    doc.switchToPage(index);
    doc.fontSize(8).fillColor("#777777").text(`${index + 1} / ${pageRange.count}`, 58, doc.page.height - 38, { width: doc.page.width - 116, align: "right" });
  }
  doc.end();
  return { buffer: await result, markdown: parsed.markdown, blocks: parsed.blocks.length };
}

function docxChildren(parsed) {
  const children = [];
  let orderedReference = 0;
  for (const block of parsed.blocks) {
    if (block.type === "heading") {
      children.push(new Paragraph({ text: block.text, heading: HEADING_LEVELS[block.level] || HeadingLevel.HEADING_3 }));
    } else if (block.type === "paragraph") {
      children.push(new Paragraph({ children: [new TextRun(block.text)], spacing: { after: 180, line: 320 } }));
    } else if (block.type === "list_item") {
      if (block.ordered) orderedReference += 1;
      else orderedReference = 0;
      children.push(new Paragraph(block.ordered
        ? { text: block.text, numbering: { reference: "copilot-numbering", level: 0 }, spacing: { after: 80 } }
        : { text: block.text, bullet: { level: 0 }, spacing: { after: 80 } }));
    } else if (block.type === "quote") {
      children.push(new Paragraph({ children: [new TextRun({ text: block.text, italics: true, color: "555555" })], indent: { left: 360 }, spacing: { after: 160 } }));
    } else if (block.type === "code") {
      children.push(new Paragraph({ children: [new TextRun({ text: block.text, font: "Menlo", size: 18 })], shading: { fill: "F4F4F4" }, spacing: { before: 100, after: 180 } }));
    } else if (block.type === "table") {
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: block.rows.map((row, rowIndex) => new TableRow({
          children: row.map(cell => new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: cell, bold: rowIndex === 0 })] })],
            borders: {
              top: { style: BorderStyle.SINGLE, color: "D9D9D9", size: 1 },
              bottom: { style: BorderStyle.SINGLE, color: "D9D9D9", size: 1 },
              left: { style: BorderStyle.SINGLE, color: "D9D9D9", size: 1 },
              right: { style: BorderStyle.SINGLE, color: "D9D9D9", size: 1 }
            }
          }))
        }))
      }));
      children.push(new Paragraph(""));
    }
  }
  return children;
}

export async function renderDocx({ title, markdown }) {
  const parsed = parseDocumentMarkdown(title, markdown);
  const document = new Document({
    creator: "Personal Copilot",
    title: parsed.title,
    description: "Generated by Personal Copilot Document Generator",
    numbering: {
      config: [{
        reference: "copilot-numbering",
        levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 260 } } } }]
      }]
    },
    sections: [{ properties: {}, children: docxChildren(parsed) }]
  });
  return { buffer: await Packer.toBuffer(document), markdown: parsed.markdown, blocks: parsed.blocks.length };
}
