import type { Case } from "@evianta/core";
import { DataTable, type DataTableColumn } from "@/components/patterns/data-table";
import { StatusBadge } from "@/components/patterns/status-badge";
import { formatNumber, formatUsd } from "@/lib/format";
import { agentRoleLabels, taskStatusToWorkStatus } from "@/lib/labels";
import type { RunProgress, TaskProgress } from "@/lib/run-progress";

export interface CostPanelProps {
  caseItem: Case;
  progress: RunProgress;
}

const columns: DataTableColumn<TaskProgress>[] = [
  {
    id: "step",
    header: "Step",
    cell: (task) => (
      <div className="flex flex-col">
        <span className="font-medium">{task.title}</span>
        <span className="text-xs text-muted-foreground">{agentRoleLabels[task.assignedRole]}</span>
      </div>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (task) => <StatusBadge status={taskStatusToWorkStatus[task.status]} />,
  },
  {
    id: "tokens",
    header: "Tokens",
    numeric: true,
    cell: (task) => (task.tokenUsage ? formatNumber(task.tokenUsage.total) : "-"),
  },
  {
    id: "cost",
    header: "Cost",
    numeric: true,
    cell: (task) => (task.costEstimate !== undefined ? formatUsd(task.costEstimate) : "-"),
  },
];

export function CostPanel({ caseItem, progress }: CostPanelProps) {
  const runCount = caseItem.usage?.runCount ?? 0;
  return (
    <section aria-labelledby="cost-heading" className="flex flex-col gap-3 print:hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="cost-heading" className="text-base font-semibold">
          Model cost
        </h2>
        <p className="text-xs text-muted-foreground">Tracking only, no budget or limit.</p>
      </div>
      <dl className="grid grid-cols-3 gap-3 rounded-lg border bg-card p-3 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Case total</dt>
          <dd className="figures font-semibold" data-testid="case-cost">
            {formatUsd(progress.totalCost)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Tokens</dt>
          <dd className="figures">{formatNumber(progress.totalTokens)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">Runs</dt>
          <dd className="figures">{formatNumber(runCount)}</dd>
        </div>
      </dl>
      {progress.tasks.length > 0 ? (
        <DataTable
          columns={columns}
          rows={progress.tasks}
          getRowId={(task) => task.id}
          caption="Cost per step"
        />
      ) : null}
    </section>
  );
}
