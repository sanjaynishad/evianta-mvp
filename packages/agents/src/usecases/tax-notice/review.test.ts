import { describe, expect, it } from "vitest";

import {
  createHarness,
  createCaseAsync,
  finding,
  seedTasksAsync,
  specialistStep,
} from "../../testing/fixtures.js";
import type { UpstreamSection } from "../../handlers.js";
import type { VerificationFinding } from "../../verification.js";
import { TAX_FIGURE_KEYS } from "./constants.js";
import {
  draftFiguresCheck,
  parseMarkdownTable,
  quotedAmounts,
  reconciliationRecomputeCheck,
  scheduleEditsCheck,
  type ExpectedFigure,
} from "./review.js";

const expected: ExpectedFigure[] = [
  { key: TAX_FIGURE_KEYS.tdsClaimedInReturn, label: "Total TDS per return", value: 141000 },
  { key: TAX_FIGURE_KEYS.tdsPerTaxCredit, label: "Total TDS per 26AS/AIS", value: 128600 },
  { key: TAX_FIGURE_KEYS.tdsDifference, label: "Difference", value: 12400 },
];

function verificationFinding(
  id: string,
  taskId: string,
  figures: VerificationFinding["figures"] = [],
): VerificationFinding {
  return { id, taskId, summary: id, severity: "info", evidence: [], figures };
}

function draftSection(content: string): UpstreamSection {
  return {
    taskId: "draft",
    taskTitle: "Draft",
    role: "response-preparation",
    deliverableId: "deliverable-primary",
    title: "Response draft",
    content,
  };
}

