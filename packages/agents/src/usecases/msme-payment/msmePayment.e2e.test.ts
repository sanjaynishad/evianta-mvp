import {
  AiOutputValidationError,
  IMAGE_EXTRACTION_KEY,
  VERIFY_AGAINST_CURRENT_LAW,
} from "@evianta/ai";
import { createInMemoryStore } from "@evianta/store";
import { describe, expect, it } from "vitest";

import { validateTaskGraph } from "../../dag.js";
import { createOrchestrator } from "../../orchestrator.js";
import {
  createMsmeCaseAsync,
  createMsmeHarnessAsync,
  createMsmePaymentAi,
  MSME_AS_OF_DATE,
  MSME_DOCUMENT_IDS,
  MSME_EXPECTED,
  msmeTaskHandlers,
  seedMsmeDocumentsAsync,
  type MsmeDraftOptions,
} from "../../testing/msmePayment.js";
import {
  CASE_PACK_QUESTIONS_SECTION_TITLE,
  CHRONOLOGY_SECTION_TITLE,
  createCasePreparationAgent,
  FOLLOW_UP_DRAFT_SECTION_TITLE,
  PAYMENT_SUMMARY_SECTION_TITLE,
  SUPPORTING_DOCUMENTS_SECTION_TITLE,
} from "./casePreparation.js";
import { MSME_PAYMENT_GUARDRAIL } from "./constants.js";

async function runMsmeCaseAsync(draft: MsmeDraftOptions = {}) {
  const harness = await createMsmeHarnessAsync({ draft });
  const result = await harness.orchestrator.runCaseAsync(harness.caseRecord.id);

  return { ...harness, result, ...(await harness.readAsync()) };
}

