import { MSMED_MAX_CREDIT_DAYS } from "./constants.js";
import { addDays, daysBetween, todayIsoDate } from "./dates.js";
import {
  resolveInvoiceKey,
  type InvoiceRecord,
  type PaymentRecord,
  type PaymentRecordSet,
} from "./records.js";
import type { CreditTerms, CreditTermsResolution } from "./terms.js";

export const DEFAULT_PAYMENT_TOLERANCE = 0.5;

export type AllocationMethod = "reference" | "amount-match" | "date-order";

export interface PaymentAllocation {
  payment: PaymentRecord;
  amount: number;
  method: AllocationMethod;
}

export type InvoiceStatus = "paid" | "partly-paid" | "unpaid";

export interface InvoiceLine {
  invoice: InvoiceRecord;
  amount: number;
  allocations: PaymentAllocation[];
  paid: number;
  outstanding: number;
  status: InvoiceStatus;
  dueDate?: string;
  dueDateBasis?: "agreed-terms" | "register";
  /** The register states a due date that differs from the one implied by the agreed terms. */
  registerDueDate?: string;
  /** Days past the due date at the as-of date; only for invoices with a balance. */
  daysOverdue?: number;
  /** Invoice date plus 45 days, stated only when the agreed period is longer (a flagged assumption). */
  statutoryReferenceDate?: string;
  daysBeyondStatutoryReference?: number;
  /** Date of the payment that cleared the invoice. */
  settledOn?: string;
  daysPaidLate?: number;
  /** True when any payment was matched by amount or date rather than by reference. */
  inferred: boolean;
}

export interface UnallocatedPayment {
  payment: PaymentRecord;
  amount: number;
  reason: string;
}

export interface ReconciliationIssue {
  message: string;
  invoiceKeys: string[];
  payments: PaymentRecord[];
}

export interface PaymentTotals {
  invoiced: number;
  received: number;
  outstanding: number;
  overdue: number;
  unallocated: number;
}

export interface PaymentReconciliation {
  asOfDate: string;
  tolerance: number;
  terms?: CreditTerms;
  termsConflicts: CreditTermsResolution["conflicts"];
  lines: InvoiceLine[];
  /** Invoices dated after the as-of date, left out of the totals. */
  laterInvoices: InvoiceRecord[];
  unallocated: UnallocatedPayment[];
  issues: ReconciliationIssue[];
  totals: PaymentTotals;
  records: PaymentRecordSet;
}

