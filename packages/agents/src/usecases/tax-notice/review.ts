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
import { RECONCILIATION_TABLE_SECTION_TITLE } from "./reconciliationTask.js";
import { reconciliationTableMarkdown } from "./render.js";
import {
  buildSchedules,
  noticeFigures,
  OPEN_QUESTIONS_SECTION_TITLE,
  SCHEDULE_TITLE_PREFIX,
} from "./response.js";

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

  // Only figures that cite a source count; an untraced amount must not vouch for the draft.
  for (const finding of findings.filter((item) => item.evidence.length > 0)) {
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

/**
 * Data-quality gaps in the source records that make reconciled totals partial or uncertain, so
 * the review cannot pass them as complete: rows without a deductor, unreadable values, names
 * shared by several TANs, and 26AS and AIS disagreeing.
 */
export function reconciliationDataCheck(
  reconciliation: TaxReconciliation,
  reconciliationTaskIds: readonly string[],
): AdditionalCheck {
  return () => {
    const issue = (severity: VerificationIssue["severity"], key: string, message: string) => ({
      check: "reconciliation-data" as const,
      severity,
      key,
      message,
      findingIds: [],
      taskIds: [...reconciliationTaskIds],
    });
    const issues: VerificationIssue[] = [];

    for (const row of reconciliation.unattributedRows) {
      issues.push(
        issue(
          "high",
          `unattributed:${row.documentId}:${row.location.rowRange?.start}`,
          `Row ${row.location.rowRange?.start ?? "?"} of ${row.documentName} has values but no deductor or TAN and is not in the reconciled totals.`,
        ),
      );
    }

    for (const line of reconciliation.lines.filter((item) => item.status === "incomplete")) {
      issues.push(
        issue(
          "high",
          `incomplete:${line.ref}`,
          `${line.ref} (${line.deductorName}, ${line.period}) has blank or unreadable values, so its totals are incomplete.`,
        ),
      );
    }

    for (const row of reconciliation.undatedRows) {
      issues.push(
        issue(
          "medium",
          `undated:${row.documentId}:${row.location.rowRange?.start}`,
          `A row of ${row.documentName} (row ${row.location.rowRange?.start ?? "?"}) has no financial year and was reconciled separately.`,
        ),
      );
    }

    for (const deductor of reconciliation.ambiguousDeductors) {
      issues.push(
        issue(
          "high",
          `ambiguous:${deductor.name}`,
          `"${deductor.name}" appears under several TANs (${deductor.tans.join(", ")}); its rows without a TAN were not reconciled.`,
        ),
      );
    }

    for (const disagreement of reconciliation.statementOverlap?.disagreements ?? []) {
      issues.push(
        issue(
          "medium",
          `statements:${disagreement.tan ?? disagreement.deductorName}:${disagreement.financialYear}`,
          `Form 26AS and AIS disagree for ${disagreement.deductorName}, FY ${disagreement.financialYear} (26AS ${disagreement.taxPer26AS === undefined ? "no entry" : formatAmount(disagreement.taxPer26AS)}, AIS ${disagreement.taxPerAIS === undefined ? "no entry" : formatAmount(disagreement.taxPerAIS)}).`,
        ),
      );
    }

    return issues;
  };
}

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

/** Reads the first pipe table in markdown; escaped pipes stay inside their cell. */
export function parseMarkdownTable(content: string): MarkdownTable | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));

  if (lines.length < 2) {
    return undefined;
  }

  const cellsOf = (line: string) =>
    line
      .replace(/^\|/, "")
      .replace(/(?<!\\)\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, "|"));
  const [headers = [], ...rest] = lines.map(cellsOf);

  return {
    headers,
    rows: rest.filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell))),
  };
}

/** Amounts in a cell, keeping the sign of "-12,400", "−12,400" (Unicode minus), and "(12,400)". */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/(\()?\s*([-−])?\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(\))?/g)].map((match) => {
    const magnitude = Number((match[3] ?? "").replace(/,/g, ""));
    const negative = Boolean(match[2]) || Boolean(match[1] && match[4]);

    return negative ? -magnitude : magnitude;
  });
}

const VALUE_COLUMN = /tds|difference|amount/i;

export interface ExpectedTableSection {
  title: string;
  content: string;
}

