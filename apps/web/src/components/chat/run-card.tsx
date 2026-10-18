"use client";

import { useState } from "react";
import { CheckCircle2, Circle, CircleDashed, Loader2, Maximize2, XCircle } from "lucide-react";
import type { TaskStatus } from "@evianta/core";
import { FailurePanel } from "@/components/case/failure-panel";
import { RunProgressPanel } from "@/components/case/run-progress-panel";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { StreamConnectionState } from "@/lib/data/types";
import { formatUsd } from "@/lib/format";
import { agentRoleLabels } from "@/lib/labels";
import { canRetry, getBlockedTasks, getFailedTasks, type RunProgress } from "@/lib/run-progress";
import { cn } from "@/lib/utils";

const taskStatusText: Record<TaskStatus, string> = {
  pending: "Waiting",
  "in-progress": "Working",
  blocked: "Blocked",
  completed: "Done",
  failed: "Failed",
};

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  if (status === "completed") {
    return <CheckCircle2 aria-hidden className="size-4 text-success" />;
  }

  if (status === "in-progress") {
    return (
      <Loader2
        aria-hidden
        className="size-4 animate-spin text-primary motion-reduce:animate-none"
      />
    );
  }

  if (status === "failed") {
    return <XCircle aria-hidden className="size-4 text-danger" />;
  }

  if (status === "blocked") {
    return <CircleDashed aria-hidden className="size-4 text-warning" />;
  }

  return <Circle aria-hidden className="size-4 text-muted-foreground" />;
}

export interface RunCardProps {
  progress: RunProgress;
  connection?: StreamConnectionState;
  readOnly?: boolean;
  retrying?: boolean;
  onRetry: () => void;
}

export function RunCard({ progress, connection, readOnly, retrying, onRetry }: RunCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const done = progress.tasks.filter((task) => task.status === "completed").length;
  const total = progress.tasks.length;
  const ratio = total > 0 ? done / total : 0;
  const working = progress.tasks.find((task) => task.status === "in-progress");
  const failedTasks = getFailedTasks(progress);
  const headline =
    progress.status === "completed"
      ? "The specialists finished their work"
      : progress.status === "failed"
        ? "The work stopped before it finished"
        : working
          ? `${agentRoleLabels[working.assignedRole]}: ${working.title}`
          : "Planning the work";

  return (
    <div
      data-slot="run-card"
      className="flex w-full flex-col gap-3 rounded-xl border bg-card p-4 shadow-elevation-1"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {progress.mode === "retry" ? "Retrying failed steps" : "Agents at work"}
          </p>
          <p className="truncate text-sm font-semibold" aria-live="polite">
            {headline}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setDetailsOpen(true)}>
          <Maximize2 aria-hidden />
          Watch in detail
        </Button>
      </div>

      <div
        role="progressbar"
        aria-label="Steps completed"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full origin-left rounded-full bg-primary transition-transform duration-slow ease-standard motion-reduce:transition-none",
            progress.status === "failed" && "bg-danger",
          )}
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>

      {total > 0 ? (
        <ol className="grid gap-1.5 sm:grid-cols-2" aria-label="Steps">
          {progress.tasks.map((task) => (
            <li key={task.id} className="flex min-w-0 items-center gap-2 text-sm">
              <TaskStatusIcon status={task.status} />
              <span className="truncate">
                <span className="font-medium">{agentRoleLabels[task.assignedRole]}</span>
                <span className="sr-only">, {taskStatusText[task.status]}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="figures text-foreground">
            {done}/{total}
          </span>{" "}
          steps done
        </span>
        <span>
          <span className="figures text-foreground">{progress.findings.length}</span> findings so
          far
        </span>
        <span>
          Model cost{" "}
          <span className="figures text-foreground">{formatUsd(progress.totalCost)}</span>
        </span>
      </div>

      {progress.status === "failed" || failedTasks.length > 0 ? (
        <FailurePanel
          failedTasks={failedTasks}
          blockedTasks={getBlockedTasks(progress)}
          runError={progress.error}
          runFailed={progress.status === "failed"}
          canRetry={canRetry(progress) && !retrying}
          retrying={retrying}
          readOnly={readOnly}
          onRetry={onRetry}
        />
      ) : null}

      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-xl"
        >
          <SheetHeader>
            <SheetTitle>Run progress</SheetTitle>
            <SheetDescription>Every step the coordinator planned, as it happens.</SheetDescription>
          </SheetHeader>
          <div className="px-5 pb-5">
            <RunProgressPanel progress={progress} connection={connection} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function PastRunNote({ mode }: { mode: "run" | "retry" }) {
  return (
    <p className="text-sm text-muted-foreground">
      {mode === "retry" ? "An earlier retry ran here." : "An earlier run ran here."} The latest run
      is shown below.
    </p>
  );
}
