import type { EvidenceLocation, ExtractedTable, OpenQuestionSeverity } from "@evianta/core";

import {
  screenPeriodAnomalies,
  type AnomalyScreeningStatus,
  type PeriodAnomaly,
} from "./anomalies.js";
import { cellText, isMissingCell, parseNumericCell, type ParsedDate } from "./cells.js";
import {
  blankRowIndexes,
  profileColumns,
  selectRoles,
  type ColumnProfile,
  type DatasetRoles,
} from "./columns.js";
import { columnLocation } from "./evidence.js";
import type { Currency } from "./format.js";
import { createIdAllocator } from "./ids.js";
import {
  computeSalesMetrics,
  type Metric,
  type PeriodTotal,
  type SalesRecord,
  type SegmentBreakdown,
  type TrendSummary,
} from "./metrics.js";
import {
  DATA_QUALITY_KIND_LABELS,
  isOutOfRangeDate,
  amountCurrency,
  medianDayOf,
  runDataQualityChecks,
  type DataQualityIssue,
} from "./quality.js";

export interface TabularSource {
  documentId: string;
  documentName: string;
  table: ExtractedTable;
}

export type DataAnalysisErrorCode = "no-tabular-data" | "no-amount-column";

export class DataAnalysisError extends Error {
  constructor(
    readonly code: DataAnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DataAnalysisError";
  }
}

export type AnalysisRoles = DatasetRoles & { amount: ColumnProfile };

export interface AnalysisQuestion {
  text: string;
  severity: OpenQuestionSeverity;
}

export interface AnalysisAnomaly extends PeriodAnomaly {
  valueMetricId: string;
  expectedMetricId: string;
  deviationMetricId?: string;
  scoreMetricId: string;
}

export interface AnalysisIssue extends DataQualityIssue {
  rowsMetricId: string;
}

export interface DataAnalysis {
  source: TabularSource;
  columns: ColumnProfile[];
  roles: AnalysisRoles;
  currency?: Currency;
  /** Data rows in the table, excluding the header. */
  rowCount: number;
  blankRows: number[];
  /** Non-blank rows with exact repeats removed; the rows every metric is computed from. */
  analyzedRows: number[];
  issues: AnalysisIssue[];
  metrics: Metric[];
  metricsById: ReadonlyMap<string, Metric>;
  headlineMetricIds: string[];
  periods: PeriodTotal[];
  trend?: TrendSummary;
  segments: SegmentBreakdown[];
  anomalies: AnalysisAnomaly[];
  /** Whether the monthly totals could be screened for anomalies at all. */
  anomalyScreening: { status: AnomalyScreeningStatus; periods: number; minPeriods: number };
  /** Assumptions made by the deterministic analysis itself. */
  assumptions: string[];
  /** Questions that confirm those assumptions. */
  questions: AnalysisQuestion[];
  locations: {
    amount: EvidenceLocation;
    date?: EvidenceLocation;
    quantity?: EvidenceLocation;
    categories: ReadonlyMap<number, EvidenceLocation>;
  };
}

export interface AnalyzeOptions {
  /** Tables found in the case that were not analyzed, for the assumptions list. */
  skippedTables?: number;
}

function sourceLabel(source: TabularSource): string {
  return source.table.name === source.documentName || !source.table.name
    ? source.documentName
    : `${source.table.name} in ${source.documentName}`;
}

/** Profiles a table without computing metrics; returns undefined when it has no amount column. */
export function profileTable(table: ExtractedTable) {
  const blankRows = new Set(blankRowIndexes(table));
  const rows = table.rows.map((_row, index) => index).filter((index) => !blankRows.has(index));
  const profiling = profileColumns(table, rows);
  const roles = selectRoles(profiling.columns);

  return { rows, blankRows: [...blankRows], profiling, roles };
}

/** Chooses the table to analyze: one with an amount column, then a date column, then the most rows. */
export function selectAnalysisSource(sources: readonly TabularSource[]): TabularSource | undefined {
  let best: { source: TabularSource; score: number } | undefined;

  for (const source of sources) {
    const { rows, roles } = profileTable(source.table);

    if (!roles.amount || rows.length === 0) {
      continue;
    }

    const score = (roles.date ? 1_000_000_000 : 0) + rows.length;

    if (!best || score > best.score) {
      best = { source, score };
    }
  }

  return best?.source;
}

