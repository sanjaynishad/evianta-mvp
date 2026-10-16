import type { TableCell } from "@evianta/core";

const MISSING_MARKERS = new Set(["", "n/a", "na", "#n/a", "null", "none", "nil", "-", "--"]);

/** Empty cells and common placeholders such as "N/A" count as missing rather than mismatched. */
export function isMissingCell(cell: TableCell | undefined): boolean {
  if (cell === null || cell === undefined) {
    return true;
  }

  return typeof cell === "string" && MISSING_MARKERS.has(cell.trim().toLowerCase());
}

export function cellText(cell: TableCell | undefined): string {
  return cell === null || cell === undefined ? "" : String(cell).trim();
}

const CURRENCY_TOKEN = String.raw`(?:₹|rs\.?|inr|usd|eur|gbp|\$|€|£)`;
const GROUPED_DIGITS = String.raw`(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+)(?:\.\d+)?|\.\d+`;
const NUMERIC_TEXT = new RegExp(
  String.raw`^([+-]?)\s*${CURRENCY_TOKEN}?\s*([+-]?)\s*(${GROUPED_DIGITS})\s*${CURRENCY_TOKEN}?$`,
  "i",
);
const INR_MARKER = /₹|\brs\.?(?=\s|\d|$)|\binr\b/i;

/** Reads numbers, including text with digit grouping, currency marks, or accounting parentheses. */
export function parseNumericCell(cell: TableCell | undefined): number | undefined {
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? cell : undefined;
  }

  if (typeof cell !== "string") {
    return undefined;
  }

  let text = cell.trim();
  let negative = false;
  const parenthesized = /^\((.+)\)$/.exec(text);

  if (parenthesized?.[1]) {
    negative = true;
    text = parenthesized[1].trim();
  }

  const match = NUMERIC_TEXT.exec(text);

  if (!match?.[3]) {
    return undefined;
  }

  const value = Number(match[3].replace(/,/g, ""));

  if (!Number.isFinite(value)) {
    return undefined;
  }

  const signs = [match[1], match[2]].filter((sign) => sign === "-").length;
  const isNegative = negative !== (signs % 2 === 1);

  return isNegative ? -value : value;
}

export function hasInrMarker(text: string): boolean {
  return INR_MARKER.test(text);
}

export type DateOrder = "dmy" | "mdy";

