import type {
  Case,
  Deliverable,
  DeliverableSection,
  Evidence,
  EvidenceLocation,
  Finding,
} from "@evianta/core";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import { z } from "zod";

export const exportFormatSchema = z.enum(["docx", "xlsx", "json"]);

export type ExportFormat = z.infer<typeof exportFormatSchema>;

export interface ExportInput {
  caseRecord: Case;
  deliverable: Deliverable;
  /** Active findings of the case. */
  findings: readonly Finding[];
  /** Every stored evidence item of the case; the appendix keeps only what the deliverable cites. */
  evidence: readonly Evidence[];
  generatedAt: Date;
}

export interface ExportFile {
  fileName: string;
  contentType: string;
  body: Buffer;
}

export interface AppendixEntry {
  ref: string;
  evidence: Evidence;
}

export interface ParsedTable {
  header: string[];
  rows: string[][];
}

export function effectiveContent(section: DeliverableSection): string {
  return section.editedContent ?? section.content;
}

export function isEditedByReviewer(section: DeliverableSection): boolean {
  return section.editedContent !== undefined && section.editedContent !== section.content;
}

/** Evidence cited by the deliverable's sections (directly or through their findings), numbered E1, E2, ... */
export function buildEvidenceAppendix(input: ExportInput): {
  entries: AppendixEntry[];
  refsBySection: Map<string, string[]>;
} {
  const findingsById = new Map(input.findings.map((finding) => [finding.id, finding]));
  const evidenceById = new Map<string, Evidence>();

  for (const finding of input.findings) {
    for (const item of finding.evidence) {
      evidenceById.set(item.id, item);
    }
  }

  for (const item of input.evidence) {
    evidenceById.set(item.id, item);
  }

  const refsById = new Map<string, string>();
  const entries: AppendixEntry[] = [];
  const refsBySection = new Map<string, string[]>();

  for (const section of input.deliverable.sections) {
    const ids = [
      ...section.evidenceIds,
      ...section.findingIds.flatMap(
        (id) => findingsById.get(id)?.evidence.map((item) => item.id) ?? [],
      ),
    ];
    const refs: string[] = [];

    for (const id of ids) {
      const item = evidenceById.get(id);

      if (!item) {
        continue;
      }

      let ref = refsById.get(id);

      if (!ref) {
        ref = `E${entries.length + 1}`;
        refsById.set(id, ref);
        entries.push({ ref, evidence: item });
      }

      if (!refs.includes(ref)) {
        refs.push(ref);
      }
    }

    refsBySection.set(section.id, refs);
  }

  return { entries, refsBySection };
}

export function describeLocation(location: EvidenceLocation | undefined): string {
  if (!location) {
    return "";
  }

  const parts: string[] = [];

  if (location.page !== undefined) {
    parts.push(`page ${location.page}`);
  }

  if (location.sheet) {
    parts.push(location.cellRange ? `${location.sheet}!${location.cellRange}` : location.sheet);
  } else if (location.cellRange) {
    parts.push(location.cellRange);
  }

  if (location.rowRange) {
    const { start, end } = location.rowRange;

    parts.push(start === end ? `row ${start}` : `rows ${start}-${end}`);
  }

  return parts.join(", ");
}

// Splits on unescaped pipes only; `\|` inside a cell is a literal pipe.
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTable(lines: readonly string[]): ParsedTable | undefined {
  const rows = lines.map(splitTableRow).filter((cells) => !isSeparatorRow(cells));
  const [header, ...body] = rows;

  if (!header || header.length === 0) {
    return undefined;
  }

  return { header, rows: body.map((row) => header.map((_, index) => row[index] ?? "")) };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function parseJsonTable(content: string): ParsedTable | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (Array.isArray(parsed) && parsed.every((row) => row && typeof row === "object")) {
    const header = [...new Set(parsed.flatMap((row) => Object.keys(row as object)))];

    return {
      header,
      rows: parsed.map((row) =>
        header.map((key) => cellText((row as Record<string, unknown>)[key])),
      ),
    };
  }

  if (parsed && typeof parsed === "object") {
    const table = parsed as { columns?: unknown; rows?: unknown };

    if (Array.isArray(table.columns) && Array.isArray(table.rows)) {
      const header = table.columns.map((column) =>
        column && typeof column === "object" && "name" in column
          ? cellText((column as { name: unknown }).name)
          : cellText(column),
      );

      return {
        header,
        rows: table.rows.map((row) =>
          header.map((_, index) => cellText(Array.isArray(row) ? row[index] : undefined)),
        ),
      };
    }
  }

  return undefined;
}

