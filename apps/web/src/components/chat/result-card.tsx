"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CircleHelp,
  Download,
  FileCheck2,
  ListChecks,
  ReceiptIndianRupee,
  ScanSearch,
} from "lucide-react";
import type { CaseState, FindingFigure } from "@evianta/core";
import { DeliverableView } from "@/components/case/deliverable-view";
import { ExportMenu } from "@/components/case/export-menu";
import { FindingsList } from "@/components/case/findings-list";
import { EvidenceChip } from "@/components/patterns/evidence-chip";
import { OpenQuestionsChecklist } from "@/components/review/open-questions-checklist";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LocalReviewNotes } from "@/hooks/use-local-review-notes";
import {
  questionActionKey,
  sectionActionKey,
  type ReviewActions,
} from "@/hooks/use-review-actions";
import { useDataSource } from "@/lib/data/data-source-context";
import {
  buildEvidenceIndex,
  formatEvidenceLocator,
  getEvidenceKind,
  getEvidenceLabel,
  numberEvidenceReferences,
} from "@/lib/evidence";
import { formatInr, formatNumber, formatUsd } from "@/lib/format";
import { collectOpenQuestions } from "@/lib/review";
import { importedFromLabel } from "@/lib/sources";
import { cn } from "@/lib/utils";

type ResultView =
  { kind: "deliverable"; id: string } | { kind: "findings" | "questions" | "evidence" };

export interface ResultCardProps {
  state: CaseState;
  readOnly: boolean;
  reviewActions: ReviewActions;
  localNotes: LocalReviewNotes;
  onOpenEvidence: (evidenceId: string) => void;
}

const summaryLength = 320;

