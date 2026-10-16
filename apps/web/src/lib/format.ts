const locale = "en-IN";
const defaultTimeZone = "Asia/Kolkata";
const crore = 10_000_000;
const lakh = 100_000;

export interface NumberFormatOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

export function formatNumber(value: number, options: NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(value);
}

export function formatInr(amount: number, options: NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(amount);
}

function compactParts(value: number): { scaled: number; unit: "crore" | "lakh" | null } {
  const magnitude = Math.abs(value);
  if (magnitude >= crore) {
    return { scaled: value / crore, unit: "crore" };
  }

  if (magnitude >= lakh) {
    return { scaled: value / lakh, unit: "lakh" };
  }

  return { scaled: value, unit: null };
}

export function formatIndianCompact(value: number, maximumFractionDigits = 2): string {
  const { scaled, unit } = compactParts(value);
  if (!unit) {
    return formatNumber(value, { maximumFractionDigits });
  }

  return `${formatNumber(scaled, { maximumFractionDigits })} ${unit}`;
}

export function formatInrCompact(amount: number, maximumFractionDigits = 2): string {
  const { scaled, unit } = compactParts(amount);
  if (!unit) {
    return formatInr(amount, { maximumFractionDigits });
  }

  return `${formatInr(scaled, { maximumFractionDigits })} ${unit}`;
}

export function formatPercent(ratio: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits,
  }).format(ratio);
}

export type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatDate(value: DateInput, timeZone = defaultTimeZone): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(toDate(value));
}

export function formatDateTime(value: DateInput, timeZone = defaultTimeZone): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(toDate(value));
}

export function toIsoDate(value: DateInput): string {
  return toDate(value).toISOString();
}
