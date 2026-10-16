import { VERIFY_AGAINST_CURRENT_LAW } from "@evianta/ai";
import { describe, expect, it } from "vitest";

import {
  CITATIONS,
  createTaxNoticeHarnessAsync,
  taxResearchStep,
} from "../../testing/taxNotice.js";
import { citationsForProvision } from "./research.js";

const citations = CITATIONS.map((citation) => ({ snippet: "", ...citation }));

describe("tax-research handler", () => {
  it("links provisions to grounding citations and flags the unsupported ones", async () => {
    const { orchestrator, mock, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "research", role: "tax-research" }],
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings, deliverables } = await readAsync();
    const call = mock.calls.find((item) => item.key === "tax-research");
    const [section143, section199, rule37ba] = findings;
    const [section] = deliverables[0]?.sections ?? [];

    expect(call).toMatchObject({ tier: "mid", grounding: true });
    expect(call?.prompt).not.toContain("PF-04");
    expect(section143).toMatchObject({
      summary: "Section 143(1)(a): Adjustments while processing the return",
      severity: "medium",
      evidence: [
        expect.objectContaining({
          sourceRef: "https://tax-reference.example/act/section-143",
          excerpt: CITATIONS[0]?.snippet,
        }),
      ],
      assumptions: [expect.stringContaining(VERIFY_AGAINST_CURRENT_LAW)],
    });
    expect(section199?.evidence.map((item) => item.sourceRef)).toEqual([
      "https://tax-reference.example/act/section-199",
    ]);
    expect(rule37ba).toMatchObject({
      summary: "Rule 37BA: Credit for tax deducted at source (unverified)",
      severity: "low",
      confidence: "low",
      evidence: [],
      openQuestions: [
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining(`${VERIFY_AGAINST_CURRENT_LAW}: "Rule 37BA"`),
        }),
      ],
    });
    expect(section?.title).toBe("Research: potentially applicable provisions");
    expect(section?.content).toContain(
      "**Section 143(1)(a): Adjustments while processing the return** [1]",
    );
    expect(section?.content).toContain("(verify against current law: no cited source)");
    expect(section?.content).toContain(
      "2. Section 199: credit for tax deducted (synthetic): https://tax-reference.example/act/section-199",
    );
    expect(section?.findingIds).toEqual([section143?.id, section199?.id, rule37ba?.id]);
  });

  it("flags everything for verification when grounding returned no citations", async () => {
    const step = taxResearchStep();
    const { orchestrator, caseRecord, readAsync } = await createTaxNoticeHarnessAsync({
      tasks: [{ id: "research", role: "tax-research" }],
      script: { "tax-research": { ...step, citations: [] } },
    });

    await orchestrator.runCaseAsync(caseRecord.id);

    const { findings } = await readAsync();
    const questions = findings.flatMap((finding) => finding.openQuestions);

    expect(findings.slice(0, 3).every((finding) => finding.evidence.length === 0)).toBe(true);
    expect(
      questions.filter((question) => question.text.startsWith(VERIFY_AGAINST_CURRENT_LAW)),
    ).toHaveLength(4);
    expect(questions.at(-1)?.text).toContain("the research returned no cited sources");
  });

  it("matches citations by exact URL, then site and section, never by guesswork", () => {
    const provision = (reference: string, sourceUrls: string[]) => ({
      reference,
      summary: "Summary",
      sourceUrls,
    });

    expect(
      citationsForProvision(provision("Section 199", [citations[1]!.url]), citations).map(
        (item) => item.url,
      ),
    ).toEqual([citations[1]?.url]);
    expect(
      citationsForProvision(
        provision("Section 199", ["https://tax-reference.example/x"]),
        citations,
      ).map((item) => item.url),
    ).toEqual([citations[1]?.url]);
    expect(
      citationsForProvision(provision("Section 143(1)(a)", []), citations).map((item) => item.url),
    ).toEqual([citations[0]?.url]);
    expect(
      citationsForProvision(provision("Section 80C", ["https://other.example/80c"]), citations),
    ).toEqual([]);
  });
});
