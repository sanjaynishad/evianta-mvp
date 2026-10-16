import { formatInr, formatInrAmount, markdownTableOf, MSMED_MAX_CREDIT_DAYS } from "./constants.js";
import { recordLocationLabel } from "./records.js";
import type { InvoiceLine, PaymentReconciliation } from "./reconcile.js";

const STATUS_LABELS: Readonly<Record<InvoiceLine["status"], string>> = {
  paid: "Paid",
  "partly-paid": "Part paid",
  unpaid: "Unpaid",
};

function paymentsCell(line: InvoiceLine): string {
  if (line.allocations.length === 0) {
    return "-";
  }

  return line.allocations
    .map((allocation) => {
      const how = allocation.method === "reference" ? "" : ", matched by amount (inferred)";

      return `${allocation.payment.label} ${allocation.payment.date ?? ""}: ${formatInr(allocation.amount)}${how}`;
    })
    .join("; ");
}

function overdueCell(line: InvoiceLine): string {
  if (line.outstanding === 0) {
    return line.daysPaidLate ? `paid ${line.daysPaidLate} day(s) late` : "-";
  }

  if (line.daysOverdue === undefined) {
    return "due date unknown";
  }

  return line.daysOverdue > 0 ? String(line.daysOverdue) : "not yet due";
}

function sourcesCell(line: InvoiceLine): string {
  return [
    recordLocationLabel(line.invoice),
    ...line.allocations.map((allocation) => recordLocationLabel(allocation.payment)),
  ].join("; ");
}

/** Invoice-by-invoice reconciliation with the payments applied and the cells they come from. */
export function paymentReconciliationTableMarkdown(reconciliation: PaymentReconciliation): string {
  const capped = reconciliation.lines.some((line) => line.statutoryReferenceDate !== undefined);
  const headers = [
    "Invoice",
    "Invoice date",
    "Amount (Rs)",
    "Payments applied",
    "Paid (Rs)",
    "Outstanding (Rs)",
    "Due date",
    "Days overdue",
    ...(capped ? [`Days beyond ${MSMED_MAX_CREDIT_DAYS} days (assumption)`] : []),
    "Status",
    "Source cells",
  ];
  const rows = reconciliation.lines.map((line) => [
    line.invoice.invoiceNumber,
    line.invoice.invoiceDate ?? "-",
    formatInr(line.amount),
    paymentsCell(line),
    formatInr(line.paid),
    formatInr(line.outstanding),
    line.dueDate ?? "-",
    overdueCell(line),
    ...(capped
      ? [
          line.daysBeyondStatutoryReference === undefined
            ? "-"
            : String(line.daysBeyondStatutoryReference),
        ]
      : []),
    STATUS_LABELS[line.status],
    sourcesCell(line),
  ]);
  const { totals } = reconciliation;

  rows.push([
    "Total",
    "",
    formatInr(totals.invoiced),
    "",
    formatInr(totals.received),
    formatInr(totals.outstanding),
    "",
    "",
    ...(capped ? [""] : []),
    "",
    "",
  ]);

  const notes = [
    `Outstanding as of ${reconciliation.asOfDate}, from the invoice register and the payment records only.`,
  ];

  if (reconciliation.unallocated.length > 0) {
    notes.push(
      `Payments not applied to any invoice (${formatInrAmount(totals.unallocated)}) are listed separately and are not deducted.`,
    );
  }

  if (capped) {
    notes.push(
      `The ${MSMED_MAX_CREDIT_DAYS}-day column assumes the MSMED Act limit applies from the invoice date. It is an assumption to verify, not a legal determination.`,
    );
  }

  return [markdownTableOf(headers, rows), "", ...notes].join("\n");
}

export function unallocatedPaymentsMarkdown(
  reconciliation: PaymentReconciliation,
): string | undefined {
  if (reconciliation.unallocated.length === 0) {
    return undefined;
  }

  return markdownTableOf(
    ["Payment", "Date", "Amount (Rs)", "Why it was not applied", "Source"],
    reconciliation.unallocated.map((item) => [
      item.payment.label,
      item.payment.date ?? "-",
      formatInr(item.amount),
      item.reason,
      recordLocationLabel(item.payment),
    ]),
  );
}

/** A compact payment position for the case pack summary. */
export function paymentSummaryTableMarkdown(reconciliation: PaymentReconciliation): string {
  const rows = reconciliation.lines.map((line) => [
    line.invoice.invoiceNumber,
    line.invoice.invoiceDate ?? "-",
    formatInr(line.amount),
    formatInr(line.paid),
    formatInr(line.outstanding),
    line.dueDate ?? "-",
    overdueCell(line),
  ]);
  const { totals } = reconciliation;

  rows.push([
    "Total",
    "",
    formatInr(totals.invoiced),
    formatInr(totals.received),
    formatInr(totals.outstanding),
    "",
    "",
  ]);

  return markdownTableOf(
    [
      "Invoice",
      "Invoice date",
      "Amount (Rs)",
      "Paid (Rs)",
      "Outstanding (Rs)",
      "Due date",
      "Days overdue",
    ],
    rows,
  );
}
