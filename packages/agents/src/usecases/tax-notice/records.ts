import type {
  DocumentMetadata,
  EvidenceLocation,
  ExtractedDocument,
  ExtractedTable,
  TableCell,
} from "@evianta/core";
import { tableEvidenceLocation } from "@evianta/ingest";

export type TaxRecordSource = "return" | "ledger" | "tax-credit";

export const TAX_RECORD_SOURCES: readonly TaxRecordSource[] = ["return", "ledger", "tax-credit"];

export const SOURCE_LABELS: Readonly<Record<TaxRecordSource, string>> = {
  return: "Return",
  ledger: "Ledger",
  "tax-credit": "26AS/AIS",
};

export type TaxColumnKind =
  "tan" | "deductor" | "section" | "date" | "quarter" | "financialYear" | "tax" | "amount";

export type TaxColumnMap = Partial<Record<TaxColumnKind, number>>;

// Checked in order, so "TAN of deductor" is a TAN column and "Tax deducted" is not an amount.
const COLUMN_PATTERNS: ReadonlyArray<[TaxColumnKind, RegExp]> = [
  ["tan", /\btan\b/i],
  ["tax", /\btds\b|tax deducted|tax credit|tax collected|\btcs\b/i],
  ["date", /date/i],
  ["quarter", /quarter/i],
  ["financialYear", /financial year|\bfy\b|\bf\.y\.?/i],
  ["section", /\bsection\b|\bsec\.?\b/i],
  ["amount", /amount|income|gross|credited|receipt|paid|value/i],
  ["deductor", /deductor|party|payer|employer|customer|\bname\b/i],
];

export interface TaxRecordRow {
  source: TaxRecordSource;
  documentId: string;
  documentName: string;
  tableName: string;
  /** Index into the table's data rows. */
  rowIndex: number;
  tan?: string;
  deductorName?: string;
  section?: string;
  financialYear?: string;
  quarter?: string;
  /** ISO transaction date, when the table has a date column. */
  date?: string;
  amount?: number;
  tax?: number;
  /** Measures whose column exists but whose cell is blank or unreadable in this row. */
  unreadable: TaxMeasure[];
  location: EvidenceLocation;
  quote: string;
}

export type TaxMeasure = "tax" | "amount";

/** Which tax-credit statement a table comes from; Form 26AS is authoritative for TDS credit. */
export type TaxCreditStatement = "26as" | "ais";

export interface TaxRecordTable {
  source: TaxRecordSource;
  /** Set for tax-credit tables. */
  statement?: TaxCreditStatement;
  documentId: string;
  documentName: string;
  table: ExtractedTable;
  columns: TaxColumnMap;
  rows: TaxRecordRow[];
  /** Rows with content but no deductor or TAN; reported, not reconciled. Blank lines are ignored. */
  skippedRowIndexes: number[];
  /** Total and subtotal rows, excluded so they are not counted as transactions. */
  aggregateRowIndexes: number[];
  warnings: string[];
}

export interface UnclassifiedTable {
  documentId: string;
  documentName: string;
  tableName: string;
  reason: string;
}

export interface TaxRecordSet {
  tables: TaxRecordTable[];
  unclassified: UnclassifiedTable[];
}

/** Every column index matching each kind, in column order. */
export function taxColumnCandidates(
  columnNames: readonly string[],
): Partial<Record<TaxColumnKind, number[]>> {
  const candidates: Partial<Record<TaxColumnKind, number[]>> = {};

  columnNames.forEach((name, index) => {
    const kind = COLUMN_PATTERNS.find(([, pattern]) => pattern.test(name))?.[0];

    if (kind) {
      candidates[kind] = [...(candidates[kind] ?? []), index];
    }
  });

  return candidates;
}

// Which column to trust when a source has several TDS or amount columns.
const MEASURE_PREFERENCES: Readonly<Record<TaxRecordSource, Record<TaxMeasure, RegExp>>> = {
  return: { tax: /claim/i, amount: /income|offered/i },
  ledger: { tax: /\btds\b|deducted/i, amount: /gross/i },
  "tax-credit": { tax: /tax deducted|tds deducted/i, amount: /paid|credited/i },
};

