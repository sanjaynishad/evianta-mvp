import type { EvidenceLocation, FigureComponent } from "@evianta/core";

import {
  normalizeDeductorName,
  SOURCE_LABELS,
  TAX_RECORD_SOURCES,
  type TaxMeasure,
  type TaxRecordRow,
  type TaxRecordSet,
  type TaxRecordSource,
  type UnclassifiedTable,
} from "./records.js";

export const DEFAULT_RECONCILIATION_TOLERANCE = 1;

const MEASURES: readonly TaxMeasure[] = ["tax", "amount"];

/** "incomplete" means a present row has a blank or unreadable TDS or amount cell. */
export type ReconciliationStatus = "matched" | "mismatched" | "missing" | "incomplete";

export interface SourceValues {
  /** Sum of the rows, present only when every row has a readable amount. */
  amount?: number;
  /** Sum of the rows, present only when every row has a readable TDS. */
  tax?: number;
  rows: TaxRecordRow[];
  /** Measures that could not be summed because a row's cell is blank or unreadable. */
  unreadable: TaxMeasure[];
}

export interface PairDifference {
  amount?: number;
  tax?: number;
}

export interface ReconciliationLine {
  /** Stable reference such as "R-01", used by findings, schedules, and the draft. */
  ref: string;
  deductorKey: string;
  tan?: string;
  deductorName: string;
  section?: string;
  period: string;
  values: Partial<Record<TaxRecordSource, SourceValues>>;
  status: ReconciliationStatus;
  /** Provided sources that have no row for this line. */
  missingIn: TaxRecordSource[];
  /**
   * Differences against the 26AS/AIS record. A provided source with no row counts as zero; a
   * measure that is unknown on either side is left out rather than treated as zero.
   */
  returnVsTaxCredit?: PairDifference;
  ledgerVsTaxCredit?: PairDifference;
  returnVsLedger?: PairDifference;
}

export interface SourceTotals {
  /** Present only when every row of the source has a readable amount. */
  amount?: number;
  /** Present only when every row of the source has a readable TDS. */
  tax?: number;
  rowCount: number;
  unreadable: TaxMeasure[];
}

export interface ReconciliationTotals {
  bySource: Partial<Record<TaxRecordSource, SourceTotals>>;
  returnVsTaxCredit?: PairDifference;
  ledgerVsTaxCredit?: PairDifference;
}

export interface TableReference {
  source: TaxRecordSource;
  documentId: string;
  documentName: string;
  tableName: string;
  location: EvidenceLocation;
  rowCount: number;
}

export interface AmbiguousDeductor {
  name: string;
  tans: string[];
}

export interface ExcludedRow {
  documentId: string;
  documentName: string;
  location: EvidenceLocation;
}

export interface TaxReconciliation {
  tolerance: number;
  providedSources: TaxRecordSource[];
  missingSources: TaxRecordSource[];
  tables: TableReference[];
  unclassified: UnclassifiedTable[];
  /** Names shared by several TANs; their name-only rows are not assigned to any TAN. */
  ambiguousDeductors: AmbiguousDeductor[];
  /** Total and subtotal rows left out of the sums. */
  excludedRows: ExcludedRow[];
  warnings: string[];
  lines: ReconciliationLine[];
  totals: ReconciliationTotals;
}

