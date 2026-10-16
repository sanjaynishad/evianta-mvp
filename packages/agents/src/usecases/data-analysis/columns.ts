import type { ExtractedTable, TableColumnType } from "@evianta/core";

import {
  cellText,
  isMissingCell,
  parseNumericCell,
  resolveDateColumn,
  type DateColumnResolution,
} from "./cells.js";

export type ColumnRole =
  "date" | "amount" | "quantity" | "unit-price" | "category" | "identifier" | "other";

export interface ColumnProfile {
  index: number;
  name: string;
  sourceType: TableColumnType;
  role: ColumnRole;
  /** Non-missing cells across the rows considered. */
  filled: number;
  missing: number;
  numeric: number;
  dates: number;
  distinct: number;
}

export interface DatasetRoles {
  date?: ColumnProfile;
  amount?: ColumnProfile;
  quantity?: ColumnProfile;
  unitPrice?: ColumnProfile;
  identifier?: ColumnProfile;
  categories: ColumnProfile[];
}

export const MAX_CATEGORY_COLUMNS = 3;
export const MAX_CATEGORY_DISTINCT = 50;

const TYPE_SHARE = 0.6;

const DATE_NAME = /\b(date|day|month|period|dt)\b|date$/;
const AMOUNT_NAME =
  /\b(amount|amt|revenue|sales|net|gross|value|total|turnover|gmv|billing|billed)\b/;
const PRIMARY_AMOUNT_NAME = /\b(revenue|sales|net|amount|amt)\b/;
const QUANTITY_NAME = /\b(qty|quantity|units?|volume|pcs|pieces)\b/;
const UNIT_PRICE_NAME = /\bunit (price|cost|rate)\b|\b(rate|mrp|per unit)\b/;
const PRICE_NAME = /\bprice\b/;
const LINE_TOTAL_NAME = /\b(total|amount|value|line)\b/;
// Headers that end in an identifier word, such as "Sales Order No", hold ids even when numeric.
const IDENTIFIER_SUFFIX = /\b(id|no|number|code|ref|reference)$/;
const IDENTIFIER_NAME = /\b(id|no|number|code|ref|reference|invoice|order|sku|txn|transaction)\b/;
const CATEGORY_NAME =
  /\b(region|zone|state|city|country|territory|product|item|category|segment|channel|customer|client|store|branch|brand|department|team|rep|salesperson|market|type)\b/;

function normalizedName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Data rows where every cell is missing. */
export function blankRowIndexes(table: Pick<ExtractedTable, "rows">): number[] {
  return table.rows.flatMap((row, index) =>
    row.every((cell) => isMissingCell(cell)) ? [index] : [],
  );
}

function inferRole(profile: Omit<ColumnProfile, "role">, rowCount: number): ColumnRole {
  const name = normalizedName(profile.name);

  if (profile.filled === 0) {
    return "other";
  }

  const numericShare = profile.numeric / profile.filled;
  const dateShare = profile.dates / profile.filled;

  if (dateShare >= TYPE_SHARE && (DATE_NAME.test(name) || dateShare >= 0.9)) {
    return "date";
  }

  if (numericShare >= TYPE_SHARE) {
    if (IDENTIFIER_SUFFIX.test(name)) {
      return "identifier";
    }

    if (UNIT_PRICE_NAME.test(name) || (PRICE_NAME.test(name) && !LINE_TOTAL_NAME.test(name))) {
      return "unit-price";
    }

    if (QUANTITY_NAME.test(name)) {
      return "quantity";
    }

    if (AMOUNT_NAME.test(name)) {
      return "amount";
    }

    if (IDENTIFIER_NAME.test(name)) {
      return "identifier";
    }

    return "other";
  }

  if (
    IDENTIFIER_NAME.test(name) &&
    (!CATEGORY_NAME.test(name) || profile.distinct >= profile.filled * 0.9)
  ) {
    return "identifier";
  }

  const repeats = profile.distinct < profile.filled;
  const limit = CATEGORY_NAME.test(name) ? MAX_CATEGORY_DISTINCT * 2 : MAX_CATEGORY_DISTINCT;

  if (profile.distinct <= limit && (repeats || rowCount <= 3)) {
    return "category";
  }

  return "other";
}

export interface ColumnProfiling {
  columns: ColumnProfile[];
  /** Date resolution per column index, for columns read as dates. */
  dateColumns: Map<number, DateColumnResolution>;
}

/** Profiles each column over the given data rows and infers its analytical role. */
export function profileColumns(
  table: Pick<ExtractedTable, "columns" | "rows">,
  rows: readonly number[],
): ColumnProfiling {
  const dateColumns = new Map<number, DateColumnResolution>();
  const columns = table.columns.map((column, index): ColumnProfile => {
    const cells = rows.map((row) => table.rows[row]?.[index] ?? null);
    const present = cells.filter((cell) => !isMissingCell(cell));
    const resolution =
      column.type === "number" || column.type === "boolean" ? undefined : resolveDateColumn(cells);
    const dates = resolution ? resolution.dates.filter((date) => date !== undefined).length : 0;
    const base = {
      index,
      name: column.name,
      sourceType: column.type,
      filled: present.length,
      missing: cells.length - present.length,
      numeric: present.filter((cell) => parseNumericCell(cell) !== undefined).length,
      dates,
      distinct: new Set(present.map((cell) => cellText(cell).toLowerCase())).size,
    };
    const role = inferRole(base, rows.length);

    if (role === "date" && resolution) {
      dateColumns.set(index, resolution);
    }

    return { ...base, role };
  });

  return { columns, dateColumns };
}

function amountRank(column: ColumnProfile): number {
  return PRIMARY_AMOUNT_NAME.test(normalizedName(column.name)) ? 0 : 1;
}

/** Picks one column per measure role and up to three category columns. */
export function selectRoles(columns: readonly ColumnProfile[]): DatasetRoles {
  const byRole = (role: ColumnRole) => columns.filter((column) => column.role === role);
  const dateColumns = byRole("date");
  const date =
    dateColumns.find((column) => DATE_NAME.test(normalizedName(column.name))) ?? dateColumns[0];
  const namedAmount = [...byRole("amount")].sort(
    (left, right) => amountRank(left) - amountRank(right) || left.index - right.index,
  )[0];
  const unnamedMeasure = byRole("other").find(
    (column) => column.filled > 0 && column.numeric / column.filled >= TYPE_SHARE,
  );
  const amount =
    namedAmount ?? (unnamedMeasure ? { ...unnamedMeasure, role: "amount" as const } : undefined);
  const categories = byRole("category")
    .filter((column) => column.distinct >= 2)
    .sort((left, right) => {
      const leftNamed = CATEGORY_NAME.test(normalizedName(left.name)) ? 0 : 1;
      const rightNamed = CATEGORY_NAME.test(normalizedName(right.name)) ? 0 : 1;

      return leftNamed - rightNamed || left.index - right.index;
    })
    .slice(0, MAX_CATEGORY_COLUMNS)
    .sort((left, right) => left.index - right.index);

  return {
    ...(date ? { date } : {}),
    ...(amount ? { amount } : {}),
    ...(byRole("quantity")[0] ? { quantity: byRole("quantity")[0] } : {}),
    ...(byRole("unit-price")[0] ? { unitPrice: byRole("unit-price")[0] } : {}),
    ...(byRole("identifier")[0] ? { identifier: byRole("identifier")[0] } : {}),
    categories,
  };
}