export interface ColumnSelection {
  columns: TaxColumnMap;
  /** Measures with several candidate columns and no clear choice for this source. */
  ambiguous: Array<{ measure: TaxMeasure; names: string[] }>;
}

export function selectTaxColumns(
  columnNames: readonly string[],
  source?: TaxRecordSource,
): ColumnSelection {
  const candidates = taxColumnCandidates(columnNames);
  const columns: TaxColumnMap = {};
  const ambiguous: ColumnSelection["ambiguous"] = [];

  for (const [kind, indexes] of Object.entries(candidates) as Array<[TaxColumnKind, number[]]>) {
    if (kind !== "tax" && kind !== "amount") {
      columns[kind] = indexes[0];
      continue;
    }

    const preference = source ? MEASURE_PREFERENCES[source][kind] : undefined;
    const preferred = preference
      ? indexes.filter((index) => preference.test(columnNames[index] ?? ""))
      : [];
    const chosen = indexes.length === 1 ? indexes : preferred;

    if (chosen.length === 1) {
      columns[kind] = chosen[0];
    } else {
      ambiguous.push({ measure: kind, names: indexes.map((index) => columnNames[index] ?? "") });
    }
  }

  return { columns, ambiguous };
}

export function mapTaxColumns(
  columnNames: readonly string[],
  source?: TaxRecordSource,
): TaxColumnMap {
  return selectTaxColumns(columnNames, source).columns;
}

export function classifyTaxRecordSource(
  documentName: string,
  tableName: string,
  columnNames: readonly string[],
): TaxRecordSource | undefined {
  const name = `${documentName} ${tableName}`.toLowerCase();

  if (/26\s*-?as|\bais\b|\btis\b|tax[\s_-]*credit|annual information/.test(name)) {
    return "tax-credit";
  }

  if (/\bitr\b|itr[\s_-]|return|computation|schedule[\s_-]*tds/.test(name)) {
    return "return";
  }

  if (/ledger|books?\b|journal|daybook|tally/.test(name)) {
    return "ledger";
  }

  const headers = columnNames.join(" ").toLowerCase();

  if (/booking status|date of booking|status of booking/.test(headers)) {
    return "tax-credit";
  }

  if (/claimed|offered/.test(headers)) {
    return "return";
  }

  if (/voucher|narration|\bparty\b|debit|credit/.test(headers)) {
    return "ledger";
  }

  return undefined;
}

export function taxCreditStatementOf(documentName: string, tableName: string): TaxCreditStatement {
  return /\bais\b|\btis\b|annual information/i.test(`${documentName} ${tableName}`)
    ? "ais"
    : "26as";
}

export function parseAmount(cell: TableCell | undefined): number | undefined {
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? cell : undefined;
  }

  if (typeof cell !== "string") {
    return undefined;
  }

  let text = cell.trim();
  let negative = false;
  const parenthesized = /^\((.*)\)$/.exec(text);

  if (parenthesized) {
    negative = true;
    text = (parenthesized[1] ?? "").trim();
  }

  // The sign may sit before or after the currency, as in "-Rs 1,200" or "Rs -1,200".
  for (const pattern of [/^[-−]\s*/, /^\+\s*/, /^(rs\.?|inr|₹)\s*/i, /^[-−]\s*/]) {
    if (pattern.test(text)) {
      negative = negative || /^[-−]/.test(text);
      text = text.replace(pattern, "");
    }
  }

  const digits = text.replace(/\s*\/-$/, "").replace(/[,\s]/g, "");

  if (!/^\d+(\.\d+)?$/.test(digits)) {
    return undefined;
  }

  const value = Number(digits);

  return negative ? -value : value;
}

function textOf(cell: TableCell | undefined): string | undefined {
  if (cell === null || cell === undefined) {
    return undefined;
  }

  const text = String(cell).trim();

  return text.length > 0 ? text : undefined;
}

