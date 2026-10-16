import type { DataAnalysis } from "./analysis.js";
import { describeLocation } from "./evidence.js";
import { formatCurrency, formatMetricValue, formatNumber } from "./format.js";
import { DATA_QUALITY_KIND_LABELS } from "./quality.js";

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]) {
  const lines = [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ];

  return lines.join("\n");
}

export function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item.replace(/\r?\n/g, " ")}`).join("\n");
}

function metricRow(analysis: DataAnalysis, id: string | undefined): string[] | undefined {
  const metric = id ? analysis.metricsById.get(id) : undefined;

  return metric
    ? [metric.label, formatMetricValue(metric, analysis.currency), metric.basis]
    : undefined;
}

export function keyMetricsTable(analysis: DataAnalysis): string {
  const ids = [
    ...analysis.headlineMetricIds,
    ...analysis.segments.flatMap((breakdown) => [
      breakdown.top?.totalMetricId,
      breakdown.top?.shareMetricId,
      breakdown.bottom?.totalMetricId,
      breakdown.bottom?.shareMetricId,
    ]),
  ];
  const rows = ids
    .map((id) => metricRow(analysis, id))
    .filter((row): row is string[] => row !== undefined);

  return markdownTable(["Metric", "Value", "Basis"], rows);
}

export function monthlyTable(analysis: DataAnalysis): string {
  if (analysis.periods.length === 0) {
    return "No monthly trend was computed because no usable date column was found.";
  }

  const flagged = new Set(analysis.anomalies.map((anomaly) => anomaly.period));

  return markdownTable(
    ["Month", analysis.roles.amount.name, "Change from previous month", "Rows"],
    analysis.periods.map((period) => [
      flagged.has(period.period) ? `${period.period} (flagged)` : period.period,
      formatCurrency(period.total, analysis.currency),
      period.changePct === undefined ? "" : `${formatNumber(period.changePct)}%`,
      String(period.rows.length),
    ]),
  );
}

export function anomalyList(analysis: DataAnalysis): string {
  if (analysis.periods.length === 0) {
    return "Anomaly detection needs a usable date column.";
  }

  if (analysis.anomalies.length === 0) {
    return `No month was flagged: every monthly total stayed within a robust z-score of 3.5 of the trend across ${analysis.periods.length} months.`;
  }

  return bulletList(
    analysis.anomalies.map((anomaly) => {
      const deviation =
        anomaly.deviationPct === undefined ? "" : ` (${formatNumber(anomaly.deviationPct)}%)`;

      return `${anomaly.period}: ${formatCurrency(anomaly.value, analysis.currency)} against ${formatCurrency(anomaly.expected, analysis.currency)} expected from the trend${deviation}, robust z-score ${formatNumber(anomaly.score)} (${anomaly.direction}).`;
    }),
  );
}

export function dataQualityTable(analysis: DataAnalysis): string {
  if (analysis.issues.length === 0) {
    return "No data-quality issues were found by the deterministic checks.";
  }

  return markdownTable(
    ["Check", "Column", "Rows", "Cells", "Treatment"],
    analysis.issues.map((issue) => [
      DATA_QUALITY_KIND_LABELS[issue.kind],
      issue.column ?? "All columns",
      String(issue.rows.length),
      issue.locations.map(describeLocation).join(", "),
      issue.treatment,
    ]),
  );
}
