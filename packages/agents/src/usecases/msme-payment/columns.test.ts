import type { Finding } from "@evianta/core";
import { describe, expect, it } from "vitest";

import { csvPaymentDocumentAsync, reconcileMsmeFixtureAsync } from "../../testing/msmePayment.js";
import { withoutRecordTables } from "./context.js";
import { readPaymentRecords, recordTableKeys } from "./records.js";
import { reconcilePayments } from "./reconcile.js";
import { resolveCreditTerms } from "./terms.js";

const INVOICES = [
  "Invoice No,Invoice Date,Amount",
  "A-1001,2025-01-01,1000",
  "B-1001,2025-01-02,1000",
].join("\n");

async function reconcileAsync(invoices: string, payments: string) {
  const documents = [
    await csvPaymentDocumentAsync("doc-i", "invoices.csv", invoices),
    await csvPaymentDocumentAsync("doc-p", "payments.csv", payments),
  ];
  const records = readPaymentRecords(documents);

  return {
    records,
    reconciliation: reconcilePayments(records, resolveCreditTerms(documents), {
      asOfDate: "2025-03-31",
    }),
  };
}

describe("payment table columns", () => {
  it("reads the received amount rather than the invoice amount in a payment table", async () => {
    const invoices = ["Invoice No,Invoice Date,Amount", "INV-1001,2025-01-01,100000"].join("\n");
    const payments = [
      "Payment Date,UTR,Invoice Ref,Invoice Amount,Paid Amount",
      "2025-02-01,UTR1,INV-1001,100000,40000",
    ].join("\n");
    const { records, reconciliation } = await reconcileAsync(invoices, payments);

    expect(records.payments[0]).toMatchObject({ amount: 40000, location: { cellRange: "E2" } });
    expect(reconciliation.lines[0]?.outstanding).toBe(60000);
  });

  it("does not take a transaction amount header as the payment reference", async () => {
    const invoices = ["Invoice No,Invoice Date,Amount", "INV-1001,2025-01-01,1000"].join("\n");
    const payments = [
      "Date,Transaction Amount,Transaction ID,Invoice Ref",
      "2025-02-01,400,TXN-9,INV-1001",
    ].join("\n");
    const documents = [
      await csvPaymentDocumentAsync("doc-i", "invoices.csv", invoices),
      await csvPaymentDocumentAsync("doc-p", "bank-payments.csv", payments),
    ];
    const records = readPaymentRecords(documents);

    expect(records.payments[0]).toMatchObject({ amount: 400, reference: "TXN-9" });
  });

  it("applies Tally receipts but never reads the mixed party ledger as payments", async () => {
    const invoices = [
      "Invoice No,Invoice Date,Due Date,Invoice Amount",
      "SHI/26-27/014,2026-04-18,2026-06-02,212400",
      "SHI/26-27/052,2026-06-06,2026-07-21,300000",
    ].join("\n");
    const receipts = [
      "Payment Date,Receipt No,UTR,Against Invoice,Amount Received,Narration",
      "2026-06-01,RCT/26-27/064,N152261127304,SHI/26-27/014,212400,NEFT from Apex Retail",
    ].join("\n");
    const ledger = [
      "Date,Particulars,Vch Type,Vch No,Debit,Credit,Balance,Narration",
      "2026-04-18,Sales GST 18%,Sales,SHI/26-27/014,212400,,212400,Supply against PO",
      "2026-06-01,Bank,Receipt,RCT/26-27/064,,212400,0,NEFT N152261127304 against SHI/26-27/014",
      "2026-10-15,Closing Balance,,,,,0,",
    ].join("\n");
    const documents = [
      await csvPaymentDocumentAsync("doc-i", "tally-outstanding-statement.csv", invoices),
      await csvPaymentDocumentAsync(
        "doc-r",
        "tally-receipts-statement-apex-retail-fy2026-27.csv",
        receipts,
      ),
      await csvPaymentDocumentAsync("doc-l", "tally-party-ledger-apex-retail.csv", ledger),
    ];
    const records = readPaymentRecords(documents);
    const reconciliation = reconcilePayments(records, resolveCreditTerms(documents), {
      asOfDate: "2026-10-15",
    });

    expect(records.payments).toHaveLength(1);
    expect(records.payments[0]).toMatchObject({
      amount: 212400,
      reference: "N152261127304",
      documentId: "doc-r",
    });
    expect(records.unclassified.map((table) => table.documentId)).toContain("doc-l");
    expect(
      reconciliation.lines.find((line) => line.invoice.invoiceNumber === "SHI/26-27/014")
        ?.outstanding,
    ).toBe(0);
  });
});

