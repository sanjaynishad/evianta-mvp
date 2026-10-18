import { describe, expect, it } from "vitest";

import { MSME_DOCUMENT_IDS, reconcileMsmeFixtureAsync } from "../../testing/msmePayment.js";
import {
  conditionLegalClaimsInSection,
  NO_PAYMENT_DATA_MESSAGE,
  paymentSummaryFinding,
  paymentSummaryMarkdown,
} from "./casePreparation.js";
import type { ChronologyEvent } from "./chronology.js";
import { chronologyFinding } from "./evidenceAnalysis.js";

const INVOICES = [
  "Invoice No,Invoice Date,Amount",
  "INV-1,2025-01-01,1000",
  "INV-2,2025-01-02,2000",
].join("\n");

describe("case pack summary", () => {
  it("states that the outstanding amount is unavailable rather than zero when no register is read", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync("Notes\nnothing here");
    const finding = paymentSummaryFinding(reconciliation);

    expect(reconciliation.lines).toEqual([]);
    expect(finding.figures).toBeUndefined();
    expect(finding.summary).toBe("Outstanding amount not computed: no readable invoice register");
    expect(finding.openQuestions).toEqual([{ text: NO_PAYMENT_DATA_MESSAGE, severity: "high" }]);
    expect(paymentSummaryMarkdown(reconciliation)).toBe(NO_PAYMENT_DATA_MESSAGE);
  });

  it("cites every reconciled invoice and payment, including settled ones", async () => {
    const payments = [
      "Payment Date,UTR,Invoice Ref,Amount Received",
      "2025-01-10,UTR1,INV-1,1000",
      "2025-01-11,UTR2,INV-2,2000",
    ].join("\n");
    const reconciliation = await reconcileMsmeFixtureAsync(INVOICES, payments);
    const finding = paymentSummaryFinding(reconciliation);

    expect(reconciliation.totals.outstanding).toBe(0);
    expect(finding.evidence?.map((item) => [item.documentId, item.cellRange])).toEqual([
      [MSME_DOCUMENT_IDS.invoices, "C2"],
      [MSME_DOCUMENT_IDS.payments, "D2"],
      [MSME_DOCUMENT_IDS.invoices, "C3"],
      [MSME_DOCUMENT_IDS.payments, "D3"],
    ]);
  });
});

describe("statutory-interest claim conditioning", () => {
  it("catches claims across p.a. abbreviations and soft line wraps", () => {
    const result = conditionLegalClaimsInSection({
      title: "Draft",
      content:
        "Statutory interest at 18.5% p.a. is payable.\nStatutory interest under the MSMED Act\nis payable at three times the bank rate.",
    });

    expect(result.changed).toBe(true);
    expect(
      result.section.content.match(/Any statutory interest remains subject to confirmation/g),
    ).toHaveLength(2);
    expect(result.section.content).not.toContain("18.5% p.a. is payable");
    expect(result.section.content).not.toContain("is payable at three times the bank rate");
  });

  it("preserves a principal demand when interest is already conditional", () => {
    const content =
      "The principal amount of Rs 1,000 is due; any statutory interest is subject to eligibility checks.";
    const result = conditionLegalClaimsInSection({ title: "Payment", content });

    expect(result.changed).toBe(false);
    expect(result.section.content).toBe(content);
  });

  it("conditions fallback section titles as well as content and reports the change", () => {
    const result = conditionLegalClaimsInSection({
      title: "Statutory interest is payable",
      content: "Please review the account and confirm the balance.",
    });

    expect(result.changed).toBe(true);
    expect(result.section.title).toContain(
      "Any statutory interest remains subject to confirmation",
    );
    expect(result.section.content).toBe("Please review the account and confirm the balance.");
  });
});

describe("chronologyFinding", () => {
  it("keeps the evidence of every event, however long the chronology", () => {
    const events: ChronologyEvent[] = Array.from({ length: 75 }, (_unused, index) => ({
      date: `2025-01-${String((index % 28) + 1).padStart(2, "0")}`,
      kind: "payment",
      title: `Payment ${index}`,
      source: "payments.csv",
      invoiceNumbers: [],
      dateKey: `payment-date:P${index}`,
      evidence: [
        { documentId: MSME_DOCUMENT_IDS.payments, cellRange: `D${index + 2}`, description: "row" },
      ],
    }));

    expect(chronologyFinding(events).evidence).toHaveLength(75);
  });
});
