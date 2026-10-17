"use client";

import type { EvidenceEntry } from "@/lib/evidence";
import { EvidenceHoverChip } from "@/components/review/evidence-hover-chip";
import { useOptionalReview } from "@/components/review/review-context";

export interface EvidenceChipListProps {
  evidenceIds: string[];
  evidenceIndex: Map<string, EvidenceEntry>;
  onOpenEvidence: (evidenceId: string) => void;
  footnoteNumbers?: Map<string, number>;
  label?: string;
}

export function EvidenceChipList({
  evidenceIds,
  evidenceIndex,
  onOpenEvidence,
  footnoteNumbers,
  label = "Evidence",
}: EvidenceChipListProps) {
  const review = useOptionalReview();
  const entries = [...new Set(evidenceIds)]
    .map((id) => evidenceIndex.get(id))
    .filter((entry): entry is EvidenceEntry => entry !== undefined);
  if (entries.length === 0) {
    return null;
  }

  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {entries.map((entry) => {
        const footnote = footnoteNumbers?.get(entry.evidence.id);
        return (
          <li key={entry.evidence.id} className="flex items-center gap-0.5">
            <EvidenceHoverChip
              entry={entry}
              onOpen={onOpenEvidence}
              selected={review?.isEvidenceHighlighted(entry.evidence.id) ?? false}
              className="print:hidden"
            />
            {footnote ? (
              <sup className="hidden text-xs print:inline" aria-hidden>
                [{footnote}]
              </sup>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
