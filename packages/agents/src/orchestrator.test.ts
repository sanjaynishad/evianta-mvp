import type { AgentRole, RunEvent } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";

import { OrchestratorError } from "./errors.js";
import { createSpecialistTaskHandler, type TaskHandler } from "./handlers.js";
import { createDefaultTaskHandlers } from "./registry.js";
import { createOrchestrator } from "./orchestrator.js";
import {
  addDocumentAsync,
  createCaseAsync,
  createHarness,
  finding,
  seedTasksAsync,
  specialistStep,
} from "./testing/fixtures.js";

function concurrentBranchHandlers(roles: readonly AgentRole[]): TaskHandler[] {
  let started = 0;
  let release: () => void = () => {};

  const allStarted = new Promise<void>((resolve) => {
    release = resolve;
  });

  return roles.map((role) => ({
    role,
    async executeAsync() {
      started += 1;

      if (started === roles.length) {
        release();
      }

      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          allStarted,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Branches did not run concurrently.")), 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }

      return {
        findings: [finding(`${role} done`)],
        usage: { input: 100, output: 50, total: 150 },
        cost: 0.001,
        modelTier: "mid",
      };
    },
  }));
}

function typesOf(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("orchestrator", () => {
  it("runs a linear DAG in order and records usage, findings, and sections", async () => {
    const { store, ai, orchestrator } = createHarness({
      "case-analysis": specialistStep({ findings: [finding("Demand of Rs. 48,210 raised")] }),
      reconciliation: specialistStep({ findings: [finding("TDS mismatch of Rs. 12,400")] }),
      "response-preparation": specialistStep({ findings: [finding("Draft response prepared")] }),
    });
    const caseRecord = await createCaseAsync(store);

    await addDocumentAsync(store, caseRecord.id, {
      id: "doc-notice",
      name: "notice.pdf",
      pages: ["Intimation under section 143(1). Demand: Rs. 48,210."],
    });
    await seedTasksAsync(store, caseRecord.id, [
      { id: "t1", role: "case-analysis" },
      { id: "t2", role: "reconciliation", dependsOn: ["t1"] },
      { id: "t3", role: "response-preparation", dependsOn: ["t2"] },
    ]);

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const tasks = await store.tasks.getTasksForCaseAsync(caseRecord.id);
    const findings = await store.findings.getFindingsForCaseAsync(caseRecord.id);
    const [deliverable] = await store.deliverables.getDeliverablesForCaseAsync(caseRecord.id);
    const caseAfter = await store.cases.getCaseAsync(caseRecord.id);

    expect(result.status).toBe("completed");
    expect(result.completedTaskIds).toEqual(["t1", "t2", "t3"]);
    expect(ai.calls.map((call) => call.key)).toEqual([
      "case-analysis",
      "reconciliation",
      "response-preparation",
    ]);
    expect(ai.calls[0]?.tier).toBe("cheap");
    expect(ai.calls[0]?.prompt).toContain("Demand: Rs. 48,210");
    expect(ai.calls[1]?.prompt).toContain("Demand of Rs. 48,210 raised");
    expect(ai.calls[2]?.prompt).toContain("TDS mismatch of Rs. 12,400");
    expect(tasks.every((task) => task.status === "completed" && task.attempts === 1)).toBe(true);
    expect(tasks.every((task) => (task.tokenUsage?.total ?? 0) > 0)).toBe(true);
    expect(findings.map((item) => item.taskId)).toEqual(["t1", "t2", "t3"]);
    expect(deliverable).toMatchObject({
      id: "deliverable-primary",
      title: "Notice response pack",
      format: "document",
    });
    expect(deliverable?.sections.map((section) => section.producedByRole)).toEqual([
      "case-analysis",
      "reconciliation",
      "response-preparation",
    ]);
    expect(caseAfter?.status).toBe("completed");
    expect(caseAfter?.usage?.runCount).toBe(1);
    expect(result.deliverableIds).toEqual(["deliverable-primary"]);
  });

  it("runs independent branches concurrently and joins them", async () => {
    const handlers = createDefaultTaskHandlers();

    for (const handler of concurrentBranchHandlers(["reconciliation", "tax-research"])) {
      handlers.register(handler);
    }

    const { store, orchestrator } = createHarness(
      {
        "case-analysis": specialistStep(),
        "response-preparation": specialistStep(),
      },
      { handlers, concurrency: 2 },
    );
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [
      { id: "analyze", role: "case-analysis" },
      { id: "reconcile", role: "reconciliation", dependsOn: ["analyze"] },
      { id: "research", role: "tax-research", dependsOn: ["analyze"] },
      { id: "draft", role: "response-preparation", dependsOn: ["reconcile", "research"] },
    ]);

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const events = await store.events.listEventsAsync(caseRecord.id);
    const indexOf = (type: string, taskId: string) =>
      events.findIndex(
        (event) => event.type === type && "taskId" in event && event.taskId === taskId,
      );

    expect(result.status).toBe("completed");
    expect(indexOf("task-started", "research")).toBeLessThan(
      indexOf("task-completed", "reconcile"),
    );
    expect(indexOf("task-completed", "reconcile")).toBeLessThan(indexOf("task-started", "draft"));
    expect(indexOf("task-completed", "research")).toBeLessThan(indexOf("task-started", "draft"));
  });

  it("blocks only the dependents of a failed task, then retries just those", async () => {
    const { store, ai, orchestrator } = createHarness({
      "case-analysis": specialistStep(),
      reconciliation: [
        { error: "non-transient", message: "Ledger could not be read", usage: { input: 500 } },
        specialistStep({ findings: [finding("Reconciled after retry")] }),
      ],
      "tax-research": specialistStep(),
      "response-preparation": specialistStep(),
      "independent-review": specialistStep({ findings: [] }),
    });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [
      { id: "analyze", role: "case-analysis" },
      { id: "reconcile", role: "reconciliation", dependsOn: ["analyze"] },
      { id: "research", role: "tax-research", dependsOn: ["analyze"] },
      { id: "draft", role: "response-preparation", dependsOn: ["reconcile"] },
      { id: "review", role: "independent-review", dependsOn: ["draft", "research"] },
    ]);

    const first = await orchestrator.runCaseAsync(caseRecord.id);
    const afterFirst = new Map(
      (await store.tasks.getTasksForCaseAsync(caseRecord.id)).map((task) => [task.id, task]),
    );
    const firstEvents = await store.events.listEventsAsync(caseRecord.id);
    const failedEvent = firstEvents.find((event) => event.type === "task-failed");

    expect(first.status).toBe("failed");
    expect(first.failedTaskIds).toEqual(["reconcile"]);
    expect(first.blockedTaskIds.sort()).toEqual(["draft", "review"]);
    expect(afterFirst.get("research")?.status).toBe("completed");
    expect(afterFirst.get("reconcile")).toMatchObject({ status: "failed", attempts: 1 });
    expect(afterFirst.get("reconcile")?.lastError).toContain("Ledger could not be read");
    expect(afterFirst.get("reconcile")?.tokenUsage?.input).toBe(500);
    expect(afterFirst.get("draft")).toMatchObject({ status: "blocked", attempts: 0 });
    expect(afterFirst.get("draft")?.lastError).toMatch(/Blocked because/);
    expect(failedEvent).toMatchObject({ taskId: "reconcile", blockedTaskIds: ["draft", "review"] });
    expect(firstEvents.at(-1)).toMatchObject({ type: "run-failed", failedTaskIds: ["reconcile"] });
    expect((await store.cases.getCaseAsync(caseRecord.id))?.status).toBe("failed");

    const callsBeforeRetry = ai.calls.length;
    const retry = await orchestrator.retryFailedAsync(caseRecord.id);
    const tasks = await store.tasks.getTasksForCaseAsync(caseRecord.id);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const caseAfter = await store.cases.getCaseAsync(caseRecord.id);
    const retryEvents = (await store.events.listEventsAsync(caseRecord.id)).filter(
      (event) => event.runId === retry.runId,
    );
    const taskCostSum = tasks.reduce((sum, task) => sum + (task.costEstimate ?? 0), 0);
    const taskInputSum = tasks.reduce((sum, task) => sum + (task.tokenUsage?.input ?? 0), 0);

    expect(retry.status).toBe("completed");
    expect(retry.mode).toBe("retry");
    expect(ai.calls.slice(callsBeforeRetry).map((call) => call.key)).toEqual([
      "reconciliation",
      "response-preparation",
      "independent-review",
    ]);
    expect(retry.reusedTaskIds.sort()).toEqual(["analyze", "research"]);
    expect(byId.get("reconcile")).toMatchObject({ status: "completed", attempts: 2 });
    expect(byId.get("reconcile")?.lastError).toBeUndefined();
    expect(byId.get("reconcile")?.tokenUsage?.input).toBeGreaterThan(500);
    expect(byId.get("analyze")?.attempts).toBe(1);
    expect(retryEvents[0]).toMatchObject({ type: "run-started", mode: "retry" });
    expect(retryEvents[0]?.type === "run-started" && retryEvents[0].taskIds.sort()).toEqual([
      "draft",
      "reconcile",
      "review",
    ]);
    expect(caseAfter?.status).toBe("completed");
    expect(caseAfter?.usage?.runCount).toBe(2);
    expect(caseAfter?.usage?.inputTokens).toBe(taskInputSum);
    expect(caseAfter?.usage?.costEstimate).toBeCloseTo(taskCostSum, 10);
    expect(retry.caseCostEstimate).toBeCloseTo(taskCostSum, 10);

    await expect(orchestrator.retryFailedAsync(caseRecord.id)).rejects.toMatchObject({
      code: "nothing-to-retry",
    });
  });

  it("stamps a caller-supplied run id on the run and retry events", async () => {
    const { store, orchestrator } = createHarness({
      "case-analysis": [{ error: "non-transient", message: "Notice unreadable" }, specialistStep()],
    });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [{ id: "analyze", role: "case-analysis" }]);

    const first = await orchestrator.runCaseAsync(caseRecord.id, { runId: "run-from-api" });
    const retry = await orchestrator.retryFailedAsync(caseRecord.id, { runId: "retry-from-api" });
    const events = await store.events.listEventsAsync(caseRecord.id);

    expect(first).toMatchObject({ runId: "run-from-api", status: "failed" });
    expect(retry).toMatchObject({ runId: "retry-from-api", status: "completed" });
    expect(new Set(events.map((event) => event.runId))).toEqual(
      new Set(["run-from-api", "retry-from-api"]),
    );
    expect(events.filter((event) => event.runId === "retry-from-api").at(-1)?.type).toBe(
      "run-completed",
    );
  });

  it("fails fast on a dependency cycle", async () => {
    const { store, ai, orchestrator } = createHarness({});
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [
      { id: "a", role: "case-analysis", dependsOn: ["b"] },
      { id: "b", role: "reconciliation", dependsOn: ["a"] },
    ]);

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const events = await store.events.listEventsAsync(caseRecord.id);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/cycle: a -> b -> a/);
    expect(typesOf(events)).toEqual(["run-started", "run-failed"]);
    expect(ai.calls).toHaveLength(0);
    expect((await store.cases.getCaseAsync(caseRecord.id))?.status).toBe("failed");
  });

  it("fails fast on a missing dependency", async () => {
    const { store, orchestrator } = createHarness({});
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [
      { id: "a", role: "case-analysis", dependsOn: ["ghost"] },
    ]);

    const result = await orchestrator.runCaseAsync(caseRecord.id);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/unknown task\(s\): ghost/);
  });

  it("emits a running case cost equal to the sum of task costs", async () => {
    const { store, orchestrator } = createHarness({
      "case-analysis": specialistStep({}, { input: 2000, output: 300 }),
      reconciliation: specialistStep({}, { input: 1500, output: 400 }),
      "tax-research": specialistStep({}, { input: 1200, output: 100 }),
    });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [
      { id: "a", role: "case-analysis" },
      { id: "b", role: "reconciliation", dependsOn: ["a"] },
      { id: "c", role: "tax-research", dependsOn: ["a"] },
    ]);

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const tasks = await store.tasks.getTasksForCaseAsync(caseRecord.id);
    const events = await store.events.listEventsAsync(caseRecord.id);
    const taskCostSum = tasks.reduce((sum, task) => sum + (task.costEstimate ?? 0), 0);
    const running = events.flatMap((event) =>
      event.type === "task-completed" ? [event.runningCostEstimate ?? -1] : [],
    );
    const costUpdates = events.filter((event) => event.type === "cost-updated");
    const terminal = events.at(-1);

    expect(running).toHaveLength(3);
    expect([...running].sort((left, right) => left - right)).toEqual(running);
    expect(running.at(-1)).toBeCloseTo(taskCostSum, 10);
    expect(costUpdates).toHaveLength(3);
    expect(terminal?.type === "run-completed" && terminal.totalCostEstimate).toBeCloseTo(
      taskCostSum,
      10,
    );
    expect(result.costEstimate).toBeCloseTo(taskCostSum, 10);
    expect((await store.cases.getCaseAsync(caseRecord.id))?.usage?.costEstimate).toBeCloseTo(
      taskCostSum,
      10,
    );
    expect(tasks.find((task) => task.id === "a")?.costEstimate).toBeCloseTo(
      (2000 / 1000) * 0.0001 + (300 / 1000) * 0.0004,
      10,
    );
  });

  it("persists evidence and records section provenance", async () => {
    const { store, orchestrator } = createHarness({
      reconciliation: specialistStep({
        findings: [
          finding("TDS mismatch of Rs. 12,400", {
            severity: "high",
            evidence: [
              {
                documentId: "doc-26as",
                description: "TDS credited by the deductor",
                page: 2,
                textQuote: "Total TDS 48,400",
              },
              { documentId: "doc-invented", description: "Hallucinated source" },
            ],
            openQuestions: [{ text: "Was the Q4 TDS certificate issued?", severity: "medium" }],
            figures: [
              {
                key: "tds-mismatch",
                label: "TDS mismatch",
                value: 12400,
                components: [
                  { label: "TDS per 26AS", value: 48400 },
                  { label: "TDS claimed", value: -36000 },
                ],
              },
            ],
          }),
          finding("Ledger total agrees with the return"),
        ],
        openQuestions: [{ text: "Provide the March ledger.", severity: "low" }],
        section: {
          title: "Reconciliation",
          kind: "table",
          content: "| Item | 26AS | Return |",
          findingIndexes: [0],
        },
      }),
    });
    const caseRecord = await createCaseAsync(store);

    await addDocumentAsync(store, caseRecord.id, {
      id: "doc-26as",
      name: "26AS.pdf",
      pages: ["Page one", "Total TDS 48,400"],
    });
    await seedTasksAsync(store, caseRecord.id, [{ id: "rec", role: "reconciliation" }]);

    await orchestrator.runCaseAsync(caseRecord.id);

    const findings = await store.findings.getFindingsForCaseAsync(caseRecord.id);
    const evidence = await store.evidence.getEvidenceForCaseAsync(caseRecord.id);
    const [deliverable] = await store.deliverables.getDeliverablesForCaseAsync(caseRecord.id);
    const [mismatch] = findings;

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      sourceRef: "26AS.pdf p.2",
      documentId: "doc-26as",
      location: { page: 2, textQuote: "Total TDS 48,400" },
      excerpt: "Total TDS 48,400",
      confidence: "high",
    });
    expect(mismatch?.evidence.map((item) => item.id)).toEqual([evidence[0]?.id]);
    expect(mismatch?.figures?.[0]?.components).toHaveLength(2);
    expect(mismatch?.openQuestions[0]).toMatchObject({
      id: expect.any(String),
      severity: "medium",
      status: "open",
    });
    expect(findings).toHaveLength(3);
    expect(findings[2]?.openQuestions[0]).toMatchObject({ text: "Provide the March ledger." });
    expect(deliverable?.sections).toEqual([
      expect.objectContaining({
        id: "rec-section-1",
        title: "Reconciliation",
        kind: "table",
        producedByRole: "reconciliation",
        modelTier: "mid",
        findingIds: [mismatch?.id],
        evidenceIds: [evidence[0]?.id],
        reviewStatus: "pending",
      }),
    ]);
  });

  it("plans, runs, and reviews a full multi-agent case with deterministic checks", async () => {
    const { store, ai, orchestrator } = createHarness({
      coordinator: { output: { tasks: [], openQuestions: [] } },
      "case-analysis": specialistStep({
        findings: [
          finding("Demand of Rs. 48,210", {
            severity: "high",
            evidence: [{ documentId: "doc-notice", description: "Demand", page: 1 }],
            figures: [{ key: "demand", label: "Demand", value: 48210 }],
          }),
        ],
      }),
      reconciliation: specialistStep({
        findings: [
          finding("TDS mismatch", {
            severity: "high",
            evidence: [{ documentId: "doc-notice", description: "TDS", page: 1 }],
            figures: [
              {
                key: "tds-mismatch",
                label: "TDS mismatch",
                value: 13000,
                components: [
                  { label: "TDS per 26AS", value: 48400 },
                  { label: "TDS claimed", value: -36000 },
                ],
              },
            ],
          }),
        ],
      }),
      "tax-research": {
        output: {
          findings: [
            finding("Section 143(1)(a) adjustments may apply", {
              severity: "medium",
              evidence: [{ url: "https://example.gov/143", description: "Section 143" }],
            }),
          ],
        },
        citations: [
          { title: "Section 143", url: "https://example.gov/143", snippet: "Assessment" },
        ],
      },
      "response-preparation": specialistStep({
        findings: [finding("Draft response prepared")],
        section: { title: "Response draft", kind: "text", content: "Dear Sir," },
      }),
      "independent-review": {
        output: {
          findings: [],
          openQuestions: [
            { text: "The draft does not address the interest demand.", severity: "medium" },
          ],
          section: { title: "Review summary", kind: "text", content: "Mostly sound." },
        },
        usage: { input: 3000, output: 400 },
      },
    });
    const statusSpy = vi.spyOn(store.cases, "updateCaseStatusAsync");
    const caseRecord = await createCaseAsync(store);
    const received: RunEvent[] = [];

    await addDocumentAsync(store, caseRecord.id, {
      id: "doc-notice",
      name: "notice.pdf",
      pages: ["Demand Rs. 48,210. TDS per 26AS 48,400."],
    });
    orchestrator.events.subscribe(caseRecord.id, (event) => received.push(event));

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const tasks = await store.tasks.getTasksForCaseAsync(caseRecord.id);
    const review = tasks.find((task) => task.assignedRole === "independent-review");
    const findings = await store.findings.getFindingsForCaseAsync(caseRecord.id);
    const reviewFindings = findings.filter((item) => item.taskId === review?.id);
    const evidence = await store.evidence.getEvidenceForCaseAsync(caseRecord.id);
    const events = await store.events.listEventsAsync(caseRecord.id);
    const [deliverable] = await store.deliverables.getDeliverablesForCaseAsync(caseRecord.id);
    const reviewerCall = ai.calls.find((call) => call.key === "independent-review");

    expect(result.status).toBe("completed");
    expect(result.plan?.source).toBe("model");
    expect(tasks).toHaveLength(5);
    expect(statusSpy.mock.calls.map(([, status]) => status)).toEqual([
      "planning",
      "in-progress",
      "review",
      "completed",
    ]);
    expect(reviewerCall?.tier).toBe("high");
    expect(reviewerCall?.prompt).toContain("components add up to 12,400");
    expect(reviewerCall?.prompt).toContain("Dear Sir,");
    expect(reviewFindings[0]?.summary).toMatch(/found 1 issue/);
    expect(reviewFindings[0]?.openQuestions[0]).toMatchObject({ severity: "high", status: "open" });
    expect(reviewFindings.at(-1)?.openQuestions[0]?.text).toContain("interest demand");
    expect(evidence.find((item) => item.sourceRef === "https://example.gov/143")).toMatchObject({
      excerpt: "Assessment",
    });
    expect(ai.calls.find((call) => call.key === "tax-research:research")?.grounding).toBe(true);
    expect(ai.calls.find((call) => call.key === "tax-research")?.grounding).toBe(false);
    expect(deliverable?.sections.map((section) => section.title)).toEqual([
      tasks[0]?.title,
      tasks[1]?.title,
      tasks[2]?.title,
      "Response draft",
      "Verification checks",
      "Review summary",
    ]);
    expect(deliverable?.sections.at(-1)).toMatchObject({
      producedByRole: "independent-review",
      modelTier: "high",
    });
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
    expect(events[0]?.type).toBe("run-started");
    expect(events.at(-1)?.type).toBe("run-completed");
    expect(events.filter((event) => event.type === "run-completed")).toHaveLength(1);
    expect(typesOf(events)).toContain("finding-added");
    expect(received).toEqual(events);
  });

  it("flags grounded research that returned no citations", async () => {
    const { store, orchestrator } = createHarness({
      "legal-research": specialistStep({ findings: [finding("MSMED Act section 16 interest")] }),
    });
    const caseRecord = await createCaseAsync(store, "msme-payment");

    await seedTasksAsync(store, caseRecord.id, [{ id: "legal", role: "legal-research" }]);
    await orchestrator.runCaseAsync(caseRecord.id);

    const findings = await store.findings.getFindingsForCaseAsync(caseRecord.id);
    const flags = findings.flatMap((item) => item.openQuestions);

    expect(flags).toEqual([
      expect.objectContaining({
        severity: "high",
        text: expect.stringContaining("Verify against current law"),
      }),
    ]);
  });

  it("gives tasks only document slices within the token budget", async () => {
    const { store, ai, orchestrator } = createHarness(
      { "document-analysis": specialistStep() },
      { documentTokenBudget: 300 },
    );
    const caseRecord = await createCaseAsync(store, "msme-payment");
    const longPage = `${"Correspondence about delivery schedules. ".repeat(200)}END-OF-PAGE`;

    await addDocumentAsync(store, caseRecord.id, {
      id: "doc-mail",
      name: "mail.pdf",
      pages: [longPage],
    });
    await seedTasksAsync(store, caseRecord.id, [{ id: "docs", role: "document-analysis" }]);
    await orchestrator.runCaseAsync(caseRecord.id);

    const prompt = ai.calls[0]?.prompt ?? "";

    expect(prompt).toContain("Correspondence about delivery schedules.");
    expect(prompt).not.toContain("END-OF-PAGE");
    expect(prompt).toContain('"truncated": true');
  });

  it("rejects a second concurrent run and unknown cases", async () => {
    const { store, orchestrator } = createHarness({ "case-analysis": specialistStep() });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);

    const running = orchestrator.runCaseAsync(caseRecord.id);

    expect(orchestrator.isRunning(caseRecord.id)).toBe(true);
    await expect(orchestrator.runCaseAsync(caseRecord.id)).rejects.toBeInstanceOf(
      OrchestratorError,
    );
    await running;
    expect(orchestrator.isRunning(caseRecord.id)).toBe(false);
    await expect(orchestrator.runCaseAsync("missing")).rejects.toMatchObject({
      code: "case-not-found",
    });
  });

  it("holds the case lock while planning", async () => {
    const { store, orchestrator } = createHarness({
      coordinator: { output: { tasks: [], openQuestions: [] } },
    });
    const caseRecord = await createCaseAsync(store);

    const planning = orchestrator.planCaseAsync(caseRecord.id);

    expect(orchestrator.isRunning(caseRecord.id)).toBe(true);
    await expect(orchestrator.planCaseAsync(caseRecord.id)).rejects.toMatchObject({
      code: "run-in-progress",
    });
    await expect(orchestrator.runCaseAsync(caseRecord.id)).rejects.toMatchObject({
      code: "run-in-progress",
    });

    const plan = await planning;

    expect(plan.planned).toBe(true);
    expect(await store.tasks.getTasksForCaseAsync(caseRecord.id)).toHaveLength(plan.tasks.length);
    expect(orchestrator.isRunning(caseRecord.id)).toBe(false);
  });

  it("writes a generated plan atomically and charges planning when the write fails", async () => {
    const { store, orchestrator } = createHarness({
      coordinator: { output: { tasks: [], openQuestions: [] } },
      "case-analysis": specialistStep(),
      reconciliation: specialistStep(),
      "tax-research": specialistStep(),
      "response-preparation": specialistStep(),
      "independent-review": specialistStep({ findings: [] }),
    });
    const caseRecord = await createCaseAsync(store);

    vi.spyOn(store.tasks, "createTasksAsync").mockRejectedValueOnce(new Error("Write failed"));

    const failed = await orchestrator.runCaseAsync(caseRecord.id);
    const caseAfterFailure = await store.cases.getCaseAsync(caseRecord.id);

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Write failed");
    expect(failed.costEstimate).toBeGreaterThan(0);
    expect(await store.tasks.getTasksForCaseAsync(caseRecord.id)).toEqual([]);
    expect(caseAfterFailure?.usage?.costEstimate).toBeCloseTo(failed.costEstimate, 10);

    const rerun = await orchestrator.runCaseAsync(caseRecord.id);

    expect(rerun.status).toBe("completed");
    expect(rerun.completedTaskIds).toHaveLength(5);
  });

  it("keeps a task retryable until its deliverable sections are saved", async () => {
    const { store, orchestrator } = createHarness({
      "case-analysis": specialistStep({
        section: { title: "Analysis", kind: "text", content: "Demand explained." },
      }),
    });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);
    vi.spyOn(store.deliverables, "updateDeliverableAsync").mockRejectedValueOnce(
      new Error("Deliverable write failed"),
    );

    const first = await orchestrator.runCaseAsync(caseRecord.id);
    const [taskAfterFailure] = await store.tasks.getTasksForCaseAsync(caseRecord.id);

    expect(first.status).toBe("failed");
    expect(taskAfterFailure).toMatchObject({ status: "failed", attempts: 1 });
    expect(await store.deliverables.getDeliverablesForCaseAsync(caseRecord.id)).toEqual([]);

    const retry = await orchestrator.retryFailedAsync(caseRecord.id);
    const [deliverable] = await store.deliverables.getDeliverablesForCaseAsync(caseRecord.id);

    expect(retry.status).toBe("completed");
    expect(retry.deliverableIds).toEqual(["deliverable-primary"]);
    expect(deliverable?.sections.map((section) => section.content)).toEqual(["Demand explained."]);
  });

  it("reports failure and emits run-failed when run finalization cannot be recorded", async () => {
    const { store, ai, orchestrator } = createHarness({ "case-analysis": specialistStep() });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);
    const reconcileUsageAsync = store.runs.reconcileUsageAsync.bind(store.runs);

    vi.spyOn(store.runs, "reconcileUsageAsync")
      .mockResolvedValueOnce(0)
      .mockImplementationOnce(reconcileUsageAsync)
      .mockRejectedValueOnce(new Error("Usage write failed"));

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const events = await store.events.listEventsAsync(caseRecord.id);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Usage write failed");
    expect(result.completedTaskIds).toEqual(["a"]);
    expect(events.at(-1)).toMatchObject({
      type: "run-failed",
      error: expect.stringContaining("Usage write failed"),
    });
    expect((await store.cases.getCaseAsync(caseRecord.id))?.status).toBe("failed");

    const callsBeforeRecovery = ai.calls.length;
    const recovered = await createOrchestrator({ store, ai }).retryFailedAsync(caseRecord.id);
    const caseAfter = await store.cases.getCaseAsync(caseRecord.id);

    expect(recovered.status).toBe("completed");
    expect(recovered.reusedTaskIds).toEqual(["a"]);
    expect(ai.calls).toHaveLength(callsBeforeRecovery);
    expect(caseAfter?.usage).toMatchObject({
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      runCount: 1,
    });
    expect(caseAfter?.usage?.costEstimate).toBeCloseTo(result.costEstimate, 10);
    expect(await store.runs.reconcileUsageAsync(caseRecord.id)).toBe(0);
  });

  it("excludes another orchestrator while an unplanned case is being planned", async () => {
    const { store, ai, orchestrator } = createHarness({
      coordinator: { output: { tasks: [], openQuestions: [] } },
    });
    const caseRecord = await createCaseAsync(store);
    const other = createOrchestrator({ store, ai });
    const loadDocuments = store.documents.getDocumentsForCaseAsync.bind(store.documents);
    let release = () => {};

    let started = () => {};

    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const planningStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    vi.spyOn(store.documents, "getDocumentsForCaseAsync").mockImplementationOnce(async (id) => {
      started();
      await blocked;

      return loadDocuments(id);
    });

    const planning = orchestrator.planCaseAsync(caseRecord.id);

    try {
      await planningStarted;
      await expect(other.planCaseAsync(caseRecord.id)).rejects.toMatchObject({
        code: "run-in-progress",
      });
      await expect(other.runCaseAsync(caseRecord.id)).rejects.toMatchObject({
        code: "run-in-progress",
      });
    } finally {
      release();
      await planning;
    }

    expect((await other.planCaseAsync(caseRecord.id)).planned).toBe(false);
    expect(ai.calls).toHaveLength(1);
  });

  it("renews a lease during long tasks and releases it on completion", async () => {
    const handlers = createDefaultTaskHandlers();
    let started = () => {};

    let release = () => {};

    const taskStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    handlers.register({
      role: "case-analysis",
      async executeAsync() {
        started();
        await blocked;

        return { findings: [], usage: { input: 1, output: 1, total: 2 }, cost: 0 };
      },
    });

    const { store, orchestrator } = createHarness({}, { handlers });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);
    vi.useFakeTimers();
    const running = orchestrator.runCaseAsync(caseRecord.id);

    try {
      await taskStarted;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await store.runs.acquireLeaseAsync(caseRecord.id, "competitor", 60_000)).toBe(false);
      release();
      expect((await running).status).toBe("completed");
      expect(await store.runs.acquireLeaseAsync(caseRecord.id, "competitor", 60_000)).toBe(true);
    } finally {
      release();
      await running;
      vi.useRealTimers();
    }
  });

  it("recovers planning and completed-attempt charges after an interrupted run", async () => {
    const { store, ai, orchestrator } = createHarness({
      reconciliation: specialistStep(),
    });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [
      { id: "a", role: "case-analysis" },
      { id: "b", role: "reconciliation", dependsOn: ["a"] },
    ]);
    await store.tasks.updateTaskAsync(caseRecord.id, "a", {
      status: "completed",
      attempts: 1,
      tokenUsage: { input: 100, output: 20, total: 120 },
      costEstimate: 0.01,
    });
    await store.runs.recordChargeAsync(caseRecord.id, "interrupted", "run", { runCount: 1 });
    await store.runs.recordChargeAsync(caseRecord.id, "interrupted", "planning", {
      inputTokens: 50,
      outputTokens: 10,
      costEstimate: 0.005,
    });
    await store.runs.recordChargeAsync(caseRecord.id, "interrupted", "task:a:1", {
      inputTokens: 100,
      outputTokens: 20,
      costEstimate: 0.01,
    });
    const resumed = await orchestrator.runCaseAsync(caseRecord.id);
    const after = await store.cases.getCaseAsync(caseRecord.id);

    expect(resumed.status).toBe("completed");
    expect(resumed.reusedTaskIds).toEqual(["a"]);
    expect(ai.calls.map((call) => call.key)).toEqual(["reconciliation"]);
    expect(after?.usage).toMatchObject({
      inputTokens: 150 + resumed.usage.input,
      outputTokens: 30 + resumed.usage.output,
      runCount: 2,
    });
    expect(after?.usage?.costEstimate).toBeCloseTo(0.015 + resumed.costEstimate, 10);
    expect(await store.runs.reconcileUsageAsync(caseRecord.id)).toBe(0);
  });

  it("stops publishing task output when the lease cannot be renewed", async () => {
    const handlers = createDefaultTaskHandlers();
    let started = () => {};

    let release = () => {};

    const taskStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    handlers.register({
      role: "case-analysis",
      async executeAsync() {
        started();
        await blocked;

        return {
          findings: [finding("Must not be published by a stale worker")],
          usage: { input: 10, output: 2, total: 12 },
          cost: 0.001,
        };
      },
    });

    const { store, orchestrator } = createHarness({}, { handlers });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);
    const running = orchestrator.runCaseAsync(caseRecord.id);
    const failedRun = expect(running).rejects.toMatchObject({ code: "run-in-progress" });

    try {
      await taskStarted;
      const renewal = vi.spyOn(store.runs, "renewLeaseAsync").mockResolvedValue(false);

      release();
      await failedRun;
      renewal.mockRestore();
    } finally {
      release();
    }

    expect(await store.findings.getFindingsForCaseAsync(caseRecord.id)).toEqual([]);
    expect(await store.tasks.getTasksForCaseAsync(caseRecord.id)).toMatchObject([
      { id: "a", status: "in-progress" },
    ]);
    await store.runs.reconcileUsageAsync(caseRecord.id);
    expect((await store.cases.getCaseAsync(caseRecord.id))?.usage?.inputTokens).toBe(10);
    expect(orchestrator.isRunning(caseRecord.id)).toBe(false);
  });

  it("retries pending work left behind an interrupted task", async () => {
    const { store, ai, orchestrator } = createHarness({
      "case-analysis": specialistStep(),
      reconciliation: specialistStep(),
    });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [
      { id: "a", role: "case-analysis" },
      { id: "b", role: "reconciliation", dependsOn: ["a"] },
    ]);
    await store.tasks.updateTaskAsync(caseRecord.id, "a", { status: "in-progress", attempts: 1 });

    const retry = await orchestrator.retryFailedAsync(caseRecord.id);

    expect(retry.status).toBe("completed");
    expect(retry.completedTaskIds).toEqual(["a", "b"]);
    expect(ai.calls.map((call) => call.key)).toEqual(["case-analysis", "reconciliation"]);
  });

  it("charges the model call when a post-processing hook fails", async () => {
    const handlers = createDefaultTaskHandlers().register(
      createSpecialistTaskHandler("case-analysis", {
        async postProcessAsync() {
          throw new Error("Post-processing failed");
        },
      }),
    );
    const { store, orchestrator } = createHarness(
      { "case-analysis": specialistStep() },
      { handlers },
    );
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const [task] = await store.tasks.getTasksForCaseAsync(caseRecord.id);

    expect(result.failedTaskIds).toEqual(["a"]);
    expect(result.costEstimate).toBeGreaterThan(0);
    expect(task).toMatchObject({ status: "failed", lastError: "Post-processing failed" });
    expect(task?.tokenUsage?.input).toBe(1000);
    expect(task?.costEstimate).toBeCloseTo(result.costEstimate, 10);
  });

  it("keeps reviewer edits made while a later task saves its sections", async () => {
    const { store, orchestrator } = createHarness({
      "case-analysis": specialistStep(),
      reconciliation: specialistStep(),
    });
    const caseRecord = await createCaseAsync(store);
    const listDeliverablesAsync = store.deliverables.getDeliverablesForCaseAsync.bind(
      store.deliverables,
    );
    let edits = 0;

    await seedTasksAsync(store, caseRecord.id, [
      { id: "a", role: "case-analysis" },
      { id: "b", role: "reconciliation", dependsOn: ["a"] },
    ]);
    vi.spyOn(store.deliverables, "getDeliverablesForCaseAsync").mockImplementation(
      async (caseId) => {
        const snapshot = await listDeliverablesAsync(caseId);

        if (
          snapshot.some((item) => item.sections.some((section) => section.id === "a-section-1"))
        ) {
          edits += 1;
          await store.deliverables.updateSectionAsync(
            caseId,
            "deliverable-primary",
            "a-section-1",
            {
              editedContent: `Reviewer edit ${edits}`,
            },
          );
        }

        return snapshot;
      },
    );

    await orchestrator.runCaseAsync(caseRecord.id);

    const deliverable = await store.deliverables.getDeliverableAsync(
      caseRecord.id,
      "deliverable-primary",
    );

    expect(edits).toBeGreaterThan(1);
    expect(deliverable?.sections.map((section) => section.id)).toEqual([
      "a-section-1",
      "b-section-1",
    ]);
    expect(deliverable?.sections[0]?.editedContent).toBe(`Reviewer edit ${edits}`);
  });

  it("charges usage when output persistence fails and reads only the retried output", async () => {
    const { store, ai, orchestrator } = createHarness({
      reconciliation: [
        specialistStep({ findings: [finding("Old mismatch of Rs. 100"), finding("Old note")] }),
        specialistStep({ findings: [finding("Corrected mismatch of Rs. 120")] }),
      ],
      "response-preparation": specialistStep(),
    });
    const caseRecord = await createCaseAsync(store);
    const addFindingAsync = store.findings.addFindingAsync.bind(store.findings);
    let findingWrites = 0;

    await seedTasksAsync(store, caseRecord.id, [
      { id: "rec", role: "reconciliation" },
      { id: "draft", role: "response-preparation", dependsOn: ["rec"] },
    ]);
    vi.spyOn(store.findings, "addFindingAsync").mockImplementation(async (caseId, input) => {
      findingWrites += 1;

      if (findingWrites === 2) {
        throw new Error("Finding write failed");
      }

      return addFindingAsync(caseId, input);
    });

    const first = await orchestrator.runCaseAsync(caseRecord.id);
    const [failedTask] = await store.tasks.getTasksForCaseAsync(caseRecord.id);

    expect(first.failedTaskIds).toEqual(["rec"]);
    expect(first.costEstimate).toBeGreaterThan(0);
    expect(failedTask?.costEstimate).toBeCloseTo(first.costEstimate, 10);
    expect((await store.cases.getCaseAsync(caseRecord.id))?.usage?.costEstimate).toBeCloseTo(
      first.costEstimate,
      10,
    );

    const retry = await orchestrator.retryFailedAsync(caseRecord.id);
    const draftPrompt = ai.calls.find((call) => call.key === "response-preparation")?.prompt;

    expect(retry.status).toBe("completed");
    expect(draftPrompt).toContain("Corrected mismatch of Rs. 120");
    expect(draftPrompt).not.toContain("Old mismatch of Rs. 100");
  });

  it("passes upstream open questions to downstream tasks", async () => {
    const { store, ai, orchestrator } = createHarness({
      "case-analysis": specialistStep({
        openQuestions: [{ text: "Is Form 16 available?", severity: "high" }],
      }),
      reconciliation: specialistStep(),
    });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [
      { id: "a", role: "case-analysis" },
      { id: "b", role: "reconciliation", dependsOn: ["a"] },
    ]);
    await orchestrator.runCaseAsync(caseRecord.id);

    const reconciliationPrompt = ai.calls.find((call) => call.key === "reconciliation")?.prompt;

    expect(reconciliationPrompt).toContain("Is Form 16 available?");
  });

  it("does not run a task whose start cannot be persisted", async () => {
    const { store, ai, orchestrator } = createHarness({ "case-analysis": specialistStep() });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);
    vi.spyOn(store.tasks, "updateTaskAsync").mockRejectedValueOnce(new Error("Task write failed"));

    const first = await orchestrator.runCaseAsync(caseRecord.id);
    const [failed] = await store.tasks.getTasksForCaseAsync(caseRecord.id);

    expect(ai.calls).toHaveLength(0);
    expect(first.failedTaskIds).toEqual(["a"]);
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });

    const retry = await orchestrator.retryFailedAsync(caseRecord.id);
    const [completed] = await store.tasks.getTasksForCaseAsync(caseRecord.id);
    const findings = await store.findings.getFindingsForCaseAsync(caseRecord.id);

    expect(retry.status).toBe("completed");
    expect(completed).toMatchObject({ status: "completed", attempts: 2 });
    expect(findings.map((item) => item.attempt)).toEqual([2]);
  });

  it("rejects the output of a worker whose lease passed to another worker mid-task", async () => {
    const handlers = createDefaultTaskHandlers();
    const { store, orchestrator } = createHarness({}, { handlers });
    const caseRecord = await createCaseAsync(store);
    const acquireLease = vi.spyOn(store.runs, "acquireLeaseAsync");

    handlers.register({
      role: "case-analysis",
      async executeAsync() {
        const owner = acquireLease.mock.calls[0]?.[1] ?? "";

        // The worker pauses long enough for its lease to pass to a newer worker, and its own
        // lease check still passed just before the pause.
        await store.runs.releaseLeaseAsync(caseRecord.id, owner);
        await store.runs.acquireLeaseAsync(caseRecord.id, "newer-worker", 60_000);
        vi.spyOn(store.runs, "renewLeaseAsync").mockResolvedValue(true);

        return {
          findings: [finding("Stale output")],
          sections: [{ title: "Stale", kind: "text", content: "Stale" }],
          usage: { input: 10, output: 2, total: 12 },
          cost: 0.001,
        };
      },
    });
    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const [task] = await store.tasks.getTasksForCaseAsync(caseRecord.id);

    expect(result.status).toBe("failed");
    expect(await store.findings.getFindingsForCaseAsync(caseRecord.id)).toEqual([]);
    expect(await store.deliverables.getDeliverablesForCaseAsync(caseRecord.id)).toEqual([]);
    expect(task).toMatchObject({
      status: "in-progress",
      attempts: 1,
      tokenUsage: { input: 10, output: 2, total: 12 },
    });
    expect((await store.cases.getCaseAsync(caseRecord.id))?.status).toBe("in-progress");
    expect(await store.runs.acquireLeaseAsync(caseRecord.id, "third", 60_000)).toBe(false);
  });

  it("adds a journaled charge of an interrupted attempt to the task totals once", async () => {
    const { store, orchestrator } = createHarness({ "case-analysis": specialistStep() });
    const caseRecord = await createCaseAsync(store);

    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);
    await store.tasks.updateTaskAsync(caseRecord.id, "a", { status: "in-progress", attempts: 1 });
    await store.runs.recordChargeAsync(caseRecord.id, "interrupted", "task:a:1", {
      taskId: "a",
      inputTokens: 300,
      outputTokens: 50,
      totalTokens: 350,
      costEstimate: 0.002,
    });

    const retry = await orchestrator.retryFailedAsync(caseRecord.id);
    const [task] = await store.tasks.getTasksForCaseAsync(caseRecord.id);

    expect(retry.status).toBe("completed");
    expect(task).toMatchObject({ status: "completed", attempts: 2 });
    expect(task?.tokenUsage).toEqual({
      input: 300 + retry.usage.input,
      output: 50 + retry.usage.output,
      total: 350 + retry.usage.total,
    });
    expect(task?.costEstimate).toBeCloseTo(0.002 + retry.costEstimate, 10);
    expect((await store.cases.getCaseAsync(caseRecord.id))?.usage?.inputTokens).toBe(
      300 + retry.usage.input,
    );
    expect(await store.runs.reconcileUsageAsync(caseRecord.id)).toBe(0);
    expect((await store.tasks.getTasksForCaseAsync(caseRecord.id))[0]).toEqual(task);
  });

  it("never streams a lower case cost after a higher one", async () => {
    const handlers = createDefaultTaskHandlers();
    let releaseSlowTask = () => {};

    let slowTaskCompleted = () => {};

    const slowTaskReleased = new Promise<void>((resolve) => {
      releaseSlowTask = resolve;
    });
    const slowTaskDone = new Promise<void>((resolve) => {
      slowTaskCompleted = resolve;
    });

    handlers.register({
      role: "case-analysis",
      async executeAsync() {
        return { findings: [], usage: { input: 10, output: 1, total: 11 }, cost: 0.001 };
      },
    });
    handlers.register({
      role: "reconciliation",
      async executeAsync() {
        await slowTaskReleased;

        return { findings: [], usage: { input: 20, output: 2, total: 22 }, cost: 0.002 };
      },
    });

    const { store, orchestrator } = createHarness({}, { handlers });
    const caseRecord = await createCaseAsync(store);
    const appendEventAsync = store.events.appendEventAsync.bind(store.events);
    const updateTaskAsync = store.tasks.updateTaskAsync.bind(store.tasks);

    await seedTasksAsync(store, caseRecord.id, [
      { id: "fast", role: "case-analysis" },
      { id: "slow", role: "reconciliation" },
    ]);
    vi.spyOn(store.tasks, "updateTaskAsync").mockImplementation(async (...args) => {
      const updated = await updateTaskAsync(...args);

      if (args[1] === "slow" && args[2].status === "completed") {
        slowTaskCompleted();
      }

      return updated;
    });
    // While the fast task's completion is being written, the slow task finishes and queues its own.
    vi.spyOn(store.events, "appendEventAsync").mockImplementation(async (caseId, event) => {
      if (event.type === "task-completed" && event.taskId === "fast") {
        releaseSlowTask();
        await slowTaskDone;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      return appendEventAsync(caseId, event);
    });

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const events = await store.events.listEventsAsync(caseRecord.id);
    const streamedTotals = events.flatMap((event) => {
      if (event.type === "cost-updated") {
        return [event.totalCostEstimate];
      }

      return event.type === "task-completed" ? [event.runningCostEstimate ?? 0] : [];
    });

    expect(result.status).toBe("completed");
    expect(streamedTotals).toHaveLength(4);
    expect(streamedTotals).toEqual([...streamedTotals].sort((left, right) => left - right));
    expect(streamedTotals.at(-1)).toBeCloseTo(0.003, 10);
  });

  it("publishes accurate task totals when applying the task charge is deferred", async () => {
    const { store, orchestrator } = createHarness({ "case-analysis": specialistStep() });
    const caseRecord = await createCaseAsync(store);
    const reconcileUsageAsync = store.runs.reconcileUsageAsync.bind(store.runs);
    let reconciles = 0;

    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);
    await store.tasks.updateTaskAsync(caseRecord.id, "a", {
      status: "failed",
      attempts: 1,
      tokenUsage: { input: 40, output: 10, total: 50 },
      costEstimate: 0.004,
    });
    vi.spyOn(store.runs, "reconcileUsageAsync").mockImplementation(async (caseId) => {
      reconciles += 1;

      if (reconciles === 2) {
        throw new Error("Usage write failed");
      }

      return reconcileUsageAsync(caseId);
    });

    const retry = await orchestrator.retryFailedAsync(caseRecord.id);
    const events = await store.events.listEventsAsync(caseRecord.id);
    const completed = events.find((event) => event.type === "task-completed");
    const [task] = await store.tasks.getTasksForCaseAsync(caseRecord.id);
    const expectedUsage = {
      input: 40 + retry.usage.input,
      output: 10 + retry.usage.output,
      total: 50 + retry.usage.total,
    };

    expect(retry.status).toBe("completed");
    expect(reconciles).toBe(3);
    expect(completed).toMatchObject({ tokenUsage: expectedUsage });
    expect(completed?.type === "task-completed" ? completed.costEstimate : 0).toBeCloseTo(
      0.004 + retry.costEstimate,
      10,
    );
    expect(task?.tokenUsage).toEqual(expectedUsage);
    expect(task?.costEstimate).toBeCloseTo(0.004 + retry.costEstimate, 10);
    expect(retry.caseUsage).toEqual(retry.usage);
    expect(retry.caseCostEstimate).toBeCloseTo(retry.costEstimate, 10);
    expect(events.filter((event) => event.type === "cost-updated").at(-1)).toMatchObject({
      totalTokenUsage: retry.usage,
    });
  });

  it("includes a late charge from a previous worker in the completion totals", async () => {
    const handlers = createDefaultTaskHandlers();
    const { store, orchestrator } = createHarness({}, { handlers });
    const caseRecord = await createCaseAsync(store);
    const reconcileUsageAsync = store.runs.reconcileUsageAsync.bind(store.runs);
    let reconciliations = 0;

    handlers.register({
      role: "case-analysis",
      async executeAsync() {
        // The worker that lost the lease journals its billed attempt while this one runs.
        await store.runs.recordChargeAsync(caseRecord.id, "previous-run", "task:a:1", {
          taskId: "a",
          inputTokens: 100,
          outputTokens: 0,
          costEstimate: 0.01,
        });

        return { findings: [], usage: { input: 50, output: 0, total: 50 }, cost: 0.005 };
      },
    });
    vi.spyOn(store.runs, "reconcileUsageAsync").mockImplementation(async (caseId) => {
      reconciliations += 1;

      if (reconciliations === 3) {
        await store.runs.recordChargeAsync(caseId, "previous-run", "late-final", {
          inputTokens: 25,
          outputTokens: 0,
          costEstimate: 0.0025,
        });
      }

      return reconcileUsageAsync(caseId);
    });
    await seedTasksAsync(store, caseRecord.id, [{ id: "a", role: "case-analysis" }]);
    await store.tasks.updateTaskAsync(caseRecord.id, "a", { status: "in-progress", attempts: 1 });

    const retry = await orchestrator.retryFailedAsync(caseRecord.id);
    const events = await store.events.listEventsAsync(caseRecord.id);
    const completed = events.find((event) => event.type === "task-completed");
    const [task] = await store.tasks.getTasksForCaseAsync(caseRecord.id);

    expect(retry.status).toBe("completed");
    expect(reconciliations).toBe(3);
    expect(task?.tokenUsage).toEqual({ input: 150, output: 0, total: 150 });
    expect(task?.costEstimate).toBeCloseTo(0.015, 10);
    expect(completed).toMatchObject({ tokenUsage: { input: 150, output: 0, total: 150 } });
    expect(completed?.type === "task-completed" ? completed.costEstimate : 0).toBeCloseTo(
      0.015,
      10,
    );

    const caseAfter = await store.cases.getCaseAsync(caseRecord.id);
    const costUpdated = events.filter((event) => event.type === "cost-updated").at(-1);
    const terminal = events.at(-1);

    expect(caseAfter?.usage).toMatchObject({ inputTokens: 175, outputTokens: 0 });
    expect(caseAfter?.usage?.costEstimate).toBeCloseTo(0.0175, 10);
    expect(retry.usage).toEqual({ input: 50, output: 0, total: 50 });
    expect(retry.costEstimate).toBeCloseTo(0.005, 10);
    expect(retry.caseUsage).toEqual({ input: 175, output: 0, total: 175 });
    expect(retry.caseCostEstimate).toBeCloseTo(0.0175, 10);
    expect(completed?.type === "task-completed" ? completed.runningCostEstimate : 0).toBeCloseTo(
      0.015,
      10,
    );
    expect(costUpdated).toMatchObject({ totalTokenUsage: { input: 150, output: 0, total: 150 } });
    expect(costUpdated?.type === "cost-updated" ? costUpdated.totalCostEstimate : 0).toBeCloseTo(
      0.015,
      10,
    );
    expect(terminal).toMatchObject({
      type: "run-completed",
      totalTokenUsage: { input: 175, output: 0, total: 175 },
    });
    expect(terminal?.type === "run-completed" ? terminal.totalCostEstimate : 0).toBeCloseTo(
      0.0175,
      10,
    );
    expect(await store.runs.reconcileUsageAsync(caseRecord.id)).toBe(0);
  });
});
