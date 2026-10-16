import { AiNonTransientError, createMockAi } from "@evianta/ai";
import { createInMemoryStore } from "@evianta/store";
import { describe, expect, it } from "vitest";

import {
  askCaseAsync,
  CASE_ASSISTANT_KEY,
  NOT_SUPPORTED_MESSAGE,
  retrieveRelevantFindings,
} from "./caseAssistant.js";

async function seedRecordAsync() {
  const store = createInMemoryStore();
  const tdsEvidence = {
    id: "ev-tds",
    sourceRef: "26AS.pdf p.2",
    description: "TDS credited by the deductor",
    excerpt: "Total TDS 48,400",
    documentId: "doc-26as",
    location: { page: 2 },
    confidence: "high" as const,
  };
  const invoiceEvidence = {
    id: "ev-invoice",
    sourceRef: "ledger.xlsx Sheet1!A2:D9",
    description: "Unpaid invoices",
    documentId: "doc-ledger",
  };

  await store.evidence.addEvidenceAsync("case-1", tdsEvidence);
  await store.evidence.addEvidenceAsync("case-1", invoiceEvidence);
  await store.findings.addFindingAsync("case-1", {
    id: "f-tds",
    taskId: "reconcile",
    summary: "TDS mismatch of Rs. 12,400 between 26AS and the return",
    detail: "26AS shows 48,400 while the return claims 36,000.",
    severity: "high",
    evidence: [tdsEvidence],
    figures: [{ key: "tds-mismatch", label: "TDS mismatch", value: 12400 }],
  });
  await store.findings.addFindingAsync("case-1", {
    id: "f-invoices",
    taskId: "payments",
    summary: "Three invoices remain unpaid",
    severity: "medium",
    evidence: [invoiceEvidence],
  });

  return store;
}

describe("retrieveRelevantFindings", () => {
  it("scores findings by matching terms, including figures", async () => {
    const store = await seedRecordAsync();
    const findings = await store.findings.getFindingsForCaseAsync("case-1");
    const evidence = await store.evidence.getEvidenceForCaseAsync("case-1");

    expect(
      retrieveRelevantFindings("Why is the TDS mismatch 12,400?", findings, evidence).map(
        (entry) => entry.finding.id,
      ),
    ).toEqual(["f-tds"]);
    expect(
      retrieveRelevantFindings("which invoices are unpaid", findings, evidence)[0]?.finding.id,
    ).toBe("f-invoices");
  });
});