export interface ParsedDate {
  /** yyyy-mm-dd. */
  iso: string;
  year: number;
  month: number;
  day: number;
  /** Written pattern, for example "yyyy-mm-dd" or "dd/mm/yyyy". */
  format: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const YEAR_FIRST_DATE = /^(\d{4})([/.])(\d{1,2})\2(\d{1,2})$/;
const NUMERIC_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;
const DAY_MONTH_NAME_DATE = /^(\d{1,2})([\s-])([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/;
const MONTH_NAME_DAY_DATE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function toParsed(year: number, month: number, day: number, format: string) {
  if (!isValidDate(year, month, day)) {
    return undefined;
  }

  return { iso: `${pad(year, 4)}-${pad(month)}-${pad(day)}`, year, month, day, format };
}

function monthFromName(name: string): number | undefined {
  const lower = name.toLowerCase();
  const index = MONTH_NAMES.findIndex((month) => lower.length >= 3 && month.startsWith(lower));

  return index === -1 ? undefined : index + 1;
}

/** A numeric d/m/y or m/d/y date before the column's day-month order is known. */
interface NumericDateCandidate {
  first: number;
  second: number;
  year: number;
  separator: string;
}

type DateCandidate =
  { kind: "parsed"; date: ParsedDate } | { kind: "numeric"; numeric: NumericDateCandidate };

function dateCandidate(text: string): DateCandidate | undefined {
  const iso = ISO_DATE.exec(text);

  if (iso) {
    const date = toParsed(Number(iso[1]), Number(iso[2]), Number(iso[3]), "yyyy-mm-dd");

    return date ? { kind: "parsed", date } : undefined;
  }

  const yearFirst = YEAR_FIRST_DATE.exec(text);

  if (yearFirst) {
    const separator = yearFirst[2] as string;
    const date = toParsed(
      Number(yearFirst[1]),
      Number(yearFirst[3]),
      Number(yearFirst[4]),
      `yyyy${separator}mm${separator}dd`,
    );

    return date ? { kind: "parsed", date } : undefined;
  }

  const numeric = NUMERIC_DATE.exec(text);

  if (numeric) {
    return {
      kind: "numeric",
      numeric: {
        first: Number(numeric[1]),
        separator: numeric[2] as string,
        second: Number(numeric[3]),
        year: Number(numeric[4]),
      },
    };
  }

  const dayFirst = DAY_MONTH_NAME_DATE.exec(text);

  if (dayFirst) {
    const month = monthFromName(dayFirst[3] as string);
    const date =
      month === undefined
        ? undefined
        : toParsed(Number(dayFirst[4]), month, Number(dayFirst[1]), "d mon yyyy");

    return date ? { kind: "parsed", date } : undefined;
  }

  const monthFirst = MONTH_NAME_DAY_DATE.exec(text);

  if (monthFirst) {
    const month = monthFromName(monthFirst[1] as string);
    const date =
      month === undefined
        ? undefined
        : toParsed(Number(monthFirst[3]), month, Number(monthFirst[2]), "mon d, yyyy");

    return date ? { kind: "parsed", date } : undefined;
  }

  return undefined;
}

function resolveNumeric(candidate: NumericDateCandidate, order: DateOrder): ParsedDate | undefined {
  const { first, second, year, separator } = candidate;
  const [day, month] = order === "dmy" ? [first, second] : [second, first];
  const format =
    order === "dmy" ? `dd${separator}mm${separator}yyyy` : `mm${separator}dd${separator}yyyy`;

  return toParsed(year, month, day, format);
}

/** Order a numeric date must use, or undefined when both orders give a valid date. */
function forcedOrder(candidate: NumericDateCandidate): DateOrder | undefined {
  const dayFirst = resolveNumeric(candidate, "dmy") !== undefined;
  const monthFirst = resolveNumeric(candidate, "mdy") !== undefined;

  if (dayFirst && !monthFirst) {
    return "dmy";
  }

  return monthFirst && !dayFirst ? "mdy" : undefined;
}

export interface DateColumnResolution {
  /** One entry per input cell; undefined for missing or unreadable cells. */
  dates: (ParsedDate | undefined)[];
  /** Day-month order used for numeric dates that fit both orders. */
  order: DateOrder;
  /** True when some numeric dates only fit day-first and others only month-first. */
  conflictingOrders: boolean;
  /** Numeric dates that fit both orders and were read with `order`. */
  ambiguousCount: number;
}

/**
 * Parses a date column. Each numeric date that fits only one day-month order uses that order; the
 * rest use the order the column implies, or `defaultOrder` when the column does not imply one.
 */
export function resolveDateColumn(
  cells: readonly (TableCell | undefined)[],
  defaultOrder: DateOrder = "dmy",
): DateColumnResolution {
  const candidates = cells.map((cell) =>
    typeof cell === "string" && !isMissingCell(cell) ? dateCandidate(cell.trim()) : undefined,
  );
  const forced = new Set<DateOrder>();

  for (const candidate of candidates) {
    const order = candidate?.kind === "numeric" ? forcedOrder(candidate.numeric) : undefined;

    if (order) {
      forced.add(order);
    }
  }

  const conflictingOrders = forced.size > 1;
  const order: DateOrder = forced.size === 1 ? ([...forced][0] as DateOrder) : defaultOrder;
  let ambiguousCount = 0;
  const dates = candidates.map((candidate) => {
    if (!candidate) {
      return undefined;
    }

    if (candidate.kind === "parsed") {
      return candidate.date;
    }

    const own = forcedOrder(candidate.numeric);

    if (!own && resolveNumeric(candidate.numeric, order)) {
      ambiguousCount += 1;
    }

    return resolveNumeric(candidate.numeric, own ?? order);
  });

  return { dates, order, conflictingOrders, ambiguousCount };
}
