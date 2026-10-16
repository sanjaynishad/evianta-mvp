import { VERIFY_AGAINST_CURRENT_LAW } from "@evianta/ai";
import { z } from "zod";

import { defineAgent, type Agent, type AgentResult } from "../../agent.js";
import {
  SPECIALIST_DEFINITIONS,
  specialistInputSchema,
  type SpecialistInput,
} from "../../agents/specialist.js";
import {
  agentFindingSchema,
  specialistOutputSchema,
  type AgentFindingInput,
  type EvidenceReference,
  type OpenQuestionDraft,
} from "../../findings.js";
import {
  buildSpecialistInput,
  specialistResultToTaskOutput,
  type TaskHandler,
  type TaskOutput,
  type TaskSectionDraft,
} from "../../handlers.js";
import { recordRowEvidence } from "./chronology.js";
import {
  formatInrAmount,
  invoiceOutstandingFigureKey,
  MSME_DATE_KEYS,
  MSME_FIGURE_KEYS,
  msmePaymentPackSpec,
  MSMED_MAX_CREDIT_DAYS,
} from "./constants.js";
import {
  createPreparedHandler,
  preparePaymentCaseAsync,
  resolveAgentFor,
  withoutRecordTables,
  type PaymentCase,
} from "./context.js";
import { normalizeInvoiceNumber, recordDocumentIds, recordLocationLabel } from "./records.js";
import {
  hasPaymentData,
  outstandingComponents,
  type InvoiceLine,
  type PaymentReconcileOptions,
  type PaymentReconciliation,
  type UnallocatedPayment,
} from "./reconcile.js";
import { paymentReconciliationTableMarkdown, unallocatedPaymentsMarkdown } from "./render.js";

export const MAX_PAYMENT_EVIDENCE_PER_LINE = 8;

export const invoiceExplanationSchema = z.object({
  invoiceNumber: z.string().min(1),
  explanation: z.string().min(1),
  followUp: z.string().optional(),
});

export type InvoiceExplanation = z.infer<typeof invoiceExplanationSchema>;

export const paymentReconciliationOutputSchema = specialistOutputSchema.extend({
  findings: z.array(agentFindingSchema).default([]),
  summary: z.string().optional(),
  explanations: z.array(invoiceExplanationSchema).default([]),
});

export type PaymentReconciliationOutput = z.infer<typeof paymentReconciliationOutputSchema>;

export type PaymentReconciliationAgent = Agent<SpecialistInput, PaymentReconciliationOutput>;

export const PAYMENT_RECONCILIATION_SYSTEM_PROMPT = [
  "You are the payment reconciliation specialist preparing an MSME supplier's overdue-payment case for the business owner or adviser to review.",
  "context.reconciliation holds a deterministic reconciliation of the invoice register with the payment records. Its amounts, dates, and day counts are exact and final: never recompute, round, or restate them differently.",
  "For each invoice with a balance, a partial payment, or a payment matched by amount (inferred), add an explanations entry with its invoiceNumber: explain in plain language how the balance arises and suggest a concrete follow-up for the supplier (for example asking the buyer to confirm a payment's invoice).",
  "Mention unallocated payments and why they were not deducted. Put a one-paragraph overview of the outstanding position in summary.",
  `The ${MSMED_MAX_CREDIT_DAYS}-day figures are an assumption about the MSMED Act, not a conclusion; do not say the buyer is in breach or that interest is payable.`,
  "Do not state any figure that is not in context, and do not make legal determinations.",
].join("\n");

export function createPaymentReconciliationAgent(): PaymentReconciliationAgent {
  const { profile } = SPECIALIST_DEFINITIONS["payment-reconciliation"];

  return defineAgent<SpecialistInput, PaymentReconciliationOutput>({
    role: "payment-reconciliation",
    modelTier: profile.modelTier,
    systemPrompt: PAYMENT_RECONCILIATION_SYSTEM_PROMPT,
    inputSchema: specialistInputSchema,
    outputSchema: paymentReconciliationOutputSchema,
    grounding: false,
    maxOutputTokens: 4096,
    profile,
  });
}