/** Runs the full deterministic analysis of one sales table. No model calls, no I/O. */
export function analyzeTable(source: TabularSource, options: AnalyzeOptions = {}): DataAnalysis {
  const { table } = source;
  const { rows, blankRows, profiling, roles } = profileTable(table);

  if (rows.length === 0) {
    throw new DataAnalysisError(
      "no-tabular-data",
      `"${sourceLabel(source)}" has no data rows to analyze.`,
    );
  }

  const amount = roles.amount;

  if (!amount) {
    throw new DataAnalysisError(
      "no-amount-column",
      `"${sourceLabel(source)}" has no numeric amount column (for example Amount, Revenue, or Sales) to analyze.`,
    );
  }

  const analysisRoles: AnalysisRoles = { ...roles, amount };
  const issues = runDataQualityChecks({ table, rows, profiling, roles: analysisRoles });
  const duplicates = new Set(
    issues.filter((issue) => issue.kind === "duplicate-rows").flatMap((issue) => issue.rows),
  );
  const analyzedRows = rows.filter((row) => !duplicates.has(row));
  const dateResolution = roles.date ? profiling.dateColumns.get(roles.date.index) : undefined;
  const datesByRow = new Map<number, ParsedDate | undefined>(
    rows.map((row, position) => [row, dateResolution?.dates[position]]),
  );
  const analyzedSet = new Set(analyzedRows);
  const medianDay = dateResolution
    ? medianDayOf(
        dateResolution.dates.filter((_date, position) => analyzedSet.has(rows[position] as number)),
      )
    : Number.NaN;
  const foreignCurrencyRows = new Set(
    issues.filter((issue) => issue.kind === "mixed-currencies").flatMap((issue) => issue.rows),
  );
  const cellAt = (row: number, column: number) => table.rows[row]?.[column] ?? null;
  const records: SalesRecord[] = analyzedRows.map((row) => {
    const date = datesByRow.get(row);
    const amountValue = foreignCurrencyRows.has(row)
      ? undefined
      : parseNumericCell(cellAt(row, amount.index));
    const quantityValue = roles.quantity
      ? parseNumericCell(cellAt(row, roles.quantity.index))
      : undefined;

    return {
      row,
      ...(date && !isOutOfRangeDate(date, medianDay) ? { date } : {}),
      ...(amountValue === undefined ? {} : { amount: amountValue }),
      ...(quantityValue === undefined ? {} : { quantity: quantityValue }),
      categories: roles.categories.map((column) => {
        const cell = cellAt(row, column.index);

        return isMissingCell(cell) ? undefined : cellText(cell);
      }),
    };
  });
  const allocateId = createIdAllocator();
  const computed = computeSalesMetrics(
    records,
    {
      amount: amount.name,
      ...(roles.quantity ? { quantity: roles.quantity.name } : {}),
      ...(roles.date ? { date: roles.date.name } : {}),
      categories: roles.categories.map((column) => ({ name: column.name, index: column.index })),
    },
    allocateId,
  );
  const metrics = [...computed.metrics];
  const addMetric = (base: string, metric: Omit<Metric, "id">): string => {
    const id = allocateId(base);

    metrics.push({ id, ...metric });

    return id;
  };

  const totalMetricByPeriod = new Map(
    computed.periods.map((period) => [period.period, period.totalMetricId]),
  );
  const screening = screenPeriodAnomalies(computed.periods);
  const anomalies = screening.anomalies.map((anomaly): AnalysisAnomaly => {
    const expectedMetricId = addMetric(`${anomaly.id}-expected`, {
      label: `Expected ${amount.name} in ${anomaly.period} from the trend`,
      value: anomaly.expected,
      unit: "currency",
      basis: "Theil-Sen trend line of monthly totals",
    });
    const deviationMetricId =
      anomaly.deviationPct === undefined
        ? undefined
        : addMetric(`${anomaly.id}-deviation-pct`, {
            label: `Deviation of ${anomaly.period} from the trend`,
            value: anomaly.deviationPct,
            unit: "percent",
            basis: "(actual - expected) / expected",
          });
    const scoreMetricId = addMetric(`${anomaly.id}-score`, {
      label: `Robust z-score of ${anomaly.period}`,
      value: anomaly.score,
      unit: "number",
      basis: "Robust z-score of the deviation from the trend",
    });

    return {
      ...anomaly,
      valueMetricId: totalMetricByPeriod.get(anomaly.period) as string,
      expectedMetricId,
      ...(deviationMetricId ? { deviationMetricId } : {}),
      scoreMetricId,
    };
  });
  const analysisIssues = issues.map((issue): AnalysisIssue => ({
    ...issue,
    rowsMetricId: addMetric(`${issue.id}-rows`, {
      label: `Rows flagged: ${DATA_QUALITY_KIND_LABELS[issue.kind].toLowerCase()}${issue.column ? ` in ${issue.column}` : ""}`,
      value: issue.rows.length,
      unit: "count",
      countOf: "rows",
      basis: `Rows flagged by the ${issue.kind} check`,
    }),
  }));
  const assumptions: string[] = [
    `Analyzed ${sourceLabel(source)}: ${amount.name} as the amount${roles.date ? `, ${roles.date.name} as the date` : ""}${roles.categories.length > 0 ? `, and ${roles.categories.map((column) => column.name).join(", ")} as categories` : ""}.`,
  ];

  const questions: AnalysisQuestion[] = [];

  if (options.skippedTables && options.skippedTables > 0) {
    assumptions.push(
      `${options.skippedTables} other table(s) in the case were not analyzed; only the table with the most usable sales rows was used.`,
    );
    questions.push({
      text: `Should any of the ${options.skippedTables} other table(s) be analyzed instead of, or together with, ${sourceLabel(source)}?`,
      severity: "low",
    });
  }

  if (blankRows.length > 0) {
    assumptions.push(`${blankRows.length} blank row(s) were ignored.`);
  }

  if (!roles.date) {
    assumptions.push("No date column was found, so no monthly trend or anomalies were computed.");
  } else if (dateResolution && dateResolution.ambiguousCount > 0) {
    const order = dateResolution.order === "dmy" ? "day/month/year" : "month/day/year";

    assumptions.push(
      `${dateResolution.ambiguousCount} date(s) fit both day-month orders and were read as ${order}.`,
    );
    questions.push({
      text: `Is ${order} the right order for the ${dateResolution.ambiguousCount} ${roles.date.name} value(s) that fit both orders? A wrong order moves sales between months.`,
      severity: "medium",
    });
  }

  const emptyMonths = computed.periods
    .filter((period) => period.rows.length === 0)
    .map((period) => period.period);

  if (emptyMonths.length > 0) {
    assumptions.push(`Months with no rows are shown with a zero total: ${emptyMonths.join(", ")}.`);
    questions.push({
      text: `Do the months with no rows (${emptyMonths.join(", ")}) mean no sales, or is data missing for them?`,
      severity: "medium",
    });
  }

  const baseCurrency = amountCurrency(table, rows, amount, analyzedRows).base;
  const currency: Currency | undefined = baseCurrency === "INR" ? "INR" : undefined;

  if (!baseCurrency) {
    assumptions.push(
      `${amount.name} is reported in the units of the source file; no currency was stated.`,
    );
  } else if (!currency) {
    assumptions.push(
      `${amount.name} is in ${baseCurrency}; values are shown without a currency symbol.`,
    );
  }

  return {
    source,
    columns: profiling.columns,
    roles: analysisRoles,
    ...(currency ? { currency } : {}),
    rowCount: table.rows.length,
    blankRows,
    analyzedRows,
    issues: analysisIssues,
    metrics,
    metricsById: new Map(metrics.map((metric) => [metric.id, metric])),
    headlineMetricIds: computed.headlineMetricIds,
    periods: computed.periods,
    ...(computed.trend ? { trend: computed.trend } : {}),
    segments: computed.segments,
    anomalies,
    anomalyScreening: {
      status: screening.status,
      periods: screening.periods,
      minPeriods: screening.minPeriods,
    },
    assumptions,
    questions,
    locations: {
      amount: columnLocation(table, amount.index),
      ...(roles.date ? { date: columnLocation(table, roles.date.index) } : {}),
      ...(roles.quantity ? { quantity: columnLocation(table, roles.quantity.index) } : {}),
      categories: new Map(
        roles.categories.map((column) => [column.index, columnLocation(table, column.index)]),
      ),
    },
  };
}
