"use client";

import {
  Activity,
  BarChart3,
  CircleDot,
  FileSearch,
  Landmark,
  Network,
  Scale,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { AgentRole } from "@evianta/core";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/patterns/status-badge";
import { useMotionSafe } from "@/hooks/use-motion-safe";
import type { StreamConnectionState } from "@/lib/data/types";
import { formatNumber, formatUsd } from "@/lib/format";
import { agentRoleLabels, findingSeverityLabels, taskStatusToWorkStatus } from "@/lib/labels";
import type { RunProgress, TaskProgress } from "@/lib/run-progress";

const laneWidth = 260;
const nodeWidth = 220;
const nodeHeight = 104;
const laneGap = 24;
const rowHeight = nodeHeight + laneGap;

const roleIcons: Partial<Record<AgentRole, LucideIcon>> = {
  coordinator: Network,
  "business-data-analyst": BarChart3,
  "case-analysis": Search,
  reconciliation: Scale,
  "tax-research": Landmark,
  "response-preparation": FileSearch,
  "document-analysis": FileSearch,
  "payment-reconciliation": Scale,
  "evidence-analysis": Search,
  "legal-research": Landmark,
  "case-preparation": Users,
  "independent-review": ShieldCheck,
};

export interface TaskGraphNode {
  task: TaskProgress;
  column: number;
  row: number;
}

export interface TaskGraphLayout {
  nodes: TaskGraphNode[];
  columns: number;
  rows: number;
}

export function layoutTaskGraph(tasks: TaskProgress[]): TaskGraphLayout {
  const columns = new Map(tasks.map((task) => [task.id, 0]));

  for (let pass = 0; pass < tasks.length; pass += 1) {
    let changed = false;
    for (const task of tasks) {
      const column = Math.max(
        0,
        ...task.dependsOn
          .map((dependency) => columns.get(dependency))
          .filter((value): value is number => value !== undefined)
          .map((value) => value + 1),
      );
      if (column > (columns.get(task.id) ?? 0)) {
        columns.set(task.id, column);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  const rowsByColumn = new Map<number, number>();
  const nodes = tasks.map((task) => {
    const column = columns.get(task.id) ?? 0;
    const row = rowsByColumn.get(column) ?? 0;
    rowsByColumn.set(column, row + 1);
    return { task, column, row };
  });

  return {
    nodes,
    columns: Math.max(1, ...nodes.map((node) => node.column + 1)),
    rows: Math.max(1, ...rowsByColumn.values()),
  };
}

function statusLabel(task: TaskProgress): string {
  switch (task.status) {
    case "in-progress":
      return "Working";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    default:
      return "Waiting";
  }
}

function TaskCard({
  task,
  tasks,
  graph = false,
}: {
  task: TaskProgress;
  tasks: TaskProgress[];
  graph?: boolean;
}) {
  const Icon = roleIcons[task.assignedRole] ?? CircleDot;
  const tokenCount = task.tokenUsage ? task.tokenUsage.input + task.tokenUsage.output : undefined;
  const dependencies = task.dependsOn.map(
    (dependency) => tasks.find((candidate) => candidate.id === dependency)?.title ?? dependency,
  );
  const dependencyLabel = dependencies.length > 0 ? ` Depends on: ${dependencies.join(", ")}.` : "";

  return (
    <article
      className="flex min-h-[104px] min-w-0 flex-col justify-between rounded-lg border bg-card p-3 shadow-elevation-1"
      data-agent-role={task.assignedRole}
      data-agent-status={task.status}
      aria-label={`${agentRoleLabels[task.assignedRole]}: ${statusLabel(task)}. ${task.title}.${dependencyLabel}`}
      style={graph ? { width: nodeWidth, height: nodeHeight } : undefined}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary-subtle text-primary">
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-muted-foreground">
            {agentRoleLabels[task.assignedRole]}
          </p>
          <p className="truncate text-sm font-semibold" title={task.title}>
            {task.title}
          </p>
        </div>
        <StatusBadge status={taskStatusToWorkStatus[task.status]} label={statusLabel(task)} />
      </div>
      {dependencies.length > 0 ? (
        <p
          className="truncate pl-10 text-[11px] text-muted-foreground"
          title={`Depends on: ${dependencies.join(", ")}`}
        >
          Depends on: {dependencies.join(", ")}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 pl-10 text-[11px] text-muted-foreground">
        <span className="truncate">
          {task.status === "in-progress" ? "Working now" : `${task.findingIds.length} findings`}
        </span>
        <span className="figures shrink-0">
          {tokenCount !== undefined ? `${formatNumber(tokenCount)} tokens` : ""}
          {task.costEstimate !== undefined ? ` · ${formatUsd(task.costEstimate)}` : ""}
        </span>
      </div>
    </article>
  );
}

function Graph({ tasks }: { tasks: TaskProgress[] }) {
  const layout = layoutTaskGraph(tasks);
  const byId = new Map(layout.nodes.map((node) => [node.task.id, node]));
  const width = layout.columns * laneWidth - laneGap;
  const height = layout.rows * rowHeight - laneGap;

  return (
    <div className="overflow-x-auto pb-2">
      <div className="relative" style={{ width, height }}>
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          {layout.nodes.flatMap(({ task, column, row }) =>
            task.dependsOn.flatMap((dependency) => {
              const source = byId.get(dependency);
              if (!source) {
                return [];
              }

              const startX = source.column * laneWidth + nodeWidth;
              const startY = source.row * rowHeight + nodeHeight / 2;
              const endX = column * laneWidth;
              const endY = row * rowHeight + nodeHeight / 2;
              const curve = Math.max(28, (endX - startX) / 2);
              const completed = source.task.status === "completed" && task.status !== "pending";
              return [
                <path
                  key={`${dependency}-${task.id}`}
                  d={`M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className={completed ? "text-primary/65" : "text-border"}
                  strokeDasharray={completed ? undefined : "4 5"}
                />,
              ];
            }),
          )}
        </svg>
        <ol
          aria-label="Specialist agents and their work"
          className="absolute inset-0 m-0 list-none p-0"
        >
          {layout.nodes.map(({ task, column, row }) => (
            <li
              key={task.id}
              className={
                task.status === "in-progress"
                  ? "absolute animate-evidence-pulse motion-reduce:animate-none"
                  : "absolute"
              }
              style={{
                left: column * laneWidth,
                top: row * rowHeight,
                width: nodeWidth,
                height: nodeHeight,
              }}
            >
              <TaskCard task={task} tasks={tasks} graph />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export interface MissionControlProps {
  progress: RunProgress;
  replaying?: boolean;
  replayLabel?: string;
  connection?: StreamConnectionState;
}

export function MissionControl({
  progress,
  replaying = false,
  replayLabel = "Replay of fixture-generated sample events",
  connection,
}: MissionControlProps) {
  const { reduced } = useMotionSafe();
  const doneCount = progress.tasks.filter((task) => task.status === "completed").length;
  const columnCount = layoutTaskGraph(progress.tasks).columns;
  const status =
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
      className="flex flex-col gap-4 rounded-lg border bg-card p-4 shadow-elevation-1 print:hidden"
      data-testid="mission-control"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Activity aria-hidden className="size-4 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="progress-heading" className="text-base font-semibold">
            Mission Control
          </h2>
          <p className="text-xs text-muted-foreground">
            {progress.tasks.length > 0
              ? `${doneCount} of ${progress.tasks.length} steps complete across ${columnCount} ${columnCount === 1 ? "stage" : "stages"}`
              : progress.status === "running"
                ? "The coordinator is planning the work."
                : "Run the case to see how specialist work is coordinated."}
          </p>
        </div>
        <StatusBadge status={status} label={progress.status} />
        {replaying ? <Badge variant="info">{replayLabel}</Badge> : null}
        {connection === "reconnecting" ? <Badge variant="warning">Reconnecting</Badge> : null}
        <div className="flex items-baseline gap-2 text-sm">
          <span className="figures font-medium">{formatUsd(progress.totalCost)}</span>
          <span className="figures text-xs text-muted-foreground">
            {formatNumber(progress.totalTokens)} tokens
          </span>
        </div>
      </div>

      {progress.tasks.length > 0 ? (
        reduced ? (
          <ol aria-label="Specialist steps" className="flex flex-col gap-2">
            {progress.tasks.map((task) => (
              <li key={task.id}>
                <TaskCard task={task} tasks={progress.tasks} />
              </li>
            ))}
          </ol>
        ) : (
          <div className="hidden md:block">
            <Graph tasks={progress.tasks} />
          </div>
        )
      ) : null}
      {progress.tasks.length > 0 && !reduced ? (
        <ol aria-label="Specialist steps" className="flex flex-col gap-2 md:hidden">
          {progress.tasks.map((task) => (
            <li key={task.id}>
              <TaskCard task={task} tasks={progress.tasks} />
            </li>
          ))}
        </ol>
      ) : null}

      {progress.findings.length > 0 ? (
        <div className="flex flex-col gap-2 border-t pt-3">
          <h3 className="text-sm font-medium">Findings so far</h3>
          <ul className="flex flex-col gap-1.5">
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
    </section>
  );
}
