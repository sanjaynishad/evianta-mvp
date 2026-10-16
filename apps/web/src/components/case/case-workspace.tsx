"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { FileStack, History, Play, TriangleAlert } from "lucide-react";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCaseWorkspace } from "@/hooks/use-case-workspace";
import { useTryCase } from "@/hooks/use-try-case";
import { ApiError, describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";
import { buildEvidenceIndex, numberEvidenceReferences } from "@/lib/evidence";
import { caseStatusToWorkStatus, useCaseLabels } from "@/lib/labels";
import { canRetry, getBlockedTasks, getFailedTasks } from "@/lib/run-progress";
import { CostPanel } from "./cost-panel";
import { DeliverableView } from "./deliverable-view";
import { DocumentPanel } from "./document-panel";
import { EvidenceAppendix } from "./evidence-appendix";
import { EvidenceDrawer } from "./evidence-drawer";
import { ExportMenu } from "./export-menu";
import { FailurePanel } from "./failure-panel";
import { FindingsList } from "./findings-list";
import { FixtureModeNotice } from "./fixture-mode-notice";
import { RunProgressPanel } from "./run-progress-panel";
import { SampleBanner } from "./sample-banner";

export interface CaseWorkspaceProps {
  caseId: string;
}

function WorkspaceSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <Skeleton className="h-16 w-2/3" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

export function CaseWorkspace({ caseId }: CaseWorkspaceProps) {
  const dataSource = useDataSource();
  const { tryCaseAsync, copyingCaseId } = useTryCase();
  const workspace = useCaseWorkspace(caseId, { onTryCase: () => void tryCaseAsync(caseId) });
  const [openEvidenceId, setOpenEvidenceId] = useState<string>();
  const { state, progress } = workspace;

  const evidenceIndex = useMemo(() => (state ? buildEvidenceIndex(state) : new Map()), [state]);
  const evidenceNumbers = useMemo(
    () => (state ? numberEvidenceReferences(state) : new Map<string, number>()),
    [state],
  );
  const findingTitles = useMemo(
    () => new Map(state?.findings.map((finding) => [finding.id, finding.summary]) ?? []),
    [state],
  );

  if (!state || !progress) {
    if (workspace.error) {
      const notFound = workspace.error instanceof ApiError && workspace.error.status === 404;
      return (
        <EmptyState
          icon={TriangleAlert}
          title={notFound ? "Case not found" : "Could not load this case"}
          description={
            notFound
              ? "It may have been created in another browser. Cases are linked to the browser that made them."
              : describeError(workspace.error)
          }
          action={
            notFound ? (
              <Button asChild variant="outline">
                <Link href="/">Back to cases</Link>
              </Button>
            ) : (
              <Button variant="outline" onClick={workspace.reload}>
                Try again
              </Button>
            )
          }
        />
      );
    }

    return <WorkspaceSkeleton />;
  }

  const caseItem = state.case;
  const readOnly = caseItem.isSample;
  const failedTasks = getFailedTasks(progress);
  const blockedTasks = getBlockedTasks(progress);
  const streamedFindingIds = new Set(progress.findings.map((finding) => finding.id));
  const visibleFindings = workspace.streaming
    ? state.findings.filter((finding) => streamedFindingIds.has(finding.id))
    : state.findings;
  const showDeliverables = !workspace.replaying;
  const hasRun = Boolean(state.run.lastRunId) || (caseItem.usage?.runCount ?? 0) > 0;

  return (
    <div className="flex flex-col gap-6">
      {dataSource.mode === "fixtures" ? <FixtureModeNotice /> : null}

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          {caseItem.useCase ? (
            <Badge variant="neutral">{useCaseLabels[caseItem.useCase]}</Badge>
          ) : null}
          <StatusBadge status={caseStatusToWorkStatus[caseItem.status]} />
          {readOnly ? <Badge variant="info">Sample</Badge> : null}
          {caseItem.sourceCaseId ? <Badge variant="outline">Copy of a sample</Badge> : null}
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-2xl font-semibold">{caseItem.title}</h1>
            {caseItem.description ? (
              <p className="max-w-3xl text-sm text-muted-foreground">{caseItem.description}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            {state.run.lastRunId && !workspace.streaming ? (
              <Button variant="outline" onClick={workspace.replay}>
                <History aria-hidden />
                Replay run
              </Button>
            ) : null}
            {readOnly ? null : (
              <Button
                onClick={() => void workspace.runAsync()}
                loading={workspace.busyAction === "run"}
                disabled={workspace.streaming || Boolean(workspace.busyAction)}
              >
                {workspace.busyAction === "run" ? null : <Play aria-hidden />}
                {hasRun ? "Run again" : "Run case"}
              </Button>
            )}
          </div>
        </div>
      </header>

      {readOnly ? (
        <SampleBanner
          onTryCase={() => void tryCaseAsync(caseItem.id)}
          copying={copyingCaseId === caseItem.id}
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] print:block">
        <div className="flex min-w-0 flex-col gap-6">
          <RunProgressPanel
            progress={progress}
            replaying={workspace.replaying}
            connection={workspace.connection}
          />

          <FailurePanel
            failedTasks={failedTasks}
            blockedTasks={blockedTasks}
            runError={progress.error}
            runFailed={progress.status === "failed"}
            canRetry={canRetry(progress) && !workspace.busyAction}
            retrying={workspace.busyAction === "retry"}
            readOnly={readOnly}
            onRetry={() => void workspace.retryAsync()}
          />

          <section aria-labelledby="deliverables-heading" className="flex flex-col gap-4">
            <h2 id="deliverables-heading" className="text-base font-semibold print:sr-only">
              Deliverables
            </h2>
            {showDeliverables && state.deliverables.length > 0 ? (
              state.deliverables.map((deliverable) => (
                <DeliverableView
                  key={deliverable.id}
                  deliverable={deliverable}
                  evidenceIndex={evidenceIndex}
                  evidenceNumbers={evidenceNumbers}
                  onOpenEvidence={setOpenEvidenceId}
                  actions={
                    <ExportMenu
                      deliverableTitle={deliverable.title}
                      docxUrl={dataSource.getExportUrl(caseItem.id, deliverable.id, "docx")}
                      xlsxUrl={dataSource.getExportUrl(caseItem.id, deliverable.id, "xlsx")}
                      jsonUrl={
                        deliverable.format === "dashboard"
                          ? dataSource.getExportUrl(caseItem.id, deliverable.id, "json")
                          : undefined
                      }
                      onPrint={() => window.print()}
                    />
                  }
                />
              ))
            ) : (
              <EmptyState
                icon={FileStack}
                title={
                  workspace.replaying
                    ? "Deliverables appear when the replay ends"
                    : "No deliverables yet"
                }
                description="The deliverable is assembled after the specialists finish their steps."
                className="print:hidden"
              />
            )}
            {showDeliverables ? (
              <EvidenceAppendix evidenceNumbers={evidenceNumbers} evidenceIndex={evidenceIndex} />
            ) : null}
          </section>

          <FindingsList
            findings={visibleFindings}
            evidenceIndex={evidenceIndex}
            onOpenEvidence={setOpenEvidenceId}
          />
        </div>

        <aside aria-label="Case details" className="flex min-w-0 flex-col gap-6 print:hidden">
          <DocumentPanel
            documents={state.documents}
            uploads={workspace.uploads}
            readOnly={readOnly}
            onUpload={(files) => void workspace.uploadAsync(files)}
            onDismissUpload={workspace.dismissUpload}
          />
          <CostPanel caseItem={caseItem} progress={progress} />
        </aside>
      </div>

      <EvidenceDrawer
        entry={openEvidenceId ? evidenceIndex.get(openEvidenceId) : undefined}
        findingTitles={findingTitles}
        onOpenChange={(open) => {
          if (!open) {
            setOpenEvidenceId(undefined);
          }
        }}
      />
    </div>
  );
}
