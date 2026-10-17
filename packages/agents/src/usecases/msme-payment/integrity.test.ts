import type { Finding } from "@evianta/core";
import { describe, expect, it } from "vitest";

import {
  csvPaymentDocumentAsync,
  MSME_DOCUMENT_IDS,
  reconcileMsmeFixtureAsync,
  textPaymentDocument,
} from "../../testing/msmePayment.js";
import { findEscalationClaims, paymentSummaryFinding } from "./casePreparation.js";
import {
  buildChronology,
  documentEventDateKey,
  documentFactsFromFindings,
  findMissingDocuments,
} from "./chronology.js";
import {
  dedupeEvidenceReferences,
  evidenceAnalysisMarkdown,
  type EvidenceAnalysisPrepared,
  type EvidenceAnalysisOutput,
} from "./evidenceAnalysis.js";
import { readPaymentRecords } from "./records.js";
import { hasPaymentData, reconcilePayments } from "./reconcile.js";
import { msmePaymentReviewChecks } from "./review.js";
import { creditTermsInDocuments, resolveCreditTerms } from "./terms.js";

describe("findEscalationClaims", () => {
  it("catches active-voice claims of sending, submitting, or filing", () => {
    const draft = [
      "We have sent this letter to the buyer.",
      "We have submitted the complaint.",
      "We filed a reference with the council.",
      "We sent reminders on 15 January 2025.",
      "The reminder was sent on 15 January 2025.",
    ].join(" ");

    expect(findEscalationClaims(draft)).toEqual([
      "We have sent this letter to the buyer.",
      "We have submitted the complaint.",
      "We filed a reference with the council.",
    ]);
  });
});

describe("facts without a source document", () => {
  const unsourced: Finding = {
    id: "f-unsourced",
    taskId: "task-documents",
    summary: "Delivery DC-509",
    severity: "info",
    confidence: "high",
    evidence: [],
    assumptions: [],
    openQuestions: [],
    dates: [
      {
        key: documentEventDateKey("delivery", ["INV-1005"], "DC-509"),
        label: "Goods delivered under DC-509 for INV-1005",
        date: "2025-01-07",
      },
    ],
  };

  it("are left out of the chronology and raised for verification", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const facts = documentFactsFromFindings([unsourced]);

    expect(buildChronology(reconciliation, facts).map((event) => event.kind)).not.toContain(
      "delivery",
    );
    expect(findMissingDocuments(reconciliation, facts).at(-1)).toMatchObject({
      severity: "low",
      questionSeverity: "medium",
      summary:
        '"Goods delivered under DC-509 for INV-1005" on 2025-01-07 was reported by the document analysis without a source document, so it is not used',
    });
  });
});

describe("evidence analysis", () => {
  it("keeps references on different worksheets distinct", () => {
    const base = { documentId: "doc-book", cellRange: "D2", description: "row" };

    expect(
      dedupeEvidenceReferences([
        { ...base, sheet: "Receipts 2024" },
        { ...base, sheet: "Receipts 2025" },
      ]),
    ).toHaveLength(2);
  });

  it("does not report an all-clear when the model reported its own gaps", () => {
    const prepared = {
      chronology: [],
      missingDocuments: [],
      inconsistencies: [],
    } as unknown as EvidenceAnalysisPrepared;
    const output: EvidenceAnalysisOutput = {
      findings: [
        {
          summary: "The agreement is not signed",
          severity: "medium",
          confidence: "medium",
          evidence: [],
          assumptions: [],
          openQuestions: [],
        },
      ],
      openQuestions: [],
      disputedItems: [],
    };

    expect(evidenceAnalysisMarkdown(prepared, output)).not.toContain("No missing documents");
  });
});

describe("balances and cutoffs", () => {
  it("keeps a balance smaller than the matching tolerance outstanding", async () => {
    const invoices = ["Invoice No,Invoice Date,Amount", "INV-1,2025-01-01,1000"].join("\n");
    const payments = [
      "Payment Date,UTR,Invoice Ref,Amount Received",
      "2025-01-10,UTR1,INV-1,999.75",
    ].join("\n");
    const reconciliation = await reconcileMsmeFixtureAsync(invoices, payments);

    expect(reconciliation.lines[0]).toMatchObject({ outstanding: 0.25, status: "partly-paid" });
    expect(reconciliation.totals.outstanding).toBe(0.25);
  });

  it("treats a register with only post-cutoff invoices as readable with nothing due", async () => {
    const invoices = ["Invoice No,Invoice Date,Amount", "INV-9,2025-06-01,5000"].join("\n");
    const documents = [
      await csvPaymentDocumentAsync(MSME_DOCUMENT_IDS.invoices, "invoices.csv", invoices),
    ];
    const reconciliation = reconcilePayments(
      readPaymentRecords(documents),
      resolveCreditTerms(documents),
      { asOfDate: "2025-03-31" },
    );
    const summary = paymentSummaryFinding(reconciliation);

    expect(hasPaymentData(reconciliation)).toBe(true);
    expect(reconciliation.laterInvoices.map((invoice) => invoice.invoiceNumber)).toEqual(["INV-9"]);
    expect(summary.figures?.[0]).toMatchObject({ key: "outstanding-total", value: 0 });
    expect(summary.evidence).toEqual([
      expect.objectContaining({ documentId: MSME_DOCUMENT_IDS.invoices, cellRange: "A1:C2" }),
    ]);
  });

  it("ignores a reminder deadline written as payment terms", () => {
    const reminder = textPaymentDocument("doc-letter", "reminder.pdf", [
      "Payment terms: 7 days from receipt of this letter.",
    ]);

    expect(creditTermsInDocuments([reminder])).toEqual([]);
  });
});

describe("review tolerance for quoted amounts", () => {
  it("uses the review tolerance, so a sign-reversed small balance is flagged", async () => {
    const invoices = ["Invoice No,Invoice Date,Amount", "INV-1,2025-01-01,1000"].join("\n");
    const payments = [
      "Payment Date,UTR,Invoice Ref,Amount Received",
      "2025-01-10,UTR1,INV-1,999.75",
    ].join("\n");
    const reconciliation = await reconcileMsmeFixtureAsync(invoices, payments);
    const section = (content: string) => ({
      taskId: "task-prep",
      taskTitle: "Prepare the case pack",
      role: "case-preparation" as const,
      deliverableId: "deliverable-primary",
      title: "Proposed follow-up draft",
      content,
    });
    const quotedIssues = (content: string) =>
      msmePaymentReviewChecks({
        reconciliation,
        computingTaskIds: new Set(),
        quotedSections: [section(content)],
      })
        .flatMap((check) => check([]))
        .filter((issue) => issue.check === "quoted-amount")
        .map((issue) => issue.key);

    expect(reconciliation.totals.outstanding).toBe(0.25);
    expect(quotedIssues("A balance of -Rs 0.25 remains.")).toEqual(["amount:-0.25"]);
    expect(quotedIssues("A balance of Rs 0.25 remains.")).toEqual([]);
  });
});
