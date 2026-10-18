import { caseSchema, findingSchema, taskSchema } from "@evianta/core";
import { describe, expect, it } from "vitest";

import { priorFindingSchema, specialistInputSchema } from "./agents/specialist.js";
import { buildSpecialistInput, toPriorFindings, type TaskExecutionContext } from "./handlers.js";

describe("buildSpecialistInput", () => {
  it("passes answered intake clarifications to the specialist", () => {
    const caseRecord = caseSchema.parse({
      id: "case-1",
      title: "Notice reply",
      useCase: "tax-notice",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      intake: {
        clarifications: [
          { id: "ay", text: "Assessment year?", answer: " 2025-26 " },
          { id: "pan", text: "PAN?" },
        ],
      },
    });
    const task = taskSchema.parse({
      id: "respond",
      caseId: "case-1",
      title: "Draft response",
      assignedRole: "response-preparation",
      status: "in-progress",
      attempts: 1,
    });
    const ctx = {
      case: caseRecord,
      task,
      tasks: [task],
      upstreamFindings: [],
      documents: [],
    } as unknown as TaskExecutionContext;

    const input = specialistInputSchema.parse(buildSpecialistInput(ctx));

    expect(input.case.clarifications).toEqual([
      { question: "Assessment year?", answer: "2025-26" },
    ]);
  });

  it("passes the user's setup messages so later corrections reach the specialist", () => {
    const caseRecord = caseSchema.parse({
      id: "case-1",
      title: "Notice reply",
      useCase: "tax-notice",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      intake: {
        requestMessages: ["Reply to my notice for AY 2024-25", "Correction: it is AY 2025-26"],
      },
    });
    const task = taskSchema.parse({
      id: "respond",
      caseId: "case-1",
      title: "Draft response",
      assignedRole: "response-preparation",
      status: "in-progress",
      attempts: 1,
    });
    const ctx = {
      case: caseRecord,
      task,
      tasks: [task],
      upstreamFindings: [],
      documents: [],
    } as unknown as TaskExecutionContext;

    const input = specialistInputSchema.parse(buildSpecialistInput(ctx));

    expect(input.case.requestMessages).toEqual([
      "Reply to my notice for AY 2024-25",
      "Correction: it is AY 2025-26",
    ]);
  });
});

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
