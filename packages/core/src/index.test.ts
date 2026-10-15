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
  });
});
