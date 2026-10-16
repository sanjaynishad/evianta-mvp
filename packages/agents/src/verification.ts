import type { FigureComponent, Finding, OpenQuestionSeverity } from "@evianta/core";

export type VerificationCheck =
  "numeric-total" | "evidence-presence" | "figure-consistency" | "date-consistency" | (string & {});

export interface VerificationIssue {
  check: VerificationCheck;
  severity: OpenQuestionSeverity;
  message: string;
  findingIds: string[];
  taskIds: string[];
  key?: string;
}

export interface VerificationReport {
  passed: boolean;
  issues: VerificationIssue[];
  checkedFindings: number;
  checkedClaims: number;
}

export interface NumericClaim {
  key: string;
  label: string;
  claimed: number;
  components: FigureComponent[];
  findingId?: string;
  taskId?: string;
}

export const DEFAULT_NUMERIC_TOLERANCE = 0.01;

export type VerificationFinding = Pick<
  Finding,
  "id" | "taskId" | "summary" | "severity" | "evidence" | "figures" | "dates"
>;

export type AdditionalCheck = (findings: readonly VerificationFinding[]) => VerificationIssue[];

export interface DeterministicCheckOptions {
  /** Absolute tolerance for numeric comparisons. */
  tolerance?: number;
  /** Extra plain-TypeScript checks, for example use-case reconciliations. */
  additionalChecks?: readonly AdditionalCheck[];
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function formatNumber(value: number): string {
  return round(value).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function recomputeTotal(components: readonly FigureComponent[]): number {
  return round(components.reduce((sum, component) => sum + component.value, 0));
}

export function numbersAgree(
  left: number,
  right: number,
  tolerance = DEFAULT_NUMERIC_TOLERANCE,
): boolean {
  return Math.abs(left - right) <= tolerance;
}

/** Recomputes each claimed total from its components and reports any that disagree. */
export function checkNumericClaims(
  claims: readonly NumericClaim[],
  tolerance = DEFAULT_NUMERIC_TOLERANCE,
): VerificationIssue[] {
  return claims.flatMap((claim) => {
    if (claim.components.length === 0) {
      return [];
    }

    const recomputed = recomputeTotal(claim.components);

    if (numbersAgree(recomputed, claim.claimed, tolerance)) {
      return [];
    }

    return [
      {
        check: "numeric-total",
        severity: "high",
        key: claim.key,
        message: `"${claim.label}" is stated as ${formatNumber(claim.claimed)} but its components add up to ${formatNumber(recomputed)} (difference ${formatNumber(claim.claimed - recomputed)}).`,
        findingIds: claim.findingId ? [claim.findingId] : [],
        taskIds: claim.taskId ? [claim.taskId] : [],
      },
    ];
  });
}

export function numericClaimsFromFindings(
  findings: readonly VerificationFinding[],
): NumericClaim[] {
  return findings.flatMap((finding) =>
    (finding.figures ?? [])
      .filter((figure) => (figure.components?.length ?? 0) > 0)
      .map((figure) => ({
        key: figure.key,
        label: figure.label,
        claimed: figure.value,
        components: figure.components ?? [],
        findingId: finding.id,
        taskId: finding.taskId,
      })),
  );
}

/** High or medium severity findings, and any finding that states figures, must cite evidence. */
export function isMaterialFinding(finding: VerificationFinding): boolean {
  return (
    finding.severity === "high" ||
    finding.severity === "medium" ||
    (finding.figures?.length ?? 0) > 0
  );
}

export function checkEvidencePresence(
  findings: readonly VerificationFinding[],
): VerificationIssue[] {
  return findings
    .filter((finding) => isMaterialFinding(finding) && finding.evidence.length === 0)
    .map((finding) => ({
      check: "evidence-presence",
      severity: finding.severity === "high" ? "high" : "medium",
      message: `"${finding.summary}" is a material finding without any cited evidence.`,
      findingIds: [finding.id],
      taskIds: [finding.taskId],
    }));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function checkFigureConsistency(
  findings: readonly VerificationFinding[],
  tolerance = DEFAULT_NUMERIC_TOLERANCE,
): VerificationIssue[] {
  const byKey = new Map<
    string,
    Array<{ value: number; label: string; finding: VerificationFinding }>
  >();

  for (const finding of findings) {
    for (const figure of finding.figures ?? []) {
      const entries = byKey.get(figure.key) ?? [];
      entries.push({ value: figure.value, label: figure.label, finding });
      byKey.set(figure.key, entries);
    }
  }

  const issues: VerificationIssue[] = [];

  for (const [key, entries] of byKey) {
    const first = entries[0];

    if (!first || entries.every((entry) => numbersAgree(entry.value, first.value, tolerance))) {
      continue;
    }

    const values = unique(entries.map((entry) => formatNumber(entry.value)));

    issues.push({
      check: "figure-consistency",
      severity: "high",
      key,
      message: `"${first.label}" has conflicting values across findings: ${values.join(" vs ")}.`,
      findingIds: unique(entries.map((entry) => entry.finding.id)),
      taskIds: unique(entries.map((entry) => entry.finding.taskId)),
    });
  }

  return issues;
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  const parsed = new Date(trimmed);

  return Number.isNaN(parsed.getTime()) ? trimmed.toLowerCase() : parsed.toISOString().slice(0, 10);
}

export function checkDateConsistency(
  findings: readonly VerificationFinding[],
): VerificationIssue[] {
  const byKey = new Map<
    string,
    Array<{ date: string; label: string; finding: VerificationFinding }>
  >();

  for (const finding of findings) {
    for (const entry of finding.dates ?? []) {
      const entries = byKey.get(entry.key) ?? [];
      entries.push({ date: normalizeDate(entry.date), label: entry.label, finding });
      byKey.set(entry.key, entries);
    }
  }

  const issues: VerificationIssue[] = [];

  for (const [key, entries] of byKey) {
    const dates = unique(entries.map((entry) => entry.date));

    if (dates.length <= 1) {
      continue;
    }

    issues.push({
      check: "date-consistency",
      severity: "medium",
      key,
      message: `"${entries[0]?.label ?? key}" has conflicting dates across findings: ${dates.join(" vs ")}.`,
      findingIds: unique(entries.map((entry) => entry.finding.id)),
      taskIds: unique(entries.map((entry) => entry.finding.taskId)),
    });
  }

  return issues;
}

/** Plain-TypeScript verification that runs before any model review, at no model cost. */
export function runDeterministicChecks(
  findings: readonly VerificationFinding[],
  options: DeterministicCheckOptions = {},
): VerificationReport {
  const tolerance = options.tolerance ?? DEFAULT_NUMERIC_TOLERANCE;
  const claims = numericClaimsFromFindings(findings);
  const issues = [
    ...checkNumericClaims(claims, tolerance),
    ...checkEvidencePresence(findings),
    ...checkFigureConsistency(findings, tolerance),
    ...checkDateConsistency(findings),
    ...(options.additionalChecks ?? []).flatMap((check) => check(findings)),
  ];

  return {
    passed: issues.length === 0,
    issues,
    checkedFindings: findings.length,
    checkedClaims: claims.length,
  };
}
