import type { EvidenceLocation, ExtractedTable, OpenQuestionSeverity } from "@evianta/core";

import { cellText, isMissingCell, parseNumericCell, type ParsedDate } from "./cells.js";
import type { ColumnProfile, ColumnProfiling, DatasetRoles } from "./columns.js";
import { rowLocations } from "./evidence.js";
import { createIdAllocator, slugify } from "./ids.js";
import { median } from "./stats.js";

export const DATA_QUALITY_ISSUE_KINDS = [
  "duplicate-rows",
  "missing-values",
  "type-mismatch",
  "negative-values",
  "out-of-range",
  "inconsistent-date-formats",
] as const;

export type DataQualityIssueKind = (typeof DATA_QUALITY_ISSUE_KINDS)[number];

export const DATA_QUALITY_KIND_LABELS: Readonly<Record<DataQualityIssueKind, string>> = {
  "duplicate-rows": "Duplicate rows",
  "missing-values": "Missing values",
  "type-mismatch": "Type mismatch",
  "negative-values": "Negative values",
  "out-of-range": "Out-of-range values",
  "inconsistent-date-formats": "Inconsistent date formats",
};

export interface DataQualityIssue {
  id: string;
  kind: DataQualityIssueKind;
  severity: OpenQuestionSeverity;
  column?: string;
  columnIndex?: number;
  /** Affected data rows, as indexes into `table.rows`. */
  rows: number[];
  message: string;
  /** How the analysis treated the affected values. */
  treatment: string;
  question: string;
  examples: string[];
  locations: EvidenceLocation[];
}

export const MIN_PLAUSIBLE_YEAR = 1900;
export const MAX_PLAUSIBLE_YEAR = 2100;
/** Dates further than this from the median date are treated as entry errors. */
export const MAX_DAYS_FROM_MEDIAN_DATE = 5 * 366;

const MAX_EXAMPLES = 3;
const DAY_MS = 86_400_000;

export interface DataQualityInput {
  table: ExtractedTable;
  /** Non-blank data rows. */
  rows: readonly number[];
  profiling: ColumnProfiling;
  roles: DatasetRoles;
}

type MeasureRole = "amount" | "quantity" | "unitPrice";

