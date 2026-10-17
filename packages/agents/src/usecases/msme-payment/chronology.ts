import type { ConfidenceLevel, Evidence, Finding } from "@evianta/core";

import type { EvidenceReference } from "../../findings.js";
import { truncate } from "../../text.js";
import { formatInrAmount } from "./constants.js";
import {
  normalizeInvoiceNumber,
  recordLocationLabel,
  resolveInvoiceKey,
  type InvoiceRecord,
} from "./records.js";
import type { InvoiceLine, PaymentReconciliation } from "./reconcile.js";

export const DOCUMENT_EVENT_KINDS = [
  "agreement",
  "purchase-order",
  "delivery",
  "invoice-copy",
  "correspondence",
  "other",
] as const;

export type DocumentEventKind = (typeof DOCUMENT_EVENT_KINDS)[number];

const EVENT_PREFIX = "event";
const NO_INVOICE = "-";

function slug(value: string): string {
  return value.trim().replace(/[:\s]+/g, "-") || NO_INVOICE;
}

/**
 * Date key for an event the document analysis read from a document, for example
 * "event:delivery:INV1001:DC-501". Later tasks rebuild the chronology from these keys.
 */
export function documentEventDateKey(
  kind: DocumentEventKind,
  invoiceRefs: readonly string[],
  ref: string,
): string {
  const invoices = invoiceRefs.map(normalizeInvoiceNumber).filter(Boolean);

  return [
    EVENT_PREFIX,
    kind,
    invoices.length > 0 ? invoices.join("+") : NO_INVOICE,
    slug(ref),
  ].join(":");
}

export interface DocumentEventFact {
  kind: DocumentEventKind;
  key: string;
  date: string;
  label: string;
  invoiceKeys: string[];
  findingId: string;
  evidence: Evidence[];
  confidence?: ConfidenceLevel;
}

export interface StatedInvoiceAmount {
  invoiceKey: string;
  amount: number;
  label: string;
  findingId: string;
  evidence: Evidence[];
  confidence?: ConfidenceLevel;
}

export interface DocumentFacts {
  events: DocumentEventFact[];
  statedAmounts: StatedInvoiceAmount[];
}

export function parseDocumentEventKey(
  key: string,
): { kind: DocumentEventKind; invoiceKeys: string[] } | undefined {
  const [prefix, kind, invoices] = key.split(":");

  if (prefix !== EVENT_PREFIX || !DOCUMENT_EVENT_KINDS.includes(kind as DocumentEventKind)) {
    return undefined;
  }

  return {
    kind: kind as DocumentEventKind,
    invoiceKeys: !invoices || invoices === NO_INVOICE ? [] : invoices.split("+"),
  };
}

const STATED_AMOUNT_PREFIX = "stated-invoice-amount:";

/** Maps invoice keys read from documents ("1002") onto register keys ("INV1002") where unambiguous. */
function alignToRegister(
  reconciliation: PaymentReconciliation,
  facts: DocumentFacts,
): DocumentFacts {
  const registerKeys = new Set(reconciliation.records.invoices.map((invoice) => invoice.key));
  const align = (key: string) => resolveInvoiceKey(key, registerKeys) ?? key;

  return {
    events: facts.events.map((event) => ({ ...event, invoiceKeys: event.invoiceKeys.map(align) })),
    statedAmounts: facts.statedAmounts.map((stated) => ({
      ...stated,
      invoiceKey: align(stated.invoiceKey),
    })),
  };
}

/** Events and stated invoice amounts recorded by the document analysis findings. */
export function documentFactsFromFindings(findings: readonly Finding[]): DocumentFacts {
  const events: DocumentEventFact[] = [];
  const statedAmounts: StatedInvoiceAmount[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    for (const entry of finding.dates ?? []) {
      const parsed = parseDocumentEventKey(entry.key);

      if (!parsed || seen.has(`${entry.key}|${entry.date}`)) {
        continue;
      }

      seen.add(`${entry.key}|${entry.date}`);
      events.push({
        ...parsed,
        key: entry.key,
        date: entry.date.slice(0, 10),
        label: entry.label,
        findingId: finding.id,
        evidence: finding.evidence,
        ...(finding.confidence ? { confidence: finding.confidence } : {}),
      });
    }

    for (const figure of finding.figures ?? []) {
      if (!figure.key.startsWith(STATED_AMOUNT_PREFIX) || seen.has(figure.key)) {
        continue;
      }

      seen.add(figure.key);

      const invoiceKey = figure.key.slice(STATED_AMOUNT_PREFIX.length).split(":")[0] ?? "";

      statedAmounts.push({
        invoiceKey,
        amount: figure.value,
        label: figure.label,
        findingId: finding.id,
        evidence: finding.evidence,
        ...(finding.confidence ? { confidence: finding.confidence } : {}),
      });
    }
  }

  return { events, statedAmounts };
}

