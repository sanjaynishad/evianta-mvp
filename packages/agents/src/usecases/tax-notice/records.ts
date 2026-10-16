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
  amount?: number;
  tax?: number;
  location: EvidenceLocation;
  quote: string;
}

export interface TaxRecordTable {
  source: TaxRecordSource;
  documentId: string;
  documentName: string;
  table: ExtractedTable;
  columns: TaxColumnMap;
  rows: TaxRecordRow[];
  /** Data rows without a deductor or any amount, for example subtotals or blank lines. */
  skippedRowIndexes: number[];
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

export function mapTaxColumns(columnNames: readonly string[]): TaxColumnMap {
  const map: TaxColumnMap = {};

  columnNames.forEach((name, index) => {
    const kind = COLUMN_PATTERNS.find(([, pattern]) => pattern.test(name))?.[0];

    if (kind && map[kind] === undefined) {
      map[kind] = index;
    }
  });

  return map;
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

export function parseAmount(cell: TableCell | undefined): number | undefined {
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? cell : undefined;
  }

  if (typeof cell !== "string") {
    return undefined;
  }

  const trimmed = cell.trim();
  const negative = /^\(.*\)$/.test(trimmed) || /^-/.test(trimmed);
  const digits = trimmed.replace(/rs\.?|inr|₹|\/-|[(),\s]/gi, "").replace(/^[-+]/, "");

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

  return compact && compact.length >= 5 ? compact : undefined;
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

  if ((!tan && !deductorName) || (amount === undefined && tax === undefined)) {
    return undefined;
  }

  const dated = financialPeriodOfDate(textOf(cell("date")));
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
    ...(amount !== undefined ? { amount } : {}),
    ...(tax !== undefined ? { tax } : {}),
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
      const columns = mapTaxColumns(columnNames);
      const hasParty = columns.tan !== undefined || columns.deductor !== undefined;
      const hasValue = columns.tax !== undefined || columns.amount !== undefined;

      if (!hasParty || !hasValue) {
        unclassified.push({
          documentId: metadata.id,
          documentName: metadata.name,
          tableName: table.name,
          reason: "no deductor or TAN column with an amount or tax column",
        });
        continue;
      }

      const source = classifyTaxRecordSource(metadata.name, table.name, columnNames);

      if (!source) {
        unclassified.push({
          documentId: metadata.id,
          documentName: metadata.name,
          tableName: table.name,
          reason: "could not tell whether it is a return, ledger, or 26AS/AIS statement",
        });
        continue;
      }

      const rows: TaxRecordRow[] = [];
      const skippedRowIndexes: number[] = [];

      table.rows.forEach((_row, rowIndex) => {
        const read = readRow(source, metadata, table, columns, rowIndex);

        if (read) {
          rows.push(read);
        } else {
          skippedRowIndexes.push(rowIndex);
        }
      });

      tables.push({
        source,
        documentId: metadata.id,
        documentName: metadata.name,
        table,
        columns,
        rows,
        skippedRowIndexes,
      });
    }
  }

  return { tables, unclassified };
}

/** Document ids whose tables were read as tax records. */
export function taxRecordDocumentIds(records: TaxRecordSet): Set<string> {
  return new Set(records.tables.map((table) => table.documentId));
}
