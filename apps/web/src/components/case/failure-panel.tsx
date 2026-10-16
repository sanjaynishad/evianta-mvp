import { Ban, CircleX, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentRoleLabels } from "@/lib/labels";
import type { TaskProgress } from "@/lib/run-progress";

export interface FailurePanelProps {
  failedTasks: TaskProgress[];
  blockedTasks: TaskProgress[];
  runError?: string;
  // A run can fail during planning or finalization without any failed task.
  runFailed?: boolean;
  canRetry: boolean;
  retrying?: boolean;
  readOnly?: boolean;
  onRetry: () => void;
}

export function FailurePanel({
  failedTasks,
  blockedTasks,
  runError,
  runFailed = false,
  canRetry,
  retrying = false,
  readOnly = false,
  onRetry,
}: FailurePanelProps) {
  const runLevelFailure = failedTasks.length === 0;
  if (runLevelFailure && !(runFailed && runError)) {
    return null;
  }

  const showRunError =
    Boolean(runError) && !failedTasks.some((task) => task.lastError === runError);
  let heading = `${failedTasks.length} steps failed`;
  if (runLevelFailure) {
    heading = "The run stopped";
  } else if (failedTasks.length === 1) {
    heading = "A step failed";
  }

  return (
    <section
      aria-labelledby="failure-heading"
      className="flex flex-col gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-4 print:hidden"
    >
      <div className="flex items-start gap-2">
        <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="flex flex-col gap-1">
          <h2 id="failure-heading" className="text-base font-semibold text-foreground">
            {heading}
          </h2>
          {showRunError ? (
            <p className="text-sm text-foreground" data-testid="run-error">
              {runError}
            </p>
          ) : null}
        </div>
      </div>
      {runLevelFailure ? null : (
        <ul className="flex flex-col gap-2">
          {failedTasks.map((task) => (
            <li key={task.id} className="rounded-md border border-danger/20 bg-background p-3">
              <p className="text-sm font-medium">
                {task.title}{" "}
                <span className="font-normal text-muted-foreground">
                  ({agentRoleLabels[task.assignedRole]})
                </span>
              </p>
              {task.lastError ? (
                <p className="mt-1 text-sm text-danger" data-testid="task-last-error">
                  {task.lastError}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {blockedTasks.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">Waiting on the failed step</p>
          <ul aria-label="Blocked steps" className="flex flex-col gap-1">
            {blockedTasks.map((task) => (
              <li key={task.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Ban aria-hidden className="size-3.5 shrink-0" />
                {task.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {readOnly || runLevelFailure ? null : (
          <Button onClick={onRetry} disabled={!canRetry} loading={retrying}>
            {retrying ? null : <RotateCcw aria-hidden />}
            Retry failed steps
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          {runLevelFailure
            ? "No step failed, so there is nothing to retry. Run the case again to start over."
            : "Completed steps are kept; only failed and waiting steps run again."}
        </p>
      </div>
    </section>
  );
}
