import { PRIMARY_DELIVERABLE_KEY, type DeliverableSpec } from "../../findings.js";
import { referencePlanFor } from "../../plans.js";

export const MSME_PAYMENT_GUARDRAIL =
  "Prepared for review by the business owner or adviser. Nothing has been sent, filed, or escalated, and nothing in this pack is a legal determination. Verify any legal requirement, deadline, or conclusion against the specific facts and current law before acting.";

/** Section 15 of the MSMED Act limits an agreed credit period to 45 days; used only as a flagged assumption. */
export const MSMED_MAX_CREDIT_DAYS = 45;

/** Shared figure keys, so deterministic checks can compare the same quantity across tasks. */
export const MSME_FIGURE_KEYS = {
  invoicedTotal: "invoiced-total",
  receivedTotal: "received-total",
  outstandingTotal: "outstanding-total",
  unallocatedTotal: "unallocated-payments-total",
  agreedCreditDays: "agreed-credit-days",
} as const;

export const MSME_DATE_KEYS = {
  asOfDate: "as-of-date",
} as const;

export function invoiceOutstandingFigureKey(invoiceKey: string): string {
  return `outstanding:${invoiceKey}`;
}

export function statedInvoiceAmountFigureKey(invoiceKey: string, index: number): string {
  return `stated-invoice-amount:${invoiceKey}:${index + 1}`;
}

/** Puts the guardrail on the primary deliverable so every export of the pack carries it. */
export function msmePaymentPackSpec(): DeliverableSpec {
  const { deliverable } = referencePlanFor("msme-payment");

  return {
    key: PRIMARY_DELIVERABLE_KEY,
    title: deliverable.title,
    format: deliverable.format,
    content: MSME_PAYMENT_GUARDRAIL,
  };
}

export function formatInr(value: number): string {
  const rounded = Math.round(value * 100) / 100;

  return rounded.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function formatInrAmount(value: number): string {
  return `${value < 0 ? "-" : ""}Rs ${formatInr(Math.abs(value))}`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function markdownTableOf(headers: readonly string[], rows: readonly string[][]): string {
  return [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}
