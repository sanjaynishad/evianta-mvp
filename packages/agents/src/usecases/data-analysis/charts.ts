import { chartSpecSchema, type ChartSpec, type ChartValueFormat } from "@evianta/core";

import type { DataAnalysis } from "./analysis.js";
import { describeLocation } from "./evidence.js";
import { createIdAllocator, slugify } from "./ids.js";
import { decimalSum, roundTo } from "./stats.js";

export const MAX_SEGMENT_CHARTS = 3;
export const MAX_PIE_SLICES = 6;
export const OTHER_SEGMENT = "Other";

export type ChartSubject = "overview" | "periods" | "segments";

export interface DashboardChart {
  spec: ChartSpec;
  subject: ChartSubject;
  /** Category column index for segment charts. */
  columnIndex?: number;
}

function amountFormat(analysis: DataAnalysis): ChartValueFormat {
  return analysis.currency === "INR" ? "currency-inr" : "number";
}

function sourceFor(analysis: DataAnalysis, aggregation: string) {
  return { aggregation, documentId: analysis.source.documentId, evidenceIds: [] };
}

/** Chart specs computed from the deterministic analysis; the model never supplies chart data. */
export function buildDashboardCharts(analysis: DataAnalysis): DashboardChart[] {
  const charts: DashboardChart[] = [];
  const allocateId = createIdAllocator();
  const amountName = analysis.roles.amount.name;
  const amountRange = describeLocation(analysis.locations.amount);
  const format = amountFormat(analysis);
  const dateName = analysis.roles.date?.name;
  const dateRange = analysis.locations.date ? describeLocation(analysis.locations.date) : "";

  if (dateName && analysis.periods.length > 0) {
    const anomalous = new Set(analysis.anomalies.map((anomaly) => anomaly.period));

    charts.push({
      subject: "periods",
      spec: chartSpecSchema.parse({
        id: allocateId("chart-monthly-total"),
        type: "line",
        title: `${amountName} by month`,
        description:
          anomalous.size > 0
            ? `Flagged months: ${[...anomalous].join(", ")}.`
            : "No month was flagged as an anomaly.",
        categoryKey: "month",
        series: [{ key: "total", label: amountName }],
        data: analysis.periods.map((period) => ({ month: period.period, total: period.total })),
        xAxis: { label: `Month of ${dateName}`, format: "number" },
        yAxis: { label: amountName, format },
        source: sourceFor(
          analysis,
          `Sum of ${amountName} (${amountRange}) by calendar month of ${dateName} (${dateRange})`,
        ),
      }),
    });

    const changes = analysis.periods.filter((period) => period.changePct !== undefined);

    if (changes.length > 0) {
      charts.push({
        subject: "periods",
        spec: chartSpecSchema.parse({
          id: allocateId("chart-monthly-change"),
          type: "bar",
          title: "Month-over-month change",
          categoryKey: "month",
          series: [{ key: "change", label: "Change from the previous month" }],
          data: changes.map((period) => ({
            month: period.period,
            change: roundTo((period.changePct as number) / 100, 4),
          })),
          xAxis: { label: `Month of ${dateName}`, format: "number" },
          yAxis: { label: "Change", format: "percent" },
          source: sourceFor(
            analysis,
            `Percent change in the monthly sum of ${amountName} (${amountRange}) from the previous month`,
          ),
        }),
      });
    }
  }

  analysis.segments.slice(0, MAX_SEGMENT_CHARTS).forEach((breakdown, position) => {
    const location = analysis.locations.categories.get(breakdown.columnIndex);
    const categoryRange = location ? ` (${describeLocation(location)})` : "";
    const aggregation = `Sum of ${amountName} (${amountRange}) by ${breakdown.column}${categoryRange}`;
    const slug = slugify(breakdown.column);

    charts.push({
      subject: "segments",
      columnIndex: breakdown.columnIndex,
      spec: chartSpecSchema.parse({
        id: allocateId(`chart-${slug}-total`),
        type: "bar",
        title: `${amountName} by ${breakdown.column}`,
        categoryKey: "segment",
        series: [{ key: "total", label: amountName }],
        data: breakdown.segments.map((segment) => ({
          segment: segment.label,
          total: segment.total,
        })),
        xAxis: { label: breakdown.column, format: "number" },
        yAxis: { label: amountName, format },
        source: sourceFor(analysis, aggregation),
      }),
    });

    const positive = breakdown.segments.filter((segment) => segment.total > 0);

    if (position !== 0 || positive.length < 2) {
      return;
    }

    const shown = positive.slice(0, MAX_PIE_SLICES - 1);
    const rest = positive.slice(MAX_PIE_SLICES - 1);
    const data = shown.map((segment) => ({ segment: segment.label, total: segment.total }));

    if (rest.length > 0) {
      const shownLabels = new Set(shown.map((segment) => segment.label));
      let remainderLabel = OTHER_SEGMENT;

      // A real category may itself be called "Other"; the remainder slice must not share its label.
      for (let suffix = 2; shownLabels.has(remainderLabel); suffix += 1) {
        remainderLabel = `${OTHER_SEGMENT} (${suffix})`;
      }

      data.push({
        segment: remainderLabel,
        total: roundTo(decimalSum(rest.map((segment) => segment.total))),
      });
    }

    charts.push({
      subject: "segments",
      columnIndex: breakdown.columnIndex,
      spec: chartSpecSchema.parse({
        id: allocateId(`chart-${slug}-share`),
        type: "pie",
        title: `Share of ${amountName} by ${breakdown.column}`,
        ...(positive.length < breakdown.segments.length
          ? { description: "Segments with a zero or negative total are not shown." }
          : {}),
        categoryKey: "segment",
        series: [{ key: "total", label: amountName }],
        data,
        yAxis: { label: amountName, format },
        source: sourceFor(analysis, aggregation),
      }),
    });
  });

  if (charts.length === 0) {
    const total = analysis.metricsById.get("total-amount");

    charts.push({
      subject: "overview",
      spec: chartSpecSchema.parse({
        id: allocateId("chart-total"),
        type: "bar",
        title: `Total ${amountName}`,
        description:
          "The data has no usable date or category column, so only the total is charted.",
        categoryKey: "measure",
        series: [{ key: "total", label: amountName }],
        data: [{ measure: total?.label ?? `Total ${amountName}`, total: total?.value ?? 0 }],
        yAxis: { label: amountName, format },
        source: sourceFor(analysis, `Sum of ${amountName} (${amountRange})`),
      }),
    });
  }

  return charts;
}
