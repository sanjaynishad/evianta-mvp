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

const JSON_MIME_TYPES = new Set(["application/json", "application/x-ndjson"]);

// Stored MIME types come from content detection, so a PDF or image named *.json keeps its
// own viewer; the file name decides only when no specific type is known.
function isJsonDocument(name: string, mimeType: string): boolean {
  if (JSON_MIME_TYPES.has(mimeType)) {
    return true;
  }

  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return false;
  }

  return /\.(json|jsonl|ndjson)$/.test(name);
}

export function getEvidenceKind(evidence: Evidence, document?: CaseDocument): EvidenceSourceKind {
  if (isWebEvidence(evidence)) {
    return "web";
  }

  const name = (document?.name ?? evidence.sourceRef).toLowerCase();
  const mimeType = document?.mimeType ?? "";
  if (isJsonDocument(name, mimeType.toLowerCase())) {
    return document?.extraction?.kind === "text" ? "document" : "spreadsheet";
  }

  if (/\.(csv|xlsx?)$/.test(name) || mimeType.includes("spreadsheet") || mimeType === "text/csv") {
    return "spreadsheet";
  }

  if (/\.(png|jpe?g|webp|gif)$/.test(name) || mimeType.startsWith("image/")) {
    return "image";
  }

  return "document";
}

export type DocumentViewKind = "pdf" | "image" | "spreadsheet" | "text";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Evidence whose description, excerpt, or quote names the label, for example a reconciliation
// row's party. Rows never inherit citations that do not mention them.
export function evidenceNamingLabel(entries: EvidenceEntry[], label: string): EvidenceEntry[] {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || /^(grand )?total$/i.test(label.trim())) {
    return [];
  }

  const pattern = new RegExp(`(^|\\W)${words.map(escapeRegExp).join("\\s+")}(\\W|$)`, "i");
  return entries.filter(({ evidence }) =>
    [evidence.description, evidence.excerpt, evidence.location?.textQuote].some(
      (text) => text !== undefined && pattern.test(text),
    ),
  );
}

export function getDocumentKind(
  document: Pick<CaseDocument, "name" | "mimeType" | "extraction">,
): DocumentViewKind {
  const name = document.name.toLowerCase();
  const mimeType = document.mimeType.toLowerCase();
  if (isJsonDocument(name, mimeType)) {
    return document.extraction?.kind === "text" ? "text" : "spreadsheet";
  }

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
