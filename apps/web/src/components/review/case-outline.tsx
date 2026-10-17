"use client";

import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  ListChecks,
  LoaderCircle,
  PencilLine,
  type LucideIcon,
} from "lucide-react";
import type { Case, DeliverableSection, TaskStatus } from "@evianta/core";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import { formatNumber, formatUsd } from "@/lib/format";
import { agentRoleLabels, sectionReviewLabels } from "@/lib/labels";
import type { OutlineGroup, OpenQuestionItem } from "@/lib/review";
import { findingsDomId, openQuestionsDomId, severityOrder } from "@/lib/review";
import type { RunProgress } from "@/lib/run-progress";
import { cn } from "@/lib/utils";
import { severityBadgeVariants } from "./inline-findings";
import { useReview } from "./review-context";

const taskIcons: Record<TaskStatus, { icon: LucideIcon; className: string; label: string }> = {
  pending: { icon: CircleDashed, className: "text-muted-foreground", label: "Queued" },
  "in-progress": {
    icon: LoaderCircle,
    className: "animate-spin text-primary motion-reduce:animate-none",
    label: "In progress",
  },
  blocked: { icon: CircleAlert, className: "text-warning", label: "Blocked" },
  completed: { icon: CircleCheck, className: "text-success", label: "Done" },
  failed: { icon: CircleX, className: "text-danger", label: "Failed" },
};

function SectionStatusIcon({ section }: { section: DeliverableSection }) {
  if (section.reviewStatus === "approved") {
    return <CircleCheck aria-hidden className="size-3.5 shrink-0 text-success" />;
  }

  if (section.reviewStatus === "needs-changes") {
    return <CircleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />;
  }

  return <CircleDashed aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}

const runStatusLabels: Record<RunProgress["status"], string> = {
  idle: "Not started",
  running: "Running",
  completed: "Completed",
  failed: "Stopped",
};

export interface CaseOutlineProps {
  caseItem: Case;
  progress: RunProgress;
  groups: OutlineGroup[];
  questions: OpenQuestionItem[];
  localOpenNotes: number;
  findingCount: number;
}

export function CaseOutline({
  caseItem,
  progress,
  groups,
  questions,
  localOpenNotes,
  findingCount,
}: CaseOutlineProps) {
  const review = useReview();
  const doneCount = progress.tasks.filter((task) => task.status === "completed").length;
  const total = progress.tasks.length;
  const openQuestions = questions.filter((item) => item.question.status === "open");
  const runWorkStatus =
    progress.status === "running"
      ? "running"
      : progress.status === "completed"
        ? "completed"
        : progress.status === "failed"
          ? "failed"
          : "pending";

  return (
    <nav aria-label="Case outline" className="flex flex-col gap-5 text-sm">
      <section aria-labelledby="outline-progress-heading" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id="outline-progress-heading"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Run status
          </h2>
          <StatusBadge status={runWorkStatus} label={runStatusLabels[progress.status]} />
        </div>
        {total > 0 ? (
          <>
            <span className="text-xs text-muted-foreground">
              {doneCount} of {total} steps done
            </span>
            <div
              role="progressbar"
              aria-label="Steps completed"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={doneCount}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full origin-left rounded-full bg-primary transition-transform duration-slow ease-standard"
                style={{ transform: `scaleX(${total > 0 ? doneCount / total : 0})` }}
              />
            </div>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">No steps planned yet.</span>
        )}
        <dl className="grid grid-cols-3 gap-2 rounded-md border bg-card p-2">
          <div className="flex flex-col">
            <dt className="text-[11px] text-muted-foreground">Model cost</dt>
            <dd className="figures font-semibold" data-testid="running-cost">
              {formatUsd(progress.totalCost)}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-[11px] text-muted-foreground">Tokens</dt>
            <dd className="figures">{formatNumber(progress.totalTokens)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-[11px] text-muted-foreground">Runs</dt>
            <dd className="figures">{formatNumber(caseItem.usage?.runCount ?? 0)}</dd>
          </div>
        </dl>
        <p className="text-[11px] text-muted-foreground">
          Cost is tracked only; there is no budget or limit.
        </p>
      </section>

      {groups.map((group) => (
        <section
          key={group.id}
          aria-labelledby={`outline-${group.id}`}
          className="flex flex-col gap-1.5"
        >
          <h2
            id={`outline-${group.id}`}
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {group.label}
          </h2>
          {group.sections.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {group.sections.map(({ section }) => (
                <li key={section.id}>
                  <button
                    type="button"
                    onClick={() => review.focusSection(section.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <SectionStatusIcon section={section} />
                    <span className="min-w-0 flex-1 truncate">{section.title}</span>
                    {section.editedContent !== undefined ? (
                      <PencilLine aria-hidden className="size-3.5 shrink-0 text-highlight" />
                    ) : null}
                    <span className="sr-only">
                      , {sectionReviewLabels[section.reviewStatus]}
                      {section.editedContent !== undefined ? ", edited by reviewer" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {group.tasks.length > 0 ? (
            <ul aria-label={`${group.label} steps`} className="flex flex-col gap-1 pl-2">
              {group.tasks.map((task) => {
                const meta = taskIcons[task.status];
                const Icon = meta.icon;
                return (
                  <li
                    key={task.id}
                    data-outline-task={task.id}
                    data-task-status={task.status}
                    className="flex items-start gap-2 text-xs text-muted-foreground"
                  >
                    <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", meta.className)} />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground">{task.title}</span>
                      <span className="block">
                        {agentRoleLabels[task.assignedRole]}
                        <span className="sr-only">, {meta.label}</span>
                      </span>
                    </span>
                    {task.costEstimate !== undefined ? (
                      <span className="figures">{formatUsd(task.costEstimate)}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ))}

      <section aria-labelledby="outline-questions" className="flex flex-col gap-1.5">
        <h2
          id="outline-questions"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Open questions
        </h2>
        <button
          type="button"
          onClick={() => review.focusElement(openQuestionsDomId)}
          className="flex w-full flex-wrap items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ListChecks aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1">
            {openQuestions.length + localOpenNotes === 0
              ? "Nothing open"
              : `${openQuestions.length + localOpenNotes} open`}
          </span>
          {severityOrder.map((severity) => {
            const count = openQuestions.filter(
              (item) => item.question.severity === severity,
            ).length;
            return count > 0 ? (
              <Badge key={severity} variant={severityBadgeVariants[severity]}>
                {count} {severity}
              </Badge>
            ) : null;
          })}
        </button>
        {findingCount > 0 ? (
          <button
            type="button"
            onClick={() => review.focusElement(findingsDomId)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            All findings ({findingCount})
          </button>
        ) : null}
      </section>
    </nav>
  );
}