export interface PaymentReconcileOptions {
  /** Date the outstanding and overdue days are stated at; today when omitted. */
  asOfDate?: string;
  tolerance?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function byDateThenRow<T extends { rowIndex: number; documentId: string }>(
  dateOf: (item: T) => string | undefined,
) {
  return (left: T, right: T) =>
    (dateOf(left) ?? "9999").localeCompare(dateOf(right) ?? "9999") ||
    left.documentId.localeCompare(right.documentId) ||
    left.rowIndex - right.rowIndex;
}

interface WorkingLine {
  invoice: InvoiceRecord;
  amount: number;
  remaining: number;
  allocations: PaymentAllocation[];
}

function allocate(
  line: WorkingLine,
  payment: PaymentRecord,
  amount: number,
  method: AllocationMethod,
) {
  const applied = round2(Math.min(amount, line.remaining));

  if (applied > 0) {
    line.allocations.push({ payment, amount: applied, method });
    line.remaining = round2(line.remaining - applied);
  }

  return applied;
}

function describeRefs(refs: readonly string[]): string {
  return refs.join(", ");
}

/**
 * Matches payments to invoices by written reference first, then by an exact open balance, then
 * by the oldest open invoice among equal balances. Payments that cannot be matched are reported
 * and never deducted, so the outstanding amount rests only on confirmed information.
 */
export function reconcilePayments(
  records: PaymentRecordSet,
  resolution: CreditTermsResolution = { conflicts: [] },
  options: PaymentReconcileOptions = {},
): PaymentReconciliation {
  const asOfDate = options.asOfDate ?? todayIsoDate();
  const tolerance = options.tolerance ?? DEFAULT_PAYMENT_TOLERANCE;
  const laterInvoices = records.invoices.filter(
    (invoice) => invoice.invoiceDate !== undefined && invoice.invoiceDate > asOfDate,
  );
  const lines: WorkingLine[] = records.invoices
    .filter((invoice) => invoice.amount !== undefined && !laterInvoices.includes(invoice))
    .sort(byDateThenRow((invoice) => invoice.invoiceDate))
    .map((invoice) => ({
      invoice,
      amount: invoice.amount ?? 0,
      remaining: invoice.amount ?? 0,
      allocations: [],
    }));
  const byKey = new Map(lines.map((line) => [line.invoice.key, line]));
  const registerKeys = new Set(records.invoices.map((invoice) => invoice.key));
  const unallocated: UnallocatedPayment[] = [];
  const issues: ReconciliationIssue[] = [];
  const unreferenced: PaymentRecord[] = [];
  const payments = [...records.payments].sort(byDateThenRow((payment) => payment.date));

  for (const payment of payments) {
    const amount = payment.amount ?? 0;

    if (payment.date && payment.date > asOfDate) {
      unallocated.push({ payment, amount, reason: `it is dated after the as-of date ${asOfDate}` });
      continue;
    }

    if (payment.invoiceRefs.length === 0) {
      unreferenced.push(payment);
      continue;
    }

    const resolved = payment.invoiceRefs.map((ref) => ({
      ref,
      line: byKey.get(resolveInvoiceKey(ref, registerKeys) ?? ""),
    }));
    const unknownRefs = resolved.filter((entry) => !entry.line).map((entry) => entry.ref);

    // A payment that names any untraceable invoice cannot be split with confidence, so none of it is applied.
    if (unknownRefs.length > 0) {
      const known = resolved.flatMap((entry) => (entry.line ? [entry.ref] : []));
      const later = unknownRefs.filter((ref) => resolveInvoiceKey(ref, registerKeys));
      const missing = unknownRefs.filter((ref) => !later.includes(ref));
      const why = [
        missing.length > 0
          ? `${describeRefs(missing)} ${missing.length === 1 ? "is" : "are"} not in the invoice register`
          : undefined,
        later.length > 0
          ? `${describeRefs(later)} ${later.length === 1 ? "is" : "are"} dated after the as-of date ${asOfDate}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" and ");

      unallocated.push({
        payment,
        amount,
        reason:
          known.length > 0
            ? `it references ${describeRefs([...known, ...unknownRefs])}, and ${why}, so the split cannot be confirmed`
            : `it references ${describeRefs(unknownRefs)}, and ${why}`,
      });
      continue;
    }

    const known = resolved.flatMap((entry) => (entry.line ? [entry.line] : []));
    let left = amount;

    for (const line of [...new Set(known)]) {
      if (payment.date && line.invoice.invoiceDate && payment.date < line.invoice.invoiceDate) {
        issues.push({
          message: `Payment ${payment.label} dated ${payment.date} references ${line.invoice.invoiceNumber}, which is dated later (${line.invoice.invoiceDate}).`,
          invoiceKeys: [line.invoice.key],
          payments: [payment],
        });
      }

      left = round2(left - allocate(line, payment, left, "reference"));
    }

    if (left > tolerance) {
      unallocated.push({
        payment,
        amount: left,
        reason: `it exceeds the open balance of ${describeRefs(known.map((line) => line.invoice.invoiceNumber))} by this amount`,
      });
    }
  }

  for (const payment of unreferenced) {
    const amount = payment.amount ?? 0;
    const open = lines.filter(
      (line) =>
        line.remaining > tolerance &&
        (!line.invoice.invoiceDate || !payment.date || line.invoice.invoiceDate <= payment.date),
    );
    const exact = open.filter((line) => Math.abs(line.remaining - amount) <= tolerance);
    const [match] = exact;

    if (match) {
      allocate(match, payment, amount, exact.length === 1 ? "amount-match" : "date-order");
      continue;
    }

    unallocated.push({
      payment,
      amount,
      reason: "it has no invoice reference and does not equal the open balance of any invoice",
    });
  }

  const { terms } = resolution;
  const result: InvoiceLine[] = lines.map((line) => {
    const { invoice } = line;
    const paid = round2(line.allocations.reduce((sum, item) => sum + item.amount, 0));
    const outstanding = round2(line.amount - paid);
    const open = outstanding > tolerance;
    const computedDue =
      terms && invoice.invoiceDate ? addDays(invoice.invoiceDate, terms.creditDays) : undefined;
    const dueDate = computedDue ?? invoice.dueDate;
    const statutoryReferenceDate =
      terms && terms.creditDays > MSMED_MAX_CREDIT_DAYS && invoice.invoiceDate
        ? addDays(invoice.invoiceDate, MSMED_MAX_CREDIT_DAYS)
        : undefined;
    const settledOn =
      !open && line.allocations.length > 0
        ? line.allocations
            .map((item) => item.payment.date ?? "")
            .sort()
            .at(-1)
        : undefined;

    return {
      invoice,
      amount: line.amount,
      allocations: line.allocations,
      paid,
      outstanding: open ? outstanding : 0,
      status: !open ? "paid" : paid > 0 ? "partly-paid" : "unpaid",
      ...(dueDate ? { dueDate, dueDateBasis: computedDue ? "agreed-terms" : "register" } : {}),
      ...(computedDue && invoice.dueDate && invoice.dueDate !== computedDue
        ? { registerDueDate: invoice.dueDate }
        : {}),
      ...(open && dueDate ? { daysOverdue: Math.max(0, daysBetween(dueDate, asOfDate)) } : {}),
      ...(statutoryReferenceDate ? { statutoryReferenceDate } : {}),
      ...(open && statutoryReferenceDate
        ? {
            daysBeyondStatutoryReference: Math.max(
              0,
              daysBetween(statutoryReferenceDate, asOfDate),
            ),
          }
        : {}),
      ...(settledOn ? { settledOn } : {}),
      ...(settledOn && dueDate
        ? { daysPaidLate: Math.max(0, daysBetween(dueDate, settledOn)) }
        : {}),
      inferred: line.allocations.some((item) => item.method !== "reference"),
    };
  });
  const sum = (values: number[]) => round2(values.reduce((total, value) => total + value, 0));

  return {
    asOfDate,
    tolerance,
    ...(terms ? { terms } : {}),
    termsConflicts: resolution.conflicts,
    lines: result,
    laterInvoices,
    unallocated,
    issues,
    totals: {
      invoiced: sum(result.map((line) => line.amount)),
      received: sum(result.map((line) => line.paid)),
      outstanding: sum(result.map((line) => line.outstanding)),
      overdue: sum(
        result.filter((line) => (line.daysOverdue ?? 0) > 0).map((line) => line.outstanding),
      ),
      unallocated: sum(unallocated.map((item) => item.amount)),
    },
    records,
  };
}

export function hasPaymentData(reconciliation: PaymentReconciliation): boolean {
  return reconciliation.lines.length > 0;
}

export function openLines(reconciliation: PaymentReconciliation): InvoiceLine[] {
  return reconciliation.lines.filter((line) => line.outstanding > 0);
}

/** The components that make up an invoice's outstanding balance: its amount less each payment. */
export function outstandingComponents(line: InvoiceLine) {
  const components = [
    { label: `${line.invoice.invoiceNumber} invoice amount`, value: line.amount },
    ...line.allocations.map((allocation) => ({
      label: `${allocation.payment.label} on ${allocation.payment.date ?? "unknown date"}`,
      value: -allocation.amount,
    })),
  ];
  const residual = round2(line.outstanding - (line.amount - line.paid));

  return residual === 0
    ? components
    : [...components, { label: "Difference within the matching tolerance", value: residual }];
}
