import { VERIFY_AGAINST_CURRENT_LAW, type AiClient } from "@evianta/ai";
import { createInMemoryStore, type Store } from "@evianta/store";
import { describe, expect, it } from "vitest";

import { validateTaskGraph } from "../../dag.js";
import { createOrchestrator } from "../../orchestrator.js";
import { seedTasksAsync } from "../../testing/fixtures.js";
import {
  createTaxNoticeAi,
  createTaxNoticeHarnessAsync,
  createTaxNoticeCaseAsync,
  DOCUMENT_IDS,
  seedTaxNoticeDocumentsAsync,
  type DraftOptions,
} from "../../testing/taxNotice.js";
import { TAX_NOTICE_GUARDRAIL } from "./constants.js";

async function runTaxNoticeCaseAsync(draft: DraftOptions = {}) {
  const store: Store = createInMemoryStore();
  const { mock, ai } = createTaxNoticeAi({}, draft);
  let counter = 0;
  const orchestrator = createOrchestrator({
    store,
    ai: ai as AiClient,
    newId: () => `id-${String(++counter).padStart(4, "0")}`,
  });
  const caseRecord = await createTaxNoticeCaseAsync(store);

  await seedTaxNoticeDocumentsAsync(store, caseRecord.id, mock);

  const result = await orchestrator.runCaseAsync(caseRecord.id);
  const [tasks, findings, evidence, deliverables, events] = await Promise.all([
    store.tasks.getTasksForCaseAsync(caseRecord.id),
    store.findings.getFindingsForCaseAsync(caseRecord.id),
    store.evidence.getEvidenceForCaseAsync(caseRecord.id),
    store.deliverables.getDeliverablesForCaseAsync(caseRecord.id),
    store.events.listEventsAsync(caseRecord.id),
  ]);

  return { store, mock, caseRecord, result, tasks, findings, evidence, deliverables, events };
}

