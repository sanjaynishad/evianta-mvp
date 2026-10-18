"use client";

import { ArrowDown, FileText, ShieldAlert } from "lucide-react";
import type { Case, CaseState } from "@evianta/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatNumber, formatUsd } from "@/lib/format";
import { caseStatusToWorkStatus, useCaseLabels } from "@/lib/labels";
import type { ApprovalSummary } from "@/lib/review";
import type { RunProgress } from "@/lib/run-progress";
import { StatusBadge } from "../patterns/status-badge";
import { useReview } from "./review-context";

export interface ReviewBriefProps {
  caseItem: Case;
  state: CaseState;
  summary: ApprovalSummary;
  progress: RunProgress;
}

export function ReviewBrief({ caseItem, state, summary, progress }: ReviewBriefProps) {
  const review = useReview();
  const linkedFindings = state.findings.filter((finding) => finding.evidence.length > 0).length;
  const unresolved = summary.unresolved;
  const highPriority = unresolved.filter((item) => item.question.severity === "high").length;
  const plannedRoles = [...new Set(state.tasks.map((task) => task.assignedRole))];
  const confidence = summary.evidenceConfidence;
  const hasEvidenceConfidence =
    confidence.high + confidence.medium + confidence.low + confidence.unassessed > 0;
  const firstSection = state.deliverables.flatMap((deliverable) => deliverable.sections)[0];
  const headline =
    state.deliverables.length === 0
      ? "Your review brief will appear when the work is ready."
      : unresolved.length === 0
        ? "Review-ready work prepared."
        : `${unresolved.length} open ${unresolved.length === 1 ? "item" : "items"} need your review.`;

  return (
    <section
      aria-labelledby="review-brief-heading"
      className="flex flex-col gap-4 rounded-xl border border-primary/15 bg-card p-4 shadow-elevation-1 sm:p-5"
      data-testid="review-brief"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Case review brief
            </p>
            {caseItem.useCase ? (
              <Badge variant="neutral">{useCaseLabels[caseItem.useCase]}</Badge>
            ) : null}
            <StatusBadge status={caseStatusToWorkStatus[caseItem.status]} />
          </div>
          <h2 id="review-brief-heading" className="text-lg font-semibold">
            {headline}
          </h2>
          <p className="text-sm text-muted-foreground">
            {state.deliverables.length > 0
              ? "Review the source-linked work and resolve any open questions before approval."
              : "Specialists will assemble findings, evidence, and deliverables here."}
          </p>
        </div>
        {firstSection ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => review.focusSection(firstSection.id)}
            aria-label="Review the first deliverable section"
          >
            <ArrowDown aria-hidden />
            Review work
          </Button>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-md border bg-background/70 px-3 py-2">
          <dt className="text-xs text-muted-foreground">Findings with sources</dt>
          <dd className="figures mt-1 text-lg font-semibold">
            {formatNumber(linkedFindings)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              / {formatNumber(state.findings.length)}
            </span>
          </dd>
        </div>
        <div className="rounded-md border bg-background/70 px-3 py-2">
          <dt className="text-xs text-muted-foreground">Open questions</dt>
          <dd className="figures mt-1 text-lg font-semibold">
            {formatNumber(unresolved.length)}
            {highPriority > 0 ? (
              <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-danger">
                <ShieldAlert aria-hidden className="size-3.5" />
                {highPriority} high
              </span>
            ) : null}
          </dd>
        </div>
        <div className="rounded-md border bg-background/70 px-3 py-2">
          <dt className="text-xs text-muted-foreground">Source documents</dt>
          <dd className="figures mt-1 flex items-center gap-1.5 text-lg font-semibold">
            <FileText aria-hidden className="size-4 text-muted-foreground" />
            {formatNumber(state.documents.length)}
          </dd>
        </div>
        <div className="rounded-md border bg-background/70 px-3 py-2">
          <dt className="text-xs text-muted-foreground">Model cost so far</dt>
          <dd className="figures mt-1 text-lg font-semibold">{formatUsd(progress.totalCost)}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs text-muted-foreground">
        <span>
          {formatNumber(plannedRoles.length)} specialist{" "}
          {plannedRoles.length === 1 ? "role" : "roles"} in the plan
        </span>
        {hasEvidenceConfidence ? (
          <span>
            Source confidence: {formatNumber(confidence.high)} high ·{" "}
            {formatNumber(confidence.medium)} medium · {formatNumber(confidence.low)} low ·{" "}
            {formatNumber(confidence.unassessed)} unassessed
          </span>
        ) : null}
        <span>
          {progress.totalTokens > 0
            ? `${formatNumber(progress.totalTokens)} tokens`
            : "No model usage recorded"}
        </span>
      </div>

      {unresolved.length > 0 ? (
        <ul aria-label="Open review items" className="flex flex-col gap-1.5">
          {unresolved.slice(0, 3).map(({ question, finding }) => (
            <li key={question.id}>
              <button
                type="button"
                onClick={() => review.focusFinding(finding.id)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Badge
                  variant={
                    question.severity === "high"
                      ? "danger"
                      : question.severity === "medium"
                        ? "warning"
                        : "neutral"
                  }
                  className="mt-0.5 shrink-0"
                >
                  {question.severity}
                </Badge>
                <span className="min-w-0 flex-1">{question.text}</span>
              </button>
            </li>
          ))}
          {unresolved.length > 3 ? (
            <li className="px-2 text-xs text-muted-foreground">
              + {formatNumber(unresolved.length - 3)} more open items
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
