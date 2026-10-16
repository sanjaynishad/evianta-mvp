import type { DocumentMetadata, Evidence, ExtractedDocument, Finding, Task } from "@evianta/core";
import { describe, expect, it } from "vitest";

import { activeFindings, buildTaskRecord, type RecordContext } from "./record.js";

const task: Task = {
  id: "draft",
  caseId: "case-1",
  title: "Draft response",
  assignedRole: "response-preparation",
  status: "in-progress",
  dependsOn: [],
  attempts: 1,
};

const metadata: DocumentMetadata = {
  id: "doc-scan",
  caseId: "case-1",
  name: "scan.pdf",
  mimeType: "application/pdf",
  size: 1024,
  gcsPath: "cases/case-1/doc-scan",
  uploadedAt: "2026-01-01T00:00:00.000Z",
};

const extraction = {
  documentId: "doc-scan",
  kind: "text",
  method: "ocr",
  confidence: 0.9,
  pages: [{ index: 1, text: "Blurry", method: "ocr", confidence: 0.4 }],
  tables: [],
  warnings: [],
} as ExtractedDocument;

const researchEvidence: Evidence = {
  id: "ev-research",
  sourceRef: "https://example.gov/143",
  description: "Section 143",
  excerpt: "Assessment",
  confidence: "medium",
};

function contextWith(overrides: Partial<RecordContext> = {}): RecordContext {
  let counter = 0;

  return {
    caseId: "case-1",
    task,
    attempt: 2,
    documentsById: new Map([[metadata.id, metadata]]),
    extractionsById: new Map([[metadata.id, extraction]]),
    upstreamEvidence: [researchEvidence],
    newId: () => `new-${++counter}`,
    ...overrides,
  };
}

function recordFor(evidence: Record<string, unknown>[], ctx = contextWith()) {
  return buildTaskRecord(
    {
      findings: [{ summary: "Claim", severity: "high", confidence: "high", evidence }],
      usage: { input: 0, output: 0, total: 0 },
      cost: 0,
    },
    ctx,
    "response-preparation",
    "mid",
  );
}

describe("buildTaskRecord", () => {
  it("derives document evidence confidence from the extraction, not the model", () => {
    const record = recordFor([
      { documentId: "doc-scan", description: "Scanned page", page: 1, confidence: "high" },
    ]);

    expect(record.evidence[0]).toMatchObject({ documentId: "doc-scan", confidence: "low" });
  });

  it("rejects a page that is not in the cached extraction", () => {
    const record = recordFor([{ documentId: "doc-scan", description: "Invented page", page: 999 }]);

    expect(record.evidence).toEqual([]);
    expect(record.dropped[0]?.reason).toBe('Page 999 is not in the extraction of "scan.pdf".');
  });

  it("reuses validated upstream evidence by id or URL and rejects unknown sources", () => {
    const record = recordFor([
      { evidenceId: "ev-research", description: "" },
      { url: "https://example.gov/143", description: "Section 143 again" },
      { evidenceId: "ev-invented", description: "Made up" },
      { url: "https://invented.example", description: "Made up" },
    ]);

    expect(record.evidence).toEqual([
      expect.objectContaining({
        id: "new-1",
        sourceRef: "https://example.gov/143",
        description: "Section 143",
      }),
      expect.objectContaining({
        id: "new-2",
        sourceRef: "https://example.gov/143",
        description: "Section 143 again",
      }),
    ]);
    expect(record.dropped.map((item) => item.reason)).toEqual([
      'Unknown evidence "ev-invented".',
      'URL "https://invented.example" is not among the grounding citations or upstream evidence.',
    ]);
  });

  it("tags findings with the attempt that produced them", () => {
    const record = buildTaskRecord(
      {
        findings: [{ summary: "Claim", severity: "low", confidence: "high" }],
        openQuestions: [{ text: "Missing ledger?", severity: "medium" }],
        usage: { input: 0, output: 0, total: 0 },
        cost: 0,
      },
      contextWith(),
      "response-preparation",
      "mid",
    );

    expect(record.findings.map((finding) => finding.attempt)).toEqual([2, 2]);
  });
});

describe("activeFindings", () => {
  it("keeps only the latest completed attempt and untagged findings", () => {
    const tasks: Task[] = [
      { ...task, id: "done", status: "completed", attempts: 2 },
      { ...task, id: "broken", status: "failed", attempts: 1 },
    ];
    const findings = [
      { id: "stale", taskId: "done", attempt: 1 },
      { id: "current", taskId: "done", attempt: 2 },
      { id: "partial", taskId: "broken", attempt: 1 },
      { id: "notes", taskId: "broken" },
    ].map((item) => ({
      ...item,
      summary: item.id,
      evidence: [],
      assumptions: [],
      openQuestions: [],
    }));

    expect(activeFindings(findings as Finding[], tasks).map((finding) => finding.id)).toEqual([
      "current",
      "notes",
    ]);
  });
});
