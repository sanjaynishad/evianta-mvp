import type { ExtractedTable } from "@evianta/core";

import { capWarnings, MAX_EXPANDED_CELL_SLOTS, type TabularParseResult } from "./spreadsheet.js";
import { buildTable, type DateOrder, type RawCell } from "./tabular.js";

export type JsonParseResult =
  ({ kind: "tabular" } & TabularParseResult) | { kind: "text"; text: string; warnings: string[] };

interface JsonParseOptions {
  /** Table name for a top-level array or JSON Lines records, usually the file stem. */
  name: string;
  dateOrder: DateOrder;
}

const VALUE_COLUMN = "value";
const MAX_FLATTEN_DEPTH = 5;
const MAX_DISCOVERY_DEPTH = 8;
const EMPTY_CELL: RawCell = { kind: "empty" };

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.some(isJsonObject) &&
    value.every((item) => item === null || isJsonObject(item))
  );
}

function toRawCell(value: unknown): RawCell {
  if (value === null || value === undefined) {
    return EMPTY_CELL;
  }

  if (typeof value === "string") {
    return { kind: "text", text: value };
  }

  if (typeof value === "number") {
    return { kind: "number", value, text: String(value) };
  }

  if (typeof value === "boolean") {
    return { kind: "boolean", value, text: String(value) };
  }

  return { kind: "string", text: JSON.stringify(value) };
}

function flattenRecord(
  record: JsonObject,
  prefix: string,
  depth: number,
  into: Map<string, unknown>,
): void {
  for (const [key, value] of Object.entries(record)) {
    const column = prefix ? `${prefix}.${key}` : key;

    if (isJsonObject(value) && depth < MAX_FLATTEN_DEPTH && Object.keys(value).length > 0) {
      flattenRecord(value, column, depth + 1, into);
    } else {
      into.set(column, value);
    }
  }
}

class CellBudget {
  private remaining = MAX_EXPANDED_CELL_SLOTS;

  spend(rows: number, columns: number): void {
    const slots = rows * columns;

    if (!Number.isSafeInteger(slots) || slots > this.remaining) {
      throw new RangeError(
        `File exceeds the ${MAX_EXPANDED_CELL_SLOTS.toLocaleString("en-US")}-cell expanded grid limit.`,
      );
    }

    this.remaining -= slots;
  }
}

function header(names: readonly string[]): RawCell[] {
  return names.map((name): RawCell => ({ kind: "string", text: name }));
}

/** Records become rows under the union of their flattened keys; non-object items fill a value column. */
function recordsGrid(items: readonly unknown[], budget: CellBudget): RawCell[][] {
  const columns = new Map<string, number>();
  const flattened = items.map((item) => {
    const values = new Map<string, unknown>();

    if (isJsonObject(item)) {
      flattenRecord(item, "", 0, values);
    } else if (item !== null && item !== undefined) {
      values.set(VALUE_COLUMN, item);
    }

    for (const column of values.keys()) {
      if (!columns.has(column)) {
        columns.set(column, columns.size);
      }
    }

    return values;
  });
  const names = [...columns.keys()];

  budget.spend(items.length + 1, names.length);

  return [
    header(names),
    ...flattened.map((values) => names.map((name) => toRawCell(values.get(name)))),
  ];
}

/** An array of arrays is read like a sheet: the first row is the header. */
function rowsGrid(rows: readonly unknown[][], budget: CellBudget): RawCell[][] {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);

  budget.spend(rows.length, width);

  return rows.map((row) => row.map(toRawCell));
}

function arrayGrid(items: readonly unknown[], budget: CellBudget): RawCell[][] {
  if (items.length > 0 && items.every(Array.isArray)) {
    return rowsGrid(items as unknown[][], budget);
  }

  return recordsGrid(items, budget);
}

interface DiscoveredTables {
  arrays: { path: string; items: unknown[] }[];
  fields: [string, unknown][];
}

function discover(value: JsonObject, prefix: string, depth: number, found: DiscoveredTables): void {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isRecordArray(child)) {
      found.arrays.push({ path, items: child });
    } else if (isJsonObject(child) && depth < MAX_DISCOVERY_DEPTH) {
      discover(child, path, depth + 1, found);
    } else {
      found.fields.push([path, child]);
    }
  }
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;

  while (used.has(name)) {
    name = `${base} (${suffix})`;
    suffix += 1;
  }

  used.add(name);

  return name;
}

type TabularJsonResult = Extract<JsonParseResult, { kind: "tabular" }>;

function tablesFromArray(items: readonly unknown[], options: JsonParseOptions): TabularJsonResult {
  const table = buildTable(arrayGrid(items, new CellBudget()), {
    name: options.name,
    dateOrder: options.dateOrder,
  });

  return table
    ? { kind: "tabular", tables: [table], warnings: [] }
    : { kind: "tabular", tables: [], warnings: ["The file has no data."] };
}

function tablesFromObject(value: JsonObject, options: JsonParseOptions): ExtractedTable[] {
  const found: DiscoveredTables = { arrays: [], fields: [] };

  discover(value, "", 0, found);

  if (found.arrays.length === 0) {
    return [];
  }

  const budget = new CellBudget();
  const names = new Set<string>();
  const tables: ExtractedTable[] = [];

  for (const { path, items } of found.arrays) {
    const name = uniqueName(path, names);
    const table = buildTable(arrayGrid(items, budget), {
      name,
      sheet: name,
      dateOrder: options.dateOrder,
    });

    if (table) {
      tables.push(table);
    }
  }

  if (found.fields.length > 0) {
    budget.spend(found.fields.length + 1, 2);

    const name = uniqueName(`${options.name} fields`, names);
    const table = buildTable(
      [
        header(["field", "value"]),
        ...found.fields.map(([path, field]): RawCell[] => [
          { kind: "string", text: path },
          toRawCell(field),
        ]),
      ],
      { name, sheet: name, dateOrder: options.dateOrder },
    );

    if (table) {
      tables.push(table);
    }
  }

  return tables;
}

function textFallback(value: unknown): JsonParseResult {
  return {
    kind: "text",
    text: JSON.stringify(value, null, 2),
    warnings: ["No arrays of records were found, so the file was read as text."],
  };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Reads arrays of records as tables and falls back to pretty-printed text for other shapes. */
export function parseJsonDocument(text: string, options: JsonParseOptions): JsonParseResult {
  const value: unknown = JSON.parse(stripBom(text));

  if (Array.isArray(value)) {
    return tablesFromArray(value, options);
  }

  if (isJsonObject(value)) {
    const tables = tablesFromObject(value, options);

    if (tables.length > 0) {
      return { kind: "tabular", tables, warnings: [] };
    }
  }

  return textFallback(value);
}

/** Reads one JSON value per line into a single table; invalid lines are skipped with a warning. */
export function parseJsonLines(text: string, options: JsonParseOptions): JsonParseResult {
  const items: unknown[] = [];
  const issues: string[] = [];

  stripBom(text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (line.trim() === "") {
        return;
      }

      try {
        items.push(JSON.parse(line));
      } catch (error) {
        issues.push(`Line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

  if (items.length === 0 && issues.length > 0) {
    throw new SyntaxError(`No line is valid JSON. ${issues[0] ?? ""}`.trim());
  }

  const result = tablesFromArray(items, options);

  return { ...result, warnings: [...capWarnings(issues), ...result.warnings] };
}
