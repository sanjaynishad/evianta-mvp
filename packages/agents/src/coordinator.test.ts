import { validateTaskGraph } from "./dag.js";
import { describe, expect, it } from "vitest";

import { mergeWithReferencePlan, type CoordinatorOutput } from "./agents/coordinator.js";
import { REFERENCE_PLANS } from "./plans.js";
import { addDocumentAsync, createCaseAsync, createHarness } from "./testing/fixtures.js";

const taxPlan = REFERENCE_PLANS["tax-notice"];

function taxOutput(overrides: Partial<CoordinatorOutput> = {}): CoordinatorOutput {
  return {
    tasks: taxPlan.tasks.map((task) => ({
      assignedRole: task.assignedRole,
      title: task.title,
      dependsOn: [...task.dependsOn],
    })),
    openQuestions: [],
    ...overrides,
  };
}

describe("mergeWithReferencePlan", () => {
  it("keeps every required task and adapts titles and instructions", () => {
    const output = taxOutput();

    output.tasks[1] = {
      ...output.tasks[1]!,
      title: "Reconcile the 26AS TDS credit with the return",
      instructions: "Use 26AS.pdf and the ledger.",
    };

    const merged = mergeWithReferencePlan(taxPlan, output);

    expect(merged.source).toBe("model");
    expect(merged.tasks.map((task) => task.assignedRole)).toEqual(
      taxPlan.tasks.map((task) => task.assignedRole),
    );
    expect(merged.tasks[1]).toMatchObject({
      title: "Reconcile the 26AS TDS credit with the return",
      instructions: "Use 26AS.pdf and the ledger.",
      dependsOn: ["case-analysis"],
    });
  });

  it("restores dropped required tasks and ignores roles outside the use case", () => {
    const merged = mergeWithReferencePlan(taxPlan, {
      tasks: [
        { assignedRole: "case-analysis", title: "Analyze", dependsOn: [] },
        { assignedRole: "legal-research", title: "Wrong use case", dependsOn: [] },
      ],
      openQuestions: [
        { text: "The ledger is missing.", severity: "high", assignedRole: "reconciliation" },
      ],
    });

    expect(merged.source).toBe("model");
    expect(merged.tasks.map((task) => task.assignedRole)).toEqual(
      taxPlan.tasks.map((task) => task.assignedRole),
    );
    expect(
      merged.tasks.find((task) => task.assignedRole === "independent-review")?.dependsOn,
    ).toEqual(["response-preparation"]);
    expect(merged.openQuestions).toHaveLength(1);
    expect(merged.issues.join(" ")).toMatch(/Restored the required "independent-review"/);
    expect(merged.issues.join(" ")).toMatch(/Dropped "legal-research"/);
  });

  it("falls back to the reference plan on a cycle or duplicate roles", () => {
    const cyclic = taxOutput();

    cyclic.tasks[0] = { ...cyclic.tasks[0]!, dependsOn: ["independent-review"] };

    const fromCycle = mergeWithReferencePlan(taxPlan, cyclic);
    const fromDuplicate = mergeWithReferencePlan(taxPlan, {
      tasks: [
        ...taxOutput().tasks,
        { assignedRole: "case-analysis", title: "Again", dependsOn: [] },
      ],
      openQuestions: [],
    });

    expect(fromCycle.source).toBe("reference");
    expect(fromCycle.issues.join(" ")).toMatch(/cycle/);
    expect(fromCycle.tasks[0]?.dependsOn).toEqual([]);
    expect(fromDuplicate.source).toBe("reference");
  });
});

describe("coordinator planning", () => {
  it("plans and persists a valid multi-agent DAG with planning questions", async () => {
    const output = taxOutput({
      openQuestions: [
        {
          text: "No ledger was uploaded; reconciliation will rely on 26AS only.",
          severity: "high",
          assignedRole: "reconciliation",
        },
      ],
      notes: "Notice is a 143(1) intimation.",
    });
    const { store, ai, orchestrator } = createHarness({
      coordinator: { output, usage: { input: 800, output: 150 } },
    });
    const caseRecord = await createCaseAsync(store, "tax-notice");

    await addDocumentAsync(store, caseRecord.id, {
      id: "doc-notice",
      name: "notice.pdf",
      pages: ["Intimation under section 143(1). Demand: Rs. 48,210."],
    });

    const result = await orchestrator.planCaseAsync(caseRecord.id);
    const tasks = await store.tasks.getTasksForCaseAsync(caseRecord.id);
    const byRole = new Map(tasks.map((task) => [task.assignedRole, task]));
    const findings = await store.findings.getFindingsForCaseAsync(caseRecord.id);
    const caseAfter = await store.cases.getCaseAsync(caseRecord.id);

    expect(result.planned).toBe(true);
    expect(result.plan?.source).toBe("model");
    expect(tasks).toHaveLength(5);
    expect(() => validateTaskGraph(tasks)).not.toThrow();
    expect(byRole.get("response-preparation")?.dependsOn).toEqual([
      byRole.get("reconciliation")?.id,
      byRole.get("tax-research")?.id,
    ]);
    expect(byRole.get("independent-review")?.dependsOn).toEqual([
      byRole.get("response-preparation")?.id,
    ]);
    expect(byRole.get("reconciliation")?.instructions).toContain("No ledger was uploaded");
    expect(findings).toHaveLength(2);
    expect(findings.find((item) => item.taskId === byRole.get("reconciliation")?.id)).toMatchObject(
      { openQuestions: [expect.objectContaining({ severity: "high", status: "open" })] },
    );
    expect(findings.find((item) => item.taskId === byRole.get("case-analysis")?.id)?.detail).toBe(
      "Notice is a 143(1) intimation.",
    );
    expect(caseAfter?.usage?.inputTokens).toBe(800);
    expect(ai.calls[0]?.key).toBe("coordinator");
    expect(ai.calls[0]?.tier).toBe("mid");
    expect(ai.calls[0]?.prompt).toContain("notice.pdf");

    const again = await orchestrator.planCaseAsync(caseRecord.id);

    expect(again.planned).toBe(false);
    expect(ai.calls).toHaveLength(1);
  });

  it("falls back to the reference plan when the model output is invalid", async () => {
    const { store, orchestrator } = createHarness({
      coordinator: { text: "not json at all" },
    });
    const caseRecord = await createCaseAsync(store, "msme-payment");

    const result = await orchestrator.planCaseAsync(caseRecord.id);
    const tasks = await store.tasks.getTasksForCaseAsync(caseRecord.id);
    const byRole = new Map(tasks.map((task) => [task.assignedRole, task.id]));

    expect(result.plan?.source).toBe("reference");
    expect(tasks.map((task) => task.assignedRole)).toEqual(
      REFERENCE_PLANS["msme-payment"].tasks.map((task) => task.assignedRole),
    );
    expect(tasks.find((task) => task.assignedRole === "case-preparation")?.dependsOn).toEqual([
      byRole.get("payment-reconciliation"),
      byRole.get("evidence-analysis"),
      byRole.get("legal-research"),
    ]);
    expect(result.usage.total).toBeGreaterThan(0);
  });

  it("emits a single task for the single-agent use case", async () => {
    const { store, orchestrator } = createHarness({
      coordinator: {
        output: {
          tasks: [
            { assignedRole: "business-data-analyst", title: "Analyze Q3 sales", dependsOn: [] },
          ],
        },
      },
    });
    const caseRecord = await createCaseAsync(store, "data-analysis");

    const result = await orchestrator.planCaseAsync(caseRecord.id);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      assignedRole: "business-data-analyst",
      title: "Analyze Q3 sales",
      dependsOn: [],
    });
  });
});
