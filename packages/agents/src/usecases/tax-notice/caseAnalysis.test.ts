import { describe, expect, it } from "vitest";

import {
  caseAnalysisStep,
  createTaxNoticeHarnessAsync,
  DOCUMENT_IDS,
} from "../../testing/taxNotice.js";
import { TAX_DATE_KEYS, TAX_NOTICE_GUARDRAIL } from "./constants.js";
import { canonicalDateKey } from "./caseAnalysis.js";

describe("case-analysis handler", () => {
  it("extracts the notice with page references and flags the low-confidence OCR page", async () => {
    const { orchestrator, mock, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "analyze", role: "case-analysis" }],
    });

    const result = await orchestrator.runCaseAsync(caseRecord.id);
    const { findings, deliverables } = await readAsync();
    const call = mock.calls.find((item) => item.key === "case-analysis");
    const overview = findings.find((finding) => finding.summary.startsWith("Intimation"));
    const figures = findings.find((finding) => finding.summary === "Figures stated in the notice");
    const lowConfidence = findings.find((finding) => finding.summary.includes("low confidence"));
    const [section] = deliverables[0]?.sections ?? [];

    expect(result.status).toBe("completed");
    expect(call?.tier).toBe("cheap");
    expect(call?.prompt).toContain("Response due by: 2025-02-14");
    expect(call?.prompt).toContain('"lowConfidencePages"');
    expect(call?.prompt).not.toContain("PF-04");
    expect(overview).toMatchObject({
      summary: "Intimation under section 143(1) for assessment year 2024-25",
      severity: "medium",
      dates: [
        { key: TAX_DATE_KEYS.issueDate, label: "Date of issue", date: "2025-01-15" },
        { key: TAX_DATE_KEYS.responseDueDate, label: "Response due by", date: "2025-02-14" },
      ],
    });
    expect(overview?.evidence.map((item) => item.location?.textQuote)).toEqual(
      expect.arrayContaining(["DIN: SYN/CPC/2025/000001", "Assessment Year: 2024-25"]),
    );
    expect(
      overview?.evidence.find((item) => item.location?.textQuote?.startsWith("Date of issue")),
    ).toMatchObject({
      documentId: DOCUMENT_IDS.notice,
      sourceRef: "notice-143-1.pdf p.1",
      location: { page: 1, textQuote: "Date of issue: 2025-01-15" },
    });
    expect(figures?.figures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "tds-difference", value: 12400, unit: "INR" }),
        expect.objectContaining({
          key: "demand-total",
          value: 13020,
          components: [
            { label: "TDS credit disallowed", value: 12400 },
            { label: "Interest", value: 620 },
          ],
        }),
      ]),
    );
    expect(findings.map((finding) => finding.summary)).toEqual(
      expect.arrayContaining([
        "TDS credit restricted to Form 26AS",
        "Information requested by the notice",
      ]),
    );
    expect(lowConfidence).toMatchObject({
      confidence: "low",
      evidence: [expect.objectContaining({ location: { page: 2 }, confidence: "medium" })],
      openQuestions: [
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining("page 2 was read by OCR at 68% confidence"),
        }),
      ],
    });
    expect(section).toMatchObject({ title: "Notice analysis", kind: "text" });
    expect(section?.content).toContain("**Assessment year:** 2024-25");
    expect(section?.content).toContain("| Demand payable | 13,020 | p.1 |");
    expect(section?.content).toContain("notice-143-1.pdf p.2: ocr, 68% confidence");
    expect(section?.findingIds).toHaveLength(findings.length);
    expect(deliverables[0]?.content).toBe(TAX_NOTICE_GUARDRAIL);
  });

  it("traces the notice identity to its pages and flags identity it cannot trace", async () => {
    const step = caseAnalysisStep() as { output: { notice: Record<string, unknown> } };
    const { orchestrator, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "analyze", role: "case-analysis" }],
      script: {
        "case-analysis": {
          output: {
            notice: {
              ...step.output.notice,
              assessmentYearSource: {
                documentId: DOCUMENT_IDS.notice,
                page: 2,
                quote: "AY 2024-25",
              },
              referenceNumberSource: undefined,
            },
          },
        },
      },
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings } = await readAsync();
    const overview = findings.find((finding) => finding.summary.startsWith("Intimation"));

    expect(overview?.confidence).toBe("low");
    expect(overview?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "Assessment year",
          location: { page: 2, textQuote: "AY 2024-25" },
        }),
        expect.objectContaining({ description: "Notice type" }),
      ]),
    );
    expect(findings.flatMap((finding) => finding.openQuestions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "medium",
          text: expect.stringContaining(
            "These items could not be traced to a page and quote of the notice: Reference number.",
          ),
        }),
      ]),
    );
  });

  it("flags each untraced date and amount and keeps untraced amounts out of sourced evidence", async () => {
    const step = caseAnalysisStep() as {
      output: {
        notice: {
          dates: Array<Record<string, unknown>>;
          demandedFigures: Array<Record<string, unknown>>;
        };
      };
    };
    const { notice } = step.output;
    const { orchestrator, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "analyze", role: "case-analysis" }],
      script: {
        "case-analysis": {
          output: {
            notice: {
              ...notice,
              dates: notice.dates.map((entry) =>
                entry.key === "due" ? { ...entry, source: undefined } : entry,
              ),
              demandedFigures: notice.demandedFigures.map((figure) =>
                figure.key === "demand-interest"
                  ? { ...figure, source: { documentId: DOCUMENT_IDS.notice, page: 1 } }
                  : figure,
              ),
            },
          },
        },
      },
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings } = await readAsync();
    const overview = findings.find((finding) => finding.summary.startsWith("Intimation"));
    const traced = findings.find((finding) => finding.summary === "Figures stated in the notice");
    const untraced = findings.find((finding) =>
      finding.summary.startsWith("Figures stated in the notice that could not be traced"),
    );

    expect(overview?.confidence).toBe("medium");
    expect(traced?.figures?.map((figure) => figure.key)).not.toContain("demand-interest");
    expect(untraced).toMatchObject({
      severity: "high",
      confidence: "low",
      evidence: [],
      figures: [expect.objectContaining({ key: "demand-interest", value: 620 })],
    });
    expect(findings.flatMap((finding) => finding.openQuestions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining(
            "Response due by (2025-02-14); Interest under sections 234B and 234C (Rs 620)",
          ),
        }),
      ]),
    );
  });
  it("raises a high-severity question when no due date is found", async () => {
    const { orchestrator, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "analyze", role: "case-analysis" }],
      script: {
        "case-analysis": {
          output: { notice: { noticeType: "Notice under section 142(1)", dates: [] } },
        },
      },
      uploads: { taxCredit: false, ledger: false, returnComputation: false },
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings } = await readAsync();

    expect(findings.flatMap((finding) => finding.openQuestions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining("No response due date"),
        }),
      ]),
    );
  });

  it("keeps generic findings when the model returns no structured notice", async () => {
    const { orchestrator, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "analyze", role: "case-analysis" }],
      script: {
        "case-analysis": {
          output: {
            findings: [
              { summary: "Notice text is partly illegible", severity: "low", confidence: "low" },
            ],
          },
        },
      },
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings } = await readAsync();

    expect(findings.map((finding) => finding.summary)).toEqual([
      "Notice text is partly illegible",
      "1 page(s) were transcribed with low confidence and need verification",
    ]);
  });

  it("maps model date keys to the shared keys", () => {
    expect(canonicalDateKey({ key: "due", label: "Reply by" })).toBe(TAX_DATE_KEYS.responseDueDate);
    expect(canonicalDateKey({ key: "date-of-notice", label: "Dated" })).toBe(
      TAX_DATE_KEYS.issueDate,
    );
    expect(canonicalDateKey({ key: "hearing", label: "Hearing date" })).toBe("hearing");
  });
});
