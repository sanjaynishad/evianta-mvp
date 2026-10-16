"use client";

import type { ReactNode } from "react";
import type { Deliverable, DeliverableSection } from "@evianta/core";
import { ChartSection } from "@/components/dashboard/chart-section";
import { ProvenanceBadge } from "@/components/patterns/provenance-badge";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { EvidenceEntry } from "@/lib/evidence";
import { agentRoleLabels, deliverableFormatLabels, sectionReviewLabels } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { EvidenceChipList } from "./evidence-chip-list";

export interface DeliverableViewProps {
  deliverable: Deliverable;
  evidenceIndex: Map<string, EvidenceEntry>;
  evidenceNumbers: Map<string, number>;
  onOpenEvidence: (evidenceId: string) => void;
  actions?: ReactNode;
}

const reviewVariants: Record<
  DeliverableSection["reviewStatus"],
  NonNullable<BadgeProps["variant"]>
> = {
  pending: "neutral",
  approved: "success",
  "needs-changes": "warning",
};

function SectionBody({ section }: { section: DeliverableSection }) {
  const content = section.editedContent ?? section.content;
  if (section.kind === "table" || section.kind === "timeline") {
    return (
      <pre className="figures overflow-x-auto whitespace-pre rounded-md bg-muted p-3 text-xs leading-relaxed text-foreground print:whitespace-pre-wrap print:bg-transparent">
        {content}
      </pre>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      {content
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((paragraph, index) => (
          <p key={index} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
    </div>
  );
}

export function DeliverableView({
  deliverable,
  evidenceIndex,
  evidenceNumbers,
  onOpenEvidence,
  actions,
}: DeliverableViewProps) {
  const isDashboard = deliverable.format === "dashboard";
  const headingId = `deliverable-${deliverable.id}`;
  return (
    <article
      aria-labelledby={headingId}
      data-deliverable-id={deliverable.id}
      className="flex flex-col gap-4 print:break-inside-auto"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="min-w-0 flex-1 text-lg font-semibold">
          {deliverable.title}
        </h3>
        <Badge variant="neutral" className="print:hidden">
          {deliverableFormatLabels[deliverable.format]}
        </Badge>
        {actions ? <div className="print:hidden">{actions}</div> : null}
      </header>
      <div className={cn("grid gap-4", isDashboard && "lg:grid-cols-2")}>
        {deliverable.sections.map((section) => {
          const evidenceChips = (
            <EvidenceChipList
              evidenceIds={section.evidenceIds}
              evidenceIndex={evidenceIndex}
              onOpenEvidence={onOpenEvidence}
              footnoteNumbers={evidenceNumbers}
              label={`Evidence for ${section.title}`}
            />
          );
          if (section.kind === "chart") {
            return (
              <div
                key={section.id}
                data-section-id={section.id}
                className="print:break-inside-avoid"
              >
                <ChartSection section={section} footer={evidenceChips} />
              </div>
            );
          }

          return (
            <section
              key={section.id}
              data-section-id={section.id}
              aria-label={section.title}
              className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-elevation-1 print:border-0 print:p-0 print:shadow-none"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="min-w-0 flex-1 text-sm font-semibold">{section.title}</h4>
                <div className="flex flex-wrap items-center gap-1.5 print:hidden">
                  <ProvenanceBadge
                    kind={section.producedByRole === "independent-review" ? "review" : "specialist"}
                    by={agentRoleLabels[section.producedByRole]}
                  />
                  {section.editedContent !== undefined ? (
                    <Badge variant="highlight">Edited by reviewer</Badge>
                  ) : null}
                  <Badge variant={reviewVariants[section.reviewStatus]}>
                    {sectionReviewLabels[section.reviewStatus]}
                  </Badge>
                </div>
              </div>
              <SectionBody section={section} />
              {section.reviewComment ? (
                <p className="rounded-md bg-warning-subtle p-2 text-xs text-foreground print:hidden">
                  Reviewer comment: {section.reviewComment}
                </p>
              ) : null}
              {evidenceChips}
            </section>
          );
        })}
      </div>
    </article>
  );
}
