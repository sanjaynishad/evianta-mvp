"use client";

import { CaseContextLabel } from "@/components/shell/app-shell";
import { Badge } from "@/components/ui/badge";
import { useResource } from "@/hooks/use-resource";
import { useDataSource } from "@/lib/data/data-source-context";
import { useCaseLabels } from "@/lib/labels";

export interface CaseContextTitleProps {
  caseId: string;
}

export function CaseContextTitle({ caseId }: CaseContextTitleProps) {
  const dataSource = useDataSource();
  const caseState = useResource(`case-context:${caseId}`, () =>
    dataSource.getCaseStateAsync(caseId),
  );
  const caseItem = caseState.data?.case;
  return (
    <CaseContextLabel
      eyebrow={caseItem?.useCase ? useCaseLabels[caseItem.useCase] : "Case"}
      title={caseItem?.title ?? (caseState.error ? "Case unavailable" : "Loading case")}
      meta={caseItem?.isSample ? <Badge variant="info">Sample</Badge> : undefined}
    />
  );
}
