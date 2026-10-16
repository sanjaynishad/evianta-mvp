import type { EvidenceLocation, FigureComponent } from "@evianta/core";

import {
  normalizeDeductorName,
  SOURCE_LABELS,
  TAX_RECORD_SOURCES,
  type TaxRecordRow,
  type TaxRecordSet,
  type TaxRecordSource,
  type UnclassifiedTable,
} from "./records.js";

export const DEFAULT_RECONCILIATION_TOLERANCE = 1;

export type ReconciliationStatus = "matched" | "mismatched" | "missing";

export interface SourceValues {
  amount?: number;
  tax?: number;
  rows: TaxRecordRow[];
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
  /** Differences against the 26AS/AIS record; a provided source with no row counts as zero. */
  returnVsTaxCredit?: PairDifference;
  ledgerVsTaxCredit?: PairDifference;
  returnVsLedger?: PairDifference;
}

export interface SourceTotals {
  amount: number;
  tax: number;
  rowCount: number;
}

export interface ReconciliationTotals {
  bySource: Partial<Record<TaxRecordSource, SourceTotals>>;
  returnVsTaxCredit?: Required<PairDifference>;
  ledgerVsTaxCredit?: Required<PairDifference>;
}

export interface TableReference {
  source: TaxRecordSource;
  documentId: string;
  documentName: string;
  tableName: string;
  location: EvidenceLocation;
  rowCount: number;
}

export interface TaxReconciliation {
  tolerance: number;
  providedSources: TaxRecordSource[];
  missingSources: TaxRecordSource[];
  tables: TableReference[];
  unclassified: UnclassifiedTable[];
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

function sumOf(rows: readonly TaxRecordRow[], field: "amount" | "tax"): number | undefined {
  const present = rows.filter((row) => row[field] !== undefined);

  return present.length === 0
    ? undefined
    : round(present.reduce((sum, row) => sum + (row[field] ?? 0), 0));
}

/** Maps rows that only carry a deductor name to the TAN other rows give for the same name. */
function deductorKeyResolver(rows: readonly TaxRecordRow[]): (row: TaxRecordRow) => string {
  const tanByName = new Map<string, string>();

  for (const row of rows) {
    const name = normalizeDeductorName(row.deductorName);

    if (row.tan && name && !tanByName.has(name)) {
      tanByName.set(name, row.tan);
    }
  }

  return (row) => {
    if (row.tan) {
      return row.tan;
    }

    const name = normalizeDeductorName(row.deductorName) ?? "";

    return tanByName.get(name) ?? `name:${name}`;
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

function difference(
  left: SourceValues | undefined,
  right: SourceValues | undefined,
  leftProvided: boolean,
  rightProvided: boolean,
): PairDifference | undefined {
  if (!leftProvided || !rightProvided) {
    return undefined;
  }

  const result: PairDifference = {};
  const leftTax = left?.tax ?? 0;
  const rightTax = right?.tax ?? 0;

  if (left?.tax !== undefined || right?.tax !== undefined) {
    result.tax = round(leftTax - rightTax);
  }

  if (left?.amount !== undefined || right?.amount !== undefined) {
    result.amount = round((left?.amount ?? 0) - (right?.amount ?? 0));
  }

  return result;
}

function statusOf(
  values: Partial<Record<TaxRecordSource, SourceValues>>,
  missingIn: readonly TaxRecordSource[],
  tolerance: number,
): ReconciliationStatus {
  if (missingIn.length > 0) {
    return "missing";
  }

  const present = Object.values(values);
  const taxes = present.flatMap((entry) => (entry?.tax === undefined ? [] : [entry.tax]));
  const amounts = present.flatMap((entry) => (entry?.amount === undefined ? [] : [entry.amount]));

  return agree(taxes, tolerance) && agree(amounts, tolerance) ? "matched" : "mismatched";
}

function totalsFor(rows: readonly TaxRecordRow[]): SourceTotals {
  return {
    amount: round(rows.reduce((sum, row) => sum + (row.amount ?? 0), 0)),
    tax: round(rows.reduce((sum, row) => sum + (row.tax ?? 0), 0)),
    rowCount: rows.length,
  };
}

function totalDifference(
  left: SourceTotals | undefined,
  right: SourceTotals | undefined,
): Required<PairDifference> | undefined {
  return left && right
    ? { amount: round(left.amount - right.amount), tax: round(left.tax - right.tax) }
    : undefined;
}

/**
 * Reconciles return, ledger, and 26AS/AIS style rows by deductor (TAN, or name when no TAN is
 * given) and period. Rows are grouped at the finest period every source shares for a deductor
 * (quarter, then financial year), summed per source, and compared within the tolerance.
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
  const allRows = records.tables.flatMap((table) => table.rows);
  const keyOf = deductorKeyResolver(allRows);
  const rowsByDeductor = new Map<string, TaxRecordRow[]>();

  for (const row of allRows) {
    const key = keyOf(row);
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
        };
      }

      const missingIn = providedSources.filter((source) => !values[source]);
      const returnVsTaxCredit = difference(
        values.return,
        values["tax-credit"],
        provided.has("return"),
        provided.has("tax-credit"),
      );
      const ledgerVsTaxCredit = difference(
        values.ledger,
        values["tax-credit"],
        provided.has("ledger"),
        provided.has("tax-credit"),
      );
      const returnVsLedger = difference(
        values.return,
        values.ledger,
        provided.has("return"),
        provided.has("ledger"),
      );
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
    lines,
    totals: {
      bySource,
      ...(returnVsTaxCredit ? { returnVsTaxCredit } : {}),
      ...(ledgerVsTaxCredit ? { ledgerVsTaxCredit } : {}),
    },
  };
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
