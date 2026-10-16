import { describe, expect, it } from "vitest";

import { createSpecialistAgent } from "../../agents/specialist.js";
import { createAgentRegistry } from "../../registry.js";
import { createTaxNoticeHarnessAsync, DOCUMENT_IDS } from "../../testing/taxNotice.js";
import { reconciliationLineFigureKey, TAX_FIGURE_KEYS } from "./constants.js";

describe("reconciliation handler", () => {
  it("reconciles deterministically and asks the model only to explain the differences", async () => {
    const { orchestrator, mock, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "rec", role: "reconciliation" }],
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings, evidence, deliverables } = await readAsync();
    const call = mock.calls.find((item) => item.key === "reconciliation");
    const [mismatch, matched, totals] = findings;
    const [table, notes] = deliverables[0]?.sections ?? [];

    expect(call?.tier).toBe("mid");
    expect(call?.prompt).toContain('"discrepancies"');
    expect(call?.prompt).toContain('"ref": "R-03"');
    expect(call?.prompt).not.toContain("PF-04");
    expect(mismatch).toMatchObject({
      summary:
        "[R-03] TDS mismatch for Sunrise Consulting Pvt Ltd (DELS20002B), FY 2023-24: Return Rs 50,000 vs Ledger Rs 50,000 vs 26AS/AIS Rs 37,600",
      severity: "high",
      confidence: "high",
      figures: [
        {
          key: reconciliationLineFigureKey("R-03"),
          label: "R-03 TDS difference",
          value: 12400,
          unit: "INR",
          components: [
            { label: "TDS per Return", value: 50000 },
            { label: "TDS per 26AS/AIS", value: -37600 },
          ],
        },
      ],
      openQuestions: [
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining(
            "R-03: Ask Sunrise Consulting to file a correction statement",
          ),
        }),
      ],
    });
    expect(mismatch?.detail).toContain("Likely cause: The deductor has not reported");
    expect(mismatch?.evidence).toHaveLength(8);
    expect(mismatch?.evidence.map((item) => item.documentId)).toEqual(
      expect.arrayContaining([
        DOCUMENT_IDS.returnComputation,
        DOCUMENT_IDS.ledger,
        DOCUMENT_IDS.taxCredit,
      ]),
    );
    expect(
      mismatch?.evidence.find((item) => item.documentId === DOCUMENT_IDS.ledger),
    ).toMatchObject({
      location: {
        cellRange: "E4",
        rowRange: { start: 4, end: 4 },
        textQuote: "2023-06-30 | Sunrise Consulting Pvt Ltd | 194J | 125000 | 12500 | PF-01",
      },
      confidence: "high",
    });
    expect(matched?.summary).toBe("2 item(s) agree across Return, Ledger, 26AS/AIS within Rs 1");
    expect(matched?.evidence.length).toBeGreaterThan(0);
    expect(totals?.figures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: TAX_FIGURE_KEYS.tdsClaimedInReturn, value: 141000 }),
        expect.objectContaining({ key: TAX_FIGURE_KEYS.tdsPerTaxCredit, value: 128600 }),
        expect.objectContaining({
          key: TAX_FIGURE_KEYS.tdsDifference,
          value: 12400,
          components: [
            { label: "TDS per return", value: 141000 },
            { label: "TDS per 26AS/AIS", value: -128600 },
          ],
        }),
      ]),
    );
    expect(totals?.evidence.map((item) => item.location?.cellRange)).toEqual([
      "A1:G10",
      "A1:F11",
      "A1:F4",
    ]);
    expect(table).toMatchObject({ kind: "table", producedByRole: "reconciliation" });
    expect(table?.findingIds).toEqual([mismatch?.id, matched?.id, totals?.id]);
    expect(table?.evidenceIds).toHaveLength(
      new Set(
        [
          ...(mismatch?.evidence ?? []),
          ...(matched?.evidence ?? []),
          ...(totals?.evidence ?? []),
        ].map((item) => item.id),
      ).size,
    );
    expect(notes?.findingIds).toEqual([mismatch?.id, totals?.id]);
    expect(notes?.content).toContain("Sunrise Consulting differs by one quarter");
    expect(evidence.length).toBeGreaterThan(10);
  });

  it("uses an agent registered for the role at run time", async () => {
    const agents = createAgentRegistry().register(
      createSpecialistAgent("reconciliation", {
        modelTier: "cheap",
        systemPrompt: "Custom reconciliation prompt.",
      }),
    );
    const { orchestrator, mock, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "rec", role: "reconciliation" }],
      orchestrator: { agents },
      script: { reconciliation: { output: { findings: [], openQuestions: [] } } },
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings } = await readAsync();
    const call = mock.calls.find((item) => item.key === "reconciliation");

    expect(call).toMatchObject({ tier: "cheap", system: "Custom reconciliation prompt." });
    expect(findings[0]?.summary.startsWith("[R-03]")).toBe(true);
    expect(findings[0]?.detail).toContain("No explanation was produced");
  });

  it("flags a missing source and still reconciles the others", async () => {
    const { orchestrator, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "rec", role: "reconciliation" }],
      uploads: { ledger: false },
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings } = await readAsync();
    const questions = findings.flatMap((finding) => finding.openQuestions);

    expect(findings[0]?.summary).toBe(
      "[R-03] TDS mismatch for Sunrise Consulting Pvt Ltd (DELS20002B), FY 2023-24: Return Rs 50,000 vs 26AS/AIS Rs 37,600",
    );
    expect(questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "medium",
          text: expect.stringContaining("No Ledger records"),
        }),
      ]),
    );
  });

  it("passes the model output through when no structured records were uploaded", async () => {
    const { orchestrator, caseRecord, readAsync, mock } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "rec", role: "reconciliation" }],
      uploads: { taxCredit: false, ledger: false, returnComputation: false },
      script: {
        reconciliation: {
          output: {
            findings: [],
            openQuestions: [{ text: "Upload Form 26AS and the ledger.", severity: "high" }],
          },
        },
      },
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings } = await readAsync();

    expect(mock.calls.find((item) => item.key === "reconciliation")?.prompt).not.toContain(
      '"discrepancies"',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.openQuestions[0]?.text).toBe("Upload Form 26AS and the ledger.");
  });
});
