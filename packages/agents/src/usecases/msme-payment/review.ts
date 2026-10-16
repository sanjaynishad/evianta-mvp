import { createReviewTaskHandler, type ReviewTaskHandlerOptions } from "../../agents/reviewer.js";
import type { TaskHandler, UpstreamSection } from "../../handlers.js";
import {
  DEFAULT_NUMERIC_TOLERANCE,
  numbersAgree,
  type AdditionalCheck,
  type VerificationFinding,
  type VerificationIssue,
} from "../../verification.js";
import {
  CASE_PACK_QUESTIONS_SECTION_TITLE,
  CHRONOLOGY_SECTION_TITLE,
  SUPPORTING_DOCUMENTS_SECTION_TITLE,
} from "./casePreparation.js";
import { formatInr, invoiceOutstandingFigureKey, MSME_FIGURE_KEYS } from "./constants.js";
import { preparePaymentCaseAsync } from "./context.js";
import { quotedDates } from "./dates.js";
import {
  hasPaymentData,
  type PaymentReconcileOptions,
  type PaymentReconciliation,
} from "./reconcile.js";

export interface MsmeExpectedFigure {
  key: string;
  label: string;
  value: number;
}

/** Figures the payment reconciliation must state, recomputed independently from the records. */
export function expectedPaymentFigures(
  reconciliation: PaymentReconciliation,
): MsmeExpectedFigure[] {
  if (!hasPaymentData(reconciliation)) {
    return [];
  }

  const { totals } = reconciliation;

  return [
    { key: MSME_FIGURE_KEYS.invoicedTotal, label: "Total invoiced", value: totals.invoiced },
    {
      key: MSME_FIGURE_KEYS.receivedTotal,
      label: "Total payments applied",
      value: totals.received,
    },
    {
      key: MSME_FIGURE_KEYS.outstandingTotal,
      label: "Total outstanding",
      value: totals.outstanding,
    },
    {
      key: MSME_FIGURE_KEYS.unallocatedTotal,
      label: "Payments not applied",
      value: totals.unallocated,
    },
    ...reconciliation.lines.map((line) => ({
      key: invoiceOutstandingFigureKey(line.invoice.key),
      label: `${line.invoice.invoiceNumber} outstanding`,
      value: line.outstanding,
    })),
  ];
}

/** Compares every stated payment figure with the independent recomputation. */
export function outstandingRecomputeCheck(
  expected: readonly MsmeExpectedFigure[],
  isComputingFinding: (finding: VerificationFinding) => boolean,
  tolerance = DEFAULT_NUMERIC_TOLERANCE,
): AdditionalCheck {
  const byKey = new Map(expected.map((figure) => [figure.key, figure]));

  return (findings) =>
    findings.filter(isComputingFinding).flatMap((finding) =>
      (finding.figures ?? []).flatMap((figure): VerificationIssue[] => {
        const recomputed = byKey.get(figure.key);

        if (!recomputed || numbersAgree(recomputed.value, figure.value, tolerance)) {
          return [];
        }

        return [
          {
            check: "payment-recompute",
            severity: "high",
            key: figure.key,
            message: `"${figure.label}" is stated as ${formatInr(figure.value)} but recomputing it from the invoice register and payment records gives ${formatInr(recomputed.value)}.`,
            findingIds: [finding.id],
            taskIds: [finding.taskId],
          },
        ];
      }),
    );
}

const AMOUNT_PATTERN = /(?:\brs\.?|\binr\b|₹)\s*(\d+(?:,\d+)*(?:\.\d+)?)/gi;

export interface MsmeQuotedAmount {
  text: string;
  value: number;
}

/** Rupee amounts quoted in text, such as "Rs 1,87,000", "Rs. 50,000/-", or "₹75,000". */
export function quotedRupeeAmounts(text: string): MsmeQuotedAmount[] {
  return [...text.matchAll(AMOUNT_PATTERN)].flatMap((match) => {
    const digits = (match[1] ?? "").replace(/,/g, "");
    const value = Number(digits);

    return digits.length > 0 && Number.isFinite(value) ? [{ text: match[0].trim(), value }] : [];
  });
}

function knownAmounts(
  findings: readonly VerificationFinding[],
  expected: readonly MsmeExpectedFigure[],
  reconciliation: PaymentReconciliation,
): number[] {
  const values = new Set<number>();

  for (const finding of findings) {
    for (const figure of finding.figures ?? []) {
      values.add(Math.abs(figure.value));

      for (const component of figure.components ?? []) {
        values.add(Math.abs(component.value));
      }
    }
  }

  for (const figure of expected) {
    values.add(Math.abs(figure.value));
  }

  for (const record of [...reconciliation.records.invoices, ...reconciliation.records.payments]) {
    if (record.amount !== undefined) {
      values.add(Math.abs(record.amount));
    }
  }

  return [...values];
}

/** Every rupee amount quoted in the draft and chronology must match a computed or sourced figure. */
export function quotedAmountsCheck(
  sections: readonly UpstreamSection[],
  expected: readonly MsmeExpectedFigure[],
  reconciliation: PaymentReconciliation,
  tolerance = DEFAULT_NUMERIC_TOLERANCE,
): AdditionalCheck {
  const checkedTaskIds = new Set(sections.map((section) => section.taskId));

  return (findings) => {
    const known = knownAmounts(
      findings.filter((finding) => !checkedTaskIds.has(finding.taskId)),
      expected,
      reconciliation,
    );
    const issues: VerificationIssue[] = [];

    for (const section of sections) {
      const unmatched = new Map<string, MsmeQuotedAmount>();

      for (const amount of quotedRupeeAmounts(section.content)) {
        if (!known.some((value) => numbersAgree(value, amount.value, tolerance))) {
          unmatched.set(amount.text, amount);
        }
      }

      for (const amount of unmatched.values()) {
        const closest = [...known].sort(
          (left, right) => Math.abs(left - amount.value) - Math.abs(right - amount.value),
        )[0];

        issues.push({
          check: "quoted-amount",
          severity: "high",
          key: `amount:${amount.value}`,
          message: `"${section.title}" quotes ${amount.text}, which does not match any computed or sourced figure${closest === undefined ? "" : ` (closest: ${formatInr(closest)})`}.`,
          findingIds: [],
          taskIds: [section.taskId],
        });
      }
    }

    return issues;
  };
}

