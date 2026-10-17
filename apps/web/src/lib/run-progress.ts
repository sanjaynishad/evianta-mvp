import type {
  AgentRole,
  CaseState,
  FindingSeverity,
  RunEvent,
  RunMode,
  TaskStatus,
  TokenUsage,
} from "@evianta/core";
import { agentRoleLabels } from "@/lib/labels";

export type RunProgressStatus = "idle" | "running" | "completed" | "failed";

export interface TaskProgress {
  id: string;
  title: string;
  assignedRole: AgentRole;
  status: TaskStatus;
  dependsOn: string[];
  attempts: number;
  lastError?: string;
  tokenUsage?: TokenUsage;
  costEstimate?: number;
  findingIds: string[];
}

export interface FindingProgress {
  id: string;
  taskId: string;
  summary: string;
  severity?: FindingSeverity;
}

export interface RunProgress {
  runId?: string;
  mode: RunMode;
  status: RunProgressStatus;
  tasks: TaskProgress[];
  findings: FindingProgress[];
  totalTokens: number;
  totalCost: number;
  lastSeq: number;
  error?: string;
  announcement: string;
}

function progressStatusFromState(state: CaseState): RunProgressStatus {
  if (state.run.active) {
    return "running";
  }

  if (state.run.lastEventType === "run-failed") {
    return "failed";
  }

  if (state.run.lastEventType === "run-completed") {
    return "completed";
  }

  if (state.case.status === "failed") {
    return "failed";
  }

  return "idle";
}

// Fallback when a failed run left no message, for example state from an older API.
export const runStoppedMessage = "The run stopped before it finished. Run the case again.";

export function createRunProgress(state: CaseState): RunProgress {
  const usage = state.case.usage;
  const status = progressStatusFromState(state);
  const failedTask = state.tasks.find((task) => task.status === "failed");
  let error = failedTask?.lastError;
  if (status === "failed") {
    error = state.run.lastRunError ?? error ?? runStoppedMessage;
  }

  return {
    runId: state.run.lastRunId,
    mode: state.run.lastRunMode ?? "run",
    status,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      assignedRole: task.assignedRole,
      status: task.status,
      dependsOn: task.dependsOn,
      attempts: task.attempts,
      lastError: task.lastError,
      tokenUsage: task.tokenUsage,
      costEstimate: task.costEstimate,
      findingIds: state.findings
        .filter((finding) => finding.taskId === task.id)
        .map((finding) => finding.id),
    })),
    findings: state.findings.map((finding) => ({
      id: finding.id,
      taskId: finding.taskId,
      summary: finding.summary,
      severity: finding.severity,
    })),
    totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    totalCost: usage?.costEstimate ?? 0,
    lastSeq: state.run.lastEventSeq,
    error,
    announcement: "",
  };
}

// The board for replaying the latest run from its first event. The replayed run-started event
// resets what that run touched: every step for a normal run, only the re-run steps for a retry.
export function createReplayProgress(state: CaseState): RunProgress {
  return {
    ...createRunProgress(state),
    status: "running",
    lastSeq: 0,
    error: undefined,
    announcement: "Replaying the recorded run.",
  };
}

function updateTask(
  tasks: TaskProgress[],
  taskId: string,
  update: (task: TaskProgress) => TaskProgress,
): TaskProgress[] {
  return tasks.map((task) => (task.id === taskId ? update(task) : task));
}