describe("askCaseAsync", () => {
  it("answers from the work record and cites only retrieved evidence", async () => {
    const store = await seedRecordAsync();
    const ai = createMockAi({
      [CASE_ASSISTANT_KEY]: {
        output: {
          supported: true,
          answer: "26AS shows Rs. 48,400 of TDS while the return claims Rs. 36,000.",
          evidenceIds: ["ev-tds", "ev-invented", "ev-invoice"],
          findingIds: ["f-tds", "f-ghost"],
        },
      },
    });

    const result = await askCaseAsync(
      { caseId: "case-1", question: "Why is the TDS mismatch 12,400?" },
      { store, ai },
    );

    expect(result.status).toBe("answered");

    if (result.status !== "answered") {
      return;
    }

    expect(result.answer).toContain("48,400");
    expect(result.evidenceIds).toEqual(["ev-tds"]);
    expect(result.findingIds).toEqual(["f-tds"]);
    expect(result.evidence[0]).toMatchObject({ id: "ev-tds", sourceRef: "26AS.pdf p.2" });
    expect(result.retrievedFindingIds).toEqual(["f-tds"]);
    expect(result.usage.total).toBeGreaterThan(0);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]?.tier).toBe("cheap");
    expect(ai.calls[0]?.prompt).toContain("ev-tds");
    expect(ai.calls[0]?.prompt).not.toContain("ev-invoice");
  });

  it("falls back to the cited findings' evidence when no evidence id is valid", async () => {
    const store = await seedRecordAsync();
    const ai = createMockAi({
      [CASE_ASSISTANT_KEY]: {
        output: {
          supported: true,
          answer: "See the TDS reconciliation.",
          evidenceIds: [],
          findingIds: ["f-tds"],
        },
      },
    });

    const result = await askCaseAsync(
      { caseId: "case-1", question: "Explain the TDS mismatch" },
      { store, ai },
    );

    expect(result).toMatchObject({
      status: "answered",
      evidenceIds: ["ev-tds"],
      findingIds: ["f-tds"],
    });
  });

  it("returns not-supported without a model call when nothing relevant is retrieved", async () => {
    const store = await seedRecordAsync();
    const ai = createMockAi({});

    const result = await askCaseAsync(
      { caseId: "case-1", question: "What is the weather in Pune?" },
      { store, ai },
    );

    expect(result).toMatchObject({
      status: "not-supported",
      message: NOT_SUPPORTED_MESSAGE,
      evidenceIds: [],
      canFlagForReview: true,
      usage: { total: 0 },
    });
    expect(ai.calls).toHaveLength(0);
  });

  it("returns not-supported when the model finds no support or cites nothing valid", async () => {
    const store = await seedRecordAsync();
    const ai = createMockAi({
      [CASE_ASSISTANT_KEY]: [
        { output: { supported: false, answer: "", evidenceIds: [], findingIds: [] } },
        {
          output: {
            supported: true,
            answer: "Made up.",
            evidenceIds: ["ev-x"],
            findingIds: ["f-x"],
          },
        },
      ],
    });
    const question = { caseId: "case-1", question: "Was the TDS mismatch penalised?" };

    const unsupported = await askCaseAsync(question, { store, ai });
    const invented = await askCaseAsync(question, { store, ai });

    expect(unsupported.status).toBe("not-supported");
    expect(unsupported.usage.total).toBeGreaterThan(0);
    expect(invented.status).toBe("not-supported");
  });

  it("returns not-supported when the provider declines, and rethrows other failures", async () => {
    const store = await seedRecordAsync();
    const ai = createMockAi({
      [CASE_ASSISTANT_KEY]: [
        {
          error: new AiNonTransientError("Response blocked", {
            reason: "blocked",
            usage: { input: 300, output: 0, total: 300 },
          }),
        },
        { error: "non-transient", message: "Model misconfigured" },
      ],
    });
    const question = { caseId: "case-1", question: "Why is the TDS mismatch 12,400?" };

    const declined = await askCaseAsync(question, { store, ai });

    expect(declined).toMatchObject({
      status: "not-supported",
      retrievedFindingIds: ["f-tds"],
      usage: { input: 300 },
    });
    await expect(askCaseAsync(question, { store, ai })).rejects.toThrow(/Model misconfigured/);
  });

  it("ignores findings left by superseded or unfinished task attempts", async () => {
    const store = await seedRecordAsync();

    await store.tasks.createTaskAsync({
      id: "retried",
      caseId: "case-1",
      title: "Reconcile again",
      assignedRole: "reconciliation",
      status: "completed",
      attempts: 2,
    });
    await store.findings.addFindingAsync("case-1", {
      id: "f-stale",
      taskId: "retried",
      attempt: 1,
      summary: "TDS mismatch of Rs. 9,999",
      severity: "high",
    });
    await store.findings.addFindingAsync("case-1", {
      id: "f-current",
      taskId: "retried",
      attempt: 2,
      summary: "TDS mismatch of Rs. 12,400 confirmed",
      severity: "high",
    });

    const ai = createMockAi({
      [CASE_ASSISTANT_KEY]: {
        output: { supported: false, answer: "", evidenceIds: [], findingIds: [] },
      },
    });
    const result = await askCaseAsync(
      { caseId: "case-1", question: "What is the TDS mismatch?" },
      { store, ai },
    );

    expect(result.retrievedFindingIds).toContain("f-current");
    expect(result.retrievedFindingIds).not.toContain("f-stale");
  });
});
