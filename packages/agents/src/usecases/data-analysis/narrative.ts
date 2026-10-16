import { formatMetricValue, type Currency } from "./format.js";
import type { Metric } from "./metrics.js";
import { roundTo } from "./stats.js";

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;
// A number not glued to a word, identifier, or date, for example "40.5%", "₹92,000", or "-3".
const LITERAL_NUMBER =
  /(?<![\p{L}\p{N}_./:])(?<![\p{L}\p{N}]-)\d(?:[\d,]*\d)?(?:\.\d+)?%?(?![\p{L}\p{N}_])/gu;
const DATE_LIKE = /\b\d{4}-\d{2}(?:-\d{2})?\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g;
const MAX_FREE_INTEGER = 12;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

export type NarrativeIssueKind = "unknown-metric" | "unverified-number";

export interface NarrativeIssue {
  kind: NarrativeIssueKind;
  /** Which narrative field the issue was found in, for example "summary". */
  field: string;
  token: string;
  message: string;
}

export interface RenderedNarrative {
  text: string;
  metricIds: string[];
  issues: NarrativeIssue[];
}

/** Values a narrative may state literally: every metric, as computed or rounded for display. */
export function allowedNarrativeValues(metrics: Iterable<Pick<Metric, "value">>): number[] {
  const values = new Set<number>();

  for (const metric of metrics) {
    const absolute = Math.abs(metric.value);

    values.add(absolute);

    for (const decimals of [0, 1, 2]) {
      values.add(roundTo(absolute, decimals));
    }
  }

  return [...values];
}

function isFreeNumber(token: string, value: number): boolean {
  if (token.includes("%") || token.includes(".")) {
    return false;
  }

  if (Number.isInteger(value) && value <= MAX_FREE_INTEGER) {
    return true;
  }

  return !token.includes(",") && Number.isInteger(value) && value >= MIN_YEAR && value <= MAX_YEAR;
}

/** Literal numbers in the text that are neither small counts, years, nor a computed metric value. */
export function findUnverifiedNumbers(text: string, allowed: readonly number[]): string[] {
  const withoutDates = text.replace(DATE_LIKE, " ");
  const unverified: string[] = [];

  for (const match of withoutDates.matchAll(LITERAL_NUMBER)) {
    const token = match[0];
    const value = Number(token.replace(/[,%]/g, ""));

    if (!Number.isFinite(value) || isFreeNumber(token, value)) {
      continue;
    }

    if (!allowed.some((candidate) => Math.abs(candidate - value) < 1e-9)) {
      unverified.push(token);
    }
  }

  return unverified;
}

/**
 * Replaces {{metric-id}} placeholders with the exact computed values and flags unknown ids and
 * literal numbers that do not match a computed metric.
 */
export function renderNarrative(
  text: string,
  field: string,
  metricsById: ReadonlyMap<string, Metric>,
  options: { currency?: Currency; allowed?: readonly number[] } = {},
): RenderedNarrative {
  const issues: NarrativeIssue[] = [];
  const metricIds: string[] = [];
  const allowed = options.allowed ?? allowedNarrativeValues(metricsById.values());

  for (const token of findUnverifiedNumbers(text.replace(PLACEHOLDER, " "), allowed)) {
    issues.push({
      kind: "unverified-number",
      field,
      token,
      message: `The ${field} states "${token}", which does not match any computed metric.`,
    });
  }

  const rendered = text.replace(PLACEHOLDER, (placeholder, id: string) => {
    const metric = metricsById.get(id);

    if (!metric) {
      issues.push({
        kind: "unknown-metric",
        field,
        token: placeholder,
        message: `The ${field} references "${id}", which is not a computed metric.`,
      });

      return "[figure not computed]";
    }

    if (!metricIds.includes(id)) {
      metricIds.push(id);
    }

    return formatMetricValue(metric, options.currency);
  });

  return { text: rendered, metricIds, issues };
}
