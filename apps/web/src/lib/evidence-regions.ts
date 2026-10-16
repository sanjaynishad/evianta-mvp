import type { BoundingBox, ExtractedDocument, ExtractedTable } from "@evianta/core";
import type { EvidenceEntry } from "@/lib/evidence";
import {
  boxContainsPoint,
  isApproximateMethod,
  locationMatchesSheet,
  rangeContainsRow,
  resolveRegionHighlight,
  sheetRangeOf,
  type Point,
  type RegionHighlight,
} from "@/lib/evidence-location";

export interface EvidenceRegion {
  evidenceId: string;
  description: string;
  highlight: RegionHighlight;
}

export function entriesForDocument(
  evidenceIndex: Map<string, EvidenceEntry>,
  documentId: string,
): EvidenceEntry[] {
  return [...evidenceIndex.values()].filter(
    (entry) => (entry.document?.id ?? entry.evidence.documentId) === documentId,
  );
}

function sourceIsApproximate(extraction: ExtractedDocument | undefined, page: number): boolean {
  const extractedPage = extraction?.pages.find((candidate) => candidate.index === page);
  if (extractedPage) {
    return isApproximateMethod(extractedPage.method);
  }

  return isApproximateMethod(extraction?.method);
}

export function regionForEntry(
  entry: EvidenceEntry,
  extraction: ExtractedDocument | undefined,
  pageCount?: number,
): EvidenceRegion {
  const location = entry.evidence.location;
  const page = location?.page ?? 1;
  const extractedPage = extraction?.pages.find((candidate) => candidate.index === page);
  return {
    evidenceId: entry.evidence.id,
    description: entry.evidence.description,
    highlight: resolveRegionHighlight(location, extractedPage, {
      pageCount,
      approximate: sourceIsApproximate(extraction, page),
    }),
  };
}

export function regionsForPage(
  entries: EvidenceEntry[],
  extraction: ExtractedDocument | undefined,
  page: number,
  pageCount?: number,
): EvidenceRegion[] {
  return entries
    .map((entry) => regionForEntry(entry, extraction, pageCount))
    .filter((region) => region.highlight.page === page);
}

export function regionsAtPoint(regions: EvidenceRegion[], point: Point): EvidenceRegion[] {
  return regions.filter((region) =>
    region.highlight.boxes.some((box: BoundingBox) => boxContainsPoint(box, point)),
  );
}

export function evidenceForRow(
  entries: EvidenceEntry[],
  table: ExtractedTable,
  row: number,
): EvidenceEntry[] {
  return entries.filter((entry) => {
    const location = entry.evidence.location;
    if (!locationMatchesSheet(location, table)) {
      return false;
    }

    const range = sheetRangeOf(location);
    return range ? rangeContainsRow(range, row) : false;
  });
}

export function findingIdsForEvidence(entries: EvidenceEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.findingIds))];
}
