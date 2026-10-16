import type {
  DocumentMetadata,
  EvidenceLocation,
  ExtractedDocument,
  ExtractedTable,
  TableCell,
} from "@evianta/core";
import { tableEvidenceLocation } from "@evianta/ingest";

import { toIsoDate } from "./dates.js";

export type PaymentRecordKind = "invoices" | "payments";

export interface PaymentCaseDocument {
  metadata: DocumentMetadata;
  extraction?: ExtractedDocument;
}

type InvoiceColumn = "invoiceNumber" | "invoiceDate" | "dueDate" | "amount" | "poRef";
type PaymentColumn = "date" | "amount" | "invoiceRef" | "reference" | "narration";

// Checked in order, so "Invoice date" is a date column and "Invoice no" is the number column.
const INVOICE_COLUMN_PATTERNS: ReadonlyArray<[InvoiceColumn, RegExp]> = [
  ["dueDate", /\bdue\b/i],
  ["invoiceDate", /(invoice|bill)\s*date|^date$/i],
  ["poRef", /\bp\.?o\.?\b|purchase\s*order|\border\b/i],
  ["invoiceNumber", /(invoice|bill)\s*(no|num|number|#|ref|id)?\.?$/i],
  ["amount", /total|amount|value|gross/i],
];

const PAYMENT_COLUMN_PATTERNS: ReadonlyArray<[PaymentColumn, RegExp]> = [
  ["invoiceRef", /invoice|bill|against/i],
  ["date", /date/i],
  ["reference", /\butr\b|\bref|cheque|chq|transaction|txn|voucher|payment\s*(id|no)/i],
  ["amount", /amount|paid|received|credit|value/i],
  ["narration", /narration|remark|description|particulars|note/i],
];

export interface InvoiceRecord {
  /** Invoice number as written in the register. */
  invoiceNumber: string;
  /** Normalized number used for matching. */
  key: string;
  invoiceDate?: string;
  dueDate?: string;
  amount?: number;
  poRef?: string;
  documentId: string;
  documentName: string;
  tableName: string;
  rowIndex: number;
  location: EvidenceLocation;
  quote: string;
}

export interface PaymentRecord {
  /** Payment reference when present, else the source row. */
  label: string;
  reference?: string;
  date?: string;
  amount?: number;
  /** Invoice numbers written against the payment, as written. */
  invoiceRefs: string[];
  narration?: string;
  documentId: string;
  documentName: string;
  tableName: string;
  rowIndex: number;
  location: EvidenceLocation;
  quote: string;
}

export interface RecordTable {
  kind: PaymentRecordKind;
  documentId: string;
  documentName: string;
  table: ExtractedTable;
  location: EvidenceLocation;
  rowCount: number;
}

export interface UnreadableRecordRow {
  kind: PaymentRecordKind;
  documentId: string;
  documentName: string;
  rowIndex: number;
  location: EvidenceLocation;
  quote: string;
  reason: string;
}

export interface UnclassifiedRecordTable {
  documentId: string;
  documentName: string;
  tableName: string;
  reason: string;
}

export interface PaymentRecordSet {
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
  tables: RecordTable[];
  /** Rows that look like records but whose amount or key fields could not be read. */
  unreadable: UnreadableRecordRow[];
  /** Later rows that repeat an invoice number already in the register. */
  duplicateInvoices: InvoiceRecord[];
  unclassified: UnclassifiedRecordTable[];
}

export function normalizeInvoiceNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function columnMap<C extends string>(
  columnNames: readonly string[],
  patterns: ReadonlyArray<[C, RegExp]>,
): Partial<Record<C, number>> {
  const map: Partial<Record<C, number>> = {};

  columnNames.forEach((name, index) => {
    const kind = patterns.find(([, pattern]) => pattern.test(name.trim()))?.[0];

    if (kind !== undefined && map[kind] === undefined) {
      map[kind] = index;
    }
  });

  return map;
}

function preferredAmountColumn(columnNames: readonly string[], fallback?: number) {
  const totals = columnNames
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => /total|invoice\s*(amount|value)/i.test(name));

  return totals.length === 1 ? totals[0]?.index : fallback;
}

export function classifyRecordTable(
  documentName: string,
  tableName: string,
  columnNames: readonly string[],
): PaymentRecordKind | undefined {
  const name = `${documentName} ${tableName}`.toLowerCase();
  const headers = columnNames.join(" ").toLowerCase();
  const invoiceColumns = columnMap(columnNames, INVOICE_COLUMN_PATTERNS);
  const paymentColumns = columnMap(columnNames, PAYMENT_COLUMN_PATTERNS);
  const looksLikePayments =
    paymentColumns.amount !== undefined && paymentColumns.date !== undefined;
  const looksLikeInvoices =
    invoiceColumns.invoiceNumber !== undefined && invoiceColumns.amount !== undefined;

  if (/payment|receipt|remittance|\bbank\b|collection/.test(name) && looksLikePayments) {
    return "payments";
  }

  if (/invoice|\bbill|sales\s*register/.test(name) && looksLikeInvoices) {
    return "invoices";
  }

  if (/\butr\b|payment\s*date|amount\s*(paid|received)|cheque/.test(headers) && looksLikePayments) {
    return "payments";
  }

  return looksLikeInvoices && /invoice\s*date|bill\s*date|\bdue\b/.test(headers)
    ? "invoices"
    : undefined;
}

export function parseRecordAmount(cell: TableCell | undefined): number | undefined {
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? cell : undefined;
  }

  if (typeof cell !== "string") {
    return undefined;
  }

  const text = cell
    .trim()
    .replace(/^(rs\.?|inr|₹)\s*/i, "")
    .replace(/\s*\/-$/, "")
    .replace(/[,\s]/g, "");

  if (!/^\d+(\.\d+)?$/.test(text)) {
    return undefined;
  }

  return Number(text);
}

