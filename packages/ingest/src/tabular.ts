import type {
  EvidenceLocation,
  ExtractedTable,
  TableCell,
  TableColumn,
  TableColumnType,
} from "@evianta/core";

export type DateOrder = "dmy" | "mdy";

/** A cell as read from the source, before column type inference. */
export type RawCell =
  | { kind: "empty" }
  /** Free text that may hold a number, boolean, or date. */
  | { kind: "text"; text: string }
  /** Text that must stay a string, for example a spreadsheet error value. */
  | { kind: "string"; text: string }
  | { kind: "number"; value: number; text: string }
  | { kind: "boolean"; value: boolean; text: string }
  | { kind: "date"; iso: string; text: string };

type Candidate =
  | { type: "number"; value: number; text: string }
  | { type: "boolean"; value: boolean; text: string }
  | { type: "date"; iso: string; text: string }
  | { type: "numeric-date"; first: number; second: number; year: number; text: string }
  | { type: "string"; text: string };

const EMPTY_CELL: RawCell = { kind: "empty" };

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// Western (1,234,567) and Indian (12,34,567) digit grouping.
const GROUPED_NUMBER = /^[+-]?(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})+,\d{3})(\.\d+)?$/;
const LEADING_ZERO = /^[+-]?0\d/;
const MAX_SAFE_DIGITS = 15;
const BOOLEAN = /^(true|false)$/i;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/;
const MAX_UTC_OFFSET_HOURS = 14;
const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const DAY_MONTH_NAME_DATE = /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/;
const MONTH_NAME_DAY_DATE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function formatIsoDate(
  year: number,
  month: number,
  day: number,
  time?: { hours: number; minutes: number; seconds: number },
): string {
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

  if (!time || (time.hours === 0 && time.minutes === 0 && time.seconds === 0)) {
    return date;
  }

  return `${date}T${pad(time.hours)}:${pad(time.minutes)}:${pad(time.seconds)}`;
}

function monthFromName(name: string): number | undefined {
  const lower = name.toLowerCase();
  const index = MONTH_NAMES.findIndex((month) => lower.length >= 3 && month.startsWith(lower));

  return index === -1 ? undefined : index + 1;
}

function parseNumber(text: string): number | undefined {
  const plain = PLAIN_NUMBER.test(text);

  if (!plain && !GROUPED_NUMBER.test(text)) {
    return undefined;
  }

  const normalized = text.replace(/,/g, "");

  if (LEADING_ZERO.test(normalized)) {
    return undefined;
  }

  const digits = normalized.replace(/[^0-9]/g, "").replace(/^0+/, "");

  if (!/[.eE]/.test(normalized) && digits.length > MAX_SAFE_DIGITS) {
    return undefined;
  }

  const value = Number(normalized);

  return Number.isFinite(value) ? value : undefined;
}

function parseNamedDate(text: string): string | undefined {
  const dayFirst = DAY_MONTH_NAME_DATE.exec(text);
  const monthFirst = dayFirst ? undefined : MONTH_NAME_DAY_DATE.exec(text);
  const parts = dayFirst
    ? { day: dayFirst[1], month: dayFirst[2], year: dayFirst[3] }
    : monthFirst
      ? { day: monthFirst[2], month: monthFirst[1], year: monthFirst[3] }
      : undefined;

  if (!parts?.day || !parts.month || !parts.year) {
    return undefined;
  }

  const month = monthFromName(parts.month);
  const day = Number(parts.day);
  const year = Number(parts.year);

  return month !== undefined && isValidDate(year, month, day)
    ? formatIsoDate(year, month, day)
    : undefined;
}

function parseIsoDate(text: string): string | undefined {
  const match = ISO_DATE.exec(text);

  if (!match) {
    return undefined;
  }

  const [, year, month, day, hours, minutes, seconds, offsetHours, offsetMinutes] = match;

  if (!isValidDate(Number(year), Number(month), Number(day))) {
    return undefined;
  }

  if (hours === undefined) {
    return `${year}-${month}-${day}`;
  }

  const validTime = Number(hours) <= 23 && Number(minutes) <= 59 && Number(seconds ?? 0) <= 59;
  const validOffset =
    offsetHours === undefined ||
    (Number(offsetHours) <= MAX_UTC_OFFSET_HOURS && Number(offsetMinutes) <= 59);

  return validTime && validOffset ? text.replace(" ", "T") : undefined;
}

