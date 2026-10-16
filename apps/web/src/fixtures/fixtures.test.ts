import {
  caseStateSchema,
  isTerminalRunEvent,
  parseChartSpecContent,
  runEventSchema,
  type CaseState,
} from "@evianta/core";
import { describe, expect, it } from "vitest";
import { applyRunEvent, createReplayProgress } from "@/lib/run-progress";
import {
  failedCaseState,
  failedRunEvents,
  rawSampleCaseStates,
  sampleCaseStates,
  sampleRunEvents,
} from "./index";

function referencedIdsExist(state: CaseState) {
  const taskIds = new Set(state.tasks.map((task) => task.id));
  const findingIds = new Set(state.findings.map((finding) => finding.id));
  const documentIds = new Set(state.documents.map((document) => document.id));
  const evidenceIds = new Set([
    ...state.evidence.map((evidence) => evidence.id),
    ...state.findings.flatMap((finding) => finding.evidence.map((evidence) => evidence.id)),
  ]);

  for (const task of state.tasks) {
    expect(task.caseId).toBe(state.case.id);
    for (const dependency of task.dependsOn) {
      expect(taskIds.has(dependency), `${task.id} depends on ${dependency}`).toBe(true);
    }
  }

  for (const finding of state.findings) {
    expect(taskIds.has(finding.taskId), `${finding.id} task`).toBe(true);
    for (const evidence of finding.evidence) {
      if (evidence.documentId) {
        expect(documentIds.has(evidence.documentId), `${evidence.id} document`).toBe(true);
      }
    }
  }

  for (const deliverable of state.deliverables) {
    expect(deliverable.caseId).toBe(state.case.id);
    for (const section of deliverable.sections) {
      for (const findingId of section.findingIds) {
        expect(findingIds.has(findingId), `${section.id} finding ${findingId}`).toBe(true);
      }

      for (const evidenceId of section.evidenceIds) {
        expect(evidenceIds.has(evidenceId), `${section.id} evidence ${evidenceId}`).toBe(true);
      }
    }
  }
}

describe("sample fixtures", () => {
  it("cover all three use cases as read-only samples", () => {
    expect(sampleCaseStates.map((state) => state.case.useCase)).toEqual([
      "data-analysis",
      "tax-notice",
      "msme-payment",
    ]);
    expect(sampleCaseStates.every((state) => state.case.isSample)).toBe(true);
  });

  it.each(rawSampleCaseStates.map((raw) => [raw.case.id, raw] as const))(
    "%s conforms to the core case state schema",
    (_id, raw) => {
      const parsed = caseStateSchema.safeParse(raw);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    },
  );

  it.each(sampleCaseStates.map((state) => [state.case.id, state] as const))(
    "%s has consistent references, usage totals, and evidence",
    (_id, state) => {
      referencedIdsExist(state);
      const taskInput = state.tasks.reduce(
        (total, task) => total + (task.tokenUsage?.input ?? 0),
        0,
      );
      const taskCost = state.tasks.reduce((total, task) => total + (task.costEstimate ?? 0), 0);
      expect(state.case.usage?.inputTokens).toBe(taskInput);
      expect(state.case.usage?.costEstimate).toBeCloseTo(taskCost, 6);
      expect(state.findings.length).toBeGreaterThan(0);
      expect(state.findings.some((finding) => finding.openQuestions.length > 0)).toBe(true);
      expect(
        state.deliverables.flatMap((deliverable) => deliverable.sections).length,
      ).toBeGreaterThan(0);
    },
  );

  it("includes a dashboard with valid bar, line, and pie chart specs for use case A", () => {
    const dashboard = sampleCaseStates[0]!.deliverables.find(
      (deliverable) => deliverable.format === "dashboard",
    );
    const specs = dashboard?.sections.map((section) => parseChartSpecContent(section.content));

    expect(specs?.every((result) => result.success)).toBe(true);
    expect(specs?.map((result) => (result.success ? result.spec.type : undefined))).toEqual([
      "bar",
      "line",
      "pie",
    ]);
  });
});

describe("run event fixtures", () => {
  it.each(Object.entries(sampleRunEvents))(
    "%s replays as valid, ordered run events",
    (caseId, events) => {
      const state = sampleCaseStates.find((candidate) => candidate.case.id === caseId)!;
      for (const event of events) {
        expect(runEventSchema.safeParse(event).success).toBe(true);
      }

      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
      expect(isTerminalRunEvent(events.at(-1)!)).toBe(true);
      expect(state.latestRun?.lastEventSeq).toBe(events.length);

      const replayed = events.reduce(applyRunEvent, createReplayProgress(state));
      expect(replayed.status).toBe("completed");
      expect(replayed.tasks.every((task) => task.status === "completed")).toBe(true);
      expect(replayed.findings).toHaveLength(state.findings.length);
      expect(replayed.totalCost).toBeCloseTo(state.case.usage?.costEstimate ?? 0, 6);
    },
  );

  it("describes a failed run with blocked steps that matches the failed case state", () => {
    expect(caseStateSchema.safeParse(failedCaseState).success).toBe(true);
    for (const event of failedRunEvents) {
      expect(runEventSchema.safeParse(event).success).toBe(true);
    }

    const failed = failedRunEvents.find((event) => event.type === "task-failed");
    expect(failed?.type === "task-failed" && failed.blockedTaskIds).toEqual([
      "c-task-prepare",
      "c-task-review",
    ]);
    expect(failedRunEvents.at(-1)?.type).toBe("run-failed");
    expect(failedCaseState.tasks.find((task) => task.status === "failed")?.lastError).toBeTruthy();
    expect(failedCaseState.tasks.filter((task) => task.status === "blocked")).toHaveLength(2);
    expect(failedCaseState.deliverables).toEqual([]);
  });
});
