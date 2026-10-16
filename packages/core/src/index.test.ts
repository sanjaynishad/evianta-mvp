import { describe, expect, it } from "vitest";

import { caseSchema, taskSchema } from "./index.js";

describe("caseSchema", () => {
  it("applies the default status", () => {
    const now = new Date().toISOString();
    const parsed = caseSchema.parse({
      id: "case-1",
      title: "Demo case",
      createdAt: now,
      updatedAt: now,
    });

    expect(parsed.status).toBe("draft");
    expect(parsed.isSample).toBe(false);
    expect(parsed.visitorId).toBeUndefined();
  });

  it("accepts ownership, approval, usage, and the failed status", () => {
    const now = new Date().toISOString();
    const parsed = caseSchema.parse({
      id: "case-2",
      title: "Notice under section 143(1)",
      useCase: "tax-notice",
      status: "failed",
      visitorId: "visitor-1",
      sourceCaseId: "sample-tax",
      approval: { approvedAt: now },
      usage: { inputTokens: 1200, outputTokens: 300, costEstimate: 0.004 },
      createdAt: now,
      updatedAt: now,
    });

    expect(parsed.status).toBe("failed");
    expect(parsed.approval?.unresolvedQuestionIds).toEqual([]);
    expect(parsed.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      costEstimate: 0.004,
      runCount: 0,
    });
  });

  it("rejects an unknown use case", () => {
    const now = new Date().toISOString();
    const result = caseSchema.safeParse({
      id: "case-3",
      title: "Unknown",
      useCase: "payroll",
      createdAt: now,
      updatedAt: now,
    });

    expect(result.success).toBe(false);
  });
});

describe("taskSchema", () => {
  it("defaults status and dependencies", () => {
    const parsed = taskSchema.parse({
      id: "task-1",
      caseId: "case-1",
      title: "Analyse notice",
      assignedRole: "case-analysis",
    });

    expect(parsed.status).toBe("pending");
    expect(parsed.dependsOn).toEqual([]);
    expect(parsed.attempts).toBe(0);
  });

  it("carries usage and the last error", () => {
    const parsed = taskSchema.parse({
      id: "task-2",
      caseId: "case-1",
      title: "Reconcile 26AS",
      assignedRole: "reconciliation",
      status: "failed",
      tokenUsage: { input: 800, output: 200, total: 1000 },
      costEstimate: 0.0021,
      attempts: 2,
      lastError: "Ledger could not be parsed",
    });

    expect(parsed.tokenUsage?.total).toBe(1000);
    expect(parsed.lastError).toBe("Ledger could not be parsed");
  });

  it("rejects negative attempts", () => {
    const result = taskSchema.safeParse({
      id: "task-3",
      caseId: "case-1",
      title: "Draft",
      assignedRole: "response-preparation",
      attempts: -1,
    });

    expect(result.success).toBe(false);
  });
});
