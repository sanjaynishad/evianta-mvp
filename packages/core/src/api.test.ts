import { describe, expect, it } from "vitest";

import {
  caseStateSchema,
  createCaseRequestSchema,
  sampleReadOnlyErrorBodySchema,
  sectionUpdateRequestSchema,
  usageSummarySchema,
} from "./index.js";

const now = "2026-10-01T10:00:00.000Z";

describe("caseStateSchema", () => {
  it("defaults the collections and parses documents with processing state", () => {
    const parsed = caseStateSchema.parse({
      case: { id: "case-1", title: "Sales review", createdAt: now, updatedAt: now },
      documents: [
        {
          id: "doc-1",
          caseId: "case-1",
          name: "sales.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 2048,
          gcsPath: "cases/case-1/doc-1",
          uploadedAt: now,
          processing: { status: "ready", method: "parse", confidence: 1 },
        },
      ],
      latestRun: { runId: "run-1", status: "completed", startedAt: now },
    });

    expect(parsed.tasks).toEqual([]);
    expect(parsed.deliverables).toEqual([]);
    expect(parsed.documents[0]?.processing?.handwritingDetected).toBe(false);
    expect(parsed.latestRun?.mode).toBe("run");
    expect(parsed.latestRun?.lastEventSeq).toBe(0);
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

  it("requires at least one field in a section update", () => {
    expect(sectionUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(sectionUpdateRequestSchema.safeParse({ reviewStatus: "approved" }).success).toBe(true);
  });
});

describe("sampleReadOnlyErrorBodySchema", () => {
  it("matches the read-only sample response", () => {
    expect(
      sampleReadOnlyErrorBodySchema.safeParse({
        reason: "sample-read-only",
        copyUrl: "/cases/sample-a/copy",
      }).success,
    ).toBe(true);
    expect(
      sampleReadOnlyErrorBodySchema.safeParse({ reason: "other", copyUrl: "/x" }).success,
    ).toBe(false);
  });
});

describe("usageSummarySchema", () => {
  it("defaults the per use case breakdown", () => {
    const parsed = usageSummarySchema.parse({
      totals: { cases: 3, runs: 4, visitors: 2, tokens: 12000, costEstimate: 0.12 },
    });

    expect(parsed.byUseCase).toEqual([]);
  });
});
