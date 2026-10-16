import { describe, expect, it } from "vitest";
import { sampleCaseStates } from "@/fixtures";
import {
  applySectionUpdate,
  buildOutline,
  isVerifyFlag,
  summarizeForApproval,
  unresolvedQuestions,
} from "./review";

const taxNotice = sampleCaseStates.find((state) => state.case.id === "sample-tax-notice")!;

describe("open questions", () => {
  it("orders unresolved questions by severity and spots verify flags", () => {
    const findings = [
      {
        ...taxNotice.findings[0]!,
        openQuestions: [
          { id: "q-low", text: "Low item", severity: "low" as const, status: "open" as const },
        ],
      },
      ...taxNotice.findings.slice(1),
    ];

    expect(unresolvedQuestions(findings).map((item) => item.question.id)).toEqual([
      "b-q-pan-correction",
      "b-q-verify-law",
      "q-low",
    ]);
    expect(isVerifyFlag("Verify the cited provisions against the law in force.")).toBe(true);
    expect(isVerifyFlag("Verify against current law: no sources were cited.")).toBe(true);
    expect(isVerifyFlag("Has the deductor filed a correction?")).toBe(false);
  });

  it("summarises the case for the approval gate", () => {
    const summary = summarizeForApproval(taxNotice);

    expect(summary.unresolved).toHaveLength(2);
    expect(summary.verifyCount).toBe(1);
    expect(summary.assumptions.map((item) => item.text)).toEqual([
      "Form 16A from Mehta Exports reflects the deduction actually made.",
    ]);
    expect(summary.evidenceConfidence).toEqual({ high: 2, medium: 2, low: 1, unassessed: 0 });
    expect(summary.sections).toMatchObject({ total: 3, approved: 1, pending: 2, edited: 0 });
  });
});

describe("buildOutline", () => {
  it("groups sections and steps by the kind of work", () => {
    const groups = buildOutline(taxNotice.deliverables, taxNotice.tasks);

    expect(groups.map((group) => group.label)).toEqual([
      "Analysis",
      "Reconciliation",
      "Research",
      "Draft",
      "Independent review",
    ]);
    expect(groups[1]?.sections.map(({ section }) => section.title)).toEqual(["TDS reconciliation"]);
    expect(groups[2]?.sections).toEqual([]);
    expect(groups[2]?.tasks.map((task) => task.assignedRole)).toEqual(["tax-research"]);
  });
});

describe("applySectionUpdate", () => {
  it("records and clears reviewer edits", () => {
    const section = taxNotice.deliverables[0]!.sections[2]!;
    const edited = applySectionUpdate(
      section,
      { editedContent: "New text" },
      "2026-10-16T10:00:00Z",
    );

    expect(edited).toMatchObject({ editedContent: "New text", editedAt: "2026-10-16T10:00:00Z" });
    expect(
      applySectionUpdate(edited, { editedContent: null }, "later").editedContent,
    ).toBeUndefined();
    expect(
      applySectionUpdate(
        section,
        { reviewStatus: "needs-changes", reviewComment: "Cite Form 16A" },
        "t",
      ),
    ).toMatchObject({
      reviewStatus: "needs-changes",
      reviewComment: "Cite Form 16A",
      reviewedAt: "t",
    });
  });
});
