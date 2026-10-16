import type { EvidenceEntry } from "@/lib/evidence";
import { formatEvidenceLocator, getEvidenceKind, getEvidenceLabel } from "@/lib/evidence";
import { EvidenceChip } from "@/components/patterns/evidence-chip";

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
  const entries = evidenceIds
    .map((id) => evidenceIndex.get(id))
    .filter((entry): entry is EvidenceEntry => entry !== undefined);
  if (entries.length === 0) {
    return null;
  }

  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {entries.map(({ evidence, document }) => {
        const footnote = footnoteNumbers?.get(evidence.id);
        return (
          <li key={evidence.id} className="flex items-center gap-0.5">
            <EvidenceChip
              label={getEvidenceLabel(evidence, document)}
              locator={formatEvidenceLocator(evidence.location)}
              kind={getEvidenceKind(evidence, document)}
              aria-haspopup="dialog"
              aria-label={`Open evidence: ${evidence.description}`}
              onClick={() => onOpenEvidence(evidence.id)}
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
