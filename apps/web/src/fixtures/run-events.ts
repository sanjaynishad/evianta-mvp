import type { CaseState, RunEvent, RunMode, Task, TokenUsage } from "@evianta/core";

export interface BuildRunEventsOptions {
  runId: string;
  mode?: RunMode;
  startSeq?: number;
  startTime?: string;
  stepMs?: number;
  // Defaults to every task in the case, in plan order.
  taskIds?: string[];
  failTaskId?: string;
  failError?: string;
  // Cost events carry case totals, so a retry starts from what earlier runs already spent.
  initialUsage?: TokenUsage;
  initialCost?: number;
}

function addUsage(total: TokenUsage, usage: TokenUsage | undefined): TokenUsage {
  if (!usage) {
    return total;
  }

  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    total: total.total + usage.total,
  };
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function collectDependents(tasks: Task[], taskId: string): string[] {
  const dependents = new Set<string>();
  const queue = [taskId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const task of tasks) {
      if (current && task.dependsOn.includes(current) && !dependents.has(task.id)) {
        dependents.add(task.id);
        queue.push(task.id);
      }
    }
  }

  return tasks.filter((task) => dependents.has(task.id)).map((task) => task.id);
}

// Builds a recorded-style event sequence from a finished case state, so replay fixtures stay
// consistent with the case data they describe.
export function buildRunEvents(state: CaseState, options: BuildRunEventsOptions): RunEvent[] {
  const caseId = state.case.id;
  const { runId } = options;
  const included = new Set(options.taskIds ?? state.tasks.map((task) => task.id));
  const tasks = state.tasks.filter((task) => included.has(task.id));
  const blocked = new Set(options.failTaskId ? collectDependents(tasks, options.failTaskId) : []);
  const startMs = Date.parse(
    options.startTime ?? state.latestRun?.startedAt ?? state.case.createdAt,
  );
  const stepMs = options.stepMs ?? 4000;
  let seq = (options.startSeq ?? 1) - 1;
  let usage: TokenUsage = options.initialUsage ?? { input: 0, output: 0, total: 0 };
  let cost = options.initialCost ?? 0;
  const events: RunEvent[] = [];

  function base() {
    seq += 1;
    return {
      caseId,
      runId,
      seq,
      timestamp: new Date(startMs + (events.length + 1) * stepMs).toISOString(),
    };
  }

  events.push({
    ...base(),
    type: "run-started",
    mode: options.mode ?? "run",
    taskIds: tasks.map((task) => task.id),
  });

  for (const task of tasks) {
    if (blocked.has(task.id)) {
      continue;
    }

    events.push({
      ...base(),
      type: "task-started",
      taskId: task.id,
      title: task.title,
      assignedRole: task.assignedRole,
      attempt: options.mode === "retry" ? Math.max(task.attempts, 2) : 1,
    });

    if (task.id === options.failTaskId) {
      events.push({
        ...base(),
        type: "task-failed",
        taskId: task.id,
        error: options.failError ?? "The step could not finish.",
        blockedTaskIds: [...blocked],
      });
      continue;
    }

    const findings = state.findings.filter((finding) => finding.taskId === task.id);
    for (const finding of findings) {
      events.push({
        ...base(),
        type: "finding-added",
        taskId: task.id,
        findingId: finding.id,
        summary: finding.summary,
        severity: finding.severity,
      });
    }

    usage = addUsage(usage, task.tokenUsage);
    cost = roundCost(cost + (task.costEstimate ?? 0));
    events.push({
      ...base(),
      type: "task-completed",
      taskId: task.id,
      findingIds: findings.map((finding) => finding.id),
      tokenUsage: task.tokenUsage,
      costEstimate: task.costEstimate,
    });
    events.push({
      ...base(),
      type: "cost-updated",
      taskId: task.id,
      totalTokenUsage: usage,
      totalCostEstimate: cost,
    });
  }

  if (options.failTaskId) {
    events.push({
      ...base(),
      type: "run-failed",
      error: "One step failed. Completed work is kept; retry the failed steps to continue.",
      failedTaskIds: [options.failTaskId],
      totalTokenUsage: usage,
      totalCostEstimate: cost,
    });
  } else {
    events.push({
      ...base(),
      type: "run-completed",
      deliverableIds: state.deliverables.map((deliverable) => deliverable.id),
      totalTokenUsage: usage,
      totalCostEstimate: cost,
    });
  }

  return events;
}

export interface FailedStateOptions {
  runId: string;
  failTaskId: string;
  failError: string;
  lastEventSeq: number;
}

// The case state left behind by buildRunEvents with the same failTaskId.
export function toFailedCaseState(state: CaseState, options: FailedStateOptions): CaseState {
  const blocked = new Set(collectDependents(state.tasks, options.failTaskId));
  const completedTaskIds = new Set(
    state.tasks
      .filter((task) => task.id !== options.failTaskId && !blocked.has(task.id))
      .map((task) => task.id),
  );
  const tasks = state.tasks.map((task): Task => {
    if (task.id === options.failTaskId) {
      return {
        ...task,
        status: "failed",
        attempts: 1,
        lastError: options.failError,
        tokenUsage: undefined,
        costEstimate: undefined,
      };
    }

    if (blocked.has(task.id)) {
      return {
        ...task,
        status: "blocked",
        attempts: 0,
        tokenUsage: undefined,
        costEstimate: undefined,
      };
    }

    return task;
  });
  const completedTasks = tasks.filter((task) => completedTaskIds.has(task.id));
  const usage = completedTasks.reduce((total, task) => addUsage(total, task.tokenUsage), {
    input: 0,
    output: 0,
    total: 0,
  });
  const cost = roundCost(
    completedTasks.reduce((total, task) => total + (task.costEstimate ?? 0), 0),
  );
  const startedAt = state.latestRun?.startedAt ?? state.case.createdAt;

  return {
    ...state,
    case: {
      ...state.case,
      status: "failed",
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        costEstimate: cost,
        runCount: 1,
        lastRunAt: startedAt,
      },
    },
    tasks,
    findings: state.findings.filter((finding) => completedTaskIds.has(finding.taskId)),
    deliverables: [],
    latestRun: {
      runId: options.runId,
      mode: "run",
      status: "failed",
      startedAt,
      finishedAt: startedAt,
      lastEventSeq: options.lastEventSeq,
    },
  };
}
