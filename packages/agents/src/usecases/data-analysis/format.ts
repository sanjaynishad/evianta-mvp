import type { Metric } from "./metrics.js";

export type Currency = "INR";

const NUMBER_FORMAT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

export function formatCurrency(value: number, currency?: Currency): string {
  const formatted = formatNumber(Math.abs(value));
  const symbol = currency === "INR" ? "₹" : "";

  return `${value < 0 ? "-" : ""}${symbol}${formatted}`;
}

export function formatMetricValue(metric: Pick<Metric, "value" | "unit">, currency?: Currency) {
  switch (metric.unit) {
    case "currency":
      return formatCurrency(metric.value, currency);
    case "percent":
      return `${formatNumber(metric.value)}%`;
    default:
      return formatNumber(metric.value);
  }
}
