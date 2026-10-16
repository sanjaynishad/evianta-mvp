import type { ExtractedTable } from "@evianta/core";
import Papa from "papaparse";
import { read, SSF, utils, type CellObject, type WorkSheet } from "xlsx";

import { buildTable, formatIsoDate, type DateOrder, type RawCell } from "./tabular.js";

export interface TabularParseResult {
  tables: ExtractedTable[];
  warnings: string[];
}

const EMPTY_CELL: RawCell = { kind: "empty" };
const MAX_PARSE_WARNINGS = 5;
const MAX_WORKBOOK_CELL_SLOTS = 1_000_000;

export function decodeText(buffer: Uint8Array): { text: string; warning?: string } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    return {
      text: new TextDecoder("windows-1252").decode(buffer),
      warning: "The file is not valid UTF-8; it was decoded as Windows-1252.",
    };
  }
}

function capWarnings(messages: string[]): string[] {
  if (messages.length <= MAX_PARSE_WARNINGS) {
    return messages;
  }

  return [
    ...messages.slice(0, MAX_PARSE_WARNINGS),
    `${messages.length - MAX_PARSE_WARNINGS} more parse issues were not listed.`,
  ];
}

const DELIMITER_SAMPLE_ROWS = 100;

// Blank lines skew papaparse's delimiter guess, so guess on a sample without them first.
function guessDelimiter(text: string): string {
  const sample = Papa.parse<string[]>(text, {
    preview: DELIMITER_SAMPLE_ROWS,
    skipEmptyLines: "greedy",
  });

  return sample.meta.delimiter || ",";
}

export function parseDelimitedText(
  text: string,
  options: { name: string; delimiter?: "," | "\t"; dateOrder: DateOrder },
): TabularParseResult {
  const parsed = Papa.parse<string[]>(text, {
    delimiter: options.delimiter ?? guessDelimiter(text),
    skipEmptyLines: false,
  });
  const warnings = capWarnings(
    parsed.errors
      .filter((error) => error.code !== "UndetectableDelimiter")
      .map((error) =>
        error.row === undefined ? error.message : `Row ${error.row + 1}: ${error.message}`,
      ),
  );
  const grid = parsed.data.map((row) =>
    row.map((value): RawCell => ({ kind: "text", text: value })),
  );
  const table = buildTable(grid, { name: options.name, dateOrder: options.dateOrder });

  if (!table) {
    warnings.push("The file has no data.");
  }

  return { tables: table ? [table] : [], warnings };
}

function isDateFormat(format: unknown): boolean {
  return (
    typeof format === "string" && (SSF as { is_date(format: string): boolean }).is_date(format)
  );
}

interface DateCode {
  y: number;
  m: number;
  d: number;
  H: number;
  M: number;
  S: number;
}

function dateCodeToIso(value: number, date1904: boolean): string | undefined {
  const code = (
    SSF as { parse_date_code(value: number, options: object): DateCode | null }
  ).parse_date_code(value, { date1904 });

  if (!code) {
    return undefined;
  }

  return formatIsoDate(code.y, code.m, code.d, { hours: code.H, minutes: code.M, seconds: code.S });
}

function toRawCell(cell: CellObject | undefined, date1904: boolean): RawCell {
  if (!cell || cell.t === "z" || cell.v === undefined || cell.v === null) {
    return EMPTY_CELL;
  }

  const text = cell.w ?? String(cell.v);

  switch (cell.t) {
    case "n": {
      const value = Number(cell.v);
      const iso = isDateFormat(cell.z) ? dateCodeToIso(value, date1904) : undefined;

      if (iso) {
        return { kind: "date", iso, text };
      }

      if (/^[+-]?0\d/.test(text.trim())) {
        return { kind: "string", text };
      }

      return { kind: "number", value, text };
    }

    case "b":
      return { kind: "boolean", value: Boolean(cell.v), text };
    case "e":
      return { kind: "string", text };
    case "d": {
      const date = cell.v instanceof Date ? cell.v : new Date(String(cell.v));

      return Number.isNaN(date.getTime())
        ? { kind: "string", text }
        : { kind: "date", iso: date.toISOString(), text };
    }

    default:
      return { kind: "text", text: String(cell.v) };
  }
}

function sheetGrid(sheet: WorkSheet, date1904: boolean, remainingCellSlots: number) {
  const cells = new Map<string, { row: number; column: number; cell: CellObject }>();
  let minRow = Number.POSITIVE_INFINITY;
  let minColumn = Number.POSITIVE_INFINITY;
  let maxRow = -1;
  let maxColumn = -1;

  // Bounds come from the populated cells because `!ref` can span formatted but empty areas.
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!")) {
      continue;
    }

    const { r: row, c: column } = utils.decode_cell(address);
    cells.set(address, { row, column, cell: cell as CellObject });
    minRow = Math.min(minRow, row);
    minColumn = Math.min(minColumn, column);
    maxRow = Math.max(maxRow, row);
    maxColumn = Math.max(maxColumn, column);
  }

  if (maxRow === -1) {
    return undefined;
  }

  const cellSlots = (maxRow - minRow + 1) * (maxColumn - minColumn + 1);

  if (!Number.isSafeInteger(cellSlots) || cellSlots > remainingCellSlots) {
    throw new RangeError(
      `Workbook exceeds the ${MAX_WORKBOOK_CELL_SLOTS.toLocaleString("en-US")}-cell expanded grid limit.`,
    );
  }

  const grid: RawCell[][] = Array.from({ length: maxRow - minRow + 1 }, () =>
    new Array<RawCell>(maxColumn - minColumn + 1).fill(EMPTY_CELL),
  );

  for (const { row, column, cell } of cells.values()) {
    const gridRow = grid[row - minRow];

    if (gridRow) {
      gridRow[column - minColumn] = toRawCell(cell, date1904);
    }
  }

  return { grid, origin: { row: minRow, column: minColumn }, cellSlots };
}

export function parseWorkbook(
  buffer: Uint8Array,
  options: { dateOrder: DateOrder },
): TabularParseResult {
  const workbook = read(buffer, { type: "buffer", cellNF: true, cellDates: false });
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const tables: ExtractedTable[] = [];
  const warnings: string[] = [];
  let remainingCellSlots = MAX_WORKBOOK_CELL_SLOTS;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const parsed = sheet ? sheetGrid(sheet, date1904, remainingCellSlots) : undefined;

    remainingCellSlots -= parsed?.cellSlots ?? 0;

    const table = parsed
      ? buildTable(parsed.grid, {
          name: sheetName,
          sheet: sheetName,
          origin: parsed.origin,
          dateOrder: options.dateOrder,
        })
      : undefined;

    if (table) {
      tables.push(table);
    } else {
      warnings.push(`Sheet "${sheetName}" is empty.`);
    }
  }

  return { tables, warnings };
}