export type ChronologyEventKind = DocumentEventKind | "invoice" | "due-date" | "payment";

export interface ChronologyEvent {
  date: string;
  kind: ChronologyEventKind;
  title: string;
  /** Where the event is recorded, for example "invoices.csv D3" or "delivery-notes.pdf p.1". */
  source: string;
  /** The document the event is recorded in. */
  documentId?: string;
  invoiceNumbers: string[];
  dateKey: string;
  evidence: EvidenceReference[];
  confidence?: ConfidenceLevel;
}

const KIND_ORDER: Readonly<Record<ChronologyEventKind, number>> = {
  agreement: 0,
  "purchase-order": 1,
  delivery: 2,
  invoice: 3,
  "invoice-copy": 4,
  "due-date": 5,
  payment: 6,
  correspondence: 7,
  other: 8,
};

export function recordRowEvidence(
  record: Pick<InvoiceRecord, "documentId" | "location" | "quote">,
  description: string,
): EvidenceReference {
  const { location } = record;

  return {
    documentId: record.documentId,
    description,
    ...(location.sheet ? { sheet: location.sheet } : {}),
    ...(location.cellRange ? { cellRange: location.cellRange } : {}),
    ...(location.rowRange
      ? { rowStart: location.rowRange.start, rowEnd: location.rowRange.end }
      : {}),
    textQuote: truncate(record.quote, 240),
  };
}

export function invoiceRowEvidence(invoice: InvoiceRecord, description: string): EvidenceReference {
  return recordRowEvidence(invoice, description);
}

function upstreamEvidence(evidence: readonly Evidence[], description: string): EvidenceReference[] {
  return evidence.slice(0, 2).map((item) => ({ evidenceId: item.id, description }));
}

function allocationText(line: InvoiceLine | undefined, method: string | undefined): string {
  if (!line) {
    return " (not matched to an invoice)";
  }

  return method === "reference"
    ? ` against ${line.invoice.invoiceNumber}`
    : ` matched to ${line.invoice.invoiceNumber} by amount (inferred)`;
}

function dueDateEvents(reconciliation: PaymentReconciliation): ChronologyEvent[] {
  const { terms } = reconciliation;

  return reconciliation.lines.flatMap((line): ChronologyEvent[] => {
    const lateOrOpen =
      line.outstanding > 0 ||
      (line.settledOn !== undefined && line.dueDate !== undefined && line.settledOn > line.dueDate);

    if (!line.dueDate || !lateOrOpen) {
      return [];
    }

    const basis =
      line.dueDateBasis === "agreed-terms" && terms
        ? `under the agreed ${terms.creditDays}-day credit period`
        : "per the invoice register";

    return [
      {
        date: line.dueDate,
        kind: "due-date",
        title: `${line.invoice.invoiceNumber} payment due ${basis}`,
        source:
          line.dueDateBasis === "agreed-terms" && terms?.sources[0]
            ? `${terms.sources[0].documentName} p.${terms.sources[0].page}`
            : recordLocationLabel(line.invoice),
        documentId:
          line.dueDateBasis === "agreed-terms" && terms?.sources[0]
            ? terms.sources[0].documentId
            : line.invoice.documentId,
        invoiceNumbers: [line.invoice.invoiceNumber],
        dateKey: `due-date:${line.invoice.key}`,
        evidence: [
          invoiceRowEvidence(line.invoice, `${line.invoice.invoiceNumber} invoice row`),
          ...(line.dueDateBasis === "agreed-terms" ? (terms?.evidence.slice(0, 1) ?? []) : []),
        ],
      },
    ];
  });
}

/**
 * Orders invoices, payments, due dates, and the events the document analysis read from POs,
 * agreements, delivery records, and correspondence. Every event carries the evidence for it.
 */
