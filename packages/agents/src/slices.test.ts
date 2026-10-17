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

  it("reserves room for the truncation marker in table slices", () => {
    const sheet: ExtractedDocument = {
      documentId: "sheet",
      kind: "tabular",
      method: "parse",
      confidence: 1,
      pages: [],
      tables: [
        {
          name: "Values",
          columns: [{ name: "Value", type: "string" }],
          rows: [["a".repeat(460)], ["b".repeat(460)]],
        },
      ],
      warnings: [],
    };

    for (let tokenBudget = 120; tokenBudget <= 130; tokenBudget += 1) {
      const slices = sliceDocuments([{ metadata: metadata("sheet"), extraction: sheet }], {
        tokenBudget,
      });
      const used = slices.reduce((sum, slice) => sum + estimateTokens(slice.text), 0);

      expect(used).toBeLessThanOrEqual(tokenBudget);
    }

    const [slice] = sliceDocuments([{ metadata: metadata("sheet"), extraction: sheet }], {
      tokenBudget: 130,
    });

    expect(slice?.text).toContain("(showing rows 1-1 of 2)");
  });

  it("reports table rows in worksheet coordinates from the table range", () => {
    const sheet: ExtractedDocument = {
      documentId: "sheet",
      kind: "tabular",
      method: "parse",
      confidence: 1,
      pages: [],
      tables: [
        {
          name: "Ledger",
          sheet: "Ledger",
          range: "B3:C5",
          columns: [
            { name: "Invoice", type: "string" },
            { name: "Amount", type: "number" },
          ],
          rows: [
            ["INV-1", 1200],
            ["INV-2", 800],
          ],
        },
      ],
      warnings: [],
    };

    const [whole] = sliceDocuments([{ metadata: metadata("sheet"), extraction: sheet }]);

    expect(whole).toMatchObject({ range: "B3:C5", rowRange: { start: 4, end: 5 } });

    const wide: ExtractedDocument = {
      ...sheet,
      tables: [
        {
          name: "Values",
          range: "D10:D12",
          columns: [{ name: "Value", type: "string" }],
          rows: [["a".repeat(460)], ["b".repeat(460)]],
        },
      ],
    };
    const [truncated] = sliceDocuments([{ metadata: metadata("sheet"), extraction: wide }], {
      tokenBudget: 140,
    });

    expect(truncated).toMatchObject({ range: "D10:D12", rowRange: { start: 11, end: 11 } });
    expect(truncated?.text).toContain("(showing rows 11-11 of 11-12)");
  });

  it("drops a header-only table whose header exceeds the budget", () => {
    const columns = Array.from({ length: 60 }, (_, index) => ({
      name: `Column number ${index + 1}`,
      type: "string" as const,
    }));
    const sheet: ExtractedDocument = {
      documentId: "sheet",
      kind: "tabular",
      method: "parse",
      confidence: 1,
      pages: [],
      tables: [{ name: "Empty", columns, rows: [] }],
      warnings: [],
    };

    expect(
      sliceDocuments([{ metadata: metadata("sheet"), extraction: sheet }], { tokenBudget: 120 }),
    ).toEqual([]);

    const [kept] = sliceDocuments([{ metadata: metadata("sheet"), extraction: sheet }], {
      tokenBudget: 2000,
    });

    expect(kept).toMatchObject({ kind: "table", truncated: false });
    expect(kept?.rowRange).toBeUndefined();
  });

  it("builds truncated slices from unused budget when every share is too small", () => {
    const page = "lorem ipsum ".repeat(333);
    const slices = sliceDocuments(
      ["a", "b", "c"].map((id) => ({
        metadata: metadata(id),
        extraction: textExtraction(id, [page]),
      })),
      { tokenBudget: 300 },
    );
    const used = slices.reduce((sum, slice) => sum + estimateTokens(slice.text), 0);

    expect(slices.length).toBeGreaterThan(0);
    expect(slices.every((slice) => slice.truncated)).toBe(true);
    expect(used).toBeLessThanOrEqual(300);
  });
});
