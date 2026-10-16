import { describe, expect, it } from "vitest";

import {
  apiErrorBodySchema,
  askResultSchema,
  caseStateSchema,
  createCaseRequestSchema,
  isDocumentErrorCode,
  runStartResponseSchema,
  sampleReadOnlyErrorBodySchema,
  sectionUpdateRequestSchema,
  usageSummarySchema,
} from "./index.js";

const now = "2026-10-01T10:00:00.000Z";
const usage = { input: 10, output: 5, total: 15 };

describe("caseStateSchema", () => {
  it("parses the GET /cases/:id response with documents, cost, and run cursor", () => {
    const parsed = caseStateSchema.parse({
      case: { id: "case-1", title: "Sales review", createdAt: now, updatedAt: now },
      documents: [
        {
          id: "doc-1",
          caseId: "case-1",
          name: "sales.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 2048,
          uploadedAt: now,
          status: "ready",
          errorCode: "ocr-partial",
          error: "Some pages could not be read.",
          extraction: {
            kind: "tabular",
            method: "parse",
            confidence: 1,
            pageCount: 0,
            tableCount: 1,
            warnings: [],
            pagesNeedingReview: [],
            handwriting: false,
          },
        },
      ],
      cost: { tokenUsage: usage, costEstimate: 0.01, runCount: 1 },
      run: {
        active: false,
        lastEventSeq: 12,
        lastRunId: "run-1",
        lastEventType: "run-failed",
        lastRunMode: "retry",
        lastRunError: "OCR is not available right now.",
      },
    });

    expect(parsed.tasks).toEqual([]);
    expect(parsed.documents[0]?.status).toBe("ready");
    expect(parsed.documents[0]?.errorCode).toBe("ocr-partial");
    expect(isDocumentErrorCode(parsed.documents[0]?.errorCode)).toBe(true);
    expect(isDocumentErrorCode("new-code")).toBe(false);
    expect(parsed.run.lastRunMode).toBe("retry");
    expect(parsed.run.lastRunError).toBe("OCR is not available right now.");
  });

  it("defaults the run cursor and rejects unknown event types", () => {
    const base = { case: { id: "c", title: "T", createdAt: now, updatedAt: now } };

    expect(caseStateSchema.parse(base).run).toEqual({ active: false, lastEventSeq: 0 });
    expect(
      caseStateSchema.safeParse({ ...base, run: { lastEventType: "run-paused" } }).success,
    ).toBe(false);
  });
});

describe("request schemas", () => {
  it("trims and validates a new case", () => {
    expect(
      createCaseRequestSchema.parse({ title: "  Notice  ", useCase: "tax-notice" }).title,
    ).toBe("Notice");
    expect(createCaseRequestSchema.safeParse({ title: "", useCase: "tax-notice" }).success).toBe(
      false,
    );
  });

  it("requires at least one field in a section update and allows clearing an edit", () => {
    expect(sectionUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(sectionUpdateRequestSchema.safeParse({ reviewStatus: "approved" }).success).toBe(true);
    expect(sectionUpdateRequestSchema.safeParse({ editedContent: null }).success).toBe(true);
  });
});

describe("response schemas", () => {
  it("parses the 202 run start response", () => {
    expect(
      runStartResponseSchema.parse({
        caseId: "case-1",
        runId: "run-2",
        mode: "retry",
        streamUrl: "/cases/case-1/stream",
      }).mode,
    ).toBe("retry");
  });

  it("matches the read-only sample error", () => {
    expect(
      sampleReadOnlyErrorBodySchema.safeParse({
        error: "sample-read-only",
        message: "Sample cases are read-only.",
        reason: "sample-read-only",
        copyUrl: "/cases/sample-a/copy",
      }).success,
    ).toBe(true);
    expect(
      sampleReadOnlyErrorBodySchema.safeParse({ reason: "other", copyUrl: "/x" }).success,
    ).toBe(false);
  });

  it("keeps error details", () => {
    const parsed = apiErrorBodySchema.parse({
      error: "invalid-request",
      message: "The request is invalid.",
      issues: [],
    });

    expect(parsed.issues).toEqual([]);
  });

  it("parses both ask outcomes", () => {
    expect(
      askResultSchema.parse({
        status: "answered",
        answer: "Yes.",
        evidenceIds: ["ev-1"],
        findingIds: ["f-1"],
        evidence: [],
        usage,
        cost: 0.001,
      }).status,
    ).toBe("answered");
    expect(
      askResultSchema.parse({
        status: "not-supported",
        message: "The record does not answer this.",
        evidenceIds: [],
        findingIds: [],
        canFlagForReview: true,
      }).status,
    ).toBe("not-supported");
  });

  it("parses usage totals keyed by use case", () => {
    const totals = {
      cases: 3,
      samples: 1,
      copies: 1,
      runs: 4,
      visitors: 2,
      tokenUsage: usage,
      costEstimate: 0.12,
    };
    const parsed = usageSummarySchema.parse({
      totals,
      byUseCase: { "tax-notice": totals, unspecified: totals },
    });

    expect(Object.keys(parsed.byUseCase)).toEqual(["tax-notice", "unspecified"]);
    expect(usageSummarySchema.parse({ totals }).byUseCase).toEqual({});
  });
});