const MEASURE_ROLES: readonly MeasureRole[] = ["amount", "quantity", "unitPrice"];

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function agree(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function dayNumber(date: ParsedDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
}

/** Dates outside the plausible year range or far from the bulk of the column. */
export function isOutOfRangeDate(date: ParsedDate, medianDay: number): boolean {
  return (
    date.year < MIN_PLAUSIBLE_YEAR ||
    date.year > MAX_PLAUSIBLE_YEAR ||
    Math.abs(dayNumber(date) - medianDay) > MAX_DAYS_FROM_MEDIAN_DATE
  );
}

export function medianDayOf(dates: readonly (ParsedDate | undefined)[]): number {
  const days = dates
    .filter((date): date is ParsedDate => date !== undefined)
    .filter((date) => date.year >= MIN_PLAUSIBLE_YEAR && date.year <= MAX_PLAUSIBLE_YEAR)
    .map(dayNumber);

  return median(days);
}

/** Deterministic data-quality checks; each issue lists its rows and cell-range locations. */
export function runDataQualityChecks(input: DataQualityInput): DataQualityIssue[] {
  const { table, rows, profiling, roles } = input;
  const issues: DataQualityIssue[] = [];
  const allocateId = createIdAllocator();
  const cellAt = (row: number, column: number) => table.rows[row]?.[column] ?? null;
  const add = (
    issue: Omit<DataQualityIssue, "id" | "locations" | "examples"> & { examples?: string[] },
  ) => {
    issues.push({
      ...issue,
      id: allocateId(
        issue.column ? `dq-${issue.kind}-${slugify(issue.column)}` : `dq-${issue.kind}`,
      ),
      examples: (issue.examples ?? []).slice(0, MAX_EXAMPLES),
      locations: rowLocations(table, issue.rows, issue.columnIndex),
    });
  };

  const seen = new Map<string, number>();
  const duplicates: number[] = [];

  for (const row of rows) {
    const key = JSON.stringify((table.rows[row] ?? []).map((cell) => cellText(cell)));

    if (seen.has(key)) {
      duplicates.push(row);
    } else {
      seen.set(key, row);
    }
  }

  if (duplicates.length > 0) {
    add({
      kind: "duplicate-rows",
      severity: "medium",
      rows: duplicates,
      message: `${plural(duplicates.length, "row")} exactly ${agree(duplicates.length, "repeats", "repeat")} an earlier row.`,
      treatment: "Exact repeats were counted once.",
      question: "Are the repeated rows genuine repeat transactions? They were counted once.",
    });
  }

  const checked: Array<{ column: ColumnProfile; role: keyof DatasetRoles | "category" }> = [];

  for (const role of ["identifier", "date", "amount", "quantity", "unitPrice"] as const) {
    const column = roles[role];

    if (column) {
      checked.push({ column, role });
    }
  }

  for (const column of roles.categories) {
    checked.push({ column, role: "category" });
  }

  checked.sort((left, right) => left.column.index - right.column.index);

  for (const { column, role } of checked) {
    const missing = rows.filter((row) => isMissingCell(cellAt(row, column.index)));

    if (missing.length === 0) {
      continue;
    }

    const treatment =
      role === "amount"
        ? `Rows without ${column.name} were left out of ${column.name} metrics.`
        : role === "date"
          ? `Rows without ${column.name} were left out of the monthly trend.`
          : role === "category"
            ? `Rows without ${column.name} were grouped as Unassigned.`
            : role === "quantity" || role === "unitPrice"
              ? `Rows without ${column.name} were left out of ${column.name} metrics.`
              : "The rows were kept in the analysis.";

    add({
      kind: "missing-values",
      severity: role === "amount" || role === "date" ? "medium" : "low",
      column: column.name,
      columnIndex: column.index,
      rows: missing,
      message: `${plural(missing.length, "row")} ${agree(missing.length, "has", "have")} no ${column.name}.`,
      treatment,
      question: `Can the missing ${column.name} values be supplied?`,
    });
  }

  for (const role of MEASURE_ROLES) {
    const column = roles[role];

    if (!column) {
      continue;
    }

    const mismatched = rows.filter((row) => {
      const cell = cellAt(row, column.index);

      return !isMissingCell(cell) && parseNumericCell(cell) === undefined;
    });

    if (mismatched.length > 0) {
      const examples = mismatched.map((row) => cellText(cellAt(row, column.index)));

      add({
        kind: "type-mismatch",
        severity: role === "amount" ? "medium" : "low",
        column: column.name,
        columnIndex: column.index,
        rows: mismatched,
        examples,
        message: `${plural(mismatched.length, `${column.name} value`)} ${agree(mismatched.length, "is not a number", "are not numbers")}, for example ${quoted(examples.slice(0, MAX_EXAMPLES))}.`,
        treatment: `Non-numeric ${column.name} values were left out of ${column.name} metrics.`,
        question: `What should the non-numeric ${column.name} values (${quoted(examples.slice(0, MAX_EXAMPLES))}) be?`,
      });
    }
  }

  const dateColumn = roles.date;
  const resolution = dateColumn ? profiling.dateColumns.get(dateColumn.index) : undefined;

  if (dateColumn && resolution) {
    const datesByRow = new Map(rows.map((row, position) => [row, resolution.dates[position]]));
    const unreadable = rows.filter(
      (row) => !isMissingCell(cellAt(row, dateColumn.index)) && !datesByRow.get(row),
    );

    if (unreadable.length > 0) {
      const examples = unreadable.map((row) => cellText(cellAt(row, dateColumn.index)));

      add({
        kind: "type-mismatch",
        severity: "medium",
        column: dateColumn.name,
        columnIndex: dateColumn.index,
        rows: unreadable,
        examples,
        message: `${plural(unreadable.length, `${dateColumn.name} value`)} ${agree(unreadable.length, "is not a readable date", "are not readable dates")}, for example ${quoted(examples.slice(0, MAX_EXAMPLES))}.`,
        treatment: `Rows with unreadable ${dateColumn.name} values were left out of the monthly trend.`,
        question: `What dates should the unreadable ${dateColumn.name} values (${quoted(examples.slice(0, MAX_EXAMPLES))}) be?`,
      });
    }
  }

  for (const role of MEASURE_ROLES) {
    const column = roles[role];

    if (!column) {
      continue;
    }

    const negative = rows.filter((row) => {
      const value = parseNumericCell(cellAt(row, column.index));

      return value !== undefined && value < 0;
    });

    if (negative.length > 0) {
      const examples = negative.map((row) => cellText(cellAt(row, column.index)));

      add({
        kind: "negative-values",
        severity: role === "amount" ? "medium" : "low",
        column: column.name,
        columnIndex: column.index,
        rows: negative,
        examples,
        message: `${plural(negative.length, `${column.name} value`)} ${agree(negative.length, "is", "are")} negative, for example ${quoted(examples.slice(0, MAX_EXAMPLES))}.`,
        treatment: `Negative ${column.name} values were included as reductions, for example returns or credit notes.`,
        question: `Are the negative ${column.name} values returns or credit notes, or entry errors?`,
      });
    }
  }

  if (dateColumn && resolution) {
    const medianDay = medianDayOf(resolution.dates);
    const outOfRange = rows.filter((_row, position) => {
      const date = resolution.dates[position];

      return date !== undefined && isOutOfRangeDate(date, medianDay);
    });

    if (outOfRange.length > 0) {
      const examples = outOfRange.map((row) => cellText(cellAt(row, dateColumn.index)));

      add({
        kind: "out-of-range",
        severity: "medium",
        column: dateColumn.name,
        columnIndex: dateColumn.index,
        rows: outOfRange,
        examples,
        message: `${plural(outOfRange.length, `${dateColumn.name} value`)} ${agree(outOfRange.length, "falls", "fall")} far outside the period the data covers, for example ${quoted(examples.slice(0, MAX_EXAMPLES))}.`,
        treatment: `Out-of-range ${dateColumn.name} values were left out of the monthly trend.`,
        question: `Are the out-of-range ${dateColumn.name} values (${quoted(examples.slice(0, MAX_EXAMPLES))}) entry errors?`,
      });
    }

    const rowsByFormat = new Map<string, number[]>();

    rows.forEach((row, position) => {
      const date = resolution.dates[position];

      if (date) {
        const formatRows = rowsByFormat.get(date.format);

        if (formatRows) {
          formatRows.push(row);
        } else {
          rowsByFormat.set(date.format, [row]);
        }
      }
    });

    if (rowsByFormat.size > 1) {
      const formats = [...rowsByFormat.entries()].sort(
        (left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]),
      );
      const minority = formats.slice(1).flatMap(([, formatRows]) => formatRows);
      const examples = minority.map((row) => cellText(cellAt(row, dateColumn.index)));
      const summary = formats
        .map(([format, formatRows]) => `${format} (${formatRows.length})`)
        .join(", ");

      add({
        kind: "inconsistent-date-formats",
        severity: "medium",
        column: dateColumn.name,
        columnIndex: dateColumn.index,
        rows: minority,
        examples,
        message: `${dateColumn.name} mixes ${formats.length} date formats: ${summary}.`,
        treatment: resolution.conflictingOrders
          ? `Each date was read in the only format it fits; dates that fit both day-month orders were read as ${resolution.order === "dmy" ? "day/month/year" : "month/day/year"}.`
          : `Each date was read in its own format.`,
        question: `Which date format does the source system use for ${dateColumn.name}? The rows outside the main format should be confirmed.`,
      });
    }
  }

  const kindOrder = new Map<DataQualityIssueKind, number>(
    DATA_QUALITY_ISSUE_KINDS.map((kind, index) => [kind, index]),
  );

  return issues.sort(
    (left, right) =>
      (kindOrder.get(left.kind) ?? 0) - (kindOrder.get(right.kind) ?? 0) ||
      (left.columnIndex ?? -1) - (right.columnIndex ?? -1),
  );
}
