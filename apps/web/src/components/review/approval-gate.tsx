"use client";

import { useId, useState } from "react";
import { BadgeCheck, CircleHelp, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Case } from "@evianta/core";
import { confidenceMeta } from "@/components/patterns/confidence-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { LocalReviewNote } from "@/hooks/use-local-review-notes";
import { formatDateTime, formatNumber, formatUsd } from "@/lib/format";
import { findingSeverityLabels } from "@/lib/labels";
import type { ApprovalSummary } from "@/lib/review";
import { severityBadgeVariants } from "./inline-findings";

export interface ApprovalBadgeProps {
  caseItem: Case;
}

export function ApprovalBadge({ caseItem }: ApprovalBadgeProps) {
  const approval = caseItem.approval;
  if (!approval) {
    return null;
  }

  const open = approval.unresolvedQuestionIds.length;
  return (
    <Badge variant="success" data-testid="approval-badge" className="py-1">
      <BadgeCheck aria-hidden />
      Approved {formatDateTime(approval.approvedAt)}
      {open > 0 ? ` with ${open} open ${open === 1 ? "item" : "items"}` : ""}
    </Badge>
  );
}

export interface ApprovalGateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: ApprovalSummary;
  localNotes: LocalReviewNote[];
  cost: { total: number; tokens: number };
  approving: boolean;
  // Set while review changes are still saving; approval waits so it records the saved state.
  waitingForChanges?: boolean;
  onApprove: (note: string) => Promise<boolean>;
}

const confidenceLevels = ["high", "medium", "low", "unassessed"] as const;

export function ApprovalGateDialog({
  open,
  onOpenChange,
  summary,
  localNotes,
  cost,
  approving,
  waitingForChanges = false,
  onApprove,
}: ApprovalGateDialogProps) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const unresolved = summary.unresolved;
  const openNotes = localNotes.filter((item) => item.status === "open");
  const highCount = unresolved.filter((item) => item.question.severity === "high").length;
  const sections = summary.sections;

  async function handleApproveAsync() {
    const approved = await onApprove(note);
    if (approved) {
      setNote("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Approve this case</DialogTitle>
          <DialogDescription>
            Approval records your sign-off with the time, any items still open, and your note.
            Evianta never files or submits anything on your behalf.
          </DialogDescription>
        </DialogHeader>

        {unresolved.length > 0 ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle p-3 text-sm"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>
              <span className="font-medium">
                {unresolved.length} {unresolved.length === 1 ? "item is" : "items are"} still open
                {highCount > 0 ? `, ${highCount} of high severity` : ""}.
              </span>{" "}
              Approving now records them as unresolved.
            </p>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-success">
            <ShieldCheck aria-hidden className="size-4" />
            Every open question has been resolved or dismissed.
          </p>
        )}

        {unresolved.length > 0 ? (
          <section aria-labelledby={`${noteId}-unresolved`} className="flex flex-col gap-2">
            <h3 id={`${noteId}-unresolved`} className="text-sm font-semibold">
              Unresolved items
            </h3>
            <ol aria-label="Unresolved items" className="flex flex-col divide-y rounded-md border">
              {unresolved.map((item) => (
                <li
                  key={item.question.id}
                  data-severity={item.question.severity}
                  className="flex items-start gap-2 px-3 py-2 text-sm"
                >
                  {item.verify ? (
                    <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                  ) : (
                    <CircleHelp
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1">{item.question.text}</span>
                  <Badge variant={severityBadgeVariants[item.question.severity]}>
                    {findingSeverityLabels[item.question.severity]}
                  </Badge>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {openNotes.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {openNotes.length} {openNotes.length === 1 ? "question" : "questions"} you flagged from
            Ask {openNotes.length === 1 ? "is" : "are"} still open. They are saved in this browser
            only and are not part of the approval record.
          </p>
        ) : null}

        <dl className="grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Sections reviewed</dt>
            <dd>
              <span className="figures font-medium">
                {sections.approved} of {sections.total}
              </span>{" "}
              approved
              {sections.needsChanges > 0 ? `, ${sections.needsChanges} need changes` : ""}
              {sections.edited > 0 ? `, ${sections.edited} edited by you` : ""}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Evidence confidence</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1">
              {confidenceLevels
                .filter((level) => summary.evidenceConfidence[level] > 0)
                .map((level) => (
                  <span key={level} className="whitespace-nowrap">
                    <span className="figures font-medium">{summary.evidenceConfidence[level]}</span>{" "}
                    {confidenceMeta[level].shortLabel.toLowerCase()}
                  </span>
                ))}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Model cost (tracking only)</dt>
            <dd>
              <span className="figures font-medium">{formatUsd(cost.total)}</span>{" "}
              <span className="figures text-xs text-muted-foreground">
                {formatNumber(cost.tokens)} tokens
              </span>
            </dd>
          </div>
        </dl>

        {summary.assumptions.length > 0 ? (
          <section aria-labelledby={`${noteId}-assumptions`} className="flex flex-col gap-1.5">
            <h3 id={`${noteId}-assumptions`} className="text-sm font-semibold">
              Assumptions the work relies on
            </h3>
            <ul className="list-disc pl-5 text-sm">
              {summary.assumptions.map((assumption) => (
                <li key={assumption.text}>{assumption.text}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={noteId} className="text-sm font-medium">
            Approval note (optional)
          </label>
          <Textarea
            id={noteId}
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        <DialogFooter>
          {waitingForChanges ? (
            <p
              role="status"
              data-testid="approval-waiting"
              className="mr-auto self-center text-xs text-muted-foreground"
            >
              Saving your review changes. The summary updates when they are saved.
            </p>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep reviewing
          </Button>
          <Button
            onClick={() => void handleApproveAsync()}
            loading={approving}
            disabled={waitingForChanges}
          >
            {approving ? null : <BadgeCheck aria-hidden />}
            {unresolved.length > 0 ? `Approve with ${unresolved.length} open` : "Approve case"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