export function buildChronology(
  reconciliation: PaymentReconciliation,
  documentFacts: DocumentFacts,
): ChronologyEvent[] {
  const facts = alignToRegister(reconciliation, documentFacts);
  const events: ChronologyEvent[] = [];
  const lineByKey = new Map(reconciliation.lines.map((line) => [line.invoice.key, line]));

  for (const line of reconciliation.lines) {
    const { invoice } = line;

    if (!invoice.invoiceDate) {
      continue;
    }

    events.push({
      date: invoice.invoiceDate,
      kind: "invoice",
      title: `Invoice ${invoice.invoiceNumber} raised for ${formatInrAmount(line.amount)}${invoice.poRef ? ` against ${invoice.poRef}` : ""}`,
      source: recordLocationLabel(invoice),
      documentId: invoice.documentId,
      invoiceNumbers: [invoice.invoiceNumber],
      dateKey: `invoice-date:${invoice.key}`,
      evidence: [invoiceRowEvidence(invoice, `${invoice.invoiceNumber} invoice row`)],
    });
  }

  events.push(...dueDateEvents(reconciliation));

  for (const payment of reconciliation.records.payments) {
    if (!payment.date) {
      continue;
    }

    const allocations = reconciliation.lines.flatMap((line) =>
      line.allocations
        .filter((allocation) => allocation.payment === payment)
        .map((allocation) => ({ line, allocation })),
    );
    const targets =
      allocations.length > 0
        ? allocations
            .map(({ line, allocation }) => allocationText(line, allocation.method).trim())
            .join("; ")
        : allocationText(undefined, undefined).trim();

    events.push({
      date: payment.date,
      kind: "payment",
      title: `Payment ${payment.label} of ${formatInrAmount(payment.amount ?? 0)} received ${targets}`,
      source: recordLocationLabel(payment),
      documentId: payment.documentId,
      invoiceNumbers: allocations.map(({ line }) => line.invoice.invoiceNumber),
      dateKey: `payment-date:${slug(payment.label)}`,
      evidence: [recordRowEvidence(payment, `Payment ${payment.label} row`)],
    });
  }

  for (const fact of facts.events) {
    const invoiceNumbers = fact.invoiceKeys.map(
      (key) => lineByKey.get(key)?.invoice.invoiceNumber ?? key,
    );

    events.push({
      date: fact.date,
      kind: fact.kind,
      title: fact.label,
      source: fact.evidence[0]?.sourceRef ?? "document analysis",
      ...(fact.evidence[0]?.documentId ? { documentId: fact.evidence[0].documentId } : {}),
      invoiceNumbers,
      dateKey: fact.key,
      evidence: upstreamEvidence(fact.evidence, fact.label),
      ...(fact.confidence ? { confidence: fact.confidence } : {}),
    });
  }

  return events.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      left.title.localeCompare(right.title),
  );
}

export function chronologyTimelineText(events: readonly ChronologyEvent[]): string {
  if (events.length === 0) {
    return "No dated events were found in the documents.";
  }

  return events
    .map((event) => {
      const flag = event.confidence === "low" ? " (low-confidence transcription, verify)" : "";

      return `${event.date}  ${event.title}${flag} [${event.source}]`;
    })
    .join("\n");
}

export type GapSeverity = "high" | "medium" | "low";

export interface EvidenceGap {
  kind: "missing-document" | "inconsistency";
  severity: GapSeverity;
  summary: string;
  question: string;
  invoiceNumbers: string[];
  evidence: EvidenceReference[];
}

function hasDeliveryFor(facts: DocumentFacts, invoiceKey: string): boolean {
  return facts.events.some(
    (event) => event.kind === "delivery" && event.invoiceKeys.includes(invoiceKey),
  );
}