/** A compact, token-cheap view of the reconciliation for the model. */
export function paymentReconciliationContext(
  reconciliation: PaymentReconciliation,
): Record<string, unknown> {
  const { terms } = reconciliation;

  return {
    reconciliation: {
      asOfDate: reconciliation.asOfDate,
      ...(terms ? { agreedCreditDays: terms.creditDays, creditPeriodRunsFrom: terms.basis } : {}),
      invoices: reconciliation.lines.map((line) => ({
        invoiceNumber: line.invoice.invoiceNumber,
        invoiceDate: line.invoice.invoiceDate,
        amount: line.amount,
        paid: line.paid,
        outstanding: line.outstanding,
        status: line.status,
        dueDate: line.dueDate,
        daysOverdue: line.daysOverdue,
        ...(line.statutoryReferenceDate
          ? {
              [`daysBeyond${MSMED_MAX_CREDIT_DAYS}DaysAssumption`]:
                line.daysBeyondStatutoryReference,
            }
          : {}),
        ...(line.daysPaidLate ? { daysPaidLate: line.daysPaidLate } : {}),
        payments: line.allocations.map((allocation) => ({
          payment: allocation.payment.label,
          date: allocation.payment.date,
          amount: allocation.amount,
          matchedBy: allocation.method,
        })),
      })),
      totals: reconciliation.totals,
      unallocatedPayments: reconciliation.unallocated.map((item) => ({
        payment: item.payment.label,
        date: item.payment.date,
        amount: item.amount,
        reason: item.reason,
      })),
    },
  };
}

function lineEvidence(line: InvoiceLine): EvidenceReference[] {
  return [
    recordRowEvidence(line.invoice, `${line.invoice.invoiceNumber} invoice row`),
    ...line.allocations.map((allocation) =>
      recordRowEvidence(
        allocation.payment,
        `Payment ${allocation.payment.label} applied to ${line.invoice.invoiceNumber}`,
      ),
    ),
  ].slice(0, MAX_PAYMENT_EVIDENCE_PER_LINE);
}

function lineSummary(line: InvoiceLine): string {
  const { invoiceNumber } = line.invoice;
  const payments = line.allocations.length;

  if (line.outstanding === 0) {
    const late = line.daysPaidLate ? `, ${line.daysPaidLate} day(s) after the due date` : "";

    return `[${invoiceNumber}] Paid in full (${formatInrAmount(line.amount)}) by ${payments} payment(s)${late}`;
  }

  const overdue =
    line.daysOverdue === undefined
      ? "due date unknown"
      : line.daysOverdue > 0
        ? `${line.daysOverdue} day(s) past the due date of ${line.dueDate}`
        : `not yet due (due ${line.dueDate})`;

  const paidPart = payments === 0 ? "with no payment received" : `after ${payments} payment(s)`;

  return `[${invoiceNumber}] ${formatInrAmount(line.outstanding)} outstanding of ${formatInrAmount(line.amount)} ${paidPart}; ${overdue}`;
}

function inferredQuestions(line: InvoiceLine): OpenQuestionDraft[] {
  return line.allocations
    .filter((allocation) => allocation.method !== "reference")
    .map((allocation) => ({
      text: `Payment ${allocation.payment.label} of ${formatInrAmount(allocation.amount)} on ${allocation.payment.date} has no invoice reference and was matched to ${line.invoice.invoiceNumber} because the amount equals its open balance. Confirm with the buyer's remittance advice.`,
      severity: "medium" as const,
    }));
}