export function normalizeTan(value: string | undefined): string | undefined {
  const compact = value?.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // A TAN is four letters, five digits, and a letter; placeholders such as "PENDING" are not TANs.
  return compact && /^[A-Z]{4}\d{5}[A-Z]$/.test(compact) ? compact : undefined;
}

export function normalizeDeductorName(value: string | undefined): string | undefined {
  const words = value
    ?.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !["the", "pvt", "private", "ltd", "limited", "co"].includes(word));

  return words && words.length > 0 ? words.join(" ") : undefined;
}

/** "2023-24" style financial year from text such as "FY 2023-24" or "2023-2024". */
export function normalizeFinancialYear(value: string | undefined): string | undefined {
  const match = /(\d{4})\s*[-/]\s*(\d{2,4})/.exec(value ?? "");

  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const start = Number(match[1]);

  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function normalizeQuarter(value: string | undefined): string | undefined {
  const text = value?.toLowerCase() ?? "";
  const numbered = /q\s*([1-4])\b|^([1-4])$/.exec(text.trim());

  if (numbered) {
    return `Q${numbered[1] ?? numbered[2]}`;
  }

  const byMonth: ReadonlyArray<[RegExp, string]> = [
    [/^apr/, "Q1"],
    [/^jul/, "Q2"],
    [/^oct/, "Q3"],
    [/^jan/, "Q4"],
  ];

  return byMonth.find(([pattern]) => pattern.test(text.trim()))?.[1];
}

/** Indian financial year (April to March) and quarter of an ISO date. */
export function financialPeriodOfDate(
  value: string | undefined,
): { financialYear: string; quarter: string } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");

  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  const quarter = month >= 4 ? Math.ceil((month - 3) / 3) : 4;

  return {
    financialYear: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    quarter: `Q${quarter}`,
  };
}

function renderRow(row: readonly TableCell[]): string {
  return row.map((cell) => (cell === null ? "" : String(cell))).join(" | ");
}

const AGGREGATE_LABEL = /^(sub[\s-]*total|grand[\s-]*total|totals?)(\s+for\b.*|\s*[:-].*)?$/i;

/** A total or subtotal line: no TAN and a cell that starts with "Total" or "Subtotal". */
export function isAggregateRow(row: readonly TableCell[], columns: TaxColumnMap): boolean {
  const tanCell = columns.tan === undefined ? undefined : row[columns.tan];

  if (normalizeTan(textOf(tanCell))) {
    return false;
  }

  return row.some((cell) => typeof cell === "string" && AGGREGATE_LABEL.test(cell.trim()));
}

function isBlankRow(row: readonly TableCell[]): boolean {
  return row.every((cell) => textOf(cell) === undefined);
}

/**
 * Reads a data row. A row that names a deductor or TAN is always kept, so a blank or unreadable
 * money cell marks the row unreadable instead of silently dropping it from the sums.
 */
