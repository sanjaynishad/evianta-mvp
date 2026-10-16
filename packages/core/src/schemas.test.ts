import { describe, expect, it } from "vitest";

import {
  agentProfileSchema,
  deliverableSchema,
  documentMetadataSchema,
  extractedDocumentSchema,
  tokenUsageSchema,
} from "./index.js";

describe("agentProfileSchema", () => {
  it("defaults lists and enables the profile", () => {
    const parsed = agentProfileSchema.parse({
      role: "tax-research",
      displayName: "Tax Research",
      specialty: "Indian income tax",
      summary: "Finds the provisions and precedents that apply to a notice.",
      modelTier: "mid",
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.limitations).toEqual([]);
  });

  it("rejects an unknown model tier", () => {
    const result = agentProfileSchema.safeParse({
      role: "tax-research",
      displayName: "Tax Research",
      specialty: "Indian income tax",
      summary: "Summary",
      modelTier: "ultra",
    });

    expect(result.success).toBe(false);
  });
});

describe("tokenUsageSchema", () => {
  it("requires non-negative integers", () => {
    expect(tokenUsageSchema.safeParse({ input: 1, output: 2, total: 3 }).success).toBe(true);
    expect(tokenUsageSchema.safeParse({ input: -1, output: 2, total: 1 }).success).toBe(false);
  });
});

describe("deliverableSchema", () => {
  it("defaults sections and keeps legacy content", () => {
    const parsed = deliverableSchema.parse({
      id: "del-1",
      caseId: "case-1",
      title: "Response",
      format: "document",
      content: "Legacy body",
    });

    expect(parsed.sections).toEqual([]);
    expect(parsed.content).toBe("Legacy body");
  });

  it("applies section defaults", () => {
    const parsed = deliverableSchema.parse({
      id: "del-2",
      caseId: "case-1",
      title: "Dashboard",
      format: "dashboard",
      sections: [
        {
          id: "sec-1",
          title: "Revenue trend",
          kind: "chart",
          content: '{"type":"line"}',
          producedByRole: "business-data-analyst",
          modelTier: "mid",
        },
      ],
    });

    expect(parsed.sections[0]).toMatchObject({
      reviewStatus: "pending",
      findingIds: [],
      evidenceIds: [],
    });
  });
});

describe("documentMetadataSchema", () => {
  it("requires a non-negative integer size", () => {
    const base = {
      id: "doc-1",
      caseId: "case-1",
      name: "notice.pdf",
      mimeType: "application/pdf",
      gcsPath: "gs://bucket/cases/case-1/documents/doc-1/notice.pdf",
      uploadedAt: new Date().toISOString(),
    };

    expect(documentMetadataSchema.safeParse({ ...base, size: 1024 }).success).toBe(true);
    expect(documentMetadataSchema.safeParse({ ...base, size: -1 }).success).toBe(false);
  });
});

describe("extractedDocumentSchema", () => {
  it("accepts a mixed PDF with per-page methods and spans", () => {
    const parsed = extractedDocumentSchema.parse({
      documentId: "doc-1",
      kind: "text",
      method: "mixed",
      confidence: 0.82,
      pages: [
        {
          index: 1,
          text: "Notice under section 143(1)",
          width: 595,
          height: 842,
          method: "pdf-text",
          confidence: 1,
          spans: [
            {
              text: "Notice under section 143(1)",
              bbox: { x: 0.1, y: 0.05, width: 0.6, height: 0.03 },
            },
          ],
        },
        { index: 2, text: "Annexure", method: "ocr", confidence: 0.64 },
      ],
    });

    expect(parsed.pages.map((page) => page.method)).toEqual(["pdf-text", "ocr"]);
    expect(parsed.tables).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("accepts parsed tables", () => {
    const parsed = extractedDocumentSchema.parse({
      documentId: "doc-2",
      kind: "tabular",
      method: "parse",
      confidence: 1,
      tables: [
        {
          name: "Sales",
          sheet: "Sales",
          columns: [
            { name: "Month", type: "date" },
            { name: "Revenue", type: "number" },
          ],
          rows: [
            ["2026-01-01", 1200],
            ["2026-02-01", null],
          ],
        },
      ],
    });

    expect(parsed.tables[0]?.rows).toHaveLength(2);
  });

  it("rejects mixed as a per-page method and out-of-range confidence", () => {
    const pageMethod = extractedDocumentSchema.safeParse({
      documentId: "doc-3",
      kind: "text",
      method: "mixed",
      confidence: 0.5,
      pages: [{ index: 1, text: "", method: "mixed", confidence: 0.5 }],
    });
    const confidence = extractedDocumentSchema.safeParse({
      documentId: "doc-3",
      kind: "text",
      method: "ocr",
      confidence: 1.5,
    });

    expect(pageMethod.success).toBe(false);
    expect(confidence.success).toBe(false);
  });
});