export function invoiceLineFinding(
  line: InvoiceLine,
  explanation?: InvoiceExplanation,
): AgentFindingInput {
  const open = line.outstanding > 0;
  const overdue = open && (line.daysOverdue ?? 0) > 0;
  const detail = [
    explanation?.explanation,
    explanation?.followUp ? `Suggested follow-up: ${explanation.followUp}` : undefined,
    line.statutoryReferenceDate && open
      ? `Assumption: ${line.daysBeyondStatutoryReference ?? 0} day(s) beyond ${line.statutoryReferenceDate}, ${MSMED_MAX_CREDIT_DAYS} days from the invoice date.`
      : undefined,
  ].filter(Boolean);

  return {
    summary: lineSummary(line),
    ...(detail.length > 0 ? { detail: detail.join("\n") } : {}),
    severity: overdue ? "high" : open || line.inferred ? "medium" : "info",
    confidence: line.inferred ? "medium" : "high",
    evidence: lineEvidence(line),
    assumptions: line.inferred
      ? [
          `A payment without an invoice reference was applied to ${line.invoice.invoiceNumber} because its amount equals the open balance.`,
        ]
      : [],
    openQuestions: [
      ...inferredQuestions(line),
      ...(explanation?.followUp && open
        ? [
            {
              text: `${line.invoice.invoiceNumber}: ${explanation.followUp}`,
              severity: "medium" as const,
            },
          ]
        : []),
    ],
    figures: [
      {
        key: invoiceOutstandingFigureKey(line.invoice.key),
        label: `${line.invoice.invoiceNumber} outstanding`,
        value: line.outstanding,
        unit: "INR",
        components: outstandingComponents(line),
      },
    ],
    ...(line.dueDate
      ? {
          dates: [
            {
              key: `due-date:${line.invoice.key}`,
              label: `${line.invoice.invoiceNumber} due date`,
              date: line.dueDate,
            },
          ],
        }
      : {}),
  };
}

export function unallocatedPaymentFinding(
  item: UnallocatedPayment,
  reconciliation: PaymentReconciliation,
): AgentFindingInput {
  const { outstanding } = reconciliation.totals;
  const ifApplied = Math.max(0, outstanding - item.amount);

  return {
    summary: `Payment ${item.payment.label} of ${formatInrAmount(item.amount)} on ${item.payment.date} was not applied: ${item.reason}`,
    severity: "medium",
    confidence: "high",
    evidence: [recordRowEvidence(item.payment, `Payment ${item.payment.label} row`)],
    openQuestions: [
      {
        text: `Confirm what payment ${item.payment.label} (${formatInrAmount(item.amount)}, ${recordLocationLabel(item.payment)}) relates to. It is not deducted; if it settles these invoices, the outstanding amount would be ${formatInrAmount(ifApplied)} instead of ${formatInrAmount(outstanding)}.`,
        severity: "high",
      },
    ],
  };
}

export function paymentTotalsFinding(reconciliation: PaymentReconciliation): AgentFindingInput {
  const { totals, terms, lines } = reconciliation;
  const open = lines.filter((line) => line.outstanding > 0);
  const figures: NonNullable<AgentFindingInput["figures"]> = [
    {
      key: MSME_FIGURE_KEYS.invoicedTotal,
      label: "Total invoiced",
      value: totals.invoiced,
      unit: "INR",
      components: lines.map((line) => ({ label: line.invoice.invoiceNumber, value: line.amount })),
    },
    {
      key: MSME_FIGURE_KEYS.receivedTotal,
      label: "Total payments applied to invoices",
      value: totals.received,
      unit: "INR",
      components: lines.flatMap((line) =>
        line.allocations.map((allocation) => ({
          label: `${allocation.payment.label} to ${line.invoice.invoiceNumber}`,
          value: allocation.amount,
        })),
      ),
    },
    {
      key: MSME_FIGURE_KEYS.outstandingTotal,
      label: "Total outstanding",
      value: totals.outstanding,
      unit: "INR",
      components: open.map((line) => ({
        label: `${line.invoice.invoiceNumber} outstanding`,
        value: line.outstanding,
      })),
    },
  ];

  if (reconciliation.unallocated.length > 0) {
    figures.push({
      key: MSME_FIGURE_KEYS.unallocatedTotal,
      label: "Payments not applied to any invoice",
      value: totals.unallocated,
      unit: "INR",
      components: reconciliation.unallocated.map((item) => ({
        label: item.payment.label,
        value: item.amount,
      })),
    });
  }

  if (terms) {
    figures.push({
      key: MSME_FIGURE_KEYS.agreedCreditDays,
      label: "Agreed credit period",
      value: terms.creditDays,
      unit: "days",
    });
  }

  const assumptions = [
    `Outstanding amounts are stated as of ${reconciliation.asOfDate} and use only the invoice register and payment records.`,
    ...(terms
      ? [
          `Due dates are the invoice date plus the agreed ${terms.creditDays}-day credit period${terms.basis === "invoice" ? "" : `; the terms run from ${terms.basis}, and the invoice date is used as a proxy`}.`,
        ]
      : [
          "No agreed credit period was found, so due dates come from the invoice register where it states them.",
        ]),
    ...(lines.some((line) => line.statutoryReferenceDate)
      ? [
          `The ${MSMED_MAX_CREDIT_DAYS}-day column assumes the MSMED Act limit applies, counted from the invoice date as a proxy for acceptance. This is an assumption to verify, not a legal determination.`,
        ]
      : []),
    ...(reconciliation.unallocated.length > 0
      ? [
          `${formatInrAmount(totals.unallocated)} of payments could not be applied to an invoice and is not deducted.`,
        ]
      : []),
  ];

  return {
    summary: `Outstanding amount: ${formatInrAmount(totals.outstanding)} across ${open.length} invoice(s) as of ${reconciliation.asOfDate}`,
    detail: [
      `Invoiced ${formatInrAmount(totals.invoiced)}, payments applied ${formatInrAmount(totals.received)}, outstanding ${formatInrAmount(totals.outstanding)}.`,
      ...(totals.overdue > 0
        ? [`Of this, ${formatInrAmount(totals.overdue)} is past its due date.`]
        : []),
    ].join("\n"),
    severity: totals.outstanding > 0 ? "high" : "info",
    confidence: lines.some((line) => line.inferred) ? "medium" : "high",
    evidence: [
      ...reconciliation.records.tables.map((table) => ({
        documentId: table.documentId,
        description: `${table.kind === "invoices" ? "Invoice register" : "Payment records"} (${table.rowCount} row(s))`,
        ...(table.location.sheet ? { sheet: table.location.sheet } : {}),
        ...(table.location.cellRange ? { cellRange: table.location.cellRange } : {}),
      })),
      ...(terms?.evidence.slice(0, 1) ?? []),
    ],
    assumptions,
    figures,
    dates: [
      {
        key: MSME_DATE_KEYS.asOfDate,
        label: "Outstanding stated as of",
        date: reconciliation.asOfDate,
      },
    ],
  };
}