describe("narration references", () => {
  it("recognizes a complete register number written without a label", async () => {
    const payments = [
      "Payment Date,UTR,Amount Received,Narration",
      "2025-02-01,UTR1,1000,Paid against B-1001",
    ].join("\n");
    const { reconciliation } = await reconcileAsync(INVOICES, payments);

    expect(
      reconciliation.lines.map((line) => [line.invoice.invoiceNumber, line.outstanding]),
    ).toEqual([
      ["A-1001", 1000],
      ["B-1001", 0],
    ]);
    expect(reconciliation.lines[1]?.allocations[0]?.method).toBe("reference");
  });

  it("does not read a longer identifier as a register number", async () => {
    const payments = [
      "Payment Date,UTR,Amount Received,Narration",
      "2025-02-01,UTR1,1000,Paid against B-1001/24A",
    ].join("\n");
    const { records } = await reconcileAsync(INVOICES, payments);

    expect(records.payments[0]?.invoiceRefs).toEqual([]);
  });
});

describe("unapplied remainders", () => {
  it("reports the part of a reference-free receipt above the matched balance", async () => {
    const payments = ["Payment Date,UTR,Amount Received", "2025-02-01,UTR1,1000.25"].join("\n");
    const { reconciliation } = await reconcileAsync(INVOICES, payments);

    expect(reconciliation.totals.received).toBe(1000);
    expect(reconciliation.unallocated).toEqual([
      expect.objectContaining({
        amount: 0.25,
        reason: "it exceeds the open balance of A-1001 by this amount",
      }),
    ]);
  });
});

describe("record table filtering", () => {
  it("drops only the record tables of a workbook and keeps its other sheets", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const keys = recordTableKeys(reconciliation.records);
    const invoiceTable = reconciliation.records.tables[0];
    const input = withoutRecordTables(
      {
        documents: [
          {
            kind: "table",
            documentId: invoiceTable?.documentId ?? "",
            table: invoiceTable?.table.name,
          },
          { kind: "table", documentId: invoiceTable?.documentId ?? "", table: "Deliveries" },
          { kind: "page", documentId: "doc-agreement" },
        ],
      },
      keys,
    );

    expect(input.documents.map((slice) => slice.table ?? slice.kind)).toEqual([
      "Deliveries",
      "page",
    ]);
  });
});

describe("credit terms from the document analysis", () => {
  const figure = {
    key: "agreed-credit-days",
    label: "Agreed credit period",
    value: 30,
    unit: "days",
  };
  const finding = (evidence: Finding["evidence"]): Finding => ({
    id: "f-terms",
    taskId: "task-documents",
    summary: "Agreed credit period: 30 days",
    evidence,
    assumptions: [],
    openQuestions: [],
    figures: [figure],
  });

  it("are used only when a source document survives", () => {
    expect(resolveCreditTerms([], [finding([])]).terms).toBeUndefined();
    expect(
      resolveCreditTerms(
        [],
        [
          finding([
            {
              id: "ev-1",
              sourceRef: "po.pdf p.1",
              description: "Payment terms",
              documentId: "doc-po",
            },
          ]),
        ],
      ).terms?.creditDays,
    ).toBe(30);
  });
});
