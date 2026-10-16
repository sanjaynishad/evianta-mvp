import { formatMetricValue, type Currency } from "./format.js";
import type { Metric, MetricUnit } from "./metrics.js";
import { roundTo } from "./stats.js";

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;
// A number not glued to a word, identifier, or date, with its sign, currency mark, and percent sign,
// for example "-40.5%", "₹92,000", "Rs. 1,200", or ".5%".
const LITERAL_NUMBER =
  /(?<![\p{L}\p{N}_./:])(?<![\p{L}\p{N}]-)(-\s?)?(₹|rs\.?|inr|\$|€|£)?\s?(-)?(\d(?:[\d,]*\d)?(?:\.\d+)?|\.\d+)(%)?(?![\p{L}\p{N}_])/giu;
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

export interface AllowedValue {
  value: number;
  unit: MetricUnit;
}

/** Values a narrative may state literally: every metric, as computed or rounded for display. */
export function allowedNarrativeValues(
  metrics: Iterable<Pick<Metric, "value" | "unit">>,
): AllowedValue[] {
  const seen = new Set<string>();
  const values: AllowedValue[] = [];

  for (const metric of metrics) {
    for (const value of [
      metric.value,
      ...[0, 1, 2].map((decimals) => roundTo(metric.value, decimals)),
    ]) {
      const key = `${metric.unit}:${value}`;

      if (!seen.has(key)) {
        seen.add(key);
        values.push({ value, unit: metric.unit });
      }
    }
  }

  return values;
}

interface LiteralNumber {
  token: string;
  value: number;
  negative: boolean;
  kind: "currency" | "percent" | "plain";
  integerLike: boolean;
  grouped: boolean;
}

function parseLiteral(match: RegExpMatchArray): LiteralNumber | undefined {
  const [token, leadingSign, currency, innerSign, digits, percent] = match;
  const value = Number((digits ?? "").replace(/,/g, ""));

  if (!Number.isFinite(value)) {
    return undefined;
  }

  return {
    token: token.trim(),
    value,
    negative: Boolean(leadingSign) !== Boolean(innerSign),
    kind: currency ? "currency" : percent ? "percent" : "plain",
    integerLike: !(digits ?? "").includes("."),
    grouped: (digits ?? "").includes(","),
  };
}

/** Small counts and years may be written freely, but never as amounts, percentages, or negatives. */
function isFreeNumber(literal: LiteralNumber): boolean {
  if (literal.kind !== "plain" || literal.negative || !literal.integerLike) {
    return false;
  }

  if (literal.value <= MAX_FREE_INTEGER) {
    return true;
  }

  return !literal.grouped && literal.value >= MIN_YEAR && literal.value <= MAX_YEAR;
}

function matchesAllowed(literal: LiteralNumber, candidate: AllowedValue): boolean {
  if (literal.kind === "currency" && candidate.unit !== "currency") {
    return false;
  }

  if (literal.kind === "percent" && candidate.unit !== "percent") {
    return false;
  }

  const stated = literal.negative ? -literal.value : literal.value;
  const expected = literal.negative ? candidate.value : Math.abs(candidate.value);

  return Math.abs(expected - stated) < 1e-9;
}

/**
 * Literal numbers in the text that match no computed metric of the same kind and sign. Unsigned
 * numbers may restate a negative metric ("fell 5%"); an explicit minus sign must match a negative one.
 */
export function findUnverifiedNumbers(text: string, allowed: readonly AllowedValue[]): string[] {
  const withoutDates = text.replace(DATE_LIKE, " ");
  const unverified: string[] = [];

  for (const match of withoutDates.matchAll(LITERAL_NUMBER)) {
    const literal = parseLiteral(match);

    if (!literal || isFreeNumber(literal)) {
      continue;
    }

    if (!allowed.some((candidate) => matchesAllowed(literal, candidate))) {
      unverified.push(literal.token);
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
  options: { currency?: Currency; allowed?: readonly AllowedValue[] } = {},
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
