import {
  formatEvidenceLocator,
  getEvidenceLabel,
  isWebEvidence,
  type EvidenceEntry,
} from "@/lib/evidence";

export interface EvidenceAppendixProps {
  evidenceNumbers: Map<string, number>;
  evidenceIndex: Map<string, EvidenceEntry>;
}

// Printed after the deliverable so footnote references resolve on paper.
export function EvidenceAppendix({ evidenceNumbers, evidenceIndex }: EvidenceAppendixProps) {
  const entries = [...evidenceNumbers.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id, number]) => ({ number, entry: evidenceIndex.get(id) }))
    .filter((item): item is { number: number; entry: EvidenceEntry } => item.entry !== undefined);
  if (entries.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="evidence-appendix-heading"
      data-print-only
      className="hidden break-before-page flex-col gap-3 print:flex"
    >
      <h2 id="evidence-appendix-heading" className="text-lg font-semibold">
        Evidence
      </h2>
      <ol className="flex flex-col gap-2 text-sm">
        {entries.map(({ number, entry }) => {
          const { evidence } = entry;
          const locator = formatEvidenceLocator(evidence.location);
          const excerpt = evidence.excerpt ? ` "${evidence.excerpt}"` : "";
          return (
            <li key={evidence.id} className="flex gap-2">
              <span className="figures shrink-0">[{number}]</span>
              {isWebEvidence(evidence) ? (
                <span>
                  {evidence.description}:{" "}
                  <span className="break-all" data-testid="evidence-url">
                    {evidence.sourceRef}
                  </span>
                  {excerpt}
                </span>
              ) : (
                <span>
                  {getEvidenceLabel(evidence, entry.document)}
                  {locator ? `, ${locator}` : ""}: {evidence.description}
                  {excerpt}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
