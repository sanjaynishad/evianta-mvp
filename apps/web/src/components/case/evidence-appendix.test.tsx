import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getSampleStateForUseCase } from "@/fixtures";
import { buildEvidenceIndex } from "@/lib/evidence";
import { EvidenceAppendix } from "./evidence-appendix";

describe("EvidenceAppendix", () => {
  it("prints the address of web sources", () => {
    const state = getSampleStateForUseCase("tax-notice");
    const evidenceIndex = buildEvidenceIndex(state);
    const research = evidenceIndex.get("b-ev-research");
    expect(research).toBeDefined();

    render(
      <EvidenceAppendix
        evidenceNumbers={new Map([["b-ev-research", 1]])}
        evidenceIndex={evidenceIndex}
      />,
    );

    expect(screen.getByTestId("evidence-url")).toHaveTextContent(research!.evidence.sourceRef);
    expect(research!.evidence.sourceRef).toMatch(/^https?:\/\//);
  });
});
