"use client";

import { useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BadgeCheck, FileStack, History, Play, TriangleAlert } from "lucide-react";
import type { CaseState } from "@evianta/core";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { ApprovalBadge, ApprovalGateDialog } from "@/components/review/approval-gate";
import { AskPanel } from "@/components/review/ask-panel";
import { CaseOutline } from "@/components/review/case-outline";
import { EvidenceViewer, type SectionReference } from "@/components/review/evidence-viewer";
import { OpenQuestionsChecklist } from "@/components/review/open-questions-checklist";
import { ReviewProvider, useReview } from "@/components/review/review-context";
import { ReviewLayout, type ReviewLayoutHandle } from "@/components/review/review-layout";
import { ReviewSidePanel } from "@/components/review/review-side-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAskConversation } from "@/hooks/use-ask-conversation";
import { useCaseWorkspace, type CaseWorkspaceController } from "@/hooks/use-case-workspace";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useLocalReviewNotes, type LocalReviewNotes } from "@/hooks/use-local-review-notes";
import {
  approveActionKey,
  questionActionKey,
  sectionActionKey,
  useReviewActions,
  type ReviewActions,
} from "@/hooks/use-review-actions";
import { useTryCase } from "@/hooks/use-try-case";
import { ApiError, describeError } from "@/lib/api/errors";
import { useDataSource } from "@/lib/data/data-source-context";
import { buildEvidenceIndex, numberEvidenceReferences } from "@/lib/evidence";
import { caseStatusToWorkStatus, useCaseLabels } from "@/lib/labels";
import { buildOutline, collectOpenQuestions, summarizeForApproval } from "@/lib/review";
import { canRetry, getBlockedTasks, getFailedTasks, type RunProgress } from "@/lib/run-progress";
import { CostPanel } from "./cost-panel";
import { DeliverableView } from "./deliverable-view";
import { DocumentPanel, type DocumentPanelProps } from "./document-panel";
import { EvidenceAppendix } from "./evidence-appendix";
import { ExportMenu } from "./export-menu";
import { FailurePanel } from "./failure-panel";
import { FindingsList } from "./findings-list";
import { FixtureModeNotice } from "./fixture-mode-notice";
import { MissionControl } from "./mission-control";
import { ReviewBrief } from "../review/review-brief";
import { SampleBanner } from "./sample-banner";

export interface CaseWorkspaceProps {
  caseId: string;
}

const sideLabel = "Evidence and Ask";

function WorkspaceSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <Skeleton className="h-16 w-2/3" />
      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_22rem]">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

function sectionsByEvidenceOf(state: CaseState): Map<string, SectionReference[]> {
  const findingsById = new Map(state.findings.map((finding) => [finding.id, finding]));
  const map = new Map<string, SectionReference[]>();
  for (const deliverable of state.deliverables) {
    for (const section of deliverable.sections) {
      const evidenceIds = new Set([
        ...section.evidenceIds,
        ...section.findingIds.flatMap(
          (findingId) => findingsById.get(findingId)?.evidence.map((item) => item.id) ?? [],
        ),
      ]);
      for (const evidenceId of evidenceIds) {
        map.set(evidenceId, [
          ...(map.get(evidenceId) ?? []),
          { sectionId: section.id, title: section.title },
        ]);
      }
    }
  }

  return map;
}

function SourceList(props: Omit<DocumentPanelProps, "onOpenDocument">) {
  const review = useReview();
  return <DocumentPanel {...props} onOpenDocument={review.openDocument} />;
}

interface ReviewContentProps {
  state: CaseState;
  progress: RunProgress;
  workspace: CaseWorkspaceController;
  actions: ReviewActions;
  localNotes: LocalReviewNotes;
  readOnly: boolean;
}