/** Documents a reviewer would expect but that are not in the case. */
export function findMissingDocuments(
  reconciliation: PaymentReconciliation,
  documentFacts: DocumentFacts,
): EvidenceGap[] {
  const facts = alignToRegister(reconciliation, documentFacts);
  const gaps: EvidenceGap[] = [];
  // Membership uses the whole register; invoices after the as-of date are registered, just not totalled.
  const registerKeys = new Set(reconciliation.records.invoices.map((invoice) => invoice.key));

  for (const line of reconciliation.lines) {
    if (hasDeliveryFor(facts, line.invoice.key)) {
      continue;
    }

    const open = line.outstanding > 0;

    gaps.push({
      kind: "missing-document",
      severity: open ? "high" : "low",
      summary: `[${line.invoice.invoiceNumber}] No delivery record or proof of acceptance was found${open ? ` for an invoice with ${formatInrAmount(line.outstanding)} outstanding` : ""}`,
      question: `Upload the delivery challan, goods receipt, or other proof of acceptance for ${line.invoice.invoiceNumber}, or confirm that none exists.`,
      invoiceNumbers: [line.invoice.invoiceNumber],
      evidence: [invoiceRowEvidence(line.invoice, `${line.invoice.invoiceNumber} invoice row`)],
    });
  }

  const hasTermsDocument = facts.events.some(
    (event) => event.kind === "agreement" || event.kind === "purchase-order",
  );

  if (!reconciliation.terms && !hasTermsDocument && reconciliation.lines.length > 0) {
    gaps.push({
      kind: "missing-document",
      severity: "high",
      summary: "No purchase order or agreement stating the payment terms was found",
      question:
        "Upload the purchase order or agreement that sets the credit period, so due dates and days overdue can be confirmed.",
      invoiceNumbers: [],
      evidence: reconciliation.records.tables
        .filter((table) => table.kind === "invoices")
        .map((table) => ({
          documentId: table.documentId,
          description: "Invoice register without agreed payment terms",
          ...(table.location.cellRange ? { cellRange: table.location.cellRange } : {}),
        })),
    });
  }

  const unregistered = new Map<string, StatedInvoiceAmount | DocumentEventFact>();

  for (const item of [...facts.statedAmounts, ...facts.events]) {
    const keys = "invoiceKey" in item ? [item.invoiceKey] : item.invoiceKeys;

    for (const key of keys) {
      if (key && !registerKeys.has(key) && !unregistered.has(key)) {
        unregistered.set(key, item);
      }
    }
  }

  for (const [key, item] of unregistered) {
    if (reconciliation.lines.length === 0) {
      break;
    }

    gaps.push({
      kind: "missing-document",
      severity: "medium",
      summary: `[${key}] Invoice mentioned in ${item.evidence[0]?.sourceRef ?? "the documents"} is not in the invoice register`,
      question: `Confirm whether ${key} belongs to this claim and, if so, add it to the invoice register.`,
      invoiceNumbers: [key],
      evidence: upstreamEvidence(item.evidence, `Mention of ${key}`),
    });
  }

  return gaps;
}

