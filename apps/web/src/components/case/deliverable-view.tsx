"use client";

import type { ReactNode } from "react";
import type { Deliverable, Finding, SectionUpdateRequest } from "@evianta/core";
import { SectionReview } from "@/components/review/section-review";
import { Badge } from "@/components/ui/badge";
import type { EvidenceEntry } from "@/lib/evidence";
import { deliverableFormatLabels } from "@/lib/labels";
import { cn } from "@/lib/utils";

export interface DeliverableViewProps {
  deliverable: Deliverable;
  evidenceIndex: Map<string, EvidenceEntry>;
  evidenceNumbers: Map<string, number>;
  onOpenEvidence: (evidenceId: string) => void;
  findingsById?: Map<string, Finding>;
  onFocusFinding?: (findingId: string) => void;
  onUpdateSection?: (
    deliverableId: string,
    sectionId: string,
    update: SectionUpdateRequest,
  ) => Promise<boolean>;
  isSectionPending?: (sectionId: string) => boolean;
  producedAt?: string;
  actions?: ReactNode;
}

export function DeliverableView({
  deliverable,
  evidenceIndex,
  evidenceNumbers,
  onOpenEvidence,
  findingsById,
  onFocusFinding,
  onUpdateSection,
  isSectionPending,
  producedAt,
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
      <div className={cn("grid gap-4", isDashboard && "xl:grid-cols-2")}>
        {deliverable.sections.map((section) => (
          <SectionReview
            key={section.id}
            section={section}
            evidenceIndex={evidenceIndex}
            evidenceNumbers={evidenceNumbers}
            findings={section.findingIds
              .map((id) => findingsById?.get(id))
              .filter((finding): finding is Finding => finding !== undefined)}
            onOpenEvidence={onOpenEvidence}
            onFocusFinding={onFocusFinding}
            onUpdate={
              onUpdateSection
                ? (update) => onUpdateSection(deliverable.id, section.id, update)
                : undefined
            }
            pending={isSectionPending?.(section.id)}
            producedAt={producedAt}
          />
        ))}
      </div>
    </article>
  );
}
