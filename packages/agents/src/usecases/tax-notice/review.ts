import { createReviewTaskHandler, type ReviewTaskHandlerOptions } from "../../agents/reviewer.js";
import type { TaskHandler, UpstreamSection } from "../../handlers.js";
import {
  DEFAULT_NUMERIC_TOLERANCE,
  numbersAgree,
  type AdditionalCheck,
  type VerificationFinding,
  type VerificationIssue,
} from "../../verification.js";
import { formatAmount, reconciliationLineFigureKey, TAX_FIGURE_KEYS } from "./constants.js";
import { reconcileCaseAsync } from "./context.js";
import {
  hasReconciliationData,
  primaryTaxDifference,
  type TaxReconciliation,
} from "./reconcile.js";
import { OPEN_QUESTIONS_SECTION_TITLE, SCHEDULE_TITLE_PREFIX } from "./response.js";

export interface ExpectedFigure {
  key: string;
  label: string;
  value: number;
}

/** Figures the reconciliation must state, recomputed independently from the source records. */
export function expectedReconciliationFigures(reconciliation: TaxReconciliation): ExpectedFigure[] {
  if (!hasReconciliationData(reconciliation)) {
    return [];
  }

  const { bySource, returnVsTaxCredit, ledgerVsTaxCredit } = reconciliation.totals;
  const expected: ExpectedFigure[] = [];
  const push = (key: string, label: string, value: number | undefined) => {
    if (value !== undefined) {
      expected.push({ key, label, value });
    }
  };

  push(TAX_FIGURE_KEYS.tdsClaimedInReturn, "Total TDS per return", bySource.return?.tax);
  push(TAX_FIGURE_KEYS.tdsPerLedger, "Total TDS per ledger", bySource.ledger?.tax);
  push(TAX_FIGURE_KEYS.tdsPerTaxCredit, "Total TDS per 26AS/AIS", bySource["tax-credit"]?.tax);
  push(TAX_FIGURE_KEYS.tdsDifference, "TDS per return less 26AS/AIS", returnVsTaxCredit?.tax);
  push(TAX_FIGURE_KEYS.ledgerTdsDifference, "TDS per ledger less 26AS/AIS", ledgerVsTaxCredit?.tax);

  for (const line of reconciliation.lines) {
    push(
      reconciliationLineFigureKey(line.ref),
      `${line.ref} TDS difference`,
      primaryTaxDifference(line),
    );
  }

  return expected;
}

/** Compares every stated reconciliation figure with the independent recomputation. */
export function reconciliationRecomputeCheck(
  expected: readonly ExpectedFigure[],
  isReconciliationFinding: (finding: VerificationFinding) => boolean,
  tolerance = DEFAULT_NUMERIC_TOLERANCE,
): AdditionalCheck {
  const byKey = new Map(expected.map((figure) => [figure.key, figure]));

  return (findings) =>
    findings.filter(isReconciliationFinding).flatMap((finding) =>
      (finding.figures ?? []).flatMap((figure): VerificationIssue[] => {
        const recomputed = byKey.get(figure.key);

        if (!recomputed || numbersAgree(recomputed.value, figure.value, tolerance)) {
          return [];
        }

        return [
          {
            check: "reconciliation-recompute",
            severity: "high",
            key: figure.key,
            message: `"${figure.label}" is stated as ${formatAmount(figure.value)} but recomputing the reconciliation from the uploaded records gives ${formatAmount(recomputed.value)}.`,
            findingIds: [finding.id],
            taskIds: [finding.taskId],
          },
        ];
      }),
    );
}

const AMOUNT_PATTERN = /([-−]\s*)?(?:\brs\.?|\binr\b|₹)\s*([-−]\s*)?(\d+(?:,\d+)*(?:\.\d+)?)/gi;

export interface QuotedAmount {
  text: string;
  /** Signed value; checks compare magnitudes because figures may be stated either way round. */
  value: number;
}