/** Reads the first markdown table in the content, or a JSON table (rows of objects, or columns and rows). */
export function parseTable(content: string): ParsedTable | undefined {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith("|"));

  if (start !== -1) {
    const end = lines.findIndex((line, index) => index > start && !line.trim().startsWith("|"));

    return parseMarkdownTable(lines.slice(start, end === -1 ? undefined : end));
  }

  return parseJsonTable(content.trim());
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "deliverable";
}

function inlineRuns(text: string, base: { italics?: boolean } = {}): TextRun[] {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter((part) => part.length > 0)
    .map((part) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4
        ? new TextRun({ text: part.slice(2, -2), bold: true, ...base })
        : new TextRun({ text: part, ...base }),
    );
}

function docxTable(table: ParsedTable): Table {
  const row = (cells: readonly string[], bold: boolean) =>
    new TableRow({
      children: cells.map(
        (cell) =>
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: cell, bold })] })],
          }),
      ),
    });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [row(table.header, true), ...table.rows.map((cells) => row(cells, false))],
  });
}

function contentBlocks(content: string): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] as string).trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("|")) {
      const tableLines = [line];

      while ((lines[index + 1] ?? "").trim().startsWith("|")) {
        index++;
        tableLines.push(lines[index] as string);
      }

      const table = parseMarkdownTable(tableLines);

      if (table) {
        blocks.push(docxTable(table));
      }

      continue;
    }

    if (trimmed.length === 0) {
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);

    if (heading) {
      blocks.push(
        new Paragraph({
          heading:
            (heading[1] as string).length <= 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          children: inlineRuns(heading[2] as string),
        }),
      );

      continue;
    }

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);

    if (bullet) {
      blocks.push(
        new Paragraph({
          bullet: { level: Math.min(3, Math.floor((bullet[1] as string).length / 2)) },
          children: inlineRuns(bullet[2] as string),
        }),
      );

      continue;
    }

    blocks.push(new Paragraph({ children: inlineRuns(trimmed) }));
  }

  return blocks;
}

function provenanceLine(section: DeliverableSection): string {
  const parts = [`Prepared by ${section.producedByRole}`];

  if (isEditedByReviewer(section)) {
    parts.push("edited by reviewer");
  }

  if (section.reviewStatus !== "pending") {
    parts.push(`review status: ${section.reviewStatus}`);
  }

  return parts.join("; ");
}

export async function exportDocxAsync(input: ExportInput): Promise<ExportFile> {
  const { caseRecord, deliverable, generatedAt } = input;
  const { entries, refsBySection } = buildEvidenceAppendix(input);
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(deliverable.title)] }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Case: ${caseRecord.title}. Generated ${generatedAt.toISOString()}.`,
          italics: true,
        }),
      ],
    }),
  ];

  if (caseRecord.approval) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Approved by the reviewer on ${caseRecord.approval.approvedAt}.`,
            italics: true,
          }),
        ],
      }),
    );
  }

  if (deliverable.content) {
    children.push(...contentBlocks(deliverable.content));
  }

  for (const section of deliverable.sections) {
    const refs = refsBySection.get(section.id) ?? [];

    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(section.title)] }),
      new Paragraph({ children: [new TextRun({ text: provenanceLine(section), italics: true })] }),
      ...contentBlocks(effectiveContent(section)),
    );

    if (section.reviewComment) {
      children.push(
        new Paragraph({
          children: inlineRuns(`Reviewer comment: ${section.reviewComment}`, { italics: true }),
        }),
      );
    }

    if (refs.length > 0) {
      children.push(new Paragraph({ children: [new TextRun(`Evidence: ${refs.join(", ")}`)] }));
    }
  }

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun("Evidence appendix")],
    }),
  );

  if (entries.length === 0) {
    children.push(new Paragraph("No evidence is cited by this deliverable."));
  } else {
    children.push(
      docxTable({
        header: ["Ref", "Source", "Location", "Description", "Excerpt", "Confidence"],
        rows: entries.map(({ ref, evidence }) => [
          ref,
          evidence.sourceRef,
          describeLocation(evidence.location),
          evidence.description,
          evidence.excerpt ?? "",
          evidence.confidence ?? "",
        ]),
      }),
    );
  }

  const document = new Document({
    title: deliverable.title,
    creator: "Evianta",
    sections: [{ children }],
  });

  return {
    fileName: `${slugify(deliverable.title)}.docx`,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: await Packer.toBuffer(document),
  };
}

