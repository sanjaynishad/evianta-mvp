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

  it("keeps a classified invoice date when detailed extraction has no date", () => {
    const output = documentAnalysisOutputSchema.parse({
      findings: [],
      documents: [
        {
          documentId: "invoice-doc",
          kind: "invoice",
          reference: "INV_2025_001",
          date: "2025-01-10",
          parties: [],
        },
      ],
      paymentTerms: [],
      invoices: [
        {
          invoiceNumber: "INV_2025_001",
          amount: 1000,
          source: { documentId: "invoice-doc", page: 1 },
        },
      ],
      deliveries: [],
      correspondence: [],
    });

    const facts = documentFactsFromFindings(documentFindings(output, []));

    expect(facts.events.map(({ kind, date, label }) => [kind, date, label])).toEqual([
      ["invoice-copy", "2025-01-10", "Invoice INV_2025_001 dated"],
    ]);
  });

  it("does not suppress an unrelated document event from a structured fact in the same file", () => {
    const output = documentAnalysisOutputSchema.parse({
      findings: [],
      documents: [
        {
          documentId: "mixed-doc",
          kind: "agreement",
          reference: "AG-1",
          date: "2025-01-10",
          parties: [],
        },
      ],
      paymentTerms: [],
      invoices: [
        {
          invoiceNumber: "INV-1",
          date: "2025-01-10",
          amount: 1000,
          source: { documentId: "mixed-doc", page: 1 },
        },
      ],
      deliveries: [],
      correspondence: [],
    });

    const facts = documentFactsFromFindings(documentFindings(output, []));

    expect(facts.events.map(({ kind, label }) => [kind, label])).toEqual([
      ["agreement", "Agreement AG-1 entered into"],
      ["invoice-copy", "Invoice INV-1 copy dated"],
    ]);
  });

  it("does not duplicate a classified date when the same event is extracted in detail", () => {
    const output = documentAnalysisOutputSchema.parse({
      findings: [],
      documents: [
        {
          documentId: "invoice-doc",
          kind: "invoice",
          reference: "INV-1",
          date: "2025-01-10",
          parties: [],
        },
      ],
      paymentTerms: [],
      invoices: [
        {
          invoiceNumber: "INV-1",
          date: "2025-01-10",
          amount: 1000,
          source: { documentId: "invoice-doc", page: 1 },
        },
      ],
      deliveries: [],
      correspondence: [],
    });

    const facts = documentFactsFromFindings(documentFindings(output, []));

    expect(facts.events.map(({ kind, date }) => [kind, date])).toEqual([
      ["invoice-copy", "2025-01-10"],
    ]);
  });
});