/** Rupee amounts quoted in text, such as "Rs 1,41,000", "Rs. 12,400/-", "-Rs 620", or "₹-12,000". */
export function quotedAmounts(text: string): QuotedAmount[] {
  return [...text.matchAll(AMOUNT_PATTERN)].flatMap((match) => {
    const digits = (match[3] ?? "").replace(/,/g, "");
    const magnitude = Number(digits);
    const negative = Boolean(match[1] || match[2]);

    return Number.isFinite(magnitude) && digits.length > 0
      ? [{ text: match[0].trim(), value: negative ? -magnitude : magnitude }]
      : [];
  });
}

export function knownFigureValues(
  findings: readonly VerificationFinding[],
  expected: readonly ExpectedFigure[],
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

  return [...values];
}

/** Every rupee amount in the draft must match a figure computed or sourced outside the draft. */
export function draftFiguresCheck(
  draftSections: readonly UpstreamSection[],
  expected: readonly ExpectedFigure[],
  tolerance = DEFAULT_NUMERIC_TOLERANCE,
): AdditionalCheck {
  const draftTaskIds = new Set(draftSections.map((section) => section.taskId));

  return (findings) => {
    const known = knownFigureValues(
      findings.filter((finding) => !draftTaskIds.has(finding.taskId)),
      expected,
    );
    const issues: VerificationIssue[] = [];

    for (const section of draftSections) {
      const unmatched = new Map<string, QuotedAmount>();

      for (const amount of quotedAmounts(section.content)) {
        const magnitude = Math.abs(amount.value);

        if (!known.some((value) => numbersAgree(value, magnitude, tolerance))) {
          unmatched.set(amount.text, amount);
        }
      }

      for (const amount of unmatched.values()) {
        const magnitude = Math.abs(amount.value);
        const closest = [...known].sort(
          (left, right) => Math.abs(left - magnitude) - Math.abs(right - magnitude),
        )[0];

        issues.push({
          check: "draft-figure",
          severity: "high",
          key: `draft:${amount.value}`,
          message: `"${section.title}" quotes ${amount.text}, which does not match any computed or sourced figure${closest === undefined ? "" : ` (closest: ${formatAmount(closest)})`}.`,
          findingIds: [],
          taskIds: [section.taskId],
        });
      }
    }

    return issues;
  };
}

export interface TaxNoticeReviewOptions extends ReviewTaskHandlerOptions {
  /** Handles review for other use cases; the generic deterministic-first reviewer by default. */
  fallback?: TaskHandler;
}

/**
 * Independent review for tax-notice cases: the generic reviewer plus an independent recompute
 * of the reconciliation and a check that every figure quoted in the draft is a computed one.
 */
export function createTaxNoticeReviewTaskHandler(
  options: TaxNoticeReviewOptions = {},
): TaskHandler {
  const { fallback, ...reviewOptions } = options;
  const generic = fallback ?? createReviewTaskHandler(reviewOptions);

  return {
    role: "independent-review",
    async executeAsync(ctx) {
      if (ctx.case.useCase !== "tax-notice") {
        return generic.executeAsync(ctx);
      }

      const { reconciliation } = await reconcileCaseAsync(ctx);
      const expected = expectedReconciliationFigures(reconciliation);
      const computingTaskIds = new Set(
        ctx.tasks
          .filter(
            (task) =>
              task.assignedRole === "reconciliation" ||
              task.assignedRole === "response-preparation",
          )
          .map((task) => task.id),
      );
      const draftSections = ctx.upstreamSections.filter(
        (section) =>
          section.role === "response-preparation" &&
          section.title !== OPEN_QUESTIONS_SECTION_TITLE &&
          !section.title.startsWith(SCHEDULE_TITLE_PREFIX),
      );
      const tolerance = reviewOptions.tolerance ?? DEFAULT_NUMERIC_TOLERANCE;
      const handler = createReviewTaskHandler({
        ...reviewOptions,
        additionalChecks: [
          ...(reviewOptions.additionalChecks ?? []),
          reconciliationRecomputeCheck(
            expected,
            (finding) => computingTaskIds.has(finding.taskId),
            tolerance,
          ),
          draftFiguresCheck(draftSections, expected, Math.max(tolerance, 0.5)),
        ],
      });

      return handler.executeAsync(ctx);
    },
  };
}