function roleLabel(progress: RunProgress, taskId: string): string {
  const task = progress.tasks.find((candidate) => candidate.id === taskId);
  return task ? agentRoleLabels[task.assignedRole] : "A specialist";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function applyRunEvent(progress: RunProgress, event: RunEvent): RunProgress {
  if (event.seq <= progress.lastSeq && progress.runId === event.runId) {
    return progress;
  }

  const next: RunProgress = { ...progress, lastSeq: Math.max(progress.lastSeq, event.seq) };
  switch (event.type) {
    case "run-started": {
      // Both modes name only the steps that will run; completed steps are reused as they are.
      const restarting = new Set(event.taskIds);
      const isRetry = event.mode === "retry";
      return {
        ...next,
        runId: event.runId,
        mode: event.mode,
        status: "running",
        error: undefined,
        findings: progress.findings.filter((finding) => !restarting.has(finding.taskId)),
        tasks: progress.tasks.map((task) =>
          restarting.has(task.id)
            ? {
                ...task,
                status: "pending",
                lastError: undefined,
                tokenUsage: undefined,
                costEstimate: undefined,
                findingIds: [],
              }
            : task,
        ),
        announcement: isRetry ? "Retrying the failed steps." : "Run started.",
      };
    }

    case "task-started": {
      const exists = progress.tasks.some((task) => task.id === event.taskId);
      const started: TaskProgress = {
        id: event.taskId,
        title: event.title,
        assignedRole: event.assignedRole,
        status: "in-progress",
        dependsOn: [],
        attempts: event.attempt,
        findingIds: [],
      };
      return {
        ...next,
        tasks: exists
          ? updateTask(progress.tasks, event.taskId, (task) => ({
              ...task,
              title: event.title,
              assignedRole: event.assignedRole,
              status: "in-progress",
              attempts: event.attempt,
              lastError: undefined,
            }))
          : [...progress.tasks, started],
        announcement: `${agentRoleLabels[event.assignedRole]} started: ${event.title}.`,
      };
    }

    case "task-completed":
      return {
        ...next,
        tasks: updateTask(progress.tasks, event.taskId, (task) => ({
          ...task,
          status: "completed",
          tokenUsage: event.tokenUsage ?? task.tokenUsage,
          costEstimate: event.costEstimate ?? task.costEstimate,
          findingIds: Array.from(new Set([...task.findingIds, ...event.findingIds])),
        })),
        announcement: `${roleLabel(progress, event.taskId)} completed, ${plural(event.findingIds.length, "finding")}.`,
      };

    case "task-failed": {
      const blocked = new Set(event.blockedTaskIds);
      return {
        ...next,
        error: event.error,
        tasks: progress.tasks.map((task) => {
          if (task.id === event.taskId) {
            return { ...task, status: "failed", lastError: event.error };
          }

          return blocked.has(task.id) ? { ...task, status: "blocked" } : task;
        }),
        announcement: `${roleLabel(progress, event.taskId)} failed: ${event.error}`,
      };
    }

    case "finding-added":
      if (progress.findings.some((finding) => finding.id === event.findingId)) {
        return next;
      }

      return {
        ...next,
        findings: [
          ...progress.findings,
          {
            id: event.findingId,
            taskId: event.taskId,
            summary: event.summary,
            severity: event.severity,
          },
        ],
        tasks: updateTask(progress.tasks, event.taskId, (task) => ({
          ...task,
          findingIds: Array.from(new Set([...task.findingIds, event.findingId])),
        })),
        announcement: `New finding: ${event.summary}.`,
      };

    case "cost-updated":
      return {
        ...next,
        totalTokens: event.totalTokenUsage.total,
        totalCost: event.totalCostEstimate,
      };

    case "run-completed":
      return {
        ...next,
        status: "completed",
        totalTokens: event.totalTokenUsage.total,
        totalCost: event.totalCostEstimate,
        announcement: `Run completed with ${plural(progress.findings.length, "finding")}.`,
      };

    case "run-failed":
      return {
        ...next,
        status: "failed",
        error: event.error,
        totalTokens: event.totalTokenUsage?.total ?? progress.totalTokens,
        totalCost: event.totalCostEstimate ?? progress.totalCost,
        announcement: `Run stopped: ${event.error}`,
      };
  }
}

export function getFailedTasks(progress: RunProgress): TaskProgress[] {
  return progress.tasks.filter((task) => task.status === "failed");
}

export function getBlockedTasks(progress: RunProgress): TaskProgress[] {
  return progress.tasks.filter((task) => task.status === "blocked");
}

export function canRetry(progress: RunProgress): boolean {
  return progress.status !== "running" && getFailedTasks(progress).length > 0;
}