export function paymentReconciliationQuestions(
  reconciliation: PaymentReconciliation,
): OpenQuestionDraft[] {
  const questions: OpenQuestionDraft[] = [];

  if (!reconciliation.terms && reconciliation.lines.some((line) => !line.dueDate)) {
    questions.push({
      text: "Some invoices have no due date and no agreed credit period was found, so their days overdue are not stated. Confirm the payment terms.",
      severity: "high",
    });
  }

  if (reconciliation.lines.some((line) => line.statutoryReferenceDate && line.outstanding > 0)) {
    questions.push({
      text: `${VERIFY_AGAINST_CURRENT_LAW}: the agreed credit period exceeds ${MSMED_MAX_CREDIT_DAYS} days. Whether the MSMED Act limit applies (supplier registration, buyer status, and the date of acceptance) must be confirmed by a professional before relying on the ${MSMED_MAX_CREDIT_DAYS}-day figures.`,
      severity: "high",
    });
  }

  if (!reconciliation.records.payments.length) {
    questions.push({
      text: "No payment records were found, so every invoice is treated as unpaid. Upload the bank statement or receipts ledger.",
      severity: "high",
    });
  }

  for (const invoice of reconciliation.laterInvoices) {
    questions.push({
      text: `${invoice.invoiceNumber} (${recordLocationLabel(invoice)}) is dated ${invoice.invoiceDate}, after the as-of date ${reconciliation.asOfDate}, so it is not included in the outstanding amount.`,
      severity: "low",
    });
  }

  for (const table of reconciliation.records.unclassified) {
    questions.push({
      text: `The table in ${table.documentName} was not used: ${table.reason}. Confirm whether it holds relevant records.`,
      severity: "low",
    });
  }

  return questions;
}

function notesMarkdown(
  reconciliation: PaymentReconciliation,
  output: PaymentReconciliationOutput,
  explanations: ReadonlyMap<string, InvoiceExplanation>,
): string {
  const parts = [output.summary?.trim() || "How the outstanding amount is made up."];

  for (const line of reconciliation.lines) {
    const explanation = explanations.get(line.invoice.key);

    if (line.outstanding === 0 && !line.inferred && !explanation) {
      continue;
    }

    parts.push("", `**${lineSummary(line)}**`);

    if (explanation) {
      parts.push(explanation.explanation);

      if (explanation.followUp) {
        parts.push(`Suggested follow-up: ${explanation.followUp}`);
      }
    }
  }

  for (const item of reconciliation.unallocated) {
    parts.push(
      "",
      `**Payment ${item.payment.label} (${formatInrAmount(item.amount)}) not applied**`,
      `Not deducted because ${item.reason}.`,
    );
  }

  return parts.join("\n");
}

