"use client";

import { ConfidenceBadge } from "@/components/patterns/confidence-badge";
import { EvidenceChip } from "@/components/patterns/evidence-chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  formatEvidenceLocator,
  getEvidenceKind,
  getEvidenceLabel,
  type EvidenceEntry,
} from "@/lib/evidence";

export interface EvidenceHoverChipProps {
  entry: EvidenceEntry;
  onOpen: (evidenceId: string) => void;
  selected?: boolean;
  className?: string;
}

// An evidence chip that previews the source on hover or focus and opens the viewer on click.
export function EvidenceHoverChip({
  entry,
  onOpen,
  selected = false,
  className,
}: EvidenceHoverChipProps) {
  const { evidence, document } = entry;
  const locator = formatEvidenceLocator(evidence.location);
  const quote = evidence.location?.textQuote ?? evidence.excerpt;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <EvidenceChip
          label={getEvidenceLabel(evidence, document)}
          locator={locator}
          kind={getEvidenceKind(evidence, document)}
          selected={selected}
          aria-haspopup="dialog"
          aria-label={`Open evidence: ${evidence.description}`}
          data-evidence-id={evidence.id}
          onClick={() => onOpen(evidence.id)}
          className={className}
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="flex max-w-sm flex-col gap-1.5 p-3">
        <span className="font-medium">{evidence.description}</span>
        <span className="opacity-80">
          {document?.name ?? evidence.sourceRef}
          {locator ? `, ${locator}` : ""}
        </span>
        {quote ? (
          <span className="line-clamp-3 italic opacity-90">&ldquo;{quote}&rdquo;</span>
        ) : null}
        <span className="flex items-center gap-2">
          <ConfidenceBadge level={evidence.confidence ?? "unassessed"} compact />
          <span className="opacity-80">Click to open the source</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
