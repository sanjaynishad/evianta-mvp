"use client";

import { useId, useState, type FormEvent } from "react";
import {
  CircleCheck,
  CircleHelp,
  CircleSlash,
  ListChecks,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { OpenQuestionSeverity, OpenQuestionStatus } from "@evianta/core";
import { EmptyState } from "@/components/patterns/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { LocalReviewNote, LocalReviewNotes } from "@/hooks/use-local-review-notes";
import { findingSeverityLabels } from "@/lib/labels";
import { groupBySeverity, openQuestionsDomId, type OpenQuestionItem } from "@/lib/review";
import { cn } from "@/lib/utils";
import { severityBadgeVariants } from "./inline-findings";

type ReviewDecision = "resolved" | "dismissed";

const statusMeta: Record<
  OpenQuestionStatus,
  { label: string; variant: "warning" | "success" | "neutral" }
> = {
  open: { label: "Open", variant: "warning" },
  resolved: { label: "Resolved", variant: "success" },
  dismissed: { label: "Dismissed", variant: "neutral" },
};

const severityHeadings: Record<OpenQuestionSeverity, string> = {
  high: "High severity",
  medium: "Medium severity",
  low: "Low severity",
};

interface DecisionFormProps {
  decision: ReviewDecision;
  subject: string;
  onSubmit: (note: string) => void;
  onCancel: () => void;
}

function DecisionForm({ decision, subject, onSubmit, onCancel }: DecisionFormProps) {
  const id = useId();
  const [note, setNote] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit(note);
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-2 pt-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {decision === "resolved" ? "How was it resolved?" : "Why dismiss it?"} (optional)
      </label>
      <Textarea
        id={id}
        rows={2}
        value={note}
        autoFocus
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          aria-label={`Confirm ${decision === "resolved" ? "resolve" : "dismiss"}: ${subject}`}
        >
          {decision === "resolved" ? "Resolve" : "Dismiss"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface ChecklistRowProps {
  id: string;
  text: string;
  severity: OpenQuestionSeverity;
  status: OpenQuestionStatus;
  verify: boolean;
  resolutionNote?: string;
  source?: { label: string; onFocus?: () => void };
  editable: boolean;
  pending?: boolean;
  onDecide: (decision: ReviewDecision, note: string) => void;
  onRemove?: () => void;
}

function ChecklistRow({
  id,
  text,
  severity,
  status,
  verify,
  resolutionNote,
  source,
  editable,
  pending = false,
  onDecide,
  onRemove,
}: ChecklistRowProps) {
  const [decision, setDecision] = useState<ReviewDecision>();
  const open = status === "open";
  const Icon = !open
    ? status === "resolved"
      ? CircleCheck
      : CircleSlash
    : verify
      ? ShieldAlert
      : CircleHelp;
  return (
    <li
      data-question-id={id}
      data-question-status={status}
      className={cn("flex flex-col gap-2 px-3 py-2.5", !open && "bg-muted/40")}
    >
      <div className="flex flex-wrap items-start gap-2">
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0",
            open ? (verify ? "text-warning" : "text-muted-foreground") : "text-success",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className={cn("text-sm", !open && "text-muted-foreground")}>{text}</p>
          {source ? (
            source.onFocus ? (
              <button
                type="button"
                onClick={source.onFocus}
                className="w-fit rounded-sm text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                From: {source.label}
              </button>
            ) : (
              <p className="text-xs text-muted-foreground">{source.label}</p>
            )
          ) : null}
          {resolutionNote ? (
            <p className="text-xs text-muted-foreground">Note: {resolutionNote}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {verify ? <Badge variant="warning">Verify</Badge> : null}
          <Badge variant={severityBadgeVariants[severity]}>{findingSeverityLabels[severity]}</Badge>
          <Badge variant={statusMeta[status].variant}>{statusMeta[status].label}</Badge>
        </div>
      </div>
      {editable && open ? (
        decision ? (
          <DecisionForm
            decision={decision}
            subject={text}
            onCancel={() => setDecision(undefined)}
            onSubmit={(note) => {
              setDecision(undefined);
              onDecide(decision, note);
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-1.5 pl-6">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              aria-label={`Resolve: ${text}`}
              onClick={() => setDecision("resolved")}
            >
              <CircleCheck aria-hidden />
              Resolve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              aria-label={`Dismiss: ${text}`}
              onClick={() => setDecision("dismissed")}
            >
              <CircleSlash aria-hidden />
              Dismiss
            </Button>
            {onRemove ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove note: ${text}`}
                onClick={onRemove}
              >
                <Trash2 aria-hidden />
                Remove
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </li>
  );
}

export interface OpenQuestionsChecklistProps {
  items: OpenQuestionItem[];
  localNotes: LocalReviewNotes;
  readOnly: boolean;
  isPending: (questionId: string) => boolean;
  onResolve: (questionId: string, note: string) => void;
  onDismiss: (questionId: string, note: string) => void;
  onFocusFinding?: (findingId: string) => void;
}

export function OpenQuestionsChecklist({
  items,
  localNotes,
  readOnly,
  isPending,
  onResolve,
  onDismiss,
  onFocusFinding,
}: OpenQuestionsChecklistProps) {
  const notes: LocalReviewNote[] = localNotes.notes;
  const openCount =
    items.filter((item) => item.question.status === "open").length +
    notes.filter((note) => note.status === "open").length;
  const groups = groupBySeverity(items);
  return (
    <section
      id={openQuestionsDomId}
      tabIndex={-1}
      aria-labelledby={`${openQuestionsDomId}-heading`}
      className="flex scroll-mt-4 flex-col gap-3 focus:outline-none print:hidden"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${openQuestionsDomId}-heading`} className="text-base font-semibold">
          Open questions and verify flags
        </h2>
        <p className="text-xs text-muted-foreground" data-testid="open-question-count">
          {openCount === 0 ? "Nothing open" : `${openCount} open`}
        </p>
      </div>
      {items.length === 0 && notes.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No open questions"
          description="Specialists raise questions here when the evidence leaves something unresolved."
        />
      ) : null}
      {groups.map((group) => (
        <div key={group.severity} className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {severityHeadings[group.severity]}
          </h3>
          <ul
            aria-label={`${severityHeadings[group.severity]} questions`}
            className="flex flex-col divide-y rounded-lg border bg-card"
          >
            {group.items.map((item) => (
              <ChecklistRow
                key={item.question.id}
                id={item.question.id}
                text={item.question.text}
                severity={item.question.severity}
                status={item.question.status}
                verify={item.verify}
                resolutionNote={item.question.resolutionNote}
                source={{
                  label: item.finding.summary,
                  onFocus: onFocusFinding ? () => onFocusFinding(item.finding.id) : undefined,
                }}
                editable={!readOnly}
                pending={isPending(item.question.id)}
                onDecide={(decision, note) =>
                  decision === "resolved"
                    ? onResolve(item.question.id, note)
                    : onDismiss(item.question.id, note)
                }
              />
            ))}
          </ul>
        </div>
      ))}
      {notes.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Flagged from Ask (saved in this browser only)
          </h3>
          <ul
            aria-label="Flagged questions"
            className="flex flex-col divide-y rounded-lg border border-dashed bg-card"
          >
            {notes.map((note) => (
              <ChecklistRow
                key={note.id}
                id={note.id}
                text={note.text}
                severity={note.severity}
                status={note.status}
                verify={false}
                resolutionNote={note.resolutionNote}
                source={note.question ? { label: `Asked: ${note.question}` } : undefined}
                editable
                onDecide={(decision, resolution) =>
                  localNotes.updateNote(note.id, {
                    status: decision,
                    resolutionNote: resolution.trim() || undefined,
                  })
                }
                onRemove={() => localNotes.removeNote(note.id)}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
