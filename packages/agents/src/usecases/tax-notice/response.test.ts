import { describe, expect, it } from "vitest";

import { createTaxNoticeHarnessAsync } from "../../testing/taxNotice.js";
import { TAX_NOTICE_GUARDRAIL } from "./constants.js";
import { findFilingClaims } from "./response.js";

describe("response-preparation handler", () => {
  it("drafts from prior findings, attaches schedules, and lists open questions", async () => {
    const { orchestrator, mock, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [
        { id: "analyze", role: "case-analysis" },
        { id: "rec", role: "reconciliation", dependsOn: ["analyze"] },
        { id: "draft", role: "response-preparation", dependsOn: ["rec"] },
      ],
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings, deliverables } = await readAsync();
    const call = mock.calls.find((item) => item.key === "response-preparation");
    const draftFindings = findings.filter((finding) => finding.taskId === "draft");
    const mismatch = findings.find((finding) => finding.summary.startsWith("[R-03]"));
    const sections = (deliverables[0]?.sections ?? []).filter((section) =>
      section.id.startsWith("draft-"),
    );

    expect(call?.prompt).toContain('"computedFigures"');
    expect(call?.prompt).toContain('"ref": "Schedule A"');
    expect(call?.prompt).toContain(TAX_NOTICE_GUARDRAIL);
    expect(sections.map((section) => [section.title, section.kind])).toEqual([
      ["Response draft", "text"],
      ["Schedule A: TDS reconciliation", "table"],
      ["Schedule B: Computation of the TDS difference", "table"],
      ["Open questions, assumptions, and verification flags", "text"],
    ]);

    const [draft, scheduleA, scheduleB, questions] = sections;

    expect(draft?.content).toContain("**Subject:** Response to intimation under section 143(1)");
    expect(draft?.content).toContain("**1. TDS credit claimed**");
    expect(draft?.content).toContain(`_Relies on: findings ${mismatch?.id}`);
    expect(draft?.content).not.toContain("not-a-finding");
    expect(draftFindings[0]).toMatchObject({
      summary: "Response point: TDS credit claimed",
      detail: expect.stringContaining(`${mismatch?.id}: [R-03]`),
    });
    expect(draftFindings[0]?.evidence.map((item) => item.documentId)).toEqual(
      expect.arrayContaining(["doc-return", "doc-ledger"]),
    );
    expect(draft?.findingIds).toEqual([draftFindings[0]?.id, draftFindings[1]?.id]);
    expect(scheduleA?.content).toContain("| R-03 |");
    expect(scheduleB?.content).toContain(
      "| TDS claimed in the return less TDS per 26AS/AIS | 12,400 | Schedule A totals |",
    );
    expect(scheduleB?.content).toContain("| Per notice: Demand payable | 13,020 | Notice |");
    expect(scheduleA?.evidenceIds.length).toBe(3);
    expect(questions?.content).toContain("**High priority**");
    expect(questions?.content).toContain(
      "Confirm whether the response should request rectification",
    );
    expect(draftFindings.flatMap((finding) => finding.openQuestions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "low",
          text: expect.stringContaining("not-a-finding"),
        }),
      ]),
    );
  });

  it("detects sentences that claim a filing or submission", () => {
    expect(
      findFilingClaims(
        "The return was filed on 31 July 2024. We have submitted Form 16A. Kindly allow the credit.\nThis reply has been uploaded to the portal.\nWe hereby submit the reply.",
      ),
    ).toEqual([
      "We have submitted Form 16A.",
      "This reply has been uploaded to the portal.",
      "We hereby submit the reply.",
    ]);
    expect(findFilingClaims("The professional may file a rectification request.")).toEqual([]);
  });
});