describe("tax-notice review checks", () => {
  it("reads rupee amounts in common notations", () => {
    expect(
      quotedAmounts(
        "Rs 1,41,000 and Rs. 12,400/- plus INR 620, ₹13,020.50 but not section 143(1).",
      ),
    ).toEqual([
      { text: "Rs 1,41,000", value: 141000 },
      { text: "Rs. 12,400", value: 12400 },
      { text: "INR 620", value: 620 },
      { text: "₹13,020.50", value: 13020.5 },
    ]);
    expect(quotedAmounts("a refund of Rs -12,000, ₹-12,000 or -Rs 620 in years 2024")).toEqual([
      { text: "Rs -12,000", value: -12000 },
      { text: "₹-12,000", value: -12000 },
      { text: "-Rs 620", value: -620 },
    ]);
  });

  it("checks the magnitude of signed draft amounts", () => {
    const check = draftFiguresCheck(
      [draftSection("A refund of Rs -12,400 is due; the other Rs -12,000 is not.")],
      expected,
    );

    expect(check([]).map((issue) => issue.message)).toEqual([
      expect.stringContaining("quotes Rs -12,000"),
    ]);
  });

  it("flags draft amounts that match no computed figure", () => {
    const unsourced = verificationFinding("unsourced", "analyze", [
      { key: "notice-other", label: "Untraced amount", value: 12000 },
    ]);
    const notice = verificationFinding("notice", "analyze", [
      {
        key: "demand-total",
        label: "Demand",
        value: 13020,
        components: [
          { label: "Tax", value: 12400 },
          { label: "Interest", value: 620 },
        ],
      },
    ]);
    const ownFigure = verificationFinding("own", "draft", [
      { key: "draft-difference", label: "Draft difference", value: 12000 },
    ]);
    const check = draftFiguresCheck(
      [
        draftSection(
          "Claimed Rs 1,41,000; 26AS Rs 1,28,600; difference Rs 12,000; interest Rs 620.",
        ),
      ],
      expected,
    );
    notice.evidence.push({ id: "ev-notice", sourceRef: "notice.pdf p.1", description: "Demand" });

    const issues = check([notice, ownFigure, unsourced]);

    expect(issues).toEqual([
      expect.objectContaining({
        check: "draft-figure",
        severity: "high",
        taskIds: ["draft"],
        message: expect.stringContaining(
          "quotes Rs 12,000, which does not match any computed or sourced figure (closest: 12,400)",
        ),
      }),
    ]);
    expect(
      draftFiguresCheck([draftSection("Rs 12,400 and Rs 13,020")], expected)([notice]),
    ).toEqual([]);
  });

  it("recomputes reconciliation figures stated by the reconciliation and draft tasks", () => {
    const check = reconciliationRecomputeCheck(expected, (item) => item.taskId !== "analyze");
    const issues = check([
      verificationFinding("rec", "rec", [
        { key: TAX_FIGURE_KEYS.tdsClaimedInReturn, label: "Total TDS per return", value: 141000 },
        { key: TAX_FIGURE_KEYS.tdsDifference, label: "Difference", value: 13400 },
      ]),
      verificationFinding("notice", "analyze", [
        { key: TAX_FIGURE_KEYS.tdsDifference, label: "Per notice", value: 99 },
      ]),
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        check: "reconciliation-recompute",
        findingIds: ["rec"],
        message:
          '"Difference" is stated as 13,400 but recomputing the reconciliation from the uploaded records gives 12,400.',
      }),
    ]);
  });

  it("compares edited schedule amounts with the regenerated source tables", () => {
    const regenerated = {
      title: "Schedule B: Computation of the TDS difference",
      content: [
        "| Item | Amount (Rs) | Basis |",
        "| --- | --- | --- |",
        "| TDS per Return | 1,41,000 | Schedule A |",
        "| TDS per 26AS/AIS | 1,28,600 | Schedule A |",
        "| Difference | 12,400 | Schedule A totals |",
      ].join("\n"),
    };
    const edited = (content: string): UpstreamSection => ({
      ...draftSection(content),
      title: regenerated.title,
    });
    const check = (content: string) => scheduleEditsCheck([edited(content)], [regenerated])([]);

    expect(parseMarkdownTable("| A \\| B | C |\n| --- | --- |\n| x \\| y | 1 |")).toEqual({
      headers: ["A | B", "C"],
      rows: [["x | y", "1"]],
    });
    expect(check(regenerated.content.replace("1,41,000", "141000"))).toEqual([]);
    expect(check(regenerated.content.replace("| 12,400 |", "| 12,000 |"))).toEqual([
      expect.objectContaining({
        check: "schedule-edit",
        severity: "high",
        message: expect.stringContaining(
          'shows "12,000" for Difference, Amount (Rs), but the source records give "12,400"',
        ),
      }),
    ]);
    expect(
      check(
        `${regenerated.content.replace(/\n\| Difference.*$/, "")}\n| Adjustment | 500 | Manual |`,
      ).map((issue) => issue.message),
    ).toEqual([
      expect.stringContaining('no longer has the row "Difference"'),
      expect.stringContaining('has a row "Adjustment" with amounts'),
    ]);
    expect(
      check(`${regenerated.content}\n| Difference | 12,000 | Edited |`).map(
        (issue) => issue.message,
      ),
    ).toEqual([expect.stringContaining('has more than one row "Difference"')]);
    expect(check("The schedule was replaced by prose.")[0]?.message).toContain(
      "no longer contains its table",
    );
  });
  it("keeps the generic reviewer for other use cases", async () => {
    const { store, ai, orchestrator } = createHarness({
      "legal-research": specialistStep({ findings: [finding("Route noted")] }),
      "independent-review": { output: { findings: [], openQuestions: [] } },
    });
    const caseRecord = await createCaseAsync(store, "msme-payment");

    await seedTasksAsync(store, caseRecord.id, [
      { id: "legal", role: "legal-research" },
      { id: "review", role: "independent-review", dependsOn: ["legal"] },
    ]);

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const findings = await store.findings.getFindingsForCaseAsync(caseRecord.id);

    expect(result.status).toBe("completed");
    expect(ai.calls.at(-1)?.key).toBe("independent-review");
    expect(findings.find((item) => item.taskId === "review")?.summary).toMatch(
      /^Deterministic checks passed/,
    );
  });
});
