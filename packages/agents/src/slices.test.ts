import type { DocumentMetadata, ExtractedDocument } from "@evianta/core";
import { describe, expect, it } from "vitest";

import { sliceDocuments } from "./slices.js";
import { estimateTokens } from "./text.js";

function metadata(id: string): DocumentMetadata {
  return {
    id,
    caseId: "case-1",
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    size: 1,
    gcsPath: `cases/case-1/${id}`,
    uploadedAt: "2025-01-01T00:00:00.000Z",
  };
}

function textExtraction(id: string, pages: string[]): ExtractedDocument {
  return {
    documentId: id,
    kind: "text",
    method: "ocr",
    confidence: 0.7,
    pages: pages.map((text, index) => ({
      index: index + 1,
      text,
      method: "ocr",
      confidence: 0.7,
    })),
    tables: [],
    warnings: [],
  };
}

describe("sliceDocuments", () => {
  it("keeps whole small documents", () => {
    const slices = sliceDocuments([
      { metadata: metadata("notice"), extraction: textExtraction("notice", ["Demand of 48,210"]) },
    ]);

    expect(slices).toEqual([
      expect.objectContaining({
        documentId: "notice",
        kind: "page",
        page: 1,
        text: "Demand of 48,210",
        truncated: false,
        confidence: 0.7,
      }),
    ]);
  });

  it("stays within the token budget and prefers relevant pages", () => {
    const filler = "lorem ipsum ".repeat(200);
    const pages = [filler, `${filler} TDS mismatch details here`, filler];
    const slices = sliceDocuments(
      [{ metadata: metadata("ledger"), extraction: textExtraction("ledger", pages) }],
      { query: "TDS mismatch", tokenBudget: 700 },
    );
    const used = slices.reduce((sum, slice) => sum + estimateTokens(slice.text), 0);

    expect(used).toBeLessThanOrEqual(700);
    expect(slices[0]?.page).toBe(2);
    expect(slices[0]?.text).toContain("TDS mismatch");
  });

  it("shares the budget across documents and truncates tables by rows", () => {
    const rows = Array.from({ length: 500 }, (_, index) => [`INV-${index + 1}`, 1000 + index]);
    const ledger: ExtractedDocument = {
      documentId: "ledger",
      kind: "tabular",
      method: "parse",
      confidence: 1,
      pages: [],
      tables: [
        {
          name: "Ledger",
          sheet: "Sheet1",
          columns: [
            { name: "Invoice", type: "string" },
            { name: "Amount", type: "number" },
          ],
          rows,
        },
      ],
      warnings: [],
    };
    const slices = sliceDocuments(
      [
        { metadata: metadata("ledger"), extraction: ledger },
        { metadata: metadata("notice"), extraction: textExtraction("notice", ["Short notice"]) },
        { metadata: metadata("missing") },
      ],
      { tokenBudget: 1000 },
    );
    const table = slices.find((slice) => slice.kind === "table");

    expect(slices.map((slice) => slice.documentId)).toEqual(["ledger", "notice"]);
    expect(table?.truncated).toBe(true);
    expect(table?.rowRange?.start).toBe(1);
    expect(table?.rowRange?.end).toBeLessThan(500);
    expect(table?.text).toContain(`of 500)`);
    expect(slices.reduce((sum, slice) => sum + estimateTokens(slice.text), 0)).toBeLessThanOrEqual(
      1000,
    );
  });
});
