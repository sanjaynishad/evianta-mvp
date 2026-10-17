import type { ExtractedTable } from "@evianta/core";

import { CellBudget } from "./spreadsheet.js";
import { buildTable, uniqueName, type DateOrder, type RawCell } from "./tabular.js";

export const DEFAULT_PAGE_CHARS = 4000;

export interface TextPage {
  text: string;
  /** Offset of the page's first character in the normalized text. */
  start: number;
}

export interface TextParseResult {
  pages: string[];
  tables: ExtractedTable[];
  warnings: string[];
}

const NO_TEXT_WARNING = "The file has no text.";

export function normalizeText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  return withoutBom.replace(/\r\n?/g, "\n");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// Prefers a paragraph break, then a line break, then a space; a break in the first half of the
// window would leave a tiny page, so it falls through to the next option.
function breakPoint(window: string): number {
  const minimum = Math.floor(window.length / 2);
  const candidates: [string, number][] = [
    ["\n\n", 2],
    ["\n", 1],
    [" ", 1],
  ];

  for (const [separator, length] of candidates) {
    const index = window.lastIndexOf(separator);

    if (index >= minimum) {
      return index + length;
    }
  }

  return isHighSurrogate(window.charCodeAt(window.length - 1)) ? window.length - 1 : window.length;
}

function chunkSegment(segment: string, start: number, maxChars: number): TextPage[] {
  const pages: TextPage[] = [];
  let offset = 0;

  while (segment.length - offset > maxChars) {
    const cut = breakPoint(segment.slice(offset, offset + maxChars));

    pages.push({ text: segment.slice(offset, offset + cut), start: start + offset });
    offset += cut;
  }

  pages.push({ text: segment.slice(offset), start: start + offset });

  return pages;
}

/**
 * Splits normalized text into pages. Form feeds always start a page; longer runs are split
 * near `maxChars`. Page text is kept verbatim so quotes can be matched against it.
 */
export function paginateText(text: string, maxChars = DEFAULT_PAGE_CHARS): TextPage[] {
  const pages: TextPage[] = [];
  let start = 0;

  for (const segment of text.split("\f")) {
    pages.push(...chunkSegment(segment, start, maxChars));
    start += segment.length + 1;
  }

  while (pages.length > 1 && pages[pages.length - 1]?.text.trim() === "") {
    pages.pop();
  }

  return pages;
}

export function parsePlainText(text: string, maxChars = DEFAULT_PAGE_CHARS): TextParseResult {
  const normalized = normalizeText(text);

  return {
    pages: paginateText(normalized, maxChars).map((page) => page.text),
    tables: [],
    warnings: normalized.trim() === "" ? [NO_TEXT_WARNING] : [],
  };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const DELIMITER_CELL = /^:?-+:?$/;

/** Splits a pipe table row into trimmed cells, honouring `\|` escapes. */
export function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  const trimmed = line.trim();

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];

    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);

  if (trimmed.startsWith("|")) {
    cells.shift();
  }

  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    cells.pop();
  }

  return cells.map((cell) => cell.trim());
}

function isDelimiterRow(line: string, columnCount: number): boolean {
  if (!line.includes("-")) {
    return false;
  }

  const cells = splitTableRow(line);

  return cells.length === columnCount && cells.every((cell) => DELIMITER_CELL.test(cell));
}

interface Line {
  text: string;
  start: number;
}

function linesWithOffsets(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;

  for (const line of text.split(/[\n\f]/)) {
    lines.push({ text: line, start });
    start += line.length + 1;
  }

  return lines;
}

/** 1-based index of the page holding `offset`. */
export function pageIndexAt(pages: readonly TextPage[], offset: number): number {
  let low = 0;
  let high = pages.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if ((pages[middle]?.start ?? Infinity) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low + 1;
}

/** GFM pipe tables outside fenced code, named after the nearest heading above them. */
function markdownTables(
  lines: readonly Line[],
  pages: readonly TextPage[],
  dateOrder: DateOrder,
): ExtractedTable[] {
  const budget = new CellBudget();
  const names = new Set<string>();
  const tables: ExtractedTable[] = [];
  let fence: string | undefined;
  let heading: string | undefined;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] as Line;
    const fenceMatch = FENCE.exec(line.text)?.[1];

    if (fence) {
      if (fenceMatch && fenceMatch[0] === fence[0] && fenceMatch.length >= fence.length) {
        fence = undefined;
      }

      index += 1;
      continue;
    }

    if (fenceMatch) {
      fence = fenceMatch;
      index += 1;
      continue;
    }

    const headingText = ATX_HEADING.exec(line.text)?.[1]?.trim();

    if (headingText) {
      heading = headingText;
      index += 1;
      continue;
    }

    const headerCells = line.text.includes("|") ? splitTableRow(line.text) : [];
    const delimiter = lines[index + 1];

    if (
      headerCells.length === 0 ||
      !delimiter ||
      !isDelimiterRow(delimiter.text, headerCells.length)
    ) {
      index += 1;
      continue;
    }

    const bodyRows: string[][] = [];
    let next = index + 2;

    while (next < lines.length) {
      const row = lines[next] as Line;

      if (row.text.trim() === "" || !row.text.includes("|") || FENCE.test(row.text)) {
        break;
      }

      bodyRows.push(splitTableRow(row.text));
      next += 1;
    }

    const width = headerCells.length;

    budget.spend(bodyRows.length + 1, width);

    const grid: RawCell[][] = [
      headerCells.map((cell): RawCell => ({ kind: "string", text: cell })),
      ...bodyRows.map((row) =>
        Array.from({ length: width }, (_unused, column): RawCell => {
          const cell = row[column];

          return cell === undefined || cell === ""
            ? { kind: "empty" }
            : { kind: "text", text: cell };
        }),
      ),
    ];
    const name = uniqueName(heading ?? `Table ${tables.length + 1}`, names);
    const table = buildTable(grid, { name, dateOrder });

    if (table) {
      tables.push({ ...table, pageIndex: pageIndexAt(pages, line.start) });
    }

    index = next;
  }

  return tables;
}

/** Keeps the Markdown source as pages and also reads its pipe tables. */
export function parseMarkdown(
  text: string,
  options: { dateOrder: DateOrder; maxChars?: number },
): TextParseResult {
  const normalized = normalizeText(text);
  const pages = paginateText(normalized, options.maxChars ?? DEFAULT_PAGE_CHARS);

  return {
    pages: pages.map((page) => page.text),
    tables: markdownTables(linesWithOffsets(normalized), pages, options.dateOrder),
    warnings: normalized.trim() === "" ? [NO_TEXT_WARNING] : [],
  };
}
