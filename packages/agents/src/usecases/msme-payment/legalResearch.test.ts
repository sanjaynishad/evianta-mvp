import { VERIFY_AGAINST_CURRENT_LAW } from "@evianta/ai";
import type { Citation } from "@evianta/core";
import { describe, expect, it } from "vitest";

import { MSME_CITATIONS } from "../../testing/msmePayment.js";
import { citationsForRoute, legalRouteFindings, legalRouteSchema } from "./legalResearch.js";

const citations = MSME_CITATIONS.map((citation) => ({ snippet: "", ...citation })) as Citation[];

const route = (input: Parameters<typeof legalRouteSchema.parse>[0]) =>
  legalRouteSchema.parse(input);

describe("citationsForRoute", () => {
  it("prefers exact source URLs", () => {
    const supported = citationsForRoute(
      route({
        name: "Buyer's liability",
        reference: "MSMED Act, 2006, section 15",
        summary: "s",
        sourceUrls: ["https://msme-reference.example/msmed-act/section-15"],
      }),
      citations,
    );

    expect(supported.map((citation) => citation.url)).toEqual([
      "https://msme-reference.example/msmed-act/section-15",
    ]);
  });

  it("matches a redirect-style citation on the same site by section number only", () => {
    const supported = citationsForRoute(
      route({
        name: "Reference to the council",
        reference: "section 18",
        summary: "s",
        sourceUrls: ["https://msme-reference.example/msmed-act/overview"],
      }),
      citations,
    );
    const wrongSection = citationsForRoute(
      route({ name: "Interest", reference: "section 1", summary: "s", sourceUrls: [] }),
      citations,
    );

    expect(supported.map((citation) => citation.url)).toEqual([
      "https://msme-reference.example/msmed-act/section-18",
    ]);
    expect(wrongSection).toEqual([]);
  });

  it("matches named schemes on the cited site and never without a cited site", () => {
    expect(
      citationsForRoute(
        route({
          name: "MSME Samadhaan portal",
          summary: "s",
          sourceUrls: ["https://samadhaan-reference.example/home"],
        }),
        citations,
      ),
    ).toHaveLength(1);
    expect(
      citationsForRoute(route({ name: "MSME Samadhaan portal", summary: "s" }), citations),
    ).toEqual([]);
    expect(
      citationsForRoute(
        route({
          name: "Reference to the council",
          reference: "section 18",
          summary: "s",
          sourceUrls: ["https://other-law.example/act"],
        }),
        citations,
      ),
    ).toEqual([]);
    expect(citationsForRoute(route({ name: "Negotiation", summary: "s" }), citations)).toEqual([]);
  });
});

describe("legalRouteFindings", () => {
  it("flags unsourced statutory routes and accepts contractual routes that cite the documents", () => {
    const { findings } = legalRouteFindings(
      [
        route({ name: "Interest on delayed payments", reference: "section 16", summary: "s" }),
        route({
          name: "Notice under the dispute clause",
          kind: "contractual",
          reference: "clause 12",
          summary: "s",
          documentSources: [{ documentId: "doc-agreement", page: 1, quote: "Clause 12." }],
        }),
      ],
      citations,
    );

    expect(findings[0]).toMatchObject({
      summary: "Interest on delayed payments (section 16) (unverified)",
      openQuestions: [
        expect.objectContaining({
          severity: "high",
          text: expect.stringContaining(`${VERIFY_AGAINST_CURRENT_LAW}: "section 16"`),
        }),
      ],
    });
    expect(findings[1]).toMatchObject({
      summary: "Potential contractual route: Notice under the dispute clause (clause 12)",
      severity: "medium",
      evidence: [expect.objectContaining({ documentId: "doc-agreement", page: 1 })],
    });
  });
});
