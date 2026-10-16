import { describe, expect, it } from "vitest";

import { evidenceSchema, findingSchema, openQuestionSchema } from "./index.js";

describe("evidenceSchema", () => {
  it("keeps the legacy shape valid", () => {
    const parsed = evidenceSchema.parse({
      id: "ev-1",
      sourceRef: "26AS p.2",
      description: "TDS credit for Q3",
    });

    expect(parsed.location).toBeUndefined();
  });

  it("accepts a structured location with a normalized bounding box", () => {
    const parsed = evidenceSchema.parse({
      id: "ev-2",
      sourceRef: "Notice p.1",
      description: "Demand amount",
      documentId: "doc-1",
      confidence: "medium",
      location: {
        page: 1,
        bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 },
        textQuote: "Rs. 48,210",
      },
    });

    expect(parsed.location?.bbox?.width).toBe(0.5);
    expect(parsed.confidence).toBe("medium");
  });

  it("rejects a bounding box outside the unit square", () => {
    const result = evidenceSchema.safeParse({
      id: "ev-3",
      sourceRef: "Notice p.1",
      description: "Out of range",
      location: { page: 1, bbox: { x: 1.2, y: 0, width: 0.1, height: 0.1 } },
    });

    expect(result.success).toBe(false);
  });

  it("supports spreadsheet references", () => {
    const parsed = evidenceSchema.parse({
      id: "ev-4",
      sourceRef: "Ledger!B2:B40",
      description: "Invoices",
      location: { sheet: "Ledger", cellRange: "B2:B40", rowRange: { start: 2, end: 40 } },
    });

    expect(parsed.location?.rowRange).toEqual({ start: 2, end: 40 });
  });
});

describe("openQuestionSchema", () => {
  it("defaults the status to open", () => {
    const parsed = openQuestionSchema.parse({
      id: "q-1",
      text: "Is the March ledger available?",
      severity: "high",
    });

    expect(parsed.status).toBe("open");
  });
});

describe("findingSchema", () => {
  it("defaults evidence, assumptions, and open questions", () => {
    const parsed = findingSchema.parse({
      id: "finding-1",
      taskId: "task-1",
      summary: "TDS mismatch of Rs. 12,000",
    });

    expect(parsed.evidence).toEqual([]);
    expect(parsed.assumptions).toEqual([]);
    expect(parsed.openQuestions).toEqual([]);
  });

  it("stores open questions as objects with severity", () => {
    const parsed = findingSchema.parse({
      id: "finding-2",
      taskId: "task-1",
      summary: "Missing ledger",
      severity: "high",
      confidence: "low",
      openQuestions: [{ id: "q-1", text: "Provide the March ledger", severity: "medium" }],
    });

    expect(parsed.openQuestions[0]).toEqual({
      id: "q-1",
      text: "Provide the March ledger",
      severity: "medium",
      status: "open",
    });
  });

  it("rejects legacy string open questions", () => {
    const result = findingSchema.safeParse({
      id: "finding-3",
      taskId: "task-1",
      summary: "Legacy",
      openQuestions: ["What about March?"],
    });

    expect(result.success).toBe(false);
  });
});
