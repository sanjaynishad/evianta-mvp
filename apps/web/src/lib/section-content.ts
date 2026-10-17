export interface TextTableRow {
  cells: string[];
  values: (number | undefined)[];
  // Set when the table has a difference column and this row states a difference; true when it is
  // not zero. Undefined when there is no difference column or the cell is blank.
  discrepancy?: boolean;
}

export interface TextTable {
  headers: string[];
  rows: TextTableRow[];
  total?: TextTableRow;
  numericColumns: boolean[];
  differenceColumn?: number;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

const differencePattern = /\b(difference|diff|variance|gap|mismatch|shortfall)\b/i;
const numberPattern = /^[-+]?(?:rs\.?\s*|₹\s*)?[\d,]+(?:\.\d+)?%?$/i;

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\S+(?: \S+)*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }

  return tokens;
}

export function parseFigure(text: string): number | undefined {
  const trimmed = text.trim();
  if (!numberPattern.test(trimmed)) {
    return undefined;
  }

  const value = Number(trimmed.replace(/rs\.?|₹|,|%|\s/gi, ""));
  return Number.isFinite(value) ? value : undefined;
}

function overlap(token: Token, header: Token): number {
  return Math.min(token.end, header.end) - Math.max(token.start, header.start);
}

function distance(token: Token, header: Token): number {
  if (overlap(token, header) > 0) {
    return 0;
  }

  return Math.min(Math.abs(token.end - header.end), Math.abs(token.start - header.start));
}

function assignColumns(tokens: Token[], headers: Token[]): string[] {
  const cells = headers.map(() => "");
  for (const token of tokens) {
    let best = 0;
    let bestOverlap = Number.NEGATIVE_INFINITY;
    let bestDistance = Number.POSITIVE_INFINITY;
    headers.forEach((header, index) => {
      const tokenOverlap = overlap(token, header);
      const tokenDistance = distance(token, header);
      if (
        tokenOverlap > bestOverlap ||
        (tokenOverlap === bestOverlap && tokenDistance < bestDistance)
      ) {
        best = index;
        bestOverlap = tokenOverlap;
        bestDistance = tokenDistance;
      }
    });
    cells[best] = cells[best] ? `${cells[best]} ${token.text}` : token.text;
  }

  return cells;
}

// Parses a plain-text table whose columns are separated by two or more spaces and aligned under
// the header row, as agents write them in deliverable sections.
export function parseTextTable(content: string): TextTable | undefined {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return undefined;
  }

  const headerTokens = tokenize(lines[0]!);
  if (headerTokens.length < 2) {
    return undefined;
  }

  const headers = headerTokens.map((token) => token.text);
  const parsedRows = lines.slice(1).map((line) => {
    const cells = assignColumns(tokenize(line), headerTokens);
    return { cells, values: cells.map(parseFigure) };
  });
  const numericColumns = headers.map(
    (_, index) =>
      index > 0 &&
      parsedRows.some((row) => row.values[index] !== undefined) &&
      parsedRows.every((row) => !row.cells[index] || row.values[index] !== undefined),
  );
  const differenceIndex = headers.findIndex(
    (header, index) => numericColumns[index] && differencePattern.test(header),
  );
  const differenceColumn = differenceIndex >= 0 ? differenceIndex : undefined;
  const rows: TextTableRow[] = parsedRows.map((row) => {
    const difference = differenceColumn === undefined ? undefined : row.values[differenceColumn];
    return { ...row, discrepancy: difference === undefined ? undefined : difference !== 0 };
  });
  const last = rows.at(-1);
  const hasTotal = last !== undefined && /^(grand )?total\b/i.test(last.cells[0] ?? "");
  return {
    headers,
    rows: hasTotal ? rows.slice(0, -1) : rows,
    total: hasTotal ? last : undefined,
    numericColumns,
    differenceColumn,
  };
}

export interface TextTimelineEntry {
  id: string;
  date: string;
  text: string;
}

const monthIndex: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function toIsoDay(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return undefined;
  }

  return date.toISOString().slice(0, 10);
}

function parseLeadingDate(line: string): { date: string; rest: string } | undefined {
  const named = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\s+(.+)$/.exec(line);
  if (named) {
    const month = monthIndex[named[2]!.slice(0, 3).toLowerCase()];
    const date =
      month === undefined ? undefined : toIsoDay(Number(named[3]), month, Number(named[1]));
    return date ? { date, rest: named[4]!.trim() } : undefined;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/.exec(line);
  if (iso) {
    const date = toIsoDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return date ? { date, rest: iso[4]!.trim() } : undefined;
  }

  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s+(.+)$/.exec(line);
  if (numeric) {
    const date = toIsoDay(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]));
    return date ? { date, rest: numeric[4]!.trim() } : undefined;
  }

  return undefined;
}

// Parses "14 Mar 2023  Event" lines (also ISO and dd/mm/yyyy dates). Undefined when any line has
// no readable date, so the caller can fall back to the plain text.
export function parseTextTimeline(content: string): TextTimelineEntry[] | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const entries: TextTimelineEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const parsed = parseLeadingDate(line);
    if (!parsed) {
      return undefined;
    }

    entries.push({ id: `entry-${index}`, date: parsed.date, text: parsed.rest });
  }

  return entries;
}
