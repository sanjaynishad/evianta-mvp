import { describe, expect, it } from "vitest";
import type { CaseDocument, ExtractedDocumentKind } from "@evianta/core";
import { getDocumentKind, getEvidenceKind } from "./evidence";

function caseDocument(name: string, mimeType: string, kind?: ExtractedDocumentKind): CaseDocument {
  return {
    id: "doc-1",
    caseId: "case-1",
    name,
    mimeType,
    size: 10,
    uploadedAt: "2026-10-01T00:00:00.000Z",
    status: kind ? "ready" : "processing",
    ...(kind
      ? {
          extraction: {
            kind,
            method: "parse",
            confidence: 1,
            pageCount: kind === "text" ? 1 : 0,
            tableCount: kind === "tabular" ? 1 : 0,
            warnings: [],
            pagesNeedingReview: [],
            handwriting: false,
          },
        }
      : {}),
  };
}

const evidence = { id: "e-1", sourceRef: "sales.json", description: "Row 2" };

describe("JSON document kinds", () => {
  it("shows JSON read as tables in the spreadsheet viewer", () => {
    for (const document of [
      caseDocument("sales.json", "application/json", "tabular"),
      caseDocument("events.jsonl", "application/x-ndjson", "tabular"),
      caseDocument("export", "application/json", "tabular"),
      caseDocument("sales.json", "application/json"),
    ]) {
      expect(getDocumentKind(document)).toBe("spreadsheet");
      expect(getEvidenceKind(evidence, document)).toBe("spreadsheet");
    }
  });

  it("shows JSON read as text in the text viewer", () => {
    const document = caseDocument("status.json", "application/json", "text");

    expect(getDocumentKind(document)).toBe("text");
    expect(getEvidenceKind(evidence, document)).toBe("document");
  });

  it("trusts a detected PDF or image type over a .json file name", () => {
    const pdf = caseDocument("export.json", "application/pdf");
    const png = caseDocument("export.json", "image/png");

    expect(getDocumentKind(pdf)).toBe("pdf");
    expect(getEvidenceKind(evidence, pdf)).toBe("document");
    expect(getDocumentKind(png)).toBe("image");
    expect(getEvidenceKind(evidence, png)).toBe("image");
    expect(getDocumentKind(caseDocument("events.ndjson", "application/octet-stream"))).toBe(
      "spreadsheet",
    );
  });
});

describe("text document kinds", () => {
  it("shows plain text, Markdown, and Word documents in the text viewer", () => {
    for (const document of [
      caseDocument("notes.txt", "text/plain", "text"),
      caseDocument("dues.md", "text/markdown", "text"),
      caseDocument(
        "statement.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text",
      ),
    ]) {
      expect(getDocumentKind(document)).toBe("text");
      expect(getEvidenceKind(evidence, document)).toBe("document");
    }
  });
});