function ReviewContent({
  state,
  progress,
  workspace,
  actions,
  localNotes,
  readOnly,
}: ReviewContentProps) {
  const dataSource = useDataSource();
  const review = useReview();
  const caseItem = state.case;
  const evidenceNumbers = useMemo(() => numberEvidenceReferences(state), [state]);
  const questions = useMemo(() => collectOpenQuestions(state.findings), [state.findings]);
  const failedTasks = getFailedTasks(progress);
  const blockedTasks = getBlockedTasks(progress);
  const streamedFindingIds = new Set(progress.findings.map((finding) => finding.id));
  const visibleFindings = workspace.streaming
    ? state.findings.filter((finding) => streamedFindingIds.has(finding.id))
    : state.findings;
  const showDeliverables = !workspace.replaying;

  return (
    <div className="flex flex-col gap-6">
      <FailurePanel
        failedTasks={failedTasks}
        blockedTasks={blockedTasks}
        runError={progress.error}
        runFailed={progress.status === "failed"}
        canRetry={canRetry(progress) && !workspace.busyAction && !workspace.uploading}
        retrying={workspace.busyAction === "retry"}
        readOnly={readOnly}
        onRetry={() => void workspace.retryAsync()}
      />

      <MissionControl
        progress={progress}
        replaying={workspace.replaying}
        replayLabel={
          dataSource.mode === "fixtures"
            ? "Replay of fixture-generated sample events"
            : "Replay of a saved run"
        }
        connection={workspace.connection}
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
              evidenceIndex={review.evidenceIndex}
              evidenceNumbers={evidenceNumbers}
              onOpenEvidence={review.openEvidence}
              findingsById={review.findingsById}
              onFocusFinding={review.focusFinding}
              onUpdateSection={readOnly ? undefined : actions.updateSectionAsync}
              isSectionPending={(sectionId) => actions.isPending(sectionActionKey(sectionId))}
              producedAt={caseItem.usage?.lastRunAt}
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
          <EvidenceAppendix
            evidenceNumbers={evidenceNumbers}
            evidenceIndex={review.evidenceIndex}
          />
        ) : null}
      </section>

      {showDeliverables ? (
        <OpenQuestionsChecklist
          items={questions}
          localNotes={localNotes}
          readOnly={readOnly}
          isPending={(questionId) => actions.isPending(questionActionKey(questionId))}
          onResolve={(questionId, note) => void actions.resolveQuestionAsync(questionId, note)}
          onDismiss={(questionId, note) => void actions.dismissQuestionAsync(questionId, note)}
          onFocusFinding={review.focusFinding}
        />
      ) : null}

      <FindingsList
        findings={visibleFindings}
        evidenceIndex={review.evidenceIndex}
        onOpenEvidence={review.openEvidence}
      />

      <CostPanel caseItem={caseItem} progress={progress} />
    </div>
  );
}

