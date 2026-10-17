const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const MS_PER_DAY = 86_400_000;
const MONTHS = [
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

function iso(year: number, month: number, day: number): string | undefined {
  if (!isValidDate(year, month, day)) {
    return undefined;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthNumber(name: string): number | undefined {
  const lower = name.toLowerCase();
  const index = MONTHS.findIndex((month) => lower.length >= 3 && month.startsWith(lower));

  return index === -1 ? undefined : index + 1;
}

/** ISO yyyy-mm-dd from ISO text, "15/01/2025" (day first), "15 Jan 2025", or "January 15, 2025". */
export function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const text = value.trim();
  const isoMatch = ISO_DATE.exec(text);

  if (isoMatch) {
    return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);

  if (numeric) {
    return iso(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  }

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})$/.exec(text);

  if (dayFirst?.[2]) {
    const month = monthNumber(dayFirst[2]);

    return month ? iso(Number(dayFirst[3]), month, Number(dayFirst[1])) : undefined;
  }

  const monthFirst = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(text);

  if (monthFirst?.[1]) {
    const month = monthNumber(monthFirst[1]);

    return month ? iso(Number(monthFirst[3]), month, Number(monthFirst[2])) : undefined;
  }

  return undefined;
}

function toUtcMs(isoDate: string): number {
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number);

  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

export function addDays(isoDate: string, days: number): string {
  return new Date(toUtcMs(isoDate) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatLongDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const name = MONTHS[(month ?? 1) - 1] ?? "";

  return `${day} ${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
}

export interface QuotedDate {
  text: string;
  iso: string;
}

const QUOTED_DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/gi,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
];

/** Calendar dates written in text, in ISO, day-first numeric, or named-month form. */
export function quotedDates(text: string): QuotedDate[] {
  const found: Array<QuotedDate & { index: number }> = [];

  for (const pattern of QUOTED_DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const parsed = toIsoDate(match[0]);

      if (parsed) {
        found.push({ text: match[0], iso: parsed, index: match.index ?? 0 });
      }
    }
  }

  return found
    .sort((left, right) => left.index - right.index)
    .map(({ text, iso }) => ({ text, iso }));
}