/** Amount and date mismatches between the documents, plus record issues found while reconciling. */
export function findInconsistencies(
  reconciliation: PaymentReconciliation,
  documentFacts: DocumentFacts,
): EvidenceGap[] {
  const facts = alignToRegister(reconciliation, documentFacts);
  const gaps: EvidenceGap[] = [];
  const lineByKey = new Map(reconciliation.lines.map((line) => [line.invoice.key, line]));

  for (const stated of facts.statedAmounts) {
    const line = lineByKey.get(stated.invoiceKey);

    if (!line || Math.abs(line.amount - stated.amount) <= reconciliation.tolerance) {
      continue;
    }

    const where = stated.evidence[0]?.sourceRef ?? "another document";
    const lowConfidence = stated.confidence === "low" ? " (low-confidence transcription)" : "";

    gaps.push({
      kind: "inconsistency",
      severity: "high",
      summary: `[${line.invoice.invoiceNumber}] Amount mismatch: ${formatInrAmount(line.amount)} in ${recordLocationLabel(line.invoice)} but ${formatInrAmount(stated.amount)} in ${where}${lowConfidence}`,
      question: `Confirm the correct amount of ${line.invoice.invoiceNumber}: the register shows ${formatInrAmount(line.amount)} and ${where} shows ${formatInrAmount(stated.amount)}. The outstanding amount uses the register figure.`,
      invoiceNumbers: [line.invoice.invoiceNumber],
      evidence: [
        invoiceRowEvidence(line.invoice, `${line.invoice.invoiceNumber} amount in the register`),
        ...upstreamEvidence(stated.evidence, stated.label),
      ],
    });
  }

  for (const event of facts.events.filter((item) => item.kind === "invoice-copy")) {
    for (const key of event.invoiceKeys) {
      const line = lineByKey.get(key);

      if (!line?.invoice.invoiceDate || line.invoice.invoiceDate === event.date) {
        continue;
      }

      const where = event.evidence[0]?.sourceRef ?? "another document";

      gaps.push({
        kind: "inconsistency",
        severity: "medium",
        summary: `[${line.invoice.invoiceNumber}] Date mismatch: ${line.invoice.invoiceDate} in the register but ${event.date} in ${where}`,
        question: `Confirm the invoice date of ${line.invoice.invoiceNumber}; it drives the due date and days overdue.`,
        invoiceNumbers: [line.invoice.invoiceNumber],
        evidence: [
          invoiceRowEvidence(line.invoice, `${line.invoice.invoiceNumber} date in the register`),
          ...upstreamEvidence(event.evidence, event.label),
        ],
      });
    }
  }

  for (const line of reconciliation.lines) {
    if (!line.registerDueDate || !line.dueDate) {
      continue;
    }

    gaps.push({
      kind: "inconsistency",
      severity: "medium",
      summary: `[${line.invoice.invoiceNumber}] Due date mismatch: the register shows ${line.registerDueDate} but the agreed terms give ${line.dueDate}`,
      question: `Confirm the due date of ${line.invoice.invoiceNumber}; days overdue are counted from ${line.dueDate}.`,
      invoiceNumbers: [line.invoice.invoiceNumber],
      evidence: [
        invoiceRowEvidence(line.invoice, `${line.invoice.invoiceNumber} due date in the register`),
        ...(reconciliation.terms?.evidence.slice(0, 1) ?? []),
      ],
    });
  }

  for (const issue of reconciliation.issues) {
    gaps.push({
      kind: "inconsistency",
      severity: "medium",
      summary: issue.message,
      question: `${issue.message} Confirm the payment reference.`,
      invoiceNumbers: issue.invoiceKeys.map(
        (key) => lineByKey.get(key)?.invoice.invoiceNumber ?? key,
      ),
      evidence: issue.payments.map((payment) =>
        recordRowEvidence(payment, `Payment ${payment.label} row`),
      ),
    });
  }

  for (const duplicate of reconciliation.records.duplicateInvoices) {
    gaps.push({
      kind: "inconsistency",
      severity: "high",
      summary: `[${duplicate.invoiceNumber}] The invoice number appears more than once in the register; only the first row was used`,
      question: `Confirm whether ${recordLocationLabel(duplicate)} is a duplicate of ${duplicate.invoiceNumber} or a separate invoice.`,
      invoiceNumbers: [duplicate.invoiceNumber],
      evidence: [invoiceRowEvidence(duplicate, `Repeated ${duplicate.invoiceNumber} row`)],
    });
  }

  for (const repeat of reconciliation.records.duplicatePayments) {
    const where = `${recordLocationLabel(repeat.payment)} and ${recordLocationLabel(repeat.original)}`;

    gaps.push({
      kind: "inconsistency",
      severity: repeat.countedOnce ? "medium" : "high",
      summary: repeat.countedOnce
        ? `Payment ${repeat.payment.label} is recorded twice (${where}); it was counted once`
        : `Payments in ${where} have the same date and amount; both were deducted`,
      question: repeat.countedOnce
        ? `Confirm that ${where} are the same receipt of ${formatInrAmount(repeat.payment.amount ?? 0)}.`
        : `Confirm whether ${where} are two receipts or one recorded twice; if one, the outstanding amount is understated by ${formatInrAmount(repeat.payment.amount ?? 0)}.`,
      invoiceNumbers: [],
      evidence: [
        recordRowEvidence(repeat.original, `Payment ${repeat.original.label} row`),
        recordRowEvidence(repeat.payment, `Repeated payment ${repeat.payment.label} row`),
      ],
    });
  }

  if (reconciliation.termsConflicts.length > 0) {
    gaps.push({
      kind: "inconsistency",
      severity: "high",
      summary: `Conflicting credit periods: ${reconciliation.termsConflicts.map((conflict) => `${conflict.creditDays} days (${conflict.where})`).join(" vs ")}`,
      question:
        "Confirm the agreed credit period. Due dates were taken from the invoice register instead.",
      invoiceNumbers: [],
      evidence: reconciliation.termsConflicts.flatMap((conflict) => conflict.evidence),
    });
  }

  return gaps;
}
