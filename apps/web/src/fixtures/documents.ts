import type { ExtractionMethod, ExtractionSummary } from "@evianta/core";

export function extractionSummary(
  method: ExtractionMethod,
  confidence: number,
  details: Partial<Omit<ExtractionSummary, "method" | "confidence">> = {},
): ExtractionSummary {
  const tabular = method === "parse";
  return {
    kind: tabular ? "tabular" : "text",
    method,
    confidence,
    pageCount: tabular ? 0 : 1,
    tableCount: tabular ? 1 : 0,
    warnings: [],
    pagesNeedingReview: [],
    handwriting: method === "handwriting",
    ...details,
  };
}