function classifyText(text: string): Candidate {
  if (BOOLEAN.test(text)) {
    return { type: "boolean", value: text.toLowerCase() === "true", text };
  }

  const number = parseNumber(text);

  if (number !== undefined) {
    return { type: "number", value: number, text };
  }

  const iso = parseIsoDate(text) ?? parseNamedDate(text);

  if (iso) {
    return { type: "date", iso, text };
  }

  const numericDate = NUMERIC_DATE.exec(text);

  if (numericDate) {
    return {
      type: "numeric-date",
      first: Number(numericDate[1]),
      second: Number(numericDate[2]),
      year: Number(numericDate[3]),
      text,
    };
  }

  return { type: "string", text };
}

function classifyCell(cell: RawCell): Candidate | undefined {
  switch (cell.kind) {
    case "empty":
      return undefined;
    case "text": {
      const text = cell.text.trim();

      return text ? classifyText(text) : undefined;
    }

    case "string":
      return cell.text.trim() ? { type: "string", text: cell.text.trim() } : undefined;
    case "number":
      return { type: "number", value: cell.value, text: cell.text };
    case "boolean":
      return { type: "boolean", value: cell.value, text: cell.text };
    case "date":
      return { type: "date", iso: cell.iso, text: cell.text };
  }
}

function numericDateIso(
  candidate: { first: number; second: number; year: number },
  order: DateOrder,
) {
  const [day, month] =
    order === "dmy" ? [candidate.first, candidate.second] : [candidate.second, candidate.first];

  return isValidDate(candidate.year, month, day)
    ? formatIsoDate(candidate.year, month, day)
    : undefined;
}

function resolveDateOrder(
  candidates: Extract<Candidate, { type: "numeric-date" }>[],
  preferred: DateOrder,
): DateOrder | undefined {
  const orders: DateOrder[] = preferred === "dmy" ? ["dmy", "mdy"] : ["mdy", "dmy"];

  return orders.find((order) =>
    candidates.every((candidate) => numericDateIso(candidate, order) !== undefined),
  );
}

interface ResolvedColumn {
  type: TableColumnType;
  cells: TableCell[];
}

export function resolveColumn(cells: readonly RawCell[], dateOrder: DateOrder): ResolvedColumn {
  const candidates = cells.map(classifyCell);
  const present = candidates.filter((candidate) => candidate !== undefined);

  if (present.length === 0) {
    return { type: "empty", cells: cells.map(() => null) };
  }

  const groups = new Set(
    present.map((candidate) => (candidate.type === "numeric-date" ? "date" : candidate.type)),
  );
  const [group] = groups;
  const asStrings = () => ({
    type: "string" as const,
    cells: candidates.map((candidate) => candidate?.text ?? null),
  });

  if (groups.size !== 1 || group === "string") {
    return asStrings();
  }

  if (group === "date") {
    const numericDates = present.filter(
      (candidate): candidate is Extract<Candidate, { type: "numeric-date" }> =>
        candidate.type === "numeric-date",
    );
    const order = numericDates.length > 0 ? resolveDateOrder(numericDates, dateOrder) : dateOrder;

    if (!order) {
      return asStrings();
    }

    return {
      type: "date",
      cells: candidates.map((candidate) => {
        if (!candidate) {
          return null;
        }

        if (candidate.type === "numeric-date") {
          return numericDateIso(candidate, order) ?? candidate.text;
        }

        return candidate.type === "date" ? candidate.iso : candidate.text;
      }),
    };
  }

  return {
    type: group as "number" | "boolean",
    cells: candidates.map((candidate) => {
      if (!candidate) {
        return null;
      }

      return candidate.type === "number" || candidate.type === "boolean"
        ? candidate.value
        : candidate.text;
    }),
  };
}

export function columnLetters(columnIndex: number): string {
  let remaining = columnIndex + 1;
  let letters = "";

  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + offset) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return letters;
}

function columnIndexFromLetters(letters: string): number {
  let index = 0;

  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }

  return index - 1;
}

/** Zero-based row and column to an A1 address such as "B3". */
export function cellAddress(rowIndex: number, columnIndex: number): string {
  return `${columnLetters(columnIndex)}${rowIndex + 1}`;
}

function isBlankCell(cell: RawCell | undefined): boolean {
  return (
    !cell ||
    cell.kind === "empty" ||
    ((cell.kind === "text" || cell.kind === "string") && cell.text.trim() === "")
  );
}

function displayText(cell: RawCell | undefined): string {
  if (!cell || cell.kind === "empty") {
    return "";
  }

  return cell.kind === "date" ? cell.iso : cell.text.trim();
}

function uniqueHeaders(names: string[], firstColumnIndex: number): string[] {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();

  return names.map((rawName, offset) => {
    const base = rawName || `Column ${columnLetters(firstColumnIndex + offset)}`;
    let name = base;
    let suffix = nextSuffix.get(base) ?? 2;

    while (used.has(name)) {
      name = `${base} (${suffix})`;
      suffix += 1;
    }

    nextSuffix.set(base, suffix);
    used.add(name);

    return name;
  });
}

