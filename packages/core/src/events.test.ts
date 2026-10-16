import { describe, expect, it } from "vitest";

import { isTerminalRunEvent, runEventSchema, runEventTypes, type RunEvent } from "./index.js";

const base = {
  caseId: "case-1",
  runId: "run-1",
  timestamp: "2026-10-16T00:00:00.000Z",
};

describe("runEventSchema", () => {
  it("lists every event type", () => {
    expect(runEventTypes).toEqual([
      "run-started",
      "task-started",
      "task-completed",
      "task-failed",
      "finding-added",
      "cost-updated",
      "run-completed",
      "run-failed",
    ]);
  });

  it("parses each event type with its payload", () => {
    const usage = { input: 10, output: 5, total: 15 };
    const events = [
      { ...base, seq: 1, type: "run-started", taskIds: ["task-1"] },
      {
        ...base,
        seq: 2,
        type: "task-started",
        taskId: "task-1",
        title: "Analyse",
        assignedRole: "case-analysis",
        attempt: 1,
      },
      { ...base, seq: 3, type: "finding-added", taskId: "task-1", findingId: "f-1", summary: "s" },
      { ...base, seq: 4, type: "task-completed", taskId: "task-1", tokenUsage: usage },
      { ...base, seq: 5, type: "cost-updated", totalTokenUsage: usage, totalCostEstimate: 0.01 },
      { ...base, seq: 6, type: "task-failed", taskId: "task-2", error: "Timed out" },
      { ...base, seq: 7, type: "run-failed", error: "1 task failed", failedTaskIds: ["task-2"] },
      {
        ...base,
        seq: 8,
        type: "run-completed",
        totalTokenUsage: usage,
        totalCostEstimate: 0.01,
      },
    ];

    const parsed = events.map((event) => runEventSchema.parse(event));

    expect(parsed.map((event) => event.type)).toEqual([
      "run-started",
      "task-started",
      "finding-added",
      "task-completed",
      "cost-updated",
      "task-failed",
      "run-failed",
      "run-completed",
    ]);
    expect(parsed[0]).toMatchObject({ mode: "run" });
    expect(parsed[3]).toMatchObject({ findingIds: [] });
    expect(parsed[5]).toMatchObject({ blockedTaskIds: [] });
  });

  it("rejects an unknown type and a missing payload", () => {
    expect(runEventSchema.safeParse({ ...base, seq: 1, type: "task-paused" }).success).toBe(false);
    expect(runEventSchema.safeParse({ ...base, seq: 1, type: "task-failed" }).success).toBe(false);
  });

  it("requires a positive integer seq", () => {
    const event = { ...base, type: "run-started" };

    expect(runEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false);
    expect(runEventSchema.safeParse({ ...event, seq: 1.5 }).success).toBe(false);
  });

  it("identifies terminal events", () => {
    const completed = runEventSchema.parse({
      ...base,
      seq: 9,
      type: "run-completed",
      totalTokenUsage: { input: 0, output: 0, total: 0 },
      totalCostEstimate: 0,
    });
    const started: RunEvent = runEventSchema.parse({ ...base, seq: 1, type: "run-started" });

    expect(isTerminalRunEvent(completed)).toBe(true);
    expect(isTerminalRunEvent(started)).toBe(false);
  });
});
