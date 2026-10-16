import type { CaseDocument, CaseState, Evidence, EvidenceLocation } from "@evianta/core";
import type { EvidenceSourceKind } from "@/components/patterns/evidence-chip";

export interface EvidenceEntry {
  evidence: Evidence;
  document?: CaseDocument;
  findingIds: string[];
}

export function formatEvidenceLocator(location: EvidenceLocation | undefined): string | undefined {
  if (!location) {
    return undefined;
  }

  const parts: string[] = [];
  if (location.page) {
    parts.push(`p.${location.page}`);
  }

  if (location.sheet) {
    parts.push(location.sheet);
  }

  if (location.cellRange) {
    parts.push(location.cellRange);
  }

  if (location.rowRange) {
    parts.push(
      location.rowRange.start === location.rowRange.end
        ? `row ${location.rowRange.start}`
        : `rows ${location.rowRange.start}-${location.rowRange.end}`,
    );
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function isWebEvidence(evidence: Pick<Evidence, "sourceRef">): boolean {
  return /^https?:\/\//i.test(evidence.sourceRef);
}

export function getEvidenceKind(evidence: Evidence, document?: CaseDocument): EvidenceSourceKind {
  if (isWebEvidence(evidence)) {
    return "web";
  }

  const name = (document?.name ?? evidence.sourceRef).toLowerCase();
  const mimeType = document?.mimeType ?? "";
  if (/\.(csv|xlsx?)$/.test(name) || mimeType.includes("spreadsheet") || mimeType === "text/csv") {
    return "spreadsheet";
  }

  if (/\.(png|jpe?g|webp|gif)$/.test(name) || mimeType.startsWith("image/")) {
    return "image";
  }

  return "document";
}

export type DocumentViewKind = "pdf" | "image" | "spreadsheet" | "text";

export function getDocumentKind(
  document: Pick<CaseDocument, "name" | "mimeType">,
): DocumentViewKind {
  const name = document.name.toLowerCase();
  const mimeType = document.mimeType.toLowerCase();
  if (mimeType === "application/pdf" || name.endsWith(".pdf")) {
    return "pdf";
  }

  if (mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(name)) {
    return "image";
  }

  if (
    /\.(csv|tsv|xlsx?)$/.test(name) ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType === "text/csv"
  ) {
    return "spreadsheet";
  }

  return "text";
}

export function getEvidenceLabel(evidence: Evidence, document?: CaseDocument): string {
  if (isWebEvidence(evidence)) {
    return evidence.description;
  }

  return document?.name ?? evidence.sourceRef;
}

export function buildEvidenceIndex(state: CaseState): Map<string, EvidenceEntry> {
  const documents = new Map(state.documents.map((document) => [document.id, document]));
  const index = new Map<string, EvidenceEntry>();

  function add(evidence: Evidence, findingId?: string) {
    const existing = index.get(evidence.id);
    if (existing) {
      if (findingId && !existing.findingIds.includes(findingId)) {
        existing.findingIds.push(findingId);
      }

      return;
    }

    index.set(evidence.id, {
      evidence,
      document: evidence.documentId ? documents.get(evidence.documentId) : undefined,
      findingIds: findingId ? [findingId] : [],
    });
  }

  for (const finding of state.findings) {
    for (const evidence of finding.evidence) {
      add(evidence, finding.id);
    }
  }

  for (const evidence of state.evidence) {
    add(evidence);
  }

  return index;
}

// Footnote numbers for print, in the order evidence first appears in the deliverables.
export function numberEvidenceReferences(state: CaseState): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const deliverable of state.deliverables) {
    for (const section of deliverable.sections) {
      for (const evidenceId of section.evidenceIds) {
        if (!numbers.has(evidenceId)) {
          numbers.set(evidenceId, numbers.size + 1);
        }
      }
    }
  }

  return numbers;
}
