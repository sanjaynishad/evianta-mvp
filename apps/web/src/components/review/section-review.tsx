"use client";

import { useId, useState, type FormEvent } from "react";
import {
  Check,
  Clock,
  GitCompareArrows,
  MessageSquareWarning,
  PencilLine,
  Undo2,
} from "lucide-react";
import type { DeliverableSection, Finding, SectionUpdateRequest } from "@evianta/core";
import { EvidenceChipList } from "@/components/case/evidence-chip-list";
import { ChartSection } from "@/components/dashboard/chart-section";
import { ProvenanceBadge } from "@/components/patterns/provenance-badge";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { EvidenceEntry } from "@/lib/evidence";
import { formatDateTime } from "@/lib/format";
import { agentRoleLabels, modelTierLabels, sectionReviewLabels } from "@/lib/labels";
import { sectionDomId } from "@/lib/review";
import { cn } from "@/lib/utils";
import { InlineFindings } from "./inline-findings";
import { useOptionalReview } from "./review-context";
import { SectionBody } from "./section-body";

const reviewVariants: Record<
  DeliverableSection["reviewStatus"],
  NonNullable<BadgeProps["variant"]>
> = {
  pending: "neutral",
  approved: "success",
  "needs-changes": "warning",
};

type EditorMode = "none" | "edit" | "comment" | "compare";

export interface SectionReviewProps {
  section: DeliverableSection;
  evidenceIndex: Map<string, EvidenceEntry>;
  evidenceNumbers: Map<string, number>;
  findings: Finding[];
  onOpenEvidence: (evidenceId: string) => void;
  onFocusFinding?: (findingId: string) => void;
  // Undefined when the section cannot be changed, for example on a read-only sample.
  onUpdate?: (update: SectionUpdateRequest) => Promise<boolean>;
  pending?: boolean;
  producedAt?: string;
}

function splitParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function BeforeAfter({ before, after }: { before: string; after: string }) {
  const beforeParagraphs = splitParagraphs(before);
  const afterParagraphs = splitParagraphs(after);
  const beforeSet = new Set(beforeParagraphs);
  const afterSet = new Set(afterParagraphs);
  return (
    <div className="grid gap-3 md:grid-cols-2" data-slot="before-after">
      <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Before: drafted by the specialist
        </p>
        <div className="flex flex-col gap-2 text-sm leading-relaxed" data-testid="before-content">
          {beforeParagraphs.map((paragraph, index) => (
            <p
              key={index}
              className={cn(
                "whitespace-pre-line",
                !afterSet.has(paragraph) && "rounded-sm bg-danger-subtle px-1 text-foreground",
              )}
            >
              {!afterSet.has(paragraph) ? <span className="sr-only">Changed: </span> : null}
              {paragraph}
            </p>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-md border border-highlight/40 bg-highlight-subtle/40 p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-highlight">
          After: edited by reviewer
        </p>
        <div className="flex flex-col gap-2 text-sm leading-relaxed" data-testid="after-content">
          {afterParagraphs.map((paragraph, index) => (
            <p
              key={index}
              className={cn(
                "whitespace-pre-line",
                !beforeSet.has(paragraph) && "rounded-sm bg-highlight-subtle px-1",
              )}
            >
              {!beforeSet.has(paragraph) ? <span className="sr-only">New: </span> : null}
              {paragraph}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SectionReview({
  section,
  evidenceIndex,
  evidenceNumbers,
  findings,
  onOpenEvidence,
  onFocusFinding,
  onUpdate,
  pending = false,
  producedAt,
}: SectionReviewProps) {
  const review = useOptionalReview();
  const headingId = useId();
  const editorId = useId();
  const [mode, setMode] = useState<EditorMode>("none");
  const [draft, setDraft] = useState("");
  const [comment, setComment] = useState("");
  const edited = section.editedContent !== undefined;
  const content = section.editedContent ?? section.content;
  const editable = Boolean(onUpdate);
  const canEditText = editable && section.kind === "text";
  const sources = section.evidenceIds
    .map((id) => evidenceIndex.get(id))
    .filter((entry): entry is EvidenceEntry => entry !== undefined);

  async function submitAsync(update: SectionUpdateRequest) {
    if (!onUpdate) {
      return;
    }

    setMode("none");
    await onUpdate(update);
  }

  function handleSaveEdit(event: FormEvent) {
    event.preventDefault();
    const next = draft.replace(/\s+$/, "");
    void submitAsync({ editedContent: next === section.content ? null : next });
  }

  function handleRequestChanges(event: FormEvent) {
    event.preventDefault();
    void submitAsync({ reviewStatus: "needs-changes", reviewComment: comment.trim() || null });
  }

  const evidenceChips = (
    <EvidenceChipList
      evidenceIds={section.evidenceIds}
      evidenceIndex={evidenceIndex}
      onOpenEvidence={onOpenEvidence}
      footnoteNumbers={evidenceNumbers}
      label={`Evidence for ${section.title}`}
    />
  );

  const actions = editable ? (
    <div
      role="toolbar"
      aria-label={`Review ${section.title}`}
      className="flex flex-wrap items-center gap-1.5 print:hidden"
    >
      <Button
        size="sm"
        variant={section.reviewStatus === "approved" ? "secondary" : "outline"}
        aria-pressed={section.reviewStatus === "approved"}
        disabled={pending}
        onClick={() =>
          void submitAsync({
            reviewStatus: section.reviewStatus === "approved" ? "pending" : "approved",
          })
        }
      >
        <Check aria-hidden />
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        aria-expanded={mode === "comment"}
        aria-controls={mode === "comment" ? editorId : undefined}
        disabled={pending}
        onClick={() => {
          setComment(section.reviewComment ?? "");
          setMode(mode === "comment" ? "none" : "comment");
        }}
      >
        <MessageSquareWarning aria-hidden />
        Needs changes
      </Button>
      {canEditText ? (
        <Button
          size="sm"
          variant="outline"
          aria-expanded={mode === "edit"}
          aria-controls={mode === "edit" ? editorId : undefined}
          disabled={pending}
          onClick={() => {
            setDraft(content);
            setMode(mode === "edit" ? "none" : "edit");
          }}
        >
          <PencilLine aria-hidden />
          Edit
        </Button>
      ) : null}
    </div>
  ) : null;

  const compareToggle = edited ? (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={mode === "compare"}
      onClick={() => setMode(mode === "compare" ? "none" : "compare")}
      className="print:hidden"
    >
      <GitCompareArrows aria-hidden />
      Before and after
    </Button>
  ) : null;

  const badges = (
    <div className="flex flex-wrap items-center gap-1.5 print:hidden">
      <ProvenanceBadge
        kind={section.producedByRole === "independent-review" ? "review" : "specialist"}
        by={agentRoleLabels[section.producedByRole]}
      />
      {section.modelTier ? (
        <Badge variant="outline" data-model-tier={section.modelTier}>
          {modelTierLabels[section.modelTier]}
        </Badge>
      ) : null}
      {producedAt ? (
        <Badge variant="neutral">
          <Clock aria-hidden />
          <time dateTime={producedAt}>{formatDateTime(producedAt)}</time>
        </Badge>
      ) : null}
      {edited ? (
        <Badge variant="highlight" data-edited-by-reviewer>
          <PencilLine aria-hidden />
          Edited by reviewer
        </Badge>
      ) : null}
      <Badge
        variant={reviewVariants[section.reviewStatus]}
        data-review-status={section.reviewStatus}
      >
        {sectionReviewLabels[section.reviewStatus]}
      </Badge>
    </div>
  );

  const editors =
    mode === "edit" ? (
      <form id={editorId} onSubmit={handleSaveEdit} className="flex flex-col gap-2 print:hidden">
        <label htmlFor={`${editorId}-text`} className="text-xs font-medium text-muted-foreground">
          Edit the text. Your edit is kept alongside the specialist&apos;s draft.
        </label>
        <Textarea
          id={`${editorId}-text`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={Math.min(14, Math.max(5, draft.split("\n").length + 2))}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setMode("none");
            }
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={draft.trim() === content.trim()}>
            Save edit
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode("none")}>
            Cancel
          </Button>
          {edited ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void submitAsync({ editedContent: null })}
            >
              <Undo2 aria-hidden />
              Restore the specialist&apos;s draft
            </Button>
          ) : null}
        </div>
      </form>
    ) : mode === "comment" ? (
      <form
        id={editorId}
        onSubmit={handleRequestChanges}
        className="flex flex-col gap-2 print:hidden"
      >
        <label
          htmlFor={`${editorId}-comment`}
          className="text-xs font-medium text-muted-foreground"
        >
          What needs to change?
        </label>
        <Textarea
          id={`${editorId}-comment`}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          rows={3}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setMode("none");
            }
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm">
            Request changes
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode("none")}>
            Cancel
          </Button>
        </div>
      </form>
    ) : null;

  const comments = section.reviewComment ? (
    <p className="rounded-md bg-warning-subtle p-2 text-xs text-foreground print:hidden">
      Reviewer comment: {section.reviewComment}
    </p>
  ) : null;

  if (section.kind === "chart") {
    return (
      <div
        id={sectionDomId(section.id)}
        tabIndex={-1}
        data-section-id={section.id}
        className="scroll-mt-4 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring print:break-inside-avoid"
      >
        <ChartSection
          section={section}
          footer={
            <div className="flex flex-col gap-2">
              {evidenceChips}
              <div className="flex flex-wrap items-center justify-between gap-2">
                {badges}
                {actions}
              </div>
              {editors}
              {comments}
            </div>
          }
        />
      </div>
    );
  }

  return (
    <section
      id={sectionDomId(section.id)}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-section-id={section.id}
      data-review-status={section.reviewStatus}
      className={cn(
        "flex scroll-mt-4 flex-col gap-3 rounded-lg border bg-card p-4 shadow-elevation-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring print:border-0 print:p-0 print:shadow-none",
        section.reviewStatus === "needs-changes" && "border-warning/40",
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <h4 id={headingId} className="min-w-0 flex-1 text-sm font-semibold">
          {section.title}
        </h4>
        {badges}
      </div>
      {mode === "compare" && edited ? (
        <BeforeAfter before={section.content} after={section.editedContent ?? ""} />
      ) : mode === "edit" ? null : (
        <SectionBody
          section={section}
          content={content}
          sources={sources}
          onOpenEvidence={onOpenEvidence}
          isEvidenceHighlighted={review?.isEvidenceHighlighted}
        />
      )}
      {editors}
      {comments}
      <InlineFindings
        findings={findings}
        evidenceIndex={evidenceIndex}
        onOpenEvidence={onOpenEvidence}
        onFocusFinding={onFocusFinding}
        label={`Findings supporting ${section.title}`}
      />
      {evidenceChips}
      {actions || compareToggle ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 print:hidden">
          {actions}
          {compareToggle}
        </div>
      ) : null}
    </section>
  );
}