function readRow(
  source: TaxRecordSource,
  metadata: DocumentMetadata,
  table: ExtractedTable,
  columns: TaxColumnMap,
  rowIndex: number,
): TaxRecordRow | undefined {
  const row = table.rows[rowIndex] ?? [];
  const cell = (kind: TaxColumnKind) => {
    const index = columns[kind];

    return index === undefined ? undefined : row[index];
  };

  const tan = normalizeTan(textOf(cell("tan")));
  const deductorName = textOf(cell("deductor"));
  const amount = parseAmount(cell("amount"));
  const tax = parseAmount(cell("tax"));

  if (!tan && !deductorName) {
    return undefined;
  }

  const unreadable: TaxMeasure[] = [];

  if (columns.tax !== undefined && tax === undefined) {
    unreadable.push("tax");
  }

  if (columns.amount !== undefined && amount === undefined) {
    unreadable.push("amount");
  }

  const dateText = textOf(cell("date"));
  const dated = financialPeriodOfDate(dateText);
  const date = dated ? dateText?.slice(0, 10) : undefined;
  const financialYear =
    normalizeFinancialYear(textOf(cell("financialYear"))) ?? dated?.financialYear;
  const quarter = normalizeQuarter(textOf(cell("quarter"))) ?? dated?.quarter;
  const focusColumn = columns.tax ?? columns.amount;
  const section = textOf(cell("section"));

  return {
    source,
    documentId: metadata.id,
    documentName: metadata.name,
    tableName: table.name,
    rowIndex,
    ...(tan ? { tan } : {}),
    ...(deductorName ? { deductorName } : {}),
    ...(section ? { section } : {}),
    ...(financialYear ? { financialYear } : {}),
    ...(quarter ? { quarter } : {}),
    ...(date ? { date } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(tax !== undefined ? { tax } : {}),
    unreadable,
    location: tableEvidenceLocation(table, {
      rowStart: rowIndex,
      ...(focusColumn !== undefined ? { columnStart: focusColumn } : {}),
    }),
    quote: renderRow(row),
  };
}

export interface TaxRecordDocument {
  metadata: DocumentMetadata;
  extraction?: ExtractedDocument;
}

/** Finds return, ledger, and 26AS/AIS style tables and reads their rows. Pure and deterministic. */
export function readTaxRecords(documents: readonly TaxRecordDocument[]): TaxRecordSet {
  const tables: TaxRecordTable[] = [];
  const unclassified: UnclassifiedTable[] = [];

  for (const { metadata, extraction } of documents) {
    for (const table of extraction?.tables ?? []) {
      const columnNames = table.columns.map((column) => column.name);
      const candidates = taxColumnCandidates(columnNames);
      const hasParty = candidates.tan !== undefined || candidates.deductor !== undefined;
      const hasValue = candidates.tax !== undefined || candidates.amount !== undefined;
      const skip = (reason: string) =>
        unclassified.push({
          documentId: metadata.id,
          documentName: metadata.name,
          tableName: table.name,
          reason,
        });

      if (!hasParty || !hasValue) {
        skip("no deductor or TAN column with an amount or tax column");
        continue;
      }

      const source = classifyTaxRecordSource(metadata.name, table.name, columnNames);

      if (!source) {
        skip("could not tell whether it is a return, ledger, or 26AS/AIS statement");
        continue;
      }

      const { columns, ambiguous } = selectTaxColumns(columnNames, source);
      const ambiguousTax = ambiguous.find((entry) => entry.measure === "tax");

      if (ambiguousTax) {
        skip(
          `it has several TDS columns (${ambiguousTax.names.join(", ")}) and none is clearly the ${source === "return" ? "TDS claimed" : "TDS deducted"}`,
        );
        continue;
      }

      if (columns.tax === undefined && columns.amount === undefined) {
        skip("none of its amount columns could be used");
        continue;
      }

      const warnings = ambiguous.map(
        (entry) =>
          `${metadata.name}: amounts were not compared because several columns could hold them (${entry.names.join(", ")}).`,
      );
      const rows: TaxRecordRow[] = [];
      const skippedRowIndexes: number[] = [];
      const aggregateRowIndexes: number[] = [];

      table.rows.forEach((row, rowIndex) => {
        if (isBlankRow(row)) {
          return;
        }

        if (isAggregateRow(row, columns)) {
          aggregateRowIndexes.push(rowIndex);

          return;
        }

        const read = readRow(source, metadata, table, columns, rowIndex);

        if (read) {
          rows.push(read);
        } else {
          skippedRowIndexes.push(rowIndex);
        }
      });

      tables.push({
        source,
        ...(source === "tax-credit"
          ? { statement: taxCreditStatementOf(metadata.name, table.name) }
          : {}),
        documentId: metadata.id,
        documentName: metadata.name,
        table,
        columns,
        rows,
        skippedRowIndexes,
        aggregateRowIndexes,
        warnings,
      });
    }
  }

  return { tables, unclassified };
}

/** Document ids whose tables were read as tax records. */
export function taxRecordDocumentIds(records: TaxRecordSet): Set<string> {
  return new Set(records.tables.map((table) => table.documentId));
}