const RESERVED_SHEET_NAME = "history";

// Excel rejects []:*?/\, names over 31 characters, names starting or ending with an apostrophe,
// and the reserved name "History".
export function worksheetName(title: string, used: Set<string>): string {
  const cleaned = title
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(/^[\s']+|[\s']+$/g, "")
    .slice(0, 28)
    .replace(/[\s']+$/, "");
  const base =
    cleaned.toLowerCase() === RESERVED_SHEET_NAME ? `${cleaned} table` : cleaned || "Table";
  let name = base;
  let counter = 2;

  while (used.has(name.toLowerCase())) {
    name = `${base.slice(0, 27 - String(counter).length).replace(/[\s']+$/, "")} ${counter}`;
    counter++;
  }

  used.add(name.toLowerCase());

  return name;
}

// Converts plain amounts such as "2,40,000" or "Rs. 1,200.50" to numbers, but keeps identifiers
// such as "00104" or "123 456" as text so the export matches the reviewed content.
export function toCellValue(text: string): string | number {
  const amount = text
    .trim()
    .replace(/^(Rs\.?|INR|\u20b9)\s*/i, "")
    .replace(/,/g, "");

  const significantDigits = amount.replace(/^-/, "").replace(".", "").replace(/^0+/, "");

  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(amount) && significantDigits.length <= 15) {
    return Number(amount);
  }

  return text;
}

const EXCEL_CELL_TEXT_LIMIT = 32_767;

function splitCellText(text: string): string[] {
  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + EXCEL_CELL_TEXT_LIMIT, text.length);
    const lastCodeUnit = text.charCodeAt(end - 1);

    if (end < text.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      end--;
    }

    parts.push(text.slice(start, end));
    start = end;
  }

  return parts.length > 0 ? parts : [""];
}

function addXlsxRows(sheet: ExcelJS.Worksheet, values: (string | number)[]): void {
  const columns = values.map((value) =>
    typeof value === "string" ? splitCellText(value) : [value],
  );
  const rowCount = Math.max(...columns.map((column) => column.length));

  for (let index = 0; index < rowCount; index++) {
    sheet.addRow(columns.map((column) => column[index] ?? ""));
  }
}

