const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MS_PER_DAY = 86_400_000;

function utcDateOf(isoDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);

  if (!match) {
    throw new Error(`Expected an ISO date (yyyy-mm-dd), got "${isoDate}".`);
  }

  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoOf(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(isoDate: string, days: number): string {
  return isoOf(new Date(utcDateOf(isoDate).getTime() + days * MS_PER_DAY));
}

export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  return Math.round(
    (utcDateOf(toIsoDate).getTime() - utcDateOf(fromIsoDate).getTime()) / MS_PER_DAY,
  );
}

/** "18-Apr-2026", the style used by Tally, TRACES, and most Indian invoices. */
export function formatDashedDate(isoDate: string): string {
  const date = utcDateOf(isoDate);

  return `${pad(date.getUTCDate())}-${MONTH_NAMES[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/** "18 Apr 2026". */
export function formatLongDate(isoDate: string): string {
  const date = utcDateOf(isoDate);

  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "18/04/2026", day first. */
export function formatSlashDate(isoDate: string): string {
  const date = utcDateOf(isoDate);

  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/** An RFC 5322 date in India Standard Time, such as "Fri, 24 Jul 2026 10:42:00 +0530". */
export function formatEmailDate(isoDate: string, time: string): string {
  const date = utcDateOf(isoDate);

  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error(`Expected a time (hh:mm), got "${time}".`);
  }

  return `${WEEKDAY_NAMES[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()} ${time}:00 +0530`;
}

/** Indian digit grouping, such as 876150 -> "8,76,150". */
export function formatIndianNumber(value: number): string {
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  const whole = Math.trunc(rounded);
  const paise = Math.round((rounded - whole) * 100);
  const digits = String(whole);
  const lastThree = digits.slice(-3);
  const leading = digits.slice(0, -3);
  const grouped = leading
    ? `${leading.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  const text = paise > 0 ? `${grouped}.${pad(paise)}` : grouped;

  return value < 0 ? `-${text}` : text;
}

export function formatRupees(value: number): string {
  return `Rs. ${formatIndianNumber(value)}`;
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundredInWords(value: number): string {
  if (value < 20) {
    return ONES[value] ?? "";
  }

  const ones = value % 10;

  return `${TENS[Math.floor(value / 10)] ?? ""}${ones > 0 ? ` ${ONES[ones] ?? ""}` : ""}`;
}

const INDIAN_UNITS: ReadonlyArray<[number, string]> = [
  [10_000_000, "Crore"],
  [100_000, "Lakh"],
  [1_000, "Thousand"],
  [100, "Hundred"],
];

function wholeNumberInWords(value: number): string {
  let remaining = value;
  const parts: string[] = [];

  for (const [size, name] of INDIAN_UNITS) {
    const count = Math.floor(remaining / size);

    if (count > 0) {
      parts.push(
        `${count >= 100 ? wholeNumberInWords(count) : belowHundredInWords(count)} ${name}`,
      );
      remaining %= size;
    }
  }

  if (remaining > 0) {
    parts.push(belowHundredInWords(remaining));
  }

  return parts.join(" ");
}

/** Whole rupees in words with Indian units, as printed on invoices. */
export function rupeesInWords(value: number): string {
  const whole = Math.round(Math.abs(value));

  return `Rupees ${whole === 0 ? "Zero" : wholeNumberInWords(whole)} Only`;
}

export type CsvCell = string | number | null;

function csvCell(cell: CsvCell): string {
  if (cell === null) {
    return "";
  }

  const text = String(cell);

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}
