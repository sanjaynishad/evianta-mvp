import type { ParsedDate } from "./cells.js";
import { slugify } from "./ids.js";
import { percentChange, roundTo, sum, theilSenFit } from "./stats.js";

export interface SalesRecord {
  /** Index into `table.rows`. */
  row: number;
  /** Readable, in-range date. */
  date?: ParsedDate;
  amount?: number;
  quantity?: number;
  /** One value per category column, aligned with `MetricColumns.categories`; undefined when missing. */
  categories: (string | undefined)[];
}

export type MetricUnit = "currency" | "count" | "percent" | "number";

export interface Metric {
  id: string;
  label: string;
  value: number;
  unit: MetricUnit;
  /** How the value was computed, in plain words. */
  basis: string;
}

export interface PeriodTotal {
  /** Calendar month, yyyy-mm. */
  period: string;
  total: number;
  rows: number[];
  /** Change from the previous month in percent; undefined for the first month or a zero base. */
  changePct?: number;
  totalMetricId: string;
  changeMetricId?: string;
}

export interface SegmentTotal {
  label: string;
  /** Rows with no value in the category column. */
  unassigned: boolean;
  total: number;
  sharePct?: number;
  rows: number[];
  totalMetricId: string;
  shareMetricId?: string;
}

export interface SegmentBreakdown {
  column: string;
  columnIndex: number;
  /** Sorted by total, largest first. */
  segments: SegmentTotal[];
  top?: SegmentTotal;
  bottom?: SegmentTotal;
}

export interface TrendSummary {
  /** Theil-Sen slope of monthly totals, per month. */
  slope: number;
  intercept: number;
  slopeMetricId: string;
  growthMetricId?: string;
  averageChangeMetricId?: string;
}

export interface SalesMetrics {
  metrics: Metric[];
  headlineMetricIds: string[];
  periods: PeriodTotal[];
  trend?: TrendSummary;
  segments: SegmentBreakdown[];
  /** Rows with a numeric amount. */
  amountRows: number[];
  /** Rows with both a numeric amount and a usable date. */
  datedAmountRows: number[];
}

export interface MetricColumns {
  amount: string;
  quantity?: string;
  date?: string;
  categories: ReadonlyArray<{ name: string; index: number }>;
}

export const UNASSIGNED_SEGMENT = "Unassigned";
export const MIN_PERIODS_FOR_TREND = 3;

function monthKey(date: ParsedDate): string {
  return date.iso.slice(0, 7);
}

function nextMonth(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];

  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

export interface MonthlyTotal {
  period: string;
  /** Rounded to cents for reporting. */
  total: number;
  /** Unrounded sum, used for derived ratios so they are rounded only once. */
  exactTotal: number;
  rows: number[];
}

/** Months from the first to the last, filling months without rows with a zero total. */
export function monthlyTotals(records: readonly SalesRecord[]): MonthlyTotal[] {
  const byMonth = new Map<string, SalesRecord[]>();

  for (const record of records) {
    if (record.date && record.amount !== undefined) {
      const key = monthKey(record.date);
      const monthRecords = byMonth.get(key);

      if (monthRecords) {
        monthRecords.push(record);
      } else {
        byMonth.set(key, [record]);
      }
    }
  }

  const months = [...byMonth.keys()].sort();
  const first = months[0];
  const last = months[months.length - 1];

  if (!first || !last) {
    return [];
  }

  const totals: MonthlyTotal[] = [];

  for (let period = first; period <= last; period = nextMonth(period)) {
    const monthRecords = byMonth.get(period) ?? [];

    const exactTotal = sum(monthRecords.map((record) => record.amount as number));

    totals.push({
      period,
      total: roundTo(exactTotal),
      exactTotal,
      rows: monthRecords.map((record) => record.row),
    });
  }

  return totals;
}

function segmentKey(value: string | undefined): string {
  return value === undefined ? "" : value.trim().toLowerCase();
}