export function paymentReconciliationTaskOutput(
  result: AgentResult<PaymentReconciliationOutput>,
  reconciliation: PaymentReconciliation,
): TaskOutput {
  const base = specialistResultToTaskOutput(result, false);

  if (!hasPaymentData(reconciliation)) {
    return {
      ...base,
      openQuestions: [
        {
          text: "No invoice register was found among the documents, so the outstanding amount could not be computed. Upload the invoices or a sales register.",
          severity: "high",
        },
        ...(base.openQuestions ?? []),
      ],
      deliverables: [msmePaymentPackSpec()],
    };
  }

  const explanations = new Map(
    result.output.explanations.map((entry) => [normalizeInvoiceNumber(entry.invoiceNumber), entry]),
  );
  const deterministic: AgentFindingInput[] = [
    ...reconciliation.lines.map((line) =>
      invoiceLineFinding(line, explanations.get(line.invoice.key)),
    ),
    ...reconciliation.unallocated.map((item) => unallocatedPaymentFinding(item, reconciliation)),
    paymentTotalsFinding(reconciliation),
  ];
  const findings = [...deterministic, ...base.findings];
  const unallocatedTable = unallocatedPaymentsMarkdown(reconciliation);
  const sections: TaskSectionDraft[] = [
    {
      title: "Payment reconciliation",
      kind: "table",
      content: [
        paymentReconciliationTableMarkdown(reconciliation),
        ...(unallocatedTable ? ["", "**Payments not applied**", "", unallocatedTable] : []),
      ].join("\n"),
      findingIndexes: deterministic.map((_finding, index) => index),
    },
    {
      title: "Reconciliation notes",
      kind: "text",
      content: notesMarkdown(reconciliation, result.output, explanations),
      findingIndexes: deterministic
        .map((finding, index) => (finding.severity === "info" ? -1 : index))
        .filter((index) => index >= 0),
    },
  ];
  const unknown = result.output.explanations
    .map((entry) => entry.invoiceNumber)
    .filter(
      (number) =>
        !reconciliation.lines.some((line) => line.invoice.key === normalizeInvoiceNumber(number)),
    );

  return {
    ...base,
    findings,
    openQuestions: [
      ...paymentReconciliationQuestions(reconciliation),
      ...(base.openQuestions ?? []),
      ...(unknown.length > 0
        ? [
            {
              text: `The explanation referred to invoice(s) not in the register (${unknown.join(", ")}); those notes were ignored.`,
              severity: "low" as const,
            },
          ]
        : []),
    ],
    sections,
    deliverables: [msmePaymentPackSpec()],
  };
}

export interface PaymentReconciliationHandlerOptions extends PaymentReconcileOptions {
  agent?: PaymentReconciliationAgent;
}

/** Deterministic invoice-to-payment matching in TypeScript, then one model call to explain it. */
export function createPaymentReconciliationTaskHandler(
  options: PaymentReconciliationHandlerOptions = {},
): TaskHandler {
  const { agent, ...reconcileOptions } = options;

  return createPreparedHandler<PaymentCase, SpecialistInput, PaymentReconciliationOutput>(
    "payment-reconciliation",
    (ctx) =>
      resolveAgentFor(ctx, "payment-reconciliation", agent, createPaymentReconciliationAgent),
    {
      prepareAsync(ctx) {
        return preparePaymentCaseAsync(ctx, reconcileOptions);
      },
      buildInput(ctx, prepared) {
        if (!hasPaymentData(prepared.reconciliation)) {
          return buildSpecialistInput(ctx);
        }

        return withoutRecordTables(
          buildSpecialistInput(ctx, paymentReconciliationContext(prepared.reconciliation)),
          recordDocumentIds(prepared.records),
        );
      },
      toTaskOutput(result, _ctx, prepared) {
        return paymentReconciliationTaskOutput(
          { ...result, output: paymentReconciliationOutputSchema.parse(result.output) },
          prepared.reconciliation,
        );
      },
    },
  );
}