describe("MSME delayed-payment use case end to end", () => {
  it("plans the six-task DAG", async () => {
    const store = createInMemoryStore();
    const { mock, ai } = createMsmePaymentAi();
    const orchestrator = createOrchestrator({ store, ai });
    const caseRecord = await createMsmeCaseAsync(store);

    await seedMsmeDocumentsAsync(store, caseRecord.id, mock);

    const plan = await orchestrator.planCaseAsync(caseRecord.id);
    const roleOf = (id: string) => plan.tasks.find((task) => task.id === id)?.assignedRole;
    const dependencies = Object.fromEntries(
      plan.tasks.map((task) => [task.assignedRole, task.dependsOn.map(roleOf)]),
    );

    expect(plan.plan?.source).toBe("model");
    expect(plan.tasks.map((task) => task.assignedRole)).toEqual([
      "document-analysis",
      "payment-reconciliation",
      "evidence-analysis",
      "legal-research",
      "case-preparation",
      "independent-review",
    ]);
    expect(() => validateTaskGraph(plan.tasks)).not.toThrow();
    expect(dependencies).toEqual({
      "document-analysis": [],
      "payment-reconciliation": ["document-analysis"],
      "evidence-analysis": ["document-analysis", "payment-reconciliation"],
      "legal-research": ["evidence-analysis"],
      "case-preparation": ["payment-reconciliation", "evidence-analysis", "legal-research"],
      "independent-review": ["case-preparation"],
    });
    expect(mock.calls.find((call) => call.key === "coordinator")?.prompt).toContain("payments.csv");
  });

  it("produces a case pack with the outstanding amount, chronology, cited routes, and open questions", async () => {
    const { mock, result, tasks, findings, evidence, deliverables, events } =
      await runMsmeCaseAsync();
    const [pack] = deliverables;
    const sections = pack?.sections ?? [];
    const section = (title: string) => sections.find((item) => item.title === title);
    const taskFor = (role: string) => tasks.find((task) => task.assignedRole === role);
    const openQuestions = findings.flatMap((finding) => finding.openQuestions);

    expect(result.status).toBe("completed");
    expect(tasks.every((task) => task.status === "completed")).toBe(true);
    expect(mock.calls.map((call) => [call.key, call.tier])).toEqual(
      expect.arrayContaining([
        ["document-analysis", "cheap"],
        ["payment-reconciliation", "mid"],
        ["evidence-analysis", "mid"],
        ["legal-research", "mid"],
        ["case-preparation", "mid"],
        ["independent-review", "high"],
      ]),
    );
    expect(mock.calls.find((call) => call.key === "legal-research")?.grounding).toBe(true);
    expect(mock.calls.filter((call) => call.key === IMAGE_EXTRACTION_KEY)).toHaveLength(1);

    expect(deliverables).toHaveLength(1);
    expect(pack).toMatchObject({
      id: "deliverable-primary",
      title: "Payment dispute case pack",
      format: "document",
      content: MSME_PAYMENT_GUARDRAIL,
    });
    expect(sections.map((item) => [item.title, item.kind, item.producedByRole])).toEqual([
      ["Document register", "table", "document-analysis"],
      ["Payment reconciliation", "table", "payment-reconciliation"],
      ["Reconciliation notes", "text", "payment-reconciliation"],
      [
        "Evidence analysis: missing documents, inconsistencies, and disputed items",
        "text",
        "evidence-analysis",
      ],
      ["Potential contractual and statutory routes", "text", "legal-research"],
      [PAYMENT_SUMMARY_SECTION_TITLE, "table", "case-preparation"],
      [CHRONOLOGY_SECTION_TITLE, "timeline", "case-preparation"],
      [SUPPORTING_DOCUMENTS_SECTION_TITLE, "table", "case-preparation"],
      [FOLLOW_UP_DRAFT_SECTION_TITLE, "text", "case-preparation"],
      [CASE_PACK_QUESTIONS_SECTION_TITLE, "text", "case-preparation"],
      ["Verification checks", "text", "independent-review"],
      ["Review summary", "text", "independent-review"],
    ]);

    const totals = findings.find((finding) => finding.summary.startsWith("Outstanding amount:"));

    expect(totals).toMatchObject({
      taskId: taskFor("payment-reconciliation")?.id,
      summary: `Outstanding amount: Rs 1,87,000 across 3 invoice(s) as of ${MSME_AS_OF_DATE}`,
      figures: expect.arrayContaining([
        expect.objectContaining({ key: "outstanding-total", value: MSME_EXPECTED.outstanding }),
        expect.objectContaining({ key: "invoiced-total", value: MSME_EXPECTED.invoiced }),
        expect.objectContaining({ key: "received-total", value: MSME_EXPECTED.received }),
      ]),
    });

    const inv1002 = findings.find((finding) => finding.summary.startsWith("[INV-1002] Rs 50,000"));

    expect(inv1002?.evidence.map((item) => [item.documentId, item.location?.cellRange])).toEqual([
      [MSME_DOCUMENT_IDS.invoices, "D3"],
      [MSME_DOCUMENT_IDS.payments, "D3"],
      [MSME_DOCUMENT_IDS.payments, "D5"],
    ]);

    const summary = section(PAYMENT_SUMMARY_SECTION_TITLE);

    expect(summary?.content).toContain(`**Outstanding as of ${MSME_AS_OF_DATE}: Rs 1,87,000**`);
    expect(summary?.content).toContain(
      "| INV-1003 | 2024-11-10 | 1,12,000 | 50,000 | 62,000 | 2025-01-09 | 81 |",
    );
    expect(summary?.evidenceIds.length).toBeGreaterThan(3);

    const chronology = section(CHRONOLOGY_SECTION_TITLE);
    const lines = chronology?.content.split("\n") ?? [];

    expect(lines).toHaveLength(23);
    expect(lines[0]).toBe(
      "2024-08-26  Agreement SA-2024-07 entered into [supply-agreement.pdf p.1]",
    );
    expect(lines).toContain(
      "2025-01-25  Payment UTR25012503 of Rs 58,000 received matched to INV-1004 by amount (inferred) [payments.csv D4]",
    );
    expect(lines.at(-1)).toMatch(
      /^2025-03-12 {2}Correspondence from Example Motors Pvt Ltd: acknowledges INV-1003 .*\(low-confidence transcription, verify\) \[correspondence\.pdf p\.2\]$/,
    );
    expect(chronology?.evidenceIds.length).toBeGreaterThanOrEqual(20);

    const chronologyEvidence = evidence.filter((item) => chronology?.evidenceIds.includes(item.id));

    expect(chronologyEvidence.map((item) => item.documentId)).toEqual(
      expect.arrayContaining(Object.values(MSME_DOCUMENT_IDS)),
    );

    const research = section("Potential contractual and statutory routes");

    expect(research?.content).toContain("https://msme-reference.example/msmed-act/section-15");
    expect(research?.content).toContain(
      "**Reference to the Micro and Small Enterprises Facilitation Council (MSMED Act, 2006, section 18)** [2]",
    );
    expect(research?.content).toContain("(cites the case documents)");
    expect(
      evidence.filter((item) => item.sourceRef.startsWith("https://msme-reference.example/")),
    ).not.toHaveLength(0);

    const draft = section(FOLLOW_UP_DRAFT_SECTION_TITLE);

    expect(draft?.content.startsWith(MSME_PAYMENT_GUARDRAIL)).toBe(true);
    expect(draft?.content).toContain("Rs 1,87,000 remains outstanding");
    expect(draft?.content).not.toContain(`findings ${totals?.id}`);
    expect(draft?.evidenceIds.length).toBeGreaterThan(0);

    const questions = section(CASE_PACK_QUESTIONS_SECTION_TITLE)?.content ?? "";

    expect(questions).toContain("[INV-1005] No delivery record or proof of acceptance was found");
    expect(questions).toContain(
      "[INV-1003] Amount mismatch: Rs 1,12,000 in invoices.csv D4 but Rs 1,18,000 in correspondence.pdf p.2 (low-confidence transcription)",
    );
    expect(questions).toContain("[INV-1003] Disputed:");
    expect(questions).toContain(`**${VERIFY_AGAINST_CURRENT_LAW}**`);
    expect(openQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining(
            `${VERIFY_AGAINST_CURRENT_LAW}: "MSMED Act, 2006, section 16"`,
          ),
        }),
        expect.objectContaining({
          severity: "high",
          text: expect.stringMatching(
            /correspondence\.pdf page 2 was read by OCR at 66% confidence/,
          ),
        }),
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining(
            "the outstanding amount would be Rs 1,82,000 instead of Rs 1,87,000",
          ),
        }),
        expect.objectContaining({
          severity: "medium",
          text: expect.stringContaining(
            "Payment UTR25012503 on 2025-01-25 has no invoice reference",
          ),
        }),
      ]),
    );

    const verification = findings.find(
      (finding) =>
        finding.taskId === taskFor("independent-review")?.id &&
        finding.summary.startsWith("Deterministic"),
    );

    expect(verification?.detail).toBeDefined();
    expect(verification?.summary).toMatch(/^Deterministic checks passed/);
    expect(events.at(-1)?.type).toBe("run-completed");
  });

  it("withholds a payment demand when invoice records cannot be reconciled", async () => {
    const harness = await createMsmeHarnessAsync({
      uploads: { invoicesCsv: "No invoice register rows", paymentsCsv: false },
    });
    const result = await harness.orchestrator.runCaseAsync(harness.caseRecord.id);
    const { deliverables, findings, tasks } = await harness.readAsync();
    const draft = deliverables[0]?.sections.find(
      (section) => section.title === FOLLOW_UP_DRAFT_SECTION_TITLE,
    );
    const preparationTask = tasks.find((task) => task.assignedRole === "case-preparation");
    const questions = findings
      .filter((finding) => finding.taskId === preparationTask?.id)
      .flatMap((finding) => finding.openQuestions);

    expect(result.status).toBe("completed");
    expect(draft?.content).toContain("A follow-up draft has been withheld");
    expect(draft?.content).not.toContain("Rs 1,87,000");
    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining("A follow-up draft was withheld"),
        }),
      ]),
    );
  });

  it("keeps deterministic case-pack sections and continues review after invalid draft output", async () => {
    const casePreparation = createCasePreparationAgent();
    const failingCasePreparation = {
      ...casePreparation,
      async runAsync() {
        throw new AiOutputValidationError(
          "The model returned invalid structured output.",
          ["Invalid JSON"],
          '{"draft":',
          {
            attempts: 2,
            usage: { input: 800, output: 400, total: 1200 },
            cost: 0.05,
          },
        );
      },
    };
    const harness = await createMsmeHarnessAsync({
      orchestrator: {
        handlers: msmeTaskHandlers({
          reconciliation: { asOfDate: MSME_AS_OF_DATE },
          agents: { casePreparation: failingCasePreparation },
        }),
      },
    });
    const result = await harness.orchestrator.runCaseAsync(harness.caseRecord.id);
    const { deliverables, findings, tasks } = await harness.readAsync();
    const pack = deliverables[0];
    const sections = pack?.sections ?? [];
    const preparationTask = tasks.find((task) => task.assignedRole === "case-preparation");
    const questions = findings
      .filter((finding) => finding.taskId === preparationTask?.id)
      .flatMap((finding) => finding.openQuestions);

    expect(result.status).toBe("completed");
    expect(preparationTask?.status).toBe("completed");
    expect(preparationTask?.tokenUsage).toEqual({
      input: 800,
      output: 400,
      total: 1200,
    });
    expect(preparationTask?.costEstimate).toBe(0.05);
    expect(tasks.find((task) => task.assignedRole === "independent-review")?.status).toBe(
      "completed",
    );
    expect(sections.map((section) => section.title)).toEqual(
      expect.arrayContaining([
        PAYMENT_SUMMARY_SECTION_TITLE,
        CHRONOLOGY_SECTION_TITLE,
        SUPPORTING_DOCUMENTS_SECTION_TITLE,
        CASE_PACK_QUESTIONS_SECTION_TITLE,
      ]),
    );
    expect(sections.some((section) => section.title === FOLLOW_UP_DRAFT_SECTION_TITLE)).toBe(false);
    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining(
            "was not generated because the model returned an invalid response",
          ),
        }),
      ]),
    );
  });

  it("withholds a payment demand when a payment row cannot be read", async () => {
    const payments = [
      "Payment Date,UTR,Invoice Ref,Amount Received,Narration",
      "2025-02-10,UTR1,INV-1002,40000,Part payment",
      "2025-02-11,UTR2,INV-1002,unreadable,Part payment",
    ].join("\n");
    const harness = await createMsmeHarnessAsync({ uploads: { paymentsCsv: payments } });
    const result = await harness.orchestrator.runCaseAsync(harness.caseRecord.id);
    const { deliverables, findings, tasks } = await harness.readAsync();
    const sections = deliverables[0]?.sections ?? [];
    const summary = sections.find((section) => section.title === PAYMENT_SUMMARY_SECTION_TITLE);
    const draft = sections.find((section) => section.title === FOLLOW_UP_DRAFT_SECTION_TITLE);
    const preparationTask = tasks.find((task) => task.assignedRole === "case-preparation");
    const questions = findings
      .filter((finding) => finding.taskId === preparationTask?.id)
      .flatMap((finding) => finding.openQuestions);
    const allSectionContent = sections.map((section) => section.content).join("\n");

    expect(result.status).toBe("completed");
    expect(summary?.content).toContain("known invoice or payment records could not be read safely");
    expect(summary?.content).not.toContain("Rs 1,87,000");
    expect(draft?.content).toContain("A follow-up draft has been withheld");
    expect(draft?.content).not.toContain("Rs 1,87,000");
    expect(allSectionContent).not.toContain("Rs 1,87,000");
    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining("A follow-up draft was withheld"),
        }),
      ]),
    );
  });

  it("conditions unsupported statutory-interest claims in the follow-up draft", async () => {
    const { deliverables, findings, tasks } = await runMsmeCaseAsync({
      statutoryInterestClaim: true,
    });
    const draft = deliverables[0]?.sections.find(
      (section) => section.title === FOLLOW_UP_DRAFT_SECTION_TITLE,
    );
    const preparationTask = tasks.find((task) => task.assignedRole === "case-preparation");
    const questions = findings
      .filter((finding) => finding.taskId === preparationTask?.id)
      .flatMap((finding) => finding.openQuestions);

    expect(draft?.content).toContain("Any statutory interest remains subject to confirmation");
    expect(draft?.content).not.toContain("We are entitled to statutory interest");
    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining("A statutory-interest statement"),
        }),
      ]),
    );
  });

  it("conditions decimal-rate and currency interest claims without leaving sentence fragments", async () => {
    const { deliverables } = await runMsmeCaseAsync({
      statutoryInterestClaim:
        "Statutory interest at 18.5% is payable. Interest of Rs. 10,000 is due.",
    });
    const draft = deliverables[0]?.sections.find(
      (section) => section.title === FOLLOW_UP_DRAFT_SECTION_TITLE,
    );

    expect(
      draft?.content.match(/Any statutory interest remains subject to confirmation/g),
    ).toHaveLength(2);
    expect(draft?.content).not.toContain("18.5% is payable");
    expect(draft?.content).not.toContain("Rs. 10,000 is due");
    expect(draft?.content).not.toContain("5% is payable");
  });

  it("conditions definitive statutory-interest claims in part titles", async () => {
    const { deliverables, findings, tasks } = await runMsmeCaseAsync({
      statutoryInterestTitle: true,
    });
    const draft = deliverables[0]?.sections.find(
      (section) => section.title === FOLLOW_UP_DRAFT_SECTION_TITLE,
    );
    const preparationTask = tasks.find((task) => task.assignedRole === "case-preparation");
    const questions = findings
      .filter((finding) => finding.taskId === preparationTask?.id)
      .flatMap((finding) => finding.openQuestions);

    expect(draft?.content).toContain("Any statutory interest remains subject to confirmation");
    expect(draft?.content).not.toContain("Statutory interest is payable");
    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining("A statutory-interest statement"),
        }),
      ]),
    );
  });

  it("conditions fallback section titles and warns when the title changes", async () => {
    const { deliverables, findings, tasks } = await runMsmeCaseAsync({
      fallbackInterestSection: true,
    });
    const fallback = deliverables[0]?.sections.find(
      (section) =>
        section.title === "Statutory interest is payable" ||
        section.title.includes("Any statutory interest remains subject to confirmation"),
    );
    const preparationTask = tasks.find((task) => task.assignedRole === "case-preparation");
    const questions = findings
      .filter((finding) => finding.taskId === preparationTask?.id)
      .flatMap((finding) => finding.openQuestions);

    expect(fallback?.title).toContain("Any statutory interest remains subject to confirmation");
    expect(fallback?.content).toBe("Please review the account and confirm the balance.");
    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining("A statutory-interest statement"),
        }),
      ]),
    );
  });

  it("catches a seeded wrong outstanding total during independent review", async () => {
    const { mock, result, tasks, findings } = await runMsmeCaseAsync({ wrongTotal: true });
    const reviewTask = tasks.find((task) => task.assignedRole === "independent-review");
    const [verification] = findings.filter((finding) => finding.taskId === reviewTask?.id);
    const reviewPrompt = mock.calls.find((call) => call.key === "independent-review")?.prompt ?? "";

    expect(result.status).toBe("completed");
    expect(verification?.summary).toMatch(/found \d+ issue/);
    expect(verification?.severity).toBe("high");
    expect(verification?.detail).toContain(
      '[numeric-total] "Outstanding in the draft" is stated as 197,000 but its components add up to 187,000',
    );
    expect(verification?.detail).toContain("[figure-consistency]");
    expect(verification?.detail).toContain(
      '[payment-recompute] "Outstanding in the draft" is stated as 1,97,000 but recomputing it from the invoice register and payment records gives 1,87,000.',
    );
    expect(verification?.detail).toMatch(
      /\[quoted-amount\] "Proposed follow-up draft" quotes Rs 1,97,000/,
    );
    expect(verification?.openQuestions.map((question) => question.severity)).toContain("high");
    expect(reviewPrompt).toContain("quoted-amount");
  });

  it("flags a draft that claims an escalation was filed", async () => {
    const { findings, tasks } = await runMsmeCaseAsync({ escalationClaim: true });
    const draftTask = tasks.find((task) => task.assignedRole === "case-preparation");
    const questions = findings
      .filter((finding) => finding.taskId === draftTask?.id)
      .flatMap((finding) => finding.openQuestions);

    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining(
            '"A reference has been filed with the Facilitation Council."',
          ),
        }),
        expect.objectContaining({ text: expect.stringContaining("not-a-finding") }),
      ]),
    );
  });
});
