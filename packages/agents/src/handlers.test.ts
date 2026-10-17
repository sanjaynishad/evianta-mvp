import { findingSchema, taskSchema } from "@evianta/core";
import { describe, expect, it } from "vitest";

import { priorFindingSchema } from "./agents/specialist.js";
import { toPriorFindings, type TaskExecutionContext } from "./handlers.js";

describe("toPriorFindings", () => {
  it("keeps each open question's status and resolution note", () => {
    const upstream = taskSchema.parse({
      id: "reconcile",
      caseId: "case-1",
      title: "Reconcile TDS",
      assignedRole: "reconciliation",
      status: "completed",
      attempts: 1,
    });
    const current = taskSchema.parse({
      id: "respond",
      caseId: "case-1",
      title: "Draft response",
      assignedRole: "response-preparation",
      status: "in-progress",
      dependsOn: ["reconcile"],
      attempts: 1,
    });
    const finding = findingSchema.parse({
      id: "f-ledger",
      taskId: "reconcile",
      summary: "Purchase ledger needed",
      openQuestions: [
        {
          id: "q-ledger",
          text: "Is the purchase ledger available?",
          severity: "high",
          status: "resolved",
          resolutionNote: "Ledger uploaded on 3 March",
        },
        { id: "q-form16", text: "Is Form 16 available?", severity: "low" },
      ],
    });
    const ctx = {
      task: current,
      tasks: [upstream, current],
      upstreamFindings: [finding],
    } as unknown as TaskExecutionContext;

    const [prior] = toPriorFindings(ctx);

    expect(prior?.openQuestions).toEqual([
      {
        text: "Is the purchase ledger available?",
        severity: "high",
        status: "resolved",
        resolutionNote: "Ledger uploaded on 3 March",
      },
      { text: "Is Form 16 available?", severity: "low", status: "open" },
    ]);
    expect(priorFindingSchema.parse(prior).openQuestions?.[0]?.resolutionNote).toBe(
      "Ledger uploaded on 3 March",
    );
  });
});