function plainSummary(state: CaseState): string | undefined {
  const section = state.deliverables
    .flatMap((deliverable) => deliverable.sections)
    .find((candidate) => candidate.kind === "text" && candidate.content.trim());
  const text = (section?.editedContent ?? section?.content ?? state.deliverables[0]?.content ?? "")
    .replace(/[#*_`>|]/g, "")
    .replace(/\[(\d+)\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return undefined;
  }

  return text.length > summaryLength ? `${text.slice(0, summaryLength).trimEnd()}...` : text;
}

function formatFigure(figure: FindingFigure): string {
  if (figure.unit === "currency" || figure.unit === "INR") {
    return formatInr(figure.value);
  }

  if (figure.unit === "percent") {
    return `${formatNumber(figure.value, { maximumFractionDigits: 1 })}%`;
  }

  return figure.unit ? `${formatNumber(figure.value)} ${figure.unit}` : formatNumber(figure.value);
}

function ResultChip({
  icon,
  children,
  onClick,
  tone = "default",
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  tone?: "default" | "attention";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs font-medium transition-colors duration-fast ease-standard hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "attention" && "border-warning/40 bg-warning-subtle text-warning",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function ResultCard({
  state,
  readOnly,
  reviewActions,
  localNotes,
  onOpenEvidence,
}: ResultCardProps) {
  const dataSource = useDataSource();
  const [view, setView] = useState<ResultView>();
  const evidenceIndex = useMemo(() => buildEvidenceIndex(state), [state]);
  const evidenceNumbers = useMemo(() => numberEvidenceReferences(state), [state]);
  const findingsById = useMemo(
    () => new Map(state.findings.map((finding) => [finding.id, finding])),
    [state.findings],
  );
  const questions = useMemo(() => collectOpenQuestions(state.findings), [state.findings]);
  const unresolved = questions.filter((item) => item.question.status === "open").length;
  const figures = state.findings.flatMap((finding) => finding.figures ?? []).slice(0, 3);
  const summary = plainSummary(state);
  const primary = state.deliverables[0];
  const caseId = state.case.id;
  const cost = state.case.usage?.costEstimate ?? state.cost?.costEstimate;
  const openDeliverable =
    view?.kind === "deliverable"
      ? state.deliverables.find((deliverable) => deliverable.id === view.id)
      : undefined;
  const evidenceEntries = [...evidenceIndex.values()];

  if (!primary) {
    return null;
  }

  return (
    <div
      data-slot="result-card"
      className="flex w-full flex-col gap-4 rounded-xl border bg-card p-4 shadow-elevation-1"
    >
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Work ready for your review
        </p>
        <p className="text-base font-semibold">
          {primary.title} ready
          {unresolved > 0
            ? `, ${unresolved} ${unresolved === 1 ? "item needs" : "items need"} your attention`
            : ""}
        </p>
      </div>

      {figures.length > 0 ? (
        <dl className="grid gap-3 sm:grid-cols-3">
          {figures.map((figure) => (
            <div key={`${figure.key}-${figure.label}`} className="rounded-lg bg-muted/60 p-3">
              <dt className="truncate text-xs text-muted-foreground">{figure.label}</dt>
              <dd className="figures text-base font-semibold">{formatFigure(figure)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {summary ? <p className="text-sm leading-relaxed text-foreground">{summary}</p> : null}

      <div role="group" className="flex flex-wrap gap-2" aria-label="Results">
        {state.deliverables.map((deliverable) => (
          <ResultChip
            key={deliverable.id}
            icon={<FileCheck2 aria-hidden className="size-3.5" />}
            onClick={() => setView({ kind: "deliverable", id: deliverable.id })}
          >
            {deliverable.title}
          </ResultChip>
        ))}
        <ResultChip
          icon={<ListChecks aria-hidden className="size-3.5" />}
          onClick={() => setView({ kind: "findings" })}
        >
          {state.findings.length} findings
        </ResultChip>
        <ResultChip
          icon={<CircleHelp aria-hidden className="size-3.5" />}
          tone={unresolved > 0 ? "attention" : "default"}
          onClick={() => setView({ kind: "questions" })}
        >
          {unresolved} open {unresolved === 1 ? "question" : "questions"}
        </ResultChip>
        <ResultChip
          icon={<ScanSearch aria-hidden className="size-3.5" />}
          onClick={() => setView({ kind: "evidence" })}
        >
          Evidence ({evidenceEntries.length})
        </ResultChip>
        <ResultChip
          icon={<Download aria-hidden className="size-3.5" />}
          onClick={() => setView({ kind: "deliverable", id: primary.id })}
        >
          Export
        </ResultChip>
        {cost !== undefined ? (
          <span className="inline-flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <ReceiptIndianRupee aria-hidden className="size-3.5" />
            Model cost <span className="figures text-foreground">{formatUsd(cost)}</span>
          </span>
        ) : null}
      </div>

      <Button asChild variant="outline" size="sm" className="self-start">
        <Link href={`/cases/${encodeURIComponent(caseId)}`}>
          Open full workspace to review and approve
          <ArrowRight aria-hidden />
        </Link>
      </Button>

      <Dialog open={Boolean(openDeliverable)} onOpenChange={(open) => !open && setView(undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{openDeliverable?.title ?? "Deliverable"}</DialogTitle>
            <DialogDescription>
              Every claim links to its evidence. Select a chip to see where it comes from.
            </DialogDescription>
          </DialogHeader>
          {openDeliverable ? (
            <DeliverableView
              deliverable={openDeliverable}
              evidenceIndex={evidenceIndex}
              evidenceNumbers={evidenceNumbers}
              onOpenEvidence={onOpenEvidence}
              findingsById={findingsById}
              onUpdateSection={readOnly ? undefined : reviewActions.updateSectionAsync}
              isSectionPending={(sectionId) => reviewActions.isPending(sectionActionKey(sectionId))}
              producedAt={state.case.usage?.lastRunAt}
              actions={
                <ExportMenu
                  deliverableTitle={openDeliverable.title}
                  docxUrl={dataSource.getExportUrl(caseId, openDeliverable.id, "docx")}
                  xlsxUrl={dataSource.getExportUrl(caseId, openDeliverable.id, "xlsx")}
                  jsonUrl={
                    openDeliverable.format === "dashboard"
                      ? dataSource.getExportUrl(caseId, openDeliverable.id, "json")
                      : undefined
                  }
                  onPrint={() => window.print()}
                />
              }
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={view?.kind === "findings"} onOpenChange={(open) => !open && setView(undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Findings</DialogTitle>
            <DialogDescription>
              What the specialists established, with the evidence for each.
            </DialogDescription>
          </DialogHeader>
          <FindingsList
            findings={state.findings}
            evidenceIndex={evidenceIndex}
            onOpenEvidence={onOpenEvidence}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={view?.kind === "questions"}
        onOpenChange={(open) => !open && setView(undefined)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Open questions</DialogTitle>
            <DialogDescription>
              Points the specialists could not settle from the evidence. Resolve or dismiss each
              with a note.
            </DialogDescription>
          </DialogHeader>
          <OpenQuestionsChecklist
            items={questions}
            localNotes={localNotes}
            readOnly={readOnly}
            isPending={(questionId) => reviewActions.isPending(questionActionKey(questionId))}
            onResolve={(questionId, note) =>
              void reviewActions.resolveQuestionAsync(questionId, note)
            }
            onDismiss={(questionId, note) =>
              void reviewActions.dismissQuestionAsync(questionId, note)
            }
          />
        </DialogContent>
      </Dialog>

      <Dialog open={view?.kind === "evidence"} onOpenChange={(open) => !open && setView(undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Evidence</DialogTitle>
            <DialogDescription>
              Everything the work relies on. Select an item to see the exact location.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col divide-y rounded-lg border">
            {evidenceEntries.map((entry) => (
              <li key={entry.evidence.id} className="flex flex-col gap-1.5 p-3">
                <EvidenceChip
                  label={getEvidenceLabel(entry.evidence, entry.document)}
                  locator={formatEvidenceLocator(entry.evidence.location)}
                  kind={getEvidenceKind(entry.evidence, entry.document)}
                  onClick={() => onOpenEvidence(entry.evidence.id)}
                  className="self-start"
                />
                <p className="text-sm">{entry.evidence.description}</p>
                {entry.document?.provenance ? (
                  <p className="text-xs text-muted-foreground">
                    Imported from {importedFromLabel(entry.document.provenance)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
