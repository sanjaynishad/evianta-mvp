import type { UsageCaseRow, UsageSummary, UsageTotals, UseCase } from "@evianta/core";
import { DataTable, type DataTableColumn } from "@/components/patterns/data-table";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatNumber, formatUsd } from "@/lib/format";
import { caseStatusToWorkStatus, useCaseLabels } from "@/lib/labels";

export interface UsageViewProps {
  cases: UsageCaseRow[];
  summary: UsageSummary;
  fixtureMode: boolean;
  nextPageHref?: string;
}

type UseCaseTotalsRow = UsageTotals & { useCase: string };

function labelForUseCase(useCase: string): string {
  return useCase in useCaseLabels ? useCaseLabels[useCase as UseCase] : "No use case";
}

const caseColumns: DataTableColumn<UsageCaseRow>[] = [
  {
    id: "title",
    header: "Case",
    cell: (row) => (
      <div className="flex min-w-48 flex-col">
        <span className="font-medium">{row.title}</span>
        <span className="text-xs text-muted-foreground">
          {row.useCase ? useCaseLabels[row.useCase] : "No use case"}
        </span>
      </div>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (row) => <StatusBadge status={caseStatusToWorkStatus[row.status]} />,
  },
  {
    id: "visitor",
    header: "Visitor",
    cell: (row) =>
      row.visitorId ? (
        <span className="figures text-xs" title={row.visitorId}>
          {row.visitorId.slice(0, 8)}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">None</span>
      ),
  },
  {
    id: "kind",
    header: "Kind",
    cell: (row) =>
      row.isSample ? (
        <Badge variant="info">Sample</Badge>
      ) : row.isCopy ? (
        <Badge variant="outline">Copy</Badge>
      ) : (
        <Badge variant="neutral">Own</Badge>
      ),
  },
  {
    id: "created",
    header: "Created",
    cell: (row) => (
      <span className="whitespace-nowrap text-xs">{formatDateTime(row.createdAt)}</span>
    ),
  },
  {
    id: "lastRun",
    header: "Last run",
    cell: (row) =>
      row.lastRunAt ? (
        <span className="whitespace-nowrap text-xs">{formatDateTime(row.lastRunAt)}</span>
      ) : (
        <span className="text-xs text-muted-foreground">Never</span>
      ),
  },
  {
    id: "documents",
    header: "Docs",
    numeric: true,
    cell: (row) => formatNumber(row.documentCount),
  },
  { id: "runs", header: "Runs", numeric: true, cell: (row) => formatNumber(row.runCount) },
  {
    id: "tokens",
    header: "Tokens",
    numeric: true,
    cell: (row) => formatNumber(row.tokenUsage.total),
  },
  { id: "cost", header: "Cost", numeric: true, cell: (row) => formatUsd(row.costEstimate) },
];

const useCaseColumns: DataTableColumn<UseCaseTotalsRow>[] = [
  { id: "useCase", header: "Use case", cell: (row) => labelForUseCase(row.useCase) },
  { id: "cases", header: "Cases", numeric: true, cell: (row) => formatNumber(row.cases) },
  { id: "runs", header: "Runs", numeric: true, cell: (row) => formatNumber(row.runs) },
  { id: "visitors", header: "Visitors", numeric: true, cell: (row) => formatNumber(row.visitors) },
  {
    id: "tokens",
    header: "Tokens",
    numeric: true,
    cell: (row) => formatNumber(row.tokenUsage.total),
  },
  { id: "cost", header: "Cost", numeric: true, cell: (row) => formatUsd(row.costEstimate) },
];

export function UsageView({ cases, summary, fixtureMode, nextPageHref }: UsageViewProps) {
  const useCaseRows: UseCaseTotalsRow[] = Object.entries(summary.byUseCase).map(
    ([useCase, totals]) => ({ ...totals, useCase }),
  );
  const totals = [
    { label: "Cases", value: formatNumber(summary.totals.cases) },
    { label: "Runs", value: formatNumber(summary.totals.runs) },
    { label: "Visitors", value: formatNumber(summary.totals.visitors) },
    { label: "Tokens", value: formatNumber(summary.totals.tokenUsage.total) },
    { label: "Model cost", value: formatUsd(summary.totals.costEstimate) },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Platform usage</h1>
        <p className="text-sm text-muted-foreground">
          Every case on the platform. Metadata only; documents are not shown here.
          {fixtureMode ? " Showing fixture data because no API is connected." : ""}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {totals.map((total) => (
          <div key={total.label} className="flex flex-col gap-0.5 rounded-lg border bg-card p-3">
            <dt className="text-xs text-muted-foreground">{total.label}</dt>
            <dd className="figures text-lg font-semibold">{total.value}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="usage-by-use-case" className="flex flex-col gap-3">
        <h2 id="usage-by-use-case" className="text-base font-semibold">
          Totals per use case
        </h2>
        <DataTable columns={useCaseColumns} rows={useCaseRows} getRowId={(row) => row.useCase} />
      </section>
      <section aria-labelledby="usage-cases" className="flex flex-col gap-3">
        <h2 id="usage-cases" className="text-base font-semibold">
          Cases, newest first
        </h2>
        <div className="overflow-x-auto">
          <DataTable
            columns={caseColumns}
            rows={cases}
            getRowId={(row) => row.id}
            empty="No cases yet."
          />
        </div>
        {nextPageHref ? (
          <a
            href={nextPageHref}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Next page
          </a>
        ) : null}
      </section>
    </div>
  );
}