export interface TaxReconcileOptions {
  /** Absolute tolerance in rupees for treating two amounts as equal. */
  tolerance?: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function agree(values: readonly number[], tolerance: number): boolean {
  if (values.length < 2) {
    return true;
  }

  return Math.max(...values) - Math.min(...values) <= tolerance;
}

/** The sum when every row has the measure; undefined when any row lacks it. */
function sumOf(rows: readonly TaxRecordRow[], measure: TaxMeasure): number | undefined {
  if (rows.length === 0 || rows.some((row) => row[measure] === undefined)) {
    return undefined;
  }

  return round(rows.reduce((sum, row) => sum + (row[measure] ?? 0), 0));
}

function unreadableIn(rows: readonly TaxRecordRow[]): TaxMeasure[] {
  return MEASURES.filter((measure) => rows.some((row) => row.unreadable.includes(measure)));
}

interface DeductorResolution {
  keyOf(row: TaxRecordRow): string;
  ambiguous: AmbiguousDeductor[];
}

/**
 * Maps rows that only carry a deductor name to the TAN other rows give for that name, but only
 * when the name belongs to exactly one TAN, so the result never depends on document order.
 */
function resolveDeductors(rows: readonly TaxRecordRow[]): DeductorResolution {
  const tansByName = new Map<string, Set<string>>();
  const displayNames = new Map<string, string>();

  for (const row of rows) {
    const name = normalizeDeductorName(row.deductorName);

    if (row.tan && name) {
      tansByName.set(name, new Set([...(tansByName.get(name) ?? []), row.tan]));
      displayNames.set(name, displayNames.get(name) ?? row.deductorName ?? name);
    }
  }

  const ambiguous = [...tansByName.entries()]
    .filter(
      ([name, tans]) =>
        tans.size > 1 &&
        rows.some((row) => !row.tan && normalizeDeductorName(row.deductorName) === name),
    )
    .map(([name, tans]) => ({ name: displayNames.get(name) ?? name, tans: [...tans].sort() }));

  return {
    ambiguous,
    keyOf(row) {
      if (row.tan) {
        return row.tan;
      }

      const name = normalizeDeductorName(row.deductorName) ?? "";
      const tans = tansByName.get(name);

      return tans?.size === 1 ? ([...tans][0] as string) : `name:${name}`;
    },
  };
}

type Granularity = "quarter" | "year" | "none";

function granularityOf(rows: readonly TaxRecordRow[]): Granularity {
  if (rows.every((row) => row.financialYear && row.quarter)) {
    return "quarter";
  }

  return rows.every((row) => row.financialYear) ? "year" : "none";
}

function periodOf(row: TaxRecordRow, granularity: Granularity): string {
  if (granularity === "quarter") {
    return `FY ${row.financialYear} ${row.quarter}`;
  }

  return granularity === "year" ? `FY ${row.financialYear}` : "All periods";
}

function mostCommon(values: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();

  for (const value of values) {
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

type MeasureAvailability = Partial<Record<TaxRecordSource, ReadonlySet<TaxMeasure>>>;

/** A side's value: its sum, zero when it has no row but records that measure, else unknown. */
function sideValue(
  values: SourceValues | undefined,
  source: TaxRecordSource,
  measure: TaxMeasure,
  available: MeasureAvailability,
): number | undefined {
  if (values) {
    return values[measure];
  }

  return available[source]?.has(measure) ? 0 : undefined;
}

function difference(
  line: Partial<Record<TaxRecordSource, SourceValues>>,
  left: TaxRecordSource,
  right: TaxRecordSource,
  available: MeasureAvailability,
): PairDifference | undefined {
  if (!available[left] || !available[right] || (!line[left] && !line[right])) {
    return undefined;
  }

  const result: PairDifference = {};

  for (const measure of MEASURES) {
    const leftValue = sideValue(line[left], left, measure, available);
    const rightValue = sideValue(line[right], right, measure, available);

    if (leftValue !== undefined && rightValue !== undefined) {
      result[measure] = round(leftValue - rightValue);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function statusOf(
  values: Partial<Record<TaxRecordSource, SourceValues>>,
  missingIn: readonly TaxRecordSource[],
  tolerance: number,
): ReconciliationStatus {
  if (missingIn.length > 0) {
    return "missing";
  }

  const present = Object.values(values).filter((entry): entry is SourceValues => !!entry);

  if (present.some((entry) => entry.unreadable.length > 0)) {
    return "incomplete";
  }

  const agrees = MEASURES.every((measure) =>
    agree(
      present.flatMap((entry) => (entry[measure] === undefined ? [] : [entry[measure]])),
      tolerance,
    ),
  );

  return agrees ? "matched" : "mismatched";
}

function totalsFor(rows: readonly TaxRecordRow[]): SourceTotals {
  const amount = sumOf(rows, "amount");
  const tax = sumOf(rows, "tax");

  return {
    ...(amount !== undefined ? { amount } : {}),
    ...(tax !== undefined ? { tax } : {}),
    rowCount: rows.length,
    unreadable: unreadableIn(rows),
  };
}

function totalDifference(
  left: SourceTotals | undefined,
  right: SourceTotals | undefined,
): PairDifference | undefined {
  if (!left || !right) {
    return undefined;
  }

  const result: PairDifference = {};

  for (const measure of MEASURES) {
    const leftValue = left[measure];
    const rightValue = right[measure];

    if (leftValue !== undefined && rightValue !== undefined) {
      result[measure] = round(leftValue - rightValue);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Reconciles return, ledger, and 26AS/AIS style rows by deductor (TAN, or a name that maps to a
 * single TAN) and period. Rows are grouped at the finest period every source shares for a
 * deductor (quarter, then financial year), summed per source, and compared within the tolerance.
 * Unknown values are never treated as zero.
 */
export function reconcileTaxRecords(
  records: TaxRecordSet,
  options: TaxReconcileOptions = {},
): TaxReconciliation {
  const tolerance = options.tolerance ?? DEFAULT_RECONCILIATION_TOLERANCE;
  const providedSources = TAX_RECORD_SOURCES.filter((source) =>
    records.tables.some((table) => table.source === source),
  );
  const provided = new Set(providedSources);
  const available: MeasureAvailability = {};

  for (const table of records.tables) {
    const measures = new Set(available[table.source] ?? []);

    for (const measure of MEASURES) {
      if (table.columns[measure] !== undefined) {
        measures.add(measure);
      }
    }

    available[table.source] = measures;
  }

  const allRows = records.tables.flatMap((table) => table.rows);
  const deductors = resolveDeductors(allRows);
  const rowsByDeductor = new Map<string, TaxRecordRow[]>();

  for (const row of allRows) {
    const key = deductors.keyOf(row);
    rowsByDeductor.set(key, [...(rowsByDeductor.get(key) ?? []), row]);
  }

  const drafts: Array<Omit<ReconciliationLine, "ref">> = [];

  for (const [deductorKey, rows] of rowsByDeductor) {
    const granularity = granularityOf(rows);
    const rowsByPeriod = new Map<string, TaxRecordRow[]>();

    for (const row of rows) {
      const period = periodOf(row, granularity);
      rowsByPeriod.set(period, [...(rowsByPeriod.get(period) ?? []), row]);
    }

    const tan = rows.find((row) => row.tan)?.tan;
    const deductorName =
      rows.find((row) => row.source === "tax-credit" && row.deductorName)?.deductorName ??
      mostCommon(rows.map((row) => row.deductorName)) ??
      tan ??
      deductorKey;

    for (const [period, periodRows] of rowsByPeriod) {
      const values: Partial<Record<TaxRecordSource, SourceValues>> = {};

      for (const source of TAX_RECORD_SOURCES) {
        const sourceRows = periodRows.filter((row) => row.source === source);

        if (sourceRows.length === 0) {
          continue;
        }

        const amount = sumOf(sourceRows, "amount");
        const tax = sumOf(sourceRows, "tax");

        values[source] = {
          ...(amount !== undefined ? { amount } : {}),
          ...(tax !== undefined ? { tax } : {}),
          rows: sourceRows,
          unreadable: unreadableIn(sourceRows),
        };
      }

      const missingIn = providedSources.filter((source) => !values[source]);
      const returnVsTaxCredit = difference(values, "return", "tax-credit", available);
      const ledgerVsTaxCredit = difference(values, "ledger", "tax-credit", available);
      const returnVsLedger = difference(values, "return", "ledger", available);
      const section = mostCommon(periodRows.map((row) => row.section));

      drafts.push({
        deductorKey,
        ...(tan ? { tan } : {}),
        deductorName,
        ...(section ? { section } : {}),
        period,
        values,
        status: statusOf(values, missingIn, tolerance),
        missingIn,
        ...(returnVsTaxCredit ? { returnVsTaxCredit } : {}),
        ...(ledgerVsTaxCredit ? { ledgerVsTaxCredit } : {}),
        ...(returnVsLedger ? { returnVsLedger } : {}),
      });
    }
  }

  drafts.sort(
    (left, right) =>
      left.deductorName.localeCompare(right.deductorName) ||
      left.deductorKey.localeCompare(right.deductorKey) ||
      left.period.localeCompare(right.period),
  );

  const lines = drafts.map((draft, index) => ({
    ref: `R-${String(index + 1).padStart(2, "0")}`,
    ...draft,
  }));
  const bySource: Partial<Record<TaxRecordSource, SourceTotals>> = {};

  for (const source of providedSources) {
    bySource[source] = totalsFor(allRows.filter((row) => row.source === source));
  }

  const returnVsTaxCredit = totalDifference(bySource.return, bySource["tax-credit"]);
  const ledgerVsTaxCredit = totalDifference(bySource.ledger, bySource["tax-credit"]);

  return {
    tolerance,
    providedSources,
    missingSources: TAX_RECORD_SOURCES.filter((source) => !provided.has(source)),
    tables: records.tables.map((table) => ({
      source: table.source,
      documentId: table.documentId,
      documentName: table.documentName,
      tableName: table.table.name,
      location: {
        ...(table.table.sheet ? { sheet: table.table.sheet } : {}),
        ...(table.table.range ? { cellRange: table.table.range } : {}),
      },
      rowCount: table.rows.length,
    })),
    unclassified: records.unclassified,
    ambiguousDeductors: deductors.ambiguous,
    excludedRows: records.tables.flatMap((table) =>
      table.aggregateRowIndexes.map((rowIndex) => ({
        documentId: table.documentId,
        documentName: table.documentName,
        location: excludedRowLocation(table.table.range, table.table.sheet, rowIndex),
      })),
    ),
    warnings: records.tables.flatMap((table) => table.warnings),
    lines,
    totals: {
      bySource,
      ...(returnVsTaxCredit ? { returnVsTaxCredit } : {}),
      ...(ledgerVsTaxCredit ? { ledgerVsTaxCredit } : {}),
    },
  };
}

function excludedRowLocation(
  range: string | undefined,
  sheet: string | undefined,
  rowIndex: number,
): EvidenceLocation {
  const headerRow = Number(/^[A-Za-z]+(\d+)/.exec(range ?? "")?.[1] ?? "1");
  const row = headerRow + 1 + rowIndex;

  return { ...(sheet ? { sheet } : {}), rowRange: { start: row, end: row } };
}

export function hasReconciliationData(reconciliation: TaxReconciliation): boolean {
  return reconciliation.providedSources.length > 0;
}

export function discrepancies(reconciliation: TaxReconciliation): ReconciliationLine[] {
  return reconciliation.lines.filter((line) => line.status !== "matched");
}

/** The headline difference of a line: return against 26AS, else ledger against 26AS. */
export function primaryTaxDifference(line: ReconciliationLine): number | undefined {
  return line.returnVsTaxCredit?.tax ?? line.ledgerVsTaxCredit?.tax ?? line.returnVsLedger?.tax;
}

export function describeLineStatus(line: ReconciliationLine): string {
  if (line.status === "matched") {
    return "Matched";
  }

  if (line.status === "missing") {
    return `Missing in ${line.missingIn.map((source) => SOURCE_LABELS[source]).join(" and ")}`;
  }

  if (line.status === "incomplete") {
    const unreadable = Object.entries(line.values)
      .filter(([, values]) => (values?.unreadable.length ?? 0) > 0)
      .map(([source]) => SOURCE_LABELS[source as TaxRecordSource]);

    return `Unreadable values in ${unreadable.join(" and ")}`;
  }

  return "Mismatch";
}

/** Components that recompute a line's headline tax difference. */
export function lineDifferenceComponents(line: ReconciliationLine): FigureComponent[] {
  const [left, right]: [TaxRecordSource, TaxRecordSource] =
    line.returnVsTaxCredit?.tax !== undefined
      ? ["return", "tax-credit"]
      : line.ledgerVsTaxCredit?.tax !== undefined
        ? ["ledger", "tax-credit"]
        : ["return", "ledger"];

  return [
    { label: `TDS per ${SOURCE_LABELS[left]}`, value: line.values[left]?.tax ?? 0 },
    { label: `TDS per ${SOURCE_LABELS[right]}`, value: -(line.values[right]?.tax ?? 0) },
  ];
}

export function sourceLabel(source: TaxRecordSource): string {
  return SOURCE_LABELS[source];
}