export function CaseWorkspace({ caseId }: CaseWorkspaceProps) {
  const dataSource = useDataSource();
  const { tryCaseAsync, copyingCaseId } = useTryCase();
  const workspace = useCaseWorkspace(caseId, { onTryCase: () => void tryCaseAsync(caseId) });
  const { state, progress } = workspace;
  const localNotes = useLocalReviewNotes(caseId);
  const actions = useReviewActions({
    caseId,
    state,
    mutate: workspace.mutate,
    onTryCase: () => void tryCaseAsync(caseId),
  });
  const layoutRef = useRef<ReviewLayoutHandle>(null);
  const refreshUsage = useLatestCallback(async () => {
    try {
      const fresh = await dataSource.getCaseStateAsync(caseId);
      workspace.mutate((current) => ({
        ...current,
        case: { ...current.case, usage: fresh.case.usage },
        cost: fresh.cost,
      }));
    } catch {
      // Keeping the previous totals is fine; the next load picks up the recorded usage.
    }
  });
  const conversation = useAskConversation({
    caseId,
    localNotes,
    onSettled: () => void refreshUsage(),
  });
  const [gateOpen, setGateOpen] = useState(false);
  const uploadWaitId = useId();

  const evidenceIndex = useMemo(() => (state ? buildEvidenceIndex(state) : new Map()), [state]);
  const outline = useMemo(
    () => (state && progress ? buildOutline(state.deliverables, progress.tasks) : []),
    [state, progress],
  );
  const questions = useMemo(() => (state ? collectOpenQuestions(state.findings) : []), [state]);
  const approvalSummary = useMemo(() => (state ? summarizeForApproval(state) : undefined), [state]);
  const sectionsByEvidence = useMemo(
    () => (state ? sectionsByEvidenceOf(state) : new Map<string, SectionReference[]>()),
    [state],
  );

  if (!state || !progress || !approvalSummary) {
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
  const hasRun = Boolean(state.run.lastRunId) || (caseItem.usage?.runCount ?? 0) > 0;
  const canApprove = !readOnly && state.deliverables.length > 0 && !workspace.streaming;
  const reviewIncomplete = state.tasks.some(
    (task) => task.assignedRole === "independent-review" && task.status !== "completed",
  );
  const openLocalNotes = localNotes.notes.filter((note) => note.status === "open").length;

  return (
    <ReviewProvider
      caseId={caseId}
      evidenceIndex={evidenceIndex}
      findings={state.findings}
      onRevealPanel={() => layoutRef.current?.revealSide()}
      onNavigate={() => layoutRef.current?.showContent() ?? false}
    >
      <div className="flex flex-col gap-4 lg:min-h-[calc(100dvh-5.5rem)] print:h-auto">
        {dataSource.mode === "fixtures" ? <FixtureModeNotice /> : null}

        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            {caseItem.useCase ? (
              <Badge variant="neutral">{useCaseLabels[caseItem.useCase]}</Badge>
            ) : null}
            <StatusBadge status={caseStatusToWorkStatus[caseItem.status]} />
            {readOnly ? <Badge variant="info">Sample</Badge> : null}
            {caseItem.sourceCaseId ? <Badge variant="outline">Copy of a sample</Badge> : null}
            <ApprovalBadge caseItem={caseItem} />
          </div>
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="text-2xl font-semibold">{caseItem.title}</h1>
              {caseItem.description ? (
                <p className="line-clamp-2 max-w-4xl text-sm text-muted-foreground">
                  {caseItem.description}
                </p>
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
                  variant={canApprove ? "outline" : "default"}
                  onClick={() => void workspace.runAsync()}
                  loading={workspace.busyAction === "run"}
                  disabled={
                    workspace.streaming || Boolean(workspace.busyAction) || workspace.uploading
                  }
                  aria-describedby={workspace.uploading ? uploadWaitId : undefined}
                >
                  {workspace.busyAction === "run" ? null : <Play aria-hidden />}
                  {hasRun ? "Run again" : "Run case"}
                </Button>
              )}
              {!readOnly && workspace.uploading ? (
                <p id={uploadWaitId} className="text-xs text-muted-foreground" role="status">
                  Waiting for uploads to finish before running.
                </p>
              ) : null}
              {canApprove ? (
                <Button
                  onClick={() => setGateOpen(true)}
                  aria-haspopup="dialog"
                  loading={actions.isPending(approveActionKey)}
                >
                  {actions.isPending(approveActionKey) ? null : <BadgeCheck aria-hidden />}
                  {caseItem.approval ? "Review approval" : "Review and approve"}
                </Button>
              ) : null}
            </div>
          </div>
        </header>

        {readOnly ? (
          <SampleBanner
            onTryCase={() => void tryCaseAsync(caseItem.id)}
            copying={copyingCaseId === caseItem.id}
          />
        ) : null}

        {!workspace.replaying ? (
          <ReviewBrief
            caseItem={caseItem}
            state={state}
            summary={approvalSummary}
            progress={progress}
          />
        ) : null}

        <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="run-announcer">
          {progress.announcement}
        </p>

        <ReviewLayout
          handleRef={layoutRef}
          sideLabel={sideLabel}
          className="lg:min-h-96"
          outline={
            <CaseOutline
              caseItem={caseItem}
              progress={progress}
              groups={outline}
              questions={questions}
              localOpenNotes={openLocalNotes}
              findingCount={state.findings.length}
            />
          }
          content={
            <ReviewContent
              state={state}
              progress={progress}
              workspace={workspace}
              actions={actions}
              localNotes={localNotes}
              readOnly={readOnly}
            />
          }
          side={
            <ReviewSidePanel
              evidence={
                <EvidenceViewer
                  documents={state.documents}
                  sectionsByEvidence={sectionsByEvidence}
                  sourceList={
                    <SourceList
                      documents={state.documents}
                      uploads={workspace.uploads}
                      readOnly={readOnly}
                      onUpload={(files) => void workspace.uploadAsync(files)}
                      onDismissUpload={workspace.dismissUpload}
                      uploadLockedReason={workspace.uploadLockedReason}
                    />
                  }
                />
              }
              ask={
                <AskPanel
                  useCase={caseItem.useCase}
                  documents={state.documents}
                  conversation={conversation}
                />
              }
            />
          }
        />
      </div>

      <ApprovalGateDialog
        open={gateOpen}
        onOpenChange={setGateOpen}
        summary={approvalSummary}
        localNotes={localNotes.notes}
        cost={{ total: progress.totalCost, tokens: progress.totalTokens }}
        approving={actions.isPending(approveActionKey)}
        reviewIncomplete={reviewIncomplete}
        waitingForChanges={actions.hasPendingChanges}
        onApprove={(note, acknowledgeIncompleteReview) => {
          setGateOpen(false);
          return actions.approveAsync(note, acknowledgeIncompleteReview);
        }}
      />
    </ReviewProvider>
  );
}
