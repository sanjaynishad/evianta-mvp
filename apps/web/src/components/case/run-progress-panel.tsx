"use client";

import { Activity, Radio } from "lucide-react";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import { useAutoAnimateList } from "@/hooks/use-auto-animate-list";
import type { StreamConnectionState } from "@/lib/data/types";
import { formatNumber, formatUsd } from "@/lib/format";
import { agentRoleLabels, findingSeverityLabels, taskStatusToWorkStatus } from "@/lib/labels";
import type { RunProgress } from "@/lib/run-progress";

export interface RunProgressPanelProps {
  progress: RunProgress;
  replaying?: boolean;
  connection?: StreamConnectionState;
}

const runStatusLabels: Record<RunProgress["status"], string> = {
  idle: "Not started",
  running: "Running",
  completed: "Completed",
  failed: "Stopped",
};

export function RunProgressPanel({
  progress,
  replaying = false,
  connection,
}: RunProgressPanelProps) {
  const taskListRef = useAutoAnimateList<HTMLOListElement>();
  const findingListRef = useAutoAnimateList<HTMLUListElement>();
  const doneCount = progress.tasks.filter((task) => task.status === "completed").length;
  const total = progress.tasks.length;
  const ratio = total > 0 ? doneCount / total : 0;
  const workStatus =
    progress.status === "running"
      ? "running"
      : progress.status === "completed"
        ? "completed"
        : progress.status === "failed"
          ? "failed"
          : "pending";

  return (
    <section
      aria-labelledby="progress-heading"
      aria-busy={progress.status === "running"}
      className="flex flex-col gap-4 rounded-lg border bg-card p-4 shadow-elevation-1 print:hidden"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Activity aria-hidden className="size-4 text-muted-foreground" />
        <h2 id="progress-heading" className="text-base font-semibold">
          Progress
        </h2>
        <StatusBadge status={workStatus} label={runStatusLabels[progress.status]} />
        {replaying ? (
          <Badge variant="info">
            <Radio aria-hidden />
            Replay of a recorded run
          </Badge>
        ) : null}
        {connection === "reconnecting" ? <Badge variant="warning">Reconnecting</Badge> : null}
        <div className="ml-auto flex items-baseline gap-3 text-sm">
          <span className="text-muted-foreground">Model cost</span>
          <span className="figures font-medium" data-testid="running-cost">
            {formatUsd(progress.totalCost)}
          </span>
          <span className="figures text-xs text-muted-foreground">
            {formatNumber(progress.totalTokens)} tokens
          </span>
        </div>
      </div>

      {total > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              {doneCount} of {total} steps done
            </span>
          </div>
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
              style={{ transform: `scaleX(${ratio})` }}
            />
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {progress.status === "running"
            ? "The coordinator is planning the steps."
            : "Run the case to see each specialist's steps here."}
        </p>
      )}

      {total > 0 ? (
        <ol
          ref={taskListRef}
          aria-label="Steps"
          className="flex flex-col divide-y rounded-md border"
        >
          {progress.tasks.map((task) => (
            <li
              key={task.id}
              data-task-id={task.id}
              data-task-status={task.status}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{task.title}</span>
                <span className="text-xs text-muted-foreground">
                  {agentRoleLabels[task.assignedRole]}
                  {task.attempts > 1 ? ` · attempt ${task.attempts}` : ""}
                </span>
              </div>
              {task.costEstimate !== undefined ? (
                <span className="figures text-xs text-muted-foreground">
                  {formatUsd(task.costEstimate)}
                </span>
              ) : null}
              <StatusBadge status={taskStatusToWorkStatus[task.status]} />
            </li>
          ))}
        </ol>
      ) : null}

      {progress.findings.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Findings so far</h3>
          <ul ref={findingListRef} className="flex flex-col gap-1.5">
            {progress.findings.map((finding) => (
              <li key={finding.id} className="flex items-start gap-2 text-sm">
                {finding.severity ? (
                  <Badge
                    variant={
                      finding.severity === "high"
                        ? "danger"
                        : finding.severity === "medium"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {findingSeverityLabels[finding.severity]}
                  </Badge>
                ) : null}
                <span>{finding.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="run-announcer">
        {progress.announcement}
      </p>
    </section>
  );
}
