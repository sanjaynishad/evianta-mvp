import { PRIMARY_DELIVERABLE_KEY, type DeliverableSpec } from "../../findings.js";
import { referencePlanFor } from "../../plans.js";

export const TAX_NOTICE_GUARDRAIL =
  "Prepared for review and approval by the Chartered Accountant. Nothing has been filed or submitted, and nothing in this pack is a legal determination.";

/** Shared figure keys, so deterministic checks can compare the same quantity across tasks. */
export const TAX_FIGURE_KEYS = {
  demandTotal: "demand-total",
  demandTax: "demand-tax",
  demandInterest: "demand-interest",
  tdsClaimedInReturn: "tds-claimed-return",
  tdsPerTaxCredit: "tds-as-per-26as",
  tdsPerLedger: "tds-as-per-ledger",
  tdsDifference: "tds-difference",
  ledgerTdsDifference: "tds-difference-ledger",
  incomePerReturn: "income-per-return",
  incomePerTaxCredit: "income-as-per-26as",
  incomePerLedger: "income-as-per-ledger",
} as const;

export const TAX_DATE_KEYS = {
  issueDate: "notice-issue-date",
  responseDueDate: "notice-response-due-date",
} as const;

export function reconciliationLineFigureKey(ref: string): string {
  return `recon-${ref.toLowerCase()}-tds-difference`;
}

/** Puts the guardrail on the primary deliverable so every export of the pack carries it. */
export function taxNoticePackSpec(): DeliverableSpec {
  const { deliverable } = referencePlanFor("tax-notice");

  return {
    key: PRIMARY_DELIVERABLE_KEY,
    title: deliverable.title,
    format: deliverable.format,
    content: TAX_NOTICE_GUARDRAIL,
  };
}

export function formatAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;

  return rounded.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function formatRupees(value: number): string {
  return `${value < 0 ? "-" : ""}Rs ${formatAmount(Math.abs(value))}`;
}

export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function markdownTable(headers: readonly string[], rows: readonly string[][]): string {
  const lines = [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ];

  return lines.join("\n");
}