function recordDates(reconciliation: PaymentReconciliation): string[] {
  return [
    reconciliation.asOfDate,
    ...reconciliation.records.invoices.flatMap((invoice) =>
      [invoice.invoiceDate, invoice.dueDate].filter((date): date is string => Boolean(date)),
    ),
    ...reconciliation.records.payments.flatMap((payment) => (payment.date ? [payment.date] : [])),
    ...reconciliation.lines.flatMap((line) =>
      [line.dueDate, line.statutoryReferenceDate, line.settledOn].filter((date): date is string =>
        Boolean(date),
      ),
    ),
  ];
}

/** Every date quoted in the draft and chronology must be a date in the records or the work record. */
export function quotedDatesCheck(
  sections: readonly UpstreamSection[],
  reconciliation: PaymentReconciliation,
): AdditionalCheck {
  const checkedTaskIds = new Set(sections.map((section) => section.taskId));

  return (findings) => {
    const known = new Set([
      ...recordDates(reconciliation),
      ...findings
        .filter((finding) => !checkedTaskIds.has(finding.taskId))
        .flatMap((finding) => (finding.dates ?? []).map((entry) => entry.date.slice(0, 10))),
    ]);
    const issues: VerificationIssue[] = [];

    for (const section of sections) {
      const reported = new Set<string>();

      for (const quoted of quotedDates(section.content)) {
        if (known.has(quoted.iso) || reported.has(quoted.iso)) {
          continue;
        }

        reported.add(quoted.iso);
        issues.push({
          check: "quoted-date",
          severity: "medium",
          key: `date:${quoted.iso}`,
          message: `"${section.title}" quotes the date ${quoted.text}, which is not a date in the documents, records, or findings.`,
          findingIds: [],
          taskIds: [section.taskId],
        });
      }
    }

    return issues;
  };
}

/** The chronology must list its events in date order. */
export function chronologyOrderCheck(sections: readonly UpstreamSection[]): AdditionalCheck {
  return () =>
    sections.flatMap((section): VerificationIssue[] => {
      const dates = section.content
        .split("\n")
        .map((line) => /^\s*(\d{4}-\d{2}-\d{2})/.exec(line)?.[1])
        .filter((date): date is string => Boolean(date));
      const outOfOrder = dates.findIndex(
        (date, index) => index > 0 && date < (dates[index - 1] ?? ""),
      );

      return outOfOrder === -1
        ? []
        : [
            {
              check: "chronology-order",
              severity: "medium",
              message: `"${section.title}" lists ${dates[outOfOrder]} after ${dates[outOfOrder - 1]}; the chronology is out of order.`,
              findingIds: [],
              taskIds: [section.taskId],
            },
          ];
    });
}

export interface MsmePaymentReviewOptions extends ReviewTaskHandlerOptions {
  reconciliation?: PaymentReconcileOptions;
  /** Handles review for other use cases; the generic deterministic-first reviewer by default. */
  fallback?: TaskHandler;
}

/**
 * Independent review for MSME payment cases: the generic reviewer plus an independent recompute
 * of the outstanding amounts and checks of every amount and date quoted in the draft and chronology.
 */
export function createMsmePaymentReviewTaskHandler(
  options: MsmePaymentReviewOptions = {},
): TaskHandler {
  const { fallback, reconciliation: reconcileOptions, ...reviewOptions } = options;
  const generic = fallback ?? createReviewTaskHandler(reviewOptions);

  return {
    role: "independent-review",
    async executeAsync(ctx) {
      if (ctx.case.useCase !== "msme-payment") {
        return generic.executeAsync(ctx);
      }

      const { reconciliation } = await preparePaymentCaseAsync(ctx, reconcileOptions);
      const expected = expectedPaymentFigures(reconciliation);
      const computingTaskIds = new Set(
        ctx.tasks
          .filter(
            (task) =>
              task.assignedRole === "payment-reconciliation" ||
              task.assignedRole === "case-preparation",
          )
          .map((task) => task.id),
      );
      const quotedSections = ctx.upstreamSections.filter(
        (section) =>
          section.role === "case-preparation" &&
          section.title !== CASE_PACK_QUESTIONS_SECTION_TITLE &&
          section.title !== SUPPORTING_DOCUMENTS_SECTION_TITLE,
      );
      const chronologySections = quotedSections.filter(
        (section) => section.title === CHRONOLOGY_SECTION_TITLE,
      );
      const tolerance = reviewOptions.tolerance ?? DEFAULT_NUMERIC_TOLERANCE;
      const handler = createReviewTaskHandler({
        ...reviewOptions,
        additionalChecks: [
          ...(reviewOptions.additionalChecks ?? []),
          outstandingRecomputeCheck(
            expected,
            (finding) => computingTaskIds.has(finding.taskId),
            tolerance,
          ),
          quotedAmountsCheck(quotedSections, expected, reconciliation, Math.max(tolerance, 0.5)),
          quotedDatesCheck(quotedSections, reconciliation),
          chronologyOrderCheck(chronologySections),
        ],
      });

      return handler.executeAsync(ctx);
    },
  };
}
