import { describe, expect, it } from "vitest";

import { documentAnalysisOutputSchema, documentFindings } from "./documentAnalysis.js";
import { documentFactsFromFindings } from "./chronology.js";

describe("document-analysis chronology facts", () => {
  it("keeps source-backed delivery and correspondence dates when detailed extraction is absent", () => {
    const output = documentAnalysisOutputSchema.parse({
      findings: [],
      documents: [
        {
          documentId: "delivery-doc",
          kind: "delivery-record",
          reference: "GRN-12",
          date: "2025-01-10",
          parties: [],
          source: { documentId: "delivery-doc", page: 1, quote: "Goods accepted on 10 Jan." },
        },
        {
          documentId: "email-doc",
          kind: "correspondence",
          date: "2025-01-15",
          parties: [],
          source: { documentId: "email-doc", page: 1, quote: "Payment will follow." },
        },
      ],
      paymentTerms: [],
      invoices: [],
      deliveries: [],
      correspondence: [],
    });

    const facts = documentFactsFromFindings(documentFindings(output, []));

    expect(
      facts.events.map(({ kind, date, evidence }) => [kind, date, evidence[0]?.documentId]),
    ).toEqual([
      ["delivery", "2025-01-10", "delivery-doc"],
      ["correspondence", "2025-01-15", "email-doc"],
    ]);
  });
});