function textOf(cell: TableCell | undefined): string | undefined {
  if (cell === null || cell === undefined) {
    return undefined;
  }

  const text = String(cell).trim();

  return text.length > 0 ? text : undefined;
}

function renderRow(row: readonly TableCell[]): string {
  return row.map((cell) => (cell === null ? "" : String(cell))).join(" | ");
}

const AGGREGATE_LABEL = /^(sub[\s-]*total|grand[\s-]*total|totals?|balance)\b/i;

/** A total or balance line, judged only by its key columns so free-text narration cannot drop a row. */
function isAggregateRow(
  row: readonly TableCell[],
  keyColumns: ReadonlyArray<number | undefined>,
): boolean {
  return keyColumns.some((index) => {
    const cell = index === undefined ? undefined : row[index];

    return typeof cell === "string" && AGGREGATE_LABEL.test(cell.trim());
  });
}

const FREE_TEXT_COLUMN = /narration|remark|description|particular|note|item/i;

/** The first column, where a total label usually sits, unless it holds free text. */
function labelColumn(columnNames: readonly string[]): number | undefined {
  return FREE_TEXT_COLUMN.test(columnNames[0] ?? "") ? undefined : 0;
}

const INVOICE_NUMBER_IN_TEXT =
  /\b(?:inv|invoice|bill)[\s#:.-]*(?:no\.?\s*)?[A-Z0-9][A-Z0-9/-]*\d\b/gi;
const PLACEHOLDER_REF = /^(n\/?a|nil|none|-+|tbd|on\s+account|advance)$/i;

function withoutLetterPrefix(key: string): string {
  return key.replace(/^[A-Z]+/, "");
}

/**
 * The register key a written reference points to: an exact match, else a match ignoring a letter
 * prefix ("1002" or "Invoice 1002" for "INV-1002") when exactly one invoice fits.
 */
export function resolveInvoiceKey(ref: string, knownKeys: ReadonlySet<string>): string | undefined {
  const normalized = normalizeInvoiceNumber(ref);

  if (knownKeys.has(normalized)) {
    return normalized;
  }

  const bare = withoutLetterPrefix(normalized);

  if (bare.length === 0) {
    return undefined;
  }

  const matches = [...knownKeys].filter((key) => withoutLetterPrefix(key) === bare);

  return matches.length === 1 ? matches[0] : undefined;
}

/** Every reference written in an invoice reference cell, such as "INV-1001; INV-1002". */
export function invoiceRefsInCell(text: string | undefined): string[] {
  return (text ?? "")
    .split(/[,;&]|\band\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !PLACEHOLDER_REF.test(part));
}

/** Invoice numbers written in free text, such as "Part payment against INV-1003". */
export function invoiceRefsInText(
  text: string | undefined,
  knownKeys: ReadonlySet<string>,
): string[] {
  if (!text) {
    return [];
  }

  const refs: string[] = [];

  for (const match of text.matchAll(INVOICE_NUMBER_IN_TEXT)) {
    refs.push(match[0].trim());
  }

  for (const part of invoiceRefsInCell(text)) {
    if (knownKeys.has(normalizeInvoiceNumber(part))) {
      refs.push(part);
    }
  }

  return refs;
}

/** Written references from the reference cell and the narration, one per distinct invoice. */
export function paymentInvoiceRefs(
  referenceCell: string | undefined,
  narration: string | undefined,
  knownKeys: ReadonlySet<string>,
): string[] {
  const refs = new Map<string, string>();

  for (const ref of [
    ...invoiceRefsInCell(referenceCell),
    ...invoiceRefsInText(narration, knownKeys),
  ]) {
    const key = resolveInvoiceKey(ref, knownKeys) ?? normalizeInvoiceNumber(ref);

    if (key && !refs.has(key)) {
      refs.set(key, ref);
    }
  }

  return [...refs.values()];
}

function readInvoices(
  metadata: DocumentMetadata,
  table: ExtractedTable,
  set: PaymentRecordSet,
  seen: Map<string, InvoiceRecord>,
): number {
  const columnNames = table.columns.map((column) => column.name);
  const columns = columnMap(columnNames, INVOICE_COLUMN_PATTERNS);
  const amountColumn = preferredAmountColumn(columnNames, columns.amount);
  let count = 0;

  table.rows.forEach((row, rowIndex) => {
    const cell = (index: number | undefined) => (index === undefined ? undefined : row[index]);
    const invoiceNumber = textOf(cell(columns.invoiceNumber));

    if (
      isAggregateRow(row, [columns.invoiceNumber, columns.invoiceDate, labelColumn(columnNames)]) ||
      row.every((value) => textOf(value) === undefined)
    ) {
      return;
    }

    const location = tableEvidenceLocation(table, {
      rowStart: rowIndex,
      ...(amountColumn !== undefined ? { columnStart: amountColumn } : {}),
    });
    const quote = renderRow(row);
    const amount = parseRecordAmount(cell(amountColumn));

    if (!invoiceNumber || amount === undefined) {
      set.unreadable.push({
        kind: "invoices",
        documentId: metadata.id,
        documentName: metadata.name,
        rowIndex,
        location,
        quote,
        reason: invoiceNumber
          ? `the amount of ${invoiceNumber} is blank or unreadable`
          : "the invoice number is blank",
      });

      return;
    }

    const invoiceDate = toIsoDate(textOf(cell(columns.invoiceDate)));
    const dueDate = toIsoDate(textOf(cell(columns.dueDate)));
    const poRef = textOf(cell(columns.poRef));
    const record: InvoiceRecord = {
      invoiceNumber,
      key: normalizeInvoiceNumber(invoiceNumber),
      ...(invoiceDate ? { invoiceDate } : {}),
      ...(dueDate ? { dueDate } : {}),
      amount,
      ...(poRef ? { poRef } : {}),
      documentId: metadata.id,
      documentName: metadata.name,
      tableName: table.name,
      rowIndex,
      location,
      quote,
    };

    count += 1;

    if (seen.has(record.key)) {
      set.duplicateInvoices.push(record);

      return;
    }

    seen.set(record.key, record);
    set.invoices.push(record);
  });

  return count;
}

function readPayments(
  metadata: DocumentMetadata,
  table: ExtractedTable,
  set: PaymentRecordSet,
  pending: Array<() => void>,
  knownKeys: ReadonlySet<string>,
): number {
  const columns = columnMap(
    table.columns.map((column) => column.name),
    PAYMENT_COLUMN_PATTERNS,
  );
  const keyColumns = [
    columns.date,
    columns.reference,
    columns.invoiceRef,
    labelColumn(table.columns.map((column) => column.name)),
  ];
  let count = 0;

  table.rows.forEach((row, rowIndex) => {
    const cell = (index: number | undefined) => (index === undefined ? undefined : row[index]);

    if (isAggregateRow(row, keyColumns) || row.every((value) => textOf(value) === undefined)) {
      return;
    }

    const location = tableEvidenceLocation(table, {
      rowStart: rowIndex,
      ...(columns.amount !== undefined ? { columnStart: columns.amount } : {}),
    });
    const quote = renderRow(row);
    const amount = parseRecordAmount(cell(columns.amount));
    const date = toIsoDate(textOf(cell(columns.date)));
    const reference = textOf(cell(columns.reference));

    if (amount === undefined || amount <= 0 || !date) {
      set.unreadable.push({
        kind: "payments",
        documentId: metadata.id,
        documentName: metadata.name,
        rowIndex,
        location,
        quote,
        reason:
          amount === undefined || amount <= 0
            ? `the payment amount${reference ? ` of ${reference}` : ""} is blank, unreadable, or not positive`
            : `the payment date${reference ? ` of ${reference}` : ""} is blank or unreadable`,
      });

      return;
    }

    count += 1;

    const rawInvoiceRef = textOf(cell(columns.invoiceRef));
    const narration = textOf(cell(columns.narration));

    // Invoice references are resolved once every invoice register has been read.
    pending.push(() => {
      set.payments.push({
        label: reference ?? `${metadata.name} row ${location.rowRange?.start ?? rowIndex + 2}`,
        ...(reference ? { reference } : {}),
        date,
        amount,
        invoiceRefs: paymentInvoiceRefs(rawInvoiceRef, narration, knownKeys),
        ...(narration ? { narration } : {}),
        documentId: metadata.id,
        documentName: metadata.name,
        tableName: table.name,
        rowIndex,
        location,
        quote,
      });
    });
  });

  return count;
}

function wholeTableLocation(table: ExtractedTable): EvidenceLocation {
  return {
    ...(table.sheet ? { sheet: table.sheet } : {}),
    ...(table.range ? { cellRange: table.range } : {}),
  };
}

/** Finds invoice registers and payment records in the extractions and reads their rows. Pure. */
export function readPaymentRecords(documents: readonly PaymentCaseDocument[]): PaymentRecordSet {
  const set: PaymentRecordSet = {
    invoices: [],
    payments: [],
    tables: [],
    unreadable: [],
    duplicateInvoices: [],
    unclassified: [],
  };
  const classified: Array<{
    kind: PaymentRecordKind;
    metadata: DocumentMetadata;
    table: ExtractedTable;
  }> = [];

  for (const { metadata, extraction } of documents) {
    for (const table of extraction?.tables ?? []) {
      const kind = classifyRecordTable(
        metadata.name,
        table.name,
        table.columns.map((column) => column.name),
      );

      if (kind) {
        classified.push({ kind, metadata, table });
      } else {
        set.unclassified.push({
          documentId: metadata.id,
          documentName: metadata.name,
          tableName: table.name,
          reason: "it is neither an invoice register nor a payment record",
        });
      }
    }
  }

  const seen = new Map<string, InvoiceRecord>();
  const rowCounts = new Map<ExtractedTable, number>();

  for (const entry of classified.filter((item) => item.kind === "invoices")) {
    rowCounts.set(entry.table, readInvoices(entry.metadata, entry.table, set, seen));
  }

  const knownKeys = new Set(seen.keys());
  const pending: Array<() => void> = [];

  for (const entry of classified.filter((item) => item.kind === "payments")) {
    rowCounts.set(entry.table, readPayments(entry.metadata, entry.table, set, pending, knownKeys));
  }

  for (const resolve of pending) {
    resolve();
  }

  set.tables = classified.map(({ kind, metadata, table }) => ({
    kind,
    documentId: metadata.id,
    documentName: metadata.name,
    table,
    location: wholeTableLocation(table),
    rowCount: rowCounts.get(table) ?? 0,
  }));

  return set;
}

export function recordDocumentIds(records: PaymentRecordSet): Set<string> {
  return new Set(records.tables.map((table) => table.documentId));
}

export function recordLocationLabel(record: {
  documentName: string;
  location: EvidenceLocation;
  rowIndex: number;
}): string {
  const { sheet, cellRange } = record.location;
  const where = sheet && cellRange ? `${sheet}!${cellRange}` : cellRange;

  return where
    ? `${record.documentName} ${where}`
    : `${record.documentName} row ${record.rowIndex + 2}`;
}
