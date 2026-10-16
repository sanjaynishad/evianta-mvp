import type { ReactNode } from "react";
import Link from "next/link";
import type { Case } from "@evianta/core";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime, formatUsd } from "@/lib/format";
import { caseStatusToWorkStatus, useCaseLabels } from "@/lib/labels";

export interface CaseSummaryCardProps {
  caseItem: Case;
  actions?: ReactNode;
}

export function CaseSummaryCard({ caseItem, actions }: CaseSummaryCardProps) {
  const lastRunAt = caseItem.usage?.lastRunAt;
  return (
    <Card interactive data-case-id={caseItem.id} className="flex h-full flex-col">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {caseItem.useCase ? (
            <Badge variant="neutral">{useCaseLabels[caseItem.useCase]}</Badge>
          ) : null}
          <StatusBadge status={caseStatusToWorkStatus[caseItem.status]} />
          {caseItem.isSample ? <Badge variant="info">Sample</Badge> : null}
        </div>
        <CardTitle>
          <Link
            href={`/cases/${encodeURIComponent(caseItem.id)}`}
            className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {caseItem.title}
          </Link>
        </CardTitle>
        {caseItem.description ? (
          <CardDescription className="line-clamp-2">{caseItem.description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="mt-auto flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{lastRunAt ? `Last run ${formatDateTime(lastRunAt)}` : "Not run yet"}</span>
        {caseItem.usage ? (
          <span>
            Model cost{" "}
            <span className="figures text-foreground">
              {formatUsd(caseItem.usage.costEstimate)}
            </span>
          </span>
        ) : null}
      </CardContent>
      {actions ? <CardFooter className="flex-wrap">{actions}</CardFooter> : null}
    </Card>
  );
}