export function computeSalesMetrics(
  records: readonly SalesRecord[],
  columns: MetricColumns,
  allocateId: (base: string) => string,
): SalesMetrics {
  const metrics: Metric[] = [];
  const headlineMetricIds: string[] = [];
  const addMetric = (base: string, metric: Omit<Metric, "id">, headline = false): string => {
    const id = allocateId(base);

    metrics.push({ id, ...metric });

    if (headline) {
      headlineMetricIds.push(id);
    }

    return id;
  };

  const withAmount = records.filter((record) => record.amount !== undefined);
  const amounts = withAmount.map((record) => record.amount as number);
  const exactTotal = sum(amounts);
  const total = roundTo(exactTotal);

  addMetric(
    "rows-analyzed",
    {
      label: "Rows analyzed",
      value: records.length,
      unit: "count",
      basis: "Non-blank data rows, counting exact repeats once",
    },
    true,
  );
  addMetric(
    "rows-with-amount",
    {
      label: `Rows with a numeric ${columns.amount}`,
      value: withAmount.length,
      unit: "count",
      basis: `Rows whose ${columns.amount} is a number`,
    },
    true,
  );
  addMetric(
    "total-amount",
    {
      label: `Total ${columns.amount}`,
      value: total,
      unit: "currency",
      basis: `Sum of ${columns.amount} over ${withAmount.length} rows`,
    },
    true,
  );

  if (withAmount.length > 0) {
    addMetric(
      "average-amount",
      {
        label: `Average ${columns.amount} per row`,
        value: roundTo(exactTotal / withAmount.length),
        unit: "currency",
        basis: `Total ${columns.amount} divided by ${withAmount.length} rows`,
      },
      true,
    );
  }

  if (columns.quantity) {
    const quantities = records
      .map((record) => record.quantity)
      .filter((value): value is number => value !== undefined);

    if (quantities.length > 0) {
      addMetric(
        "total-quantity",
        {
          label: `Total ${columns.quantity}`,
          value: roundTo(sum(quantities)),
          unit: "number",
          basis: `Sum of ${columns.quantity} over ${quantities.length} rows`,
        },
        true,
      );
    }
  }

  const months = monthlyTotals(records);
  const periods: PeriodTotal[] = months.map((month, index) => {
    const previous = months[index - 1];
    const change = previous ? percentChange(previous.exactTotal, month.exactTotal) : undefined;
    const totalMetricId = addMetric(`period-${month.period}-total`, {
      label: `${columns.amount} in ${month.period}`,
      value: month.total,
      unit: "currency",
      basis: `Sum of ${columns.amount} over ${month.rows.length} rows dated in ${month.period}`,
    });
    const changeMetricId =
      previous && change !== undefined
        ? addMetric(`period-${month.period}-change-pct`, {
            label: `Change in ${columns.amount} from ${previous.period} to ${month.period}`,
            value: roundTo(change),
            unit: "percent",
            basis: `(${month.period} total - ${previous.period} total) / ${previous.period} total`,
          })
        : undefined;

    return {
      period: month.period,
      total: month.total,
      rows: month.rows,
      ...(change !== undefined ? { changePct: roundTo(change) } : {}),
      totalMetricId,
      ...(changeMetricId ? { changeMetricId } : {}),
    };
  });

  if (periods.length > 0) {
    addMetric(
      "period-count",
      {
        label: "Months covered",
        value: periods.length,
        unit: "count",
        basis: `Calendar months from ${periods[0]?.period} to ${periods[periods.length - 1]?.period}`,
      },
      true,
    );
  }

  let trend: TrendSummary | undefined;

  if (periods.length >= 2) {
    const first = periods[0] as PeriodTotal;
    const last = periods[periods.length - 1] as PeriodTotal;
    const growth = percentChange(
      (months[0] as MonthlyTotal).exactTotal,
      (months[months.length - 1] as MonthlyTotal).exactTotal,
    );
    const growthMetricId =
      growth === undefined
        ? undefined
        : addMetric(
            "growth-first-to-last-pct",
            {
              label: `Change in monthly ${columns.amount} from ${first.period} to ${last.period}`,
              value: roundTo(growth),
              unit: "percent",
              basis: `(${last.period} total - ${first.period} total) / ${first.period} total`,
            },
            true,
          );
    const changes = periods
      .map((period) => period.changePct)
      .filter((value): value is number => value !== undefined);
    const averageChangeMetricId =
      changes.length === 0
        ? undefined
        : addMetric(
            "average-monthly-change-pct",
            {
              label: "Average month-over-month change",
              value: roundTo(sum(changes) / changes.length),
              unit: "percent",
              basis: `Mean of ${changes.length} month-over-month changes`,
            },
            true,
          );

    if (periods.length >= MIN_PERIODS_FOR_TREND) {
      const fit = theilSenFit(periods.map((period) => period.total));
      const slopeMetricId = addMetric(
        "trend-slope-per-month",
        {
          label: `Trend in monthly ${columns.amount} per month`,
          value: roundTo(fit.slope),
          unit: "currency",
          basis: `Theil-Sen slope (median pairwise change per month) of ${periods.length} monthly totals`,
        },
        true,
      );

      trend = {
        slope: fit.slope,
        intercept: fit.intercept,
        slopeMetricId,
        ...(growthMetricId ? { growthMetricId } : {}),
        ...(averageChangeMetricId ? { averageChangeMetricId } : {}),
      };
    }
  }

  const segments = columns.categories.map((category, categoryPosition): SegmentBreakdown => {
    const groups = new Map<string, { label: string; records: SalesRecord[] }>();

    for (const record of withAmount) {
      const value = record.categories[categoryPosition];
      const key = segmentKey(value);
      const group = groups.get(key) ?? {
        label: value === undefined ? UNASSIGNED_SEGMENT : value.trim(),
        records: [],
      };

      group.records.push(record);
      groups.set(key, group);
    }

    const columnSlug = slugify(category.name);
    const segmentTotals = [...groups.entries()]
      .map(([key, group]) => ({
        key,
        label: group.label,
        unassigned: key === "",
        exactTotal: sum(group.records.map((record) => record.amount as number)),
        rows: group.records.map((record) => record.row),
      }))
      .map((segment) => ({ ...segment, total: roundTo(segment.exactTotal) }))
      .sort((left, right) => right.total - left.total || left.label.localeCompare(right.label))
      .map((segment): SegmentTotal => {
        const base = `segment-${columnSlug}-${segment.unassigned ? "unassigned" : slugify(segment.label)}`;
        const totalMetricId = addMetric(`${base}-total`, {
          label: `${columns.amount} for ${category.name} ${segment.label}`,
          value: segment.total,
          unit: "currency",
          basis: `Sum of ${columns.amount} over ${segment.rows.length} rows where ${category.name} is ${segment.unassigned ? "blank" : segment.label}`,
        });
        const share = exactTotal === 0 ? undefined : (segment.exactTotal / exactTotal) * 100;
        const shareMetricId =
          share === undefined
            ? undefined
            : addMetric(`${base}-share-pct`, {
                label: `Share of ${columns.amount} for ${category.name} ${segment.label}`,
                value: roundTo(share),
                unit: "percent",
                basis: `${category.name} ${segment.label} total / total ${columns.amount}`,
              });

        return {
          label: segment.label,
          unassigned: segment.unassigned,
          total: segment.total,
          ...(share === undefined ? {} : { sharePct: roundTo(share) }),
          rows: segment.rows,
          totalMetricId,
          ...(shareMetricId ? { shareMetricId } : {}),
        };
      });
    const ranked = segmentTotals.filter((segment) => !segment.unassigned);

    return {
      column: category.name,
      columnIndex: category.index,
      segments: segmentTotals,
      ...(ranked[0] ? { top: ranked[0] } : {}),
      ...(ranked.length >= 2 ? { bottom: ranked[ranked.length - 1] } : {}),
    };
  });

  return {
    metrics,
    headlineMetricIds,
    periods,
    ...(trend ? { trend } : {}),
    segments,
    amountRows: withAmount.map((record) => record.row),
    datedAmountRows: withAmount.filter((record) => record.date).map((record) => record.row),
  };
}