export async function exportXlsxAsync(input: ExportInput): Promise<ExportFile> {
  const { caseRecord, deliverable, generatedAt } = input;
  const { entries, refsBySection } = buildEvidenceAppendix(input);
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>(["sections", "evidence"]);

  workbook.creator = "Evianta";
  workbook.title = `${deliverable.title} (case: ${caseRecord.title})`;
  workbook.created = generatedAt;

  const sections = workbook.addWorksheet("Sections");

  sections.columns = [
    { header: "Section", key: "title", width: 36 },
    { header: "Kind", key: "kind", width: 10 },
    { header: "Prepared by", key: "role", width: 24 },
    { header: "Review status", key: "status", width: 14 },
    { header: "Edited by reviewer", key: "edited", width: 18 },
    { header: "Content", key: "content", width: 90 },
    { header: "Reviewer comment", key: "comment", width: 40 },
    { header: "Evidence", key: "evidence", width: 16 },
  ];
  sections.getRow(1).font = { bold: true };

  if (deliverable.content) {
    addXlsxRows(sections, [deliverable.title, "text", "", "", "no", deliverable.content, "", ""]);
  }

  for (const section of deliverable.sections) {
    addXlsxRows(sections, [
      section.title,
      section.kind,
      section.producedByRole,
      section.reviewStatus,
      isEditedByReviewer(section) ? "yes" : "no",
      effectiveContent(section),
      section.reviewComment ?? "",
      (refsBySection.get(section.id) ?? []).join(", "),
    ]);
  }

  sections.getColumn("content").alignment = { wrapText: true, vertical: "top" };

  for (const section of deliverable.sections) {
    if (section.kind !== "table") {
      continue;
    }

    const table = parseTable(effectiveContent(section));

    if (!table || table.header.length === 0) {
      continue;
    }

    const sheet = workbook.addWorksheet(worksheetName(section.title, used));

    addXlsxRows(sheet, table.header);
    sheet.getRow(1).font = { bold: true };

    for (const row of table.rows) {
      addXlsxRows(sheet, row.map(toCellValue));
    }

    sheet.columns.forEach((column) => {
      column.width = 18;
    });
  }

  const appendix = workbook.addWorksheet("Evidence");

  appendix.columns = [
    { header: "Ref", key: "ref", width: 8 },
    { header: "Source", key: "source", width: 36 },
    { header: "Location", key: "location", width: 20 },
    { header: "Description", key: "description", width: 50 },
    { header: "Excerpt", key: "excerpt", width: 50 },
    { header: "Confidence", key: "confidence", width: 12 },
  ];
  appendix.getRow(1).font = { bold: true };

  for (const { ref, evidence } of entries) {
    addXlsxRows(appendix, [
      ref,
      evidence.sourceRef,
      describeLocation(evidence.location),
      evidence.description,
      evidence.excerpt ?? "",
      evidence.confidence ?? "",
    ]);
  }

  const body = Buffer.from(await workbook.xlsx.writeBuffer());

  return {
    fileName: `${slugify(deliverable.title)}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body,
  };
}

function parseChartSpec(section: DeliverableSection): unknown {
  if (section.kind !== "chart") {
    return undefined;
  }

  try {
    return JSON.parse(effectiveContent(section));
  } catch {
    return undefined;
  }
}

export function exportJson(input: ExportInput): ExportFile {
  const { caseRecord, deliverable, generatedAt } = input;
  const { entries, refsBySection } = buildEvidenceAppendix(input);
  const citedFindingIds = new Set(deliverable.sections.flatMap((section) => section.findingIds));
  const payload = {
    exportedAt: generatedAt.toISOString(),
    case: {
      id: caseRecord.id,
      title: caseRecord.title,
      useCase: caseRecord.useCase,
      approval: caseRecord.approval,
    },
    deliverable: {
      ...deliverable,
      sections: deliverable.sections.map((section) => {
        const chartSpec = parseChartSpec(section);

        return {
          ...section,
          effectiveContent: effectiveContent(section),
          editedByReviewer: isEditedByReviewer(section),
          evidenceRefs: refsBySection.get(section.id) ?? [],
          ...(chartSpec === undefined ? {} : { chartSpec }),
        };
      }),
    },
    findings: input.findings.filter((finding) => citedFindingIds.has(finding.id)),
    evidenceAppendix: entries.map(({ ref, evidence }) => ({ ref, ...evidence })),
  };

  return {
    fileName: `${slugify(deliverable.title)}.json`,
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(JSON.stringify(payload, null, 2)),
  };
}

export async function exportDeliverableAsync(
  format: ExportFormat,
  input: ExportInput,
): Promise<ExportFile> {
  switch (format) {
    case "docx":
      return exportDocxAsync(input);
    case "xlsx":
      return exportXlsxAsync(input);
    case "json":
      return exportJson(input);
  }
}