export interface BuildTableOptions {
  name: string;
  sheet?: string;
  /** Zero-based sheet position of grid[0][0]. */
  origin?: { row: number; column: number };
  dateOrder: DateOrder;
}

/** Uses the first non-blank row as the header; interior blank rows are kept so rows map to sheet rows. */
export function buildTable(
  grid: readonly (readonly RawCell[])[],
  options: BuildTableOptions,
): ExtractedTable | undefined {
  const isBlankRow = (row: readonly RawCell[] | undefined) => !row || row.every(isBlankCell);
  const headerRow = grid.findIndex((row) => !isBlankRow(row));

  if (headerRow === -1) {
    return undefined;
  }

  let lastRow = grid.length - 1;

  while (lastRow > headerRow && isBlankRow(grid[lastRow])) {
    lastRow -= 1;
  }

  const usedRows = grid.slice(headerRow, lastRow + 1);
  let firstColumn = Number.POSITIVE_INFINITY;
  let lastColumn = -1;

  for (const row of usedRows) {
    row.forEach((cell, index) => {
      if (!isBlankCell(cell)) {
        firstColumn = Math.min(firstColumn, index);
        lastColumn = Math.max(lastColumn, index);
      }
    });
  }

  const columnCount = lastColumn - firstColumn + 1;
  const origin = options.origin ?? { row: 0, column: 0 };
  const header = usedRows[0] ?? [];
  const dataRows = usedRows.slice(1);
  const names = uniqueHeaders(
    Array.from({ length: columnCount }, (_unused, offset) =>
      displayText(header[firstColumn + offset]),
    ),
    origin.column + firstColumn,
  );
  const resolved = names.map((_name, offset) =>
    resolveColumn(
      dataRows.map((row) => row[firstColumn + offset] ?? EMPTY_CELL),
      options.dateOrder,
    ),
  );
  const columns: TableColumn[] = names.map((name, offset) => ({
    name,
    type: resolved[offset]?.type ?? "empty",
  }));
  const rows = dataRows.map((_row, rowOffset) =>
    resolved.map((column) => column.cells[rowOffset] ?? null),
  );
  const start = cellAddress(origin.row + headerRow, origin.column + firstColumn);
  const end = cellAddress(origin.row + lastRow, origin.column + lastColumn);

  return {
    name: options.name,
    ...(options.sheet === undefined ? {} : { sheet: options.sheet }),
    range: `${start}:${end}`,
    columns,
    rows,
  };
}

interface TableOrigin {
  headerRow: number;
  firstColumn: number;
}

function tableOrigin(table: Pick<ExtractedTable, "range">): TableOrigin {
  const match = /^([A-Za-z]+)(\d+)/.exec(table.range ?? "");

  if (!match?.[1] || !match[2]) {
    return { headerRow: 0, firstColumn: 0 };
  }

  return { headerRow: Number(match[2]) - 1, firstColumn: columnIndexFromLetters(match[1]) };
}

/** A1 address of a data cell; `rowIndex` and `columnIndex` index `table.rows` and `table.columns`. */
export function tableCellAddress(
  table: Pick<ExtractedTable, "range">,
  rowIndex: number,
  columnIndex: number,
): string {
  const origin = tableOrigin(table);

  return cellAddress(origin.headerRow + 1 + rowIndex, origin.firstColumn + columnIndex);
}

export interface TableSelection {
  rowStart: number;
  rowEnd?: number;
  columnStart?: number;
  columnEnd?: number;
}

/** Builds an evidence location (sheet, cell range, and 1-based sheet row range) for table data rows. */
export function tableEvidenceLocation(
  table: Pick<ExtractedTable, "range" | "sheet" | "columns">,
  selection: TableSelection,
): EvidenceLocation {
  const rowEnd = selection.rowEnd ?? selection.rowStart;
  const columnStart = selection.columnStart ?? 0;
  const columnEnd =
    selection.columnEnd ?? selection.columnStart ?? Math.max(0, table.columns.length - 1);
  const start = tableCellAddress(table, selection.rowStart, columnStart);
  const end = tableCellAddress(table, rowEnd, columnEnd);
  const origin = tableOrigin(table);

  return {
    ...(table.sheet === undefined ? {} : { sheet: table.sheet }),
    cellRange: start === end ? start : `${start}:${end}`,
    rowRange: {
      start: origin.headerRow + 2 + selection.rowStart,
      end: origin.headerRow + 2 + rowEnd,
    },
  };
}
