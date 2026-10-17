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

// Headers such as "Total Quantity" or "Credit days" hold no money even though they say total or credit.
const NON_MONETARY = /\b(qty|quantity|units?|count|pcs|nos|weight|days|rate|percent(age)?)\b|%/i;
const MONEY_WORD = /\b(amount|amt|value)\b/i;

interface AmountRules {
  /** Among several money columns, the one that clearly holds the amount. */
  preferred: RegExp;
  /** Money columns that never hold this table's amount. */
  excluded?: RegExp;
}

const INVOICE_AMOUNT_RULES: AmountRules = {
  preferred: /\btotal\b|invoice\s*(amount|value)/i,
};

// In a payment table, an invoice or bill amount is what was billed, not what was received.
const PAYMENT_AMOUNT_RULES: AmountRules = {
  preferred: /\b(paid|received|receipt|credited|remitted)\b/i,
  excluded: /\b(invoice|bill|outstanding|balance|due)\b/i,
};

// Checked in order, so "Invoice date" is a date column and "Invoice no" is the number column.
const INVOICE_COLUMN_PATTERNS: ReadonlyArray<[InvoiceColumn, RegExp]> = [
  ["dueDate", /\bdue\b/i],
  ["invoiceDate", /(invoice|bill)\s*date|^date$/i],
  ["poRef", /\bp\.?o\.?\b|purchase\s*order|\border\b/i],
  ["invoiceNumber", /(invoice|bill)\s*(no|num|number|#|ref|id)?\.?$/i],
  ["amount", /total|amount|value|gross/i],
];

// Reference patterns skip money and date headers such as "Transaction Amount" or "Invoice Date".
const PAYMENT_COLUMN_PATTERNS: ReadonlyArray<[PaymentColumn, RegExp]> = [
  ["invoiceRef", /^(?!.*\b(amount|amt|value|date)\b).*(invoice|bill|against)/i],
  ["date", /date/i],
  [
    "reference",
    /^(?!.*\b(amount|amt|value)\b).*(\butr\b|\bref|cheque|chq|transaction|txn|voucher|payment\s*(id|no))/i,
  ],
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
  /** Set when the table is a record table that could not be read safely. */
  recordKind?: PaymentRecordKind;
}

export interface RepeatedPayment {
  payment: PaymentRecord;
  /** The earlier row it repeats. */
  original: PaymentRecord;
  /** True when it is the same receipt and was counted once; false when both rows are counted. */
  countedOnce: boolean;
}

export interface PaymentRecordSet {
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
  tables: RecordTable[];
  /** Rows that look like records but whose amount or key fields could not be read. */
  unreadable: UnreadableRecordRow[];
  /** Later rows that repeat an invoice number already in the register. */
  duplicateInvoices: InvoiceRecord[];
  /** Payment rows that repeat an earlier receipt, counted once, or look alike and need checking. */
  duplicatePayments: RepeatedPayment[];
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

interface ColumnSelection<C extends string> {
  columns: Partial<Record<C, number>>;
  /** Several money columns could hold the amount and none is clearly the one to use. */
  ambiguousAmount?: string[];
}

/** Maps columns by header, choosing the amount column only among monetary headers. */
function selectColumns<C extends string>(
  columnNames: readonly string[],
  patterns: ReadonlyArray<[C, RegExp]>,
  rules: AmountRules,
): ColumnSelection<C> {
  const amountKind = "amount" as C;
  const amountPattern = patterns.find(([kind]) => kind === amountKind)?.[1];
  const columns = columnMap(
    columnNames,
    patterns.filter(([kind]) => kind !== amountKind),
  );
  const taken = new Set(Object.values(columns) as number[]);
  const candidates = columnNames
    .map((name, index) => ({ name, index }))
    .filter(
      ({ name, index }) =>
        !taken.has(index) &&
        amountPattern?.test(name) === true &&
        !NON_MONETARY.test(name) &&
        !(rules.excluded?.test(name) && MONEY_WORD.test(name)),
    );
  const preferred = candidates.filter(({ name }) => rules.preferred.test(name));
  const chosen = candidates.length === 1 ? candidates : preferred;

  if (chosen.length === 1 && chosen[0]) {
    columns[amountKind] = chosen[0].index;

    return { columns };
  }

  return candidates.length > 1
    ? { columns, ambiguousAmount: candidates.map(({ name }) => name) }
    : { columns };
}

export function classifyRecordTable(
  documentName: string,
  tableName: string,
  columnNames: readonly string[],
): PaymentRecordKind | undefined {
  const name = `${documentName} ${tableName}`.toLowerCase();
  const headers = columnNames.join(" ").toLowerCase();
  const invoiceSelection = selectColumns(
    columnNames,
    INVOICE_COLUMN_PATTERNS,
    INVOICE_AMOUNT_RULES,
  );
  const paymentSelection = selectColumns(
    columnNames,
    PAYMENT_COLUMN_PATTERNS,
    PAYMENT_AMOUNT_RULES,
  );
  const invoiceColumns = invoiceSelection.columns;
  const paymentColumns = paymentSelection.columns;
  // An ambiguous amount still marks a record table; the reader reports it instead of guessing.
  const looksLikePayments =
    (paymentColumns.amount !== undefined || paymentSelection.ambiguousAmount !== undefined) &&
    paymentColumns.date !== undefined;
  const looksLikeInvoices =
    invoiceColumns.invoiceNumber !== undefined &&
    (invoiceColumns.amount !== undefined || invoiceSelection.ambiguousAmount !== undefined);

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

// The whole identifier, including trailing letters and single digits, as in "INV-1", "INV-1001/24A".
const INVOICE_NUMBER_IN_TEXT =
  /\b(?:inv|invoice|bill)[\s#:.-]*(?:no\.?\s*)?(?=[A-Z0-9/-]*\d)[A-Z0-9](?:[A-Z0-9/-]*[A-Z0-9])?(?![A-Z0-9/-]*[A-Z0-9])/gi;
const PLACEHOLDER_REF = /^(n\/?a|nil|none|-+|tbd|on\s+account|advance)$/i;
// A whole identifier-like token: letters, digits, "/" and "-", not cut off inside a longer token.
const IDENTIFIER_TOKEN = /(?<![A-Z0-9/-])[A-Z0-9](?:[A-Z0-9/-]*[A-Z0-9])?(?![A-Z0-9/-]*[A-Z0-9])/gi;

function withoutLetterPrefix(key: string): string {
  return key.replace(/^[A-Z]+/, "");
}

const DESCRIPTIVE_LABEL = /^(?:invoice|bill)\b\.?\s*(?:no\.?|number|#)?\s*[:#.-]?\s*/i;

/**
 * The register key a written reference points to: an exact match, after dropping a descriptive
 * label such as "Invoice" or "Bill no."; else a bare number ("1002") matched to the one invoice
 * with that number. Series prefixes such as "OLD-1001" are never dropped.
 */
export function resolveInvoiceKey(ref: string, knownKeys: ReadonlySet<string>): string | undefined {
  for (const candidate of [ref, ref.trim().replace(DESCRIPTIVE_LABEL, "")]) {
    const normalized = normalizeInvoiceNumber(candidate);

    if (knownKeys.has(normalized)) {
      return normalized;
    }

    if (/^\d+$/.test(normalized)) {
      const matches = [...knownKeys].filter((key) => withoutLetterPrefix(key) === normalized);

      return matches.length === 1 ? matches[0] : undefined;
    }
  }

  return undefined;
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

  // Register numbers written without a label, as in "Paid against B-1001"; a token must match a
  // register key exactly, so "B-1001/24A" or "OLD-1001" never stands in for B-1001.
  for (const match of text.matchAll(IDENTIFIER_TOKEN)) {
    const token = match[0];

    if (/\d/.test(token) && knownKeys.has(normalizeInvoiceNumber(token))) {
      refs.push(token);
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

function ambiguousAmountReason(names: readonly string[]): string {
  return `several columns could hold the amount (${names.join(", ")}) and none is clearly the one to use`;
}

function readInvoices(
  metadata: DocumentMetadata,
  table: ExtractedTable,
  set: PaymentRecordSet,
  seen: Map<string, InvoiceRecord>,
): number {
  const columnNames = table.columns.map((column) => column.name);
  const { columns, ambiguousAmount } = selectColumns(
    columnNames,
    INVOICE_COLUMN_PATTERNS,
    INVOICE_AMOUNT_RULES,
  );
  const amountColumn = columns.amount;
  let count = 0;

  if (ambiguousAmount) {
    set.unclassified.push({
      documentId: metadata.id,
      documentName: metadata.name,
      tableName: table.name,
      reason: ambiguousAmountReason(ambiguousAmount),
      recordKind: "invoices",
    });

    return 0;
  }

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

    // Credit notes are not modelled, so a negative amount would corrupt the totals.
    if (!invoiceNumber || amount === undefined || amount < 0) {
      set.unreadable.push({
        kind: "invoices",
        documentId: metadata.id,
        documentName: metadata.name,
        rowIndex,
        location,
        quote,
        reason: !invoiceNumber
          ? "the invoice number is blank"
          : amount === undefined
            ? `the amount of ${invoiceNumber} is blank or unreadable`
            : `the amount of ${invoiceNumber} is negative; credit notes are not handled, so it was left out`,
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
  const { columns, ambiguousAmount } = selectColumns(
    table.columns.map((column) => column.name),
    PAYMENT_COLUMN_PATTERNS,
    PAYMENT_AMOUNT_RULES,
  );

  if (ambiguousAmount) {
    set.unclassified.push({
      documentId: metadata.id,
      documentName: metadata.name,
      tableName: table.name,
      reason: ambiguousAmountReason(ambiguousAmount),
      recordKind: "payments",
    });

    return 0;
  }

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
        label:
          reference ??
          `${metadata.name}${table.sheet ? ` ${table.sheet}` : ""} row ${location.rowRange?.start ?? rowIndex + 2}`,
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

function sameSource(left: PaymentRecord, right: PaymentRecord): boolean {
  return left.documentId === right.documentId && left.tableName === right.tableName;
}

/**
 * Separates receipts recorded twice, for example in a bank export and a receipts ledger. Rows with
 * the same reference, date, amount, and invoices are one receipt; so are rows without a reference
 * that match on date, amount, and invoices across different sources. Split allocations (same
 * reference, different invoices) stay separate. Other look-alikes are kept and reported.
 */
export function separateRepeatedPayments(
  payments: readonly PaymentRecord[],
  knownKeys: ReadonlySet<string>,
): { kept: PaymentRecord[]; duplicates: RepeatedPayment[] } {
  const kept: PaymentRecord[] = [];
  const duplicates: RepeatedPayment[] = [];
  const invoicesOf = (payment: PaymentRecord) =>
    payment.invoiceRefs
      .map((ref) => resolveInvoiceKey(ref, knownKeys) ?? normalizeInvoiceNumber(ref))
      .sort()
      .join("+");
  const referenceOf = (payment: PaymentRecord) =>
    payment.reference ? normalizeInvoiceNumber(payment.reference) : "";

  for (const payment of payments) {
    const sameReceipt = kept.find(
      (other) =>
        other.date === payment.date &&
        other.amount === payment.amount &&
        invoicesOf(other) === invoicesOf(payment) &&
        referenceOf(other) === referenceOf(payment),
    );
    const confirmed =
      sameReceipt !== undefined &&
      (referenceOf(payment) !== "" ||
        (invoicesOf(payment) !== "" && !sameSource(sameReceipt, payment)));

    if (sameReceipt && confirmed) {
      duplicates.push({ payment, original: sameReceipt, countedOnce: true });
      continue;
    }

    if (sameReceipt) {
      duplicates.push({ payment, original: sameReceipt, countedOnce: false });
    }

    kept.push(payment);
  }

  return { kept, duplicates };
}

/** Finds invoice registers and payment records in the extractions and reads their rows. Pure. */
export function readPaymentRecords(documents: readonly PaymentCaseDocument[]): PaymentRecordSet {
  const set: PaymentRecordSet = {
    invoices: [],
    payments: [],
    tables: [],
    unreadable: [],
    duplicateInvoices: [],
    duplicatePayments: [],
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

  const { kept, duplicates } = separateRepeatedPayments(set.payments, knownKeys);

  set.payments = kept;
  set.duplicatePayments = duplicates;
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

export function recordTableKey(documentId: string, tableName: string): string {
  return `${documentId}|${tableName}`;
}

/** The invoice and payment tables, by document and table, so other tables in a workbook are kept. */
export function recordTableKeys(records: PaymentRecordSet): Set<string> {
  return new Set(records.tables.map((table) => recordTableKey(table.documentId, table.table.name)));
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