/**
 * Compares the amounts in the current (possibly reviewer-edited) reconciliation table and
 * schedules with tables regenerated from the source records. Cells hold bare numbers without a
 * currency prefix, so rows are matched by their first cell and amount columns by header.
 */
export function scheduleEditsCheck(
  current: readonly UpstreamSection[],
  regenerated: readonly ExpectedTableSection[],
  tolerance = DEFAULT_NUMERIC_TOLERANCE,
): AdditionalCheck {
  return () => {
    const issues: VerificationIssue[] = [];

    for (const section of current) {
      const expectedTable = parseMarkdownTable(
        regenerated.find((entry) => entry.title === section.title)?.content ?? "",
      );

      if (!expectedTable) {
        continue;
      }

      const issue = (key: string, message: string) =>
        issues.push({
          check: "schedule-edit",
          severity: "high",
          key: `${section.title}:${key}`,
          message,
          findingIds: [],
          taskIds: [section.taskId],
        });
      const actualTable = parseMarkdownTable(section.content);

      if (!actualTable) {
        issue(
          "table",
          `"${section.title}" no longer contains its table of source-derived amounts.`,
        );
        continue;
      }

      const valueColumns = expectedTable.headers.flatMap((header, index) =>
        VALUE_COLUMN.test(header) ? [index] : [],
      );
      const hasAmounts = (row: readonly string[], headers: readonly string[]) =>
        headers.some(
          (header, index) => VALUE_COLUMN.test(header) && numbersIn(row[index] ?? "").length > 0,
        );
      const seenKeys = new Set<string>();
      let duplicated = false;

      for (const row of actualTable.rows) {
        const key = row[0] ?? "";

        if (seenKeys.has(key)) {
          duplicated = true;
          issue(
            `duplicate:${key}`,
            `"${section.title}" has more than one row "${key}", so its amounts cannot be checked against the source records.`,
          );
        }

        seenKeys.add(key);
      }

      if (duplicated) {
        continue;
      }

      const actualRows = new Map(actualTable.rows.map((row) => [row[0] ?? "", row]));

      for (const row of expectedTable.rows) {
        const key = row[0] ?? "";
        const actual = actualRows.get(key);

        if (!actual) {
          if (hasAmounts(row, expectedTable.headers)) {
            issue(
              key,
              `"${section.title}" no longer has the row "${key}" from the source records.`,
            );
          }

          continue;
        }

        for (const index of valueColumns) {
          const header = expectedTable.headers[index] ?? "";
          const actualIndex = actualTable.headers.indexOf(header);
          const wanted = numbersIn(row[index] ?? "");
          const shown = actualIndex === -1 ? [] : numbersIn(actual[actualIndex] ?? "");
          const same =
            wanted.length === shown.length &&
            wanted.every((value, position) =>
              numbersAgree(value, shown[position] ?? NaN, tolerance),
            );

          if (!same) {
            issue(
              `${key}:${header}`,
              `"${section.title}" shows "${actualIndex === -1 ? "(column removed)" : (actual[actualIndex] ?? "")}" for ${key}, ${header}, but the source records give "${row[index] ?? ""}".`,
            );
          }
        }
      }

      for (const row of actualTable.rows) {
        const key = row[0] ?? "";

        if (
          !expectedTable.rows.some((expectedRow) => expectedRow[0] === key) &&
          hasAmounts(row, actualTable.headers)
        ) {
          issue(
            key,
            `"${section.title}" has a row "${key}" with amounts that are not in the source records.`,
          );
        }
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
      const regeneratedTables: ExpectedTableSection[] = hasReconciliationData(reconciliation)
        ? [
            {
              title: RECONCILIATION_TABLE_SECTION_TITLE,
              content: reconciliationTableMarkdown(reconciliation),
            },
            ...buildSchedules(reconciliation, noticeFigures(ctx)).sections,
          ]
        : [];
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
          reconciliationDataCheck(
            reconciliation,
            ctx.tasks
              .filter((task) => task.assignedRole === "reconciliation")
              .map((task) => task.id),
          ),
          scheduleEditsCheck(
            ctx.upstreamSections.filter((section) =>
              regeneratedTables.some((table) => table.title === section.title),
            ),
            regeneratedTables,
            tolerance,
          ),
        ],
      });

      return handler.executeAsync(ctx);
    },
  };
}