describe("tax-notice use case end to end", () => {
  it("plans the five-task DAG for a sample notice", async () => {
    const store = createInMemoryStore();
    const { mock, ai } = createTaxNoticeAi();
    const orchestrator = createOrchestrator({ store, ai: ai as AiClient });
    const caseRecord = await createTaxNoticeCaseAsync(store);

    await seedTaxNoticeDocumentsAsync(store, caseRecord.id, mock);

    const plan = await orchestrator.planCaseAsync(caseRecord.id);
    const byRole = new Map(plan.tasks.map((task) => [task.assignedRole, task]));
    const dependsOnRoles = (role: string) =>
      (byRole.get(role as never)?.dependsOn ?? []).map(
        (id) => plan.tasks.find((task) => task.id === id)?.assignedRole,
      );

    expect(plan.plan?.source).toBe("model");
    expect(plan.tasks.map((task) => task.assignedRole)).toEqual([
      "case-analysis",
      "reconciliation",
      "tax-research",
      "response-preparation",
      "independent-review",
    ]);
    expect(() => validateTaskGraph(plan.tasks)).not.toThrow();
    expect(dependsOnRoles("case-analysis")).toEqual([]);
    expect(dependsOnRoles("reconciliation")).toEqual(["case-analysis"]);
    expect(dependsOnRoles("tax-research")).toEqual(["case-analysis"]);
    expect(dependsOnRoles("response-preparation")).toEqual(["reconciliation", "tax-research"]);
    expect(dependsOnRoles("independent-review")).toEqual(["response-preparation"]);
    expect(mock.calls.find((call) => call.key === "coordinator")?.prompt).toContain(
      "form-26as.csv",
    );
  });

  it("produces a response pack with evidence, schedules, and flags", async () => {
    const { mock, result, tasks, findings, evidence, deliverables, events } =
      await runTaxNoticeCaseAsync();
    const [pack] = deliverables;
    const sections = pack?.sections ?? [];
    const sectionTitled = (prefix: string) =>
      sections.find((section) => section.title.startsWith(prefix));
    const reconciliationTask = tasks.find((task) => task.assignedRole === "reconciliation");
    const reviewTask = tasks.find((task) => task.assignedRole === "independent-review");
    const mismatch = findings.find((finding) => finding.summary.startsWith("[R-03]"));
    const openQuestions = findings.flatMap((finding) => finding.openQuestions);

    expect(result.status).toBe("completed");
    expect(tasks.every((task) => task.status === "completed")).toBe(true);
    expect(mock.calls.map((call) => [call.key, call.tier])).toEqual(
      expect.arrayContaining([
        ["case-analysis", "cheap"],
        ["reconciliation", "mid"],
        ["tax-research", "mid"],
        ["response-preparation", "mid"],
        ["independent-review", "high"],
      ]),
    );
    expect(mock.calls.find((call) => call.key === "tax-research")?.grounding).toBe(true);

    expect(deliverables).toHaveLength(1);
    expect(pack).toMatchObject({
      id: "deliverable-primary",
      title: "Notice response pack",
      format: "document",
      content: TAX_NOTICE_GUARDRAIL,
    });
    expect(
      sections.map((section) => [section.title, section.kind, section.producedByRole]),
    ).toEqual([
      ["Notice analysis", "text", "case-analysis"],
      ["Reconciliation: return, ledger, and 26AS/AIS", "table", "reconciliation"],
      ["Reconciliation notes", "text", "reconciliation"],
      ["Research: potentially applicable provisions", "text", "tax-research"],
      ["Response draft", "text", "response-preparation"],
      ["Schedule A: TDS reconciliation", "table", "response-preparation"],
      ["Schedule B: Computation of the TDS difference", "table", "response-preparation"],
      ["Open questions, assumptions, and verification flags", "text", "response-preparation"],
      ["Verification checks", "text", "independent-review"],
      ["Review summary", "text", "independent-review"],
    ]);

    const reconciliationSection = sectionTitled("Reconciliation:");

    expect(reconciliationSection?.content).toContain(
      "| R-03 | Sunrise Consulting Pvt Ltd (DELS20002B)",
    );
    expect(reconciliationSection?.findingIds).toContain(mismatch?.id);
    expect(reconciliationSection?.evidenceIds.length).toBeGreaterThan(3);
    expect(mismatch).toMatchObject({
      taskId: reconciliationTask?.id,
      severity: "high",
      figures: [expect.objectContaining({ value: 12400 })],
    });
    expect(mismatch?.detail).toContain("has not reported the January to March quarter");
    expect(mismatch?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: DOCUMENT_IDS.taxCredit,
          location: expect.objectContaining({ cellRange: "F4", rowRange: { start: 4, end: 4 } }),
        }),
        expect.objectContaining({
          documentId: DOCUMENT_IDS.returnComputation,
          location: expect.objectContaining({ cellRange: "F3" }),
        }),
      ]),
    );

    const noticeFigures = findings.find(
      (finding) => finding.summary === "Figures stated in the notice",
    );

    expect(noticeFigures?.evidence[0]).toMatchObject({
      documentId: DOCUMENT_IDS.notice,
      location: { page: 1 },
      confidence: "high",
    });
    expect(
      findings.find(
        (finding) => finding.summary === "Adjustment relates to Sunrise Consulting Pvt Ltd",
      ),
    ).toMatchObject({
      confidence: "low",
      evidence: [expect.objectContaining({ location: { page: 2, textQuote: expect.any(String) } })],
    });
    expect(openQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringMatching(/notice-143-1\.pdf page 2 was read by OCR at 68% confidence/),
        }),
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining(`${VERIFY_AGAINST_CURRENT_LAW}: "Rule 37BA"`),
        }),
        expect.objectContaining({ text: expect.stringContaining("R-03: Ask Sunrise Consulting") }),
      ]),
    );

    const research = sectionTitled("Research:");

    expect(research?.content).toContain("https://tax-reference.example/act/section-143");
    expect(research?.content).toContain("**Section 199: Credit for tax deducted** [2]");
    expect(research?.evidenceIds.length).toBeGreaterThanOrEqual(2);
    expect(
      evidence.filter((item) => item.sourceRef.startsWith("https://tax-reference.example/")),
    ).not.toHaveLength(0);

    const draft = sectionTitled("Response draft");

    expect(draft?.content.startsWith(`_${TAX_NOTICE_GUARDRAIL}_`)).toBe(true);
    expect(draft?.content).toContain(`findings ${mismatch?.id}`);
    expect(draft?.content).toContain("Schedule A, Schedule B");
    expect(draft?.evidenceIds.length).toBeGreaterThan(0);
    expect(sectionTitled("Schedule B")?.content).toContain(
      "| Notice disallowance less reconciled difference | 0 | Notice and reconciliation |",
    );
    expect(sectionTitled("Open questions")?.content).toContain(`**${VERIFY_AGAINST_CURRENT_LAW}**`);

    const verification = findings.find(
      (finding) => finding.taskId === reviewTask?.id && finding.summary.startsWith("Deterministic"),
    );

    expect(verification?.summary).toMatch(/^Deterministic checks passed/);
    expect(events.at(-1)?.type).toBe("run-completed");
  });

  it("catches a seeded arithmetic error in the draft during independent review", async () => {
    const { mock, result, tasks, findings } = await runTaxNoticeCaseAsync({
      arithmeticError: true,
    });
    const reviewTask = tasks.find((task) => task.assignedRole === "independent-review");
    const [verification] = findings.filter((finding) => finding.taskId === reviewTask?.id);
    const reviewPrompt = mock.calls.find((call) => call.key === "independent-review")?.prompt ?? "";

    expect(result.status).toBe("completed");
    expect(verification?.summary).toMatch(/found \d+ issue/);
    expect(verification?.severity).toBe("high");
    expect(verification?.detail).toContain(
      '[numeric-total] "TDS difference in the draft" is stated as 12,000 but its components add up to 12,400',
    );
    expect(verification?.detail).toContain("[figure-consistency]");
    expect(verification?.detail).toMatch(/\[draft-figure\] "Response draft" quotes Rs 12,000/);
    expect(verification?.openQuestions.map((question) => question.severity)).toContain("high");
    expect(reviewPrompt).toContain("draft-figure");
  });

  it("catches a reviewer edit to a schedule that departs from the source records", async () => {
    const { store, orchestrator, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [
        { id: "rec", role: "reconciliation" },
        { id: "draft", role: "response-preparation", dependsOn: ["rec"] },
      ],
    });

    await orchestrator.runCaseAsync(caseRecord.id);
    await store.deliverables.updateDeliverableAsync(
      caseRecord.id,
      "deliverable-primary",
      (current) => {
        if (!current) {
          throw new Error("The response pack was not created.");
        }

        return {
          ...current,
          sections: current.sections.map((section) =>
            section.title.startsWith("Schedule A")
              ? {
                  ...section,
                  editedContent: section.content.replace(
                    "| 50,000 | 50,000 | 37,600 | 12,400 |",
                    "| 50,000 | 50,000 | 47,600 | 2,400 |",
                  ),
                }
              : section,
          ),
        };
      },
    );
    await seedTasksAsync(store, caseRecord.id, [
      { id: "review", role: "independent-review", dependsOn: ["draft"] },
    ]);
    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings } = await readAsync();
    const [verification] = findings.filter((finding) => finding.taskId === "review");

    expect(verification?.summary).toMatch(/found \d+ issue/);
    expect(verification?.detail).toContain(
      '[schedule-edit] "Schedule A: TDS reconciliation" shows "47,600" for R-03, TDS per 26AS/AIS, but the source records give "37,600".',
    );
    expect(verification?.detail).toContain('shows "2,400" for R-03, Difference');
    expect(verification?.detail).not.toContain("Reconciliation: return, ledger");
  });
  it("flags a draft that claims a filing", async () => {
    const { findings, tasks } = await runTaxNoticeCaseAsync({ filingClaim: true });
    const draftTask = tasks.find((task) => task.assignedRole === "response-preparation");
    const questions = findings
      .filter((finding) => finding.taskId === draftTask?.id)
      .flatMap((finding) => finding.openQuestions);

    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining('"A revised return has been filed."'),
        }),
        expect.objectContaining({ text: expect.stringContaining("not-a-finding") }),
      ]),
    );
  });
});
