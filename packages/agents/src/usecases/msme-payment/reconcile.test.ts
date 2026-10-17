import { describe, expect, it } from "vitest";

import {
  csvPaymentDocumentAsync as csvDocumentAsync,
  INVOICES_CSV,
  MSME_AS_OF_DATE,
  MSME_EXPECTED,
  msmeAgreementDocument,
  PAYMENTS_CSV,
  reconcileMsmeFixtureAsync as reconcileFixtureAsync,
  textPaymentDocument as textDocument,
} from "../../testing/msmePayment.js";
import { readPaymentRecords, resolveInvoiceKey } from "./records.js";
import { outstandingComponents, reconcilePayments } from "./reconcile.js";
import { creditTermsInDocuments, resolveCreditTerms } from "./terms.js";

const AGREEMENT = msmeAgreementDocument();

async function fixtureDocumentsAsync(invoices = INVOICES_CSV, payments = PAYMENTS_CSV) {
  return [
    AGREEMENT,
    await csvDocumentAsync("doc-invoices", "invoices.csv", invoices),
    await csvDocumentAsync("doc-payments", "payments.csv", payments),
  ];
}

describe("readPaymentRecords", () => {
  it("reads the invoice register and payment records with cell locations", async () => {
    const records = readPaymentRecords(await fixtureDocumentsAsync());

    expect(records.tables.map((table) => [table.documentName, table.kind, table.rowCount])).toEqual(
      [
        ["invoices.csv", "invoices", 5],
        ["payments.csv", "payments", 6],
      ],
    );
    expect(records.invoices[1]).toMatchObject({
      invoiceNumber: "INV-1002",
      key: "INV1002",
      invoiceDate: "2024-10-15",
      dueDate: "2024-12-14",
      amount: 150000,
      poRef: "PO-4471",
      location: { cellRange: "D3", rowRange: { start: 3, end: 3 } },
    });
    expect(records.payments[2]).toMatchObject({
      label: "UTR25012503",
      date: "2025-01-25",
      amount: 58000,
      invoiceRefs: [],
      location: { cellRange: "D4" },
    });
    expect(records.payments[5]?.invoiceRefs).toEqual(["INV-0999"]);
    expect(records.unreadable).toEqual([]);
  });

  it("finds invoice numbers in a narration and skips total rows", async () => {
    const payments = [
      "Date,Reference,Amount,Narration",
      "2024-12-20,CHQ-1,60000,Part payment against INV-1002",
      "2024-12-21,CHQ-2,1000,Balance payment against invoice 1001",
      "2024-12-22,CHQ-3,500,Total settlement",
      "Total,,61500,",
    ].join("\n");
    const records = readPaymentRecords(await fixtureDocumentsAsync(INVOICES_CSV, payments));

    expect(records.payments.map((payment) => [payment.label, payment.invoiceRefs])).toEqual([
      ["CHQ-1", ["INV-1002"]],
      ["CHQ-2", ["invoice 1001"]],
      ["CHQ-3", []],
    ]);
  });

  it("keeps written references to invoices that are not in the register", async () => {
    const payments = [
      "Payment Date,UTR,Invoice Ref,Amount Received,Narration",
      "2025-01-25,UTR1,,58000,Part payment against INV-0999",
      "2025-01-26,UTR2,INV-1002; INV-0998,50000,",
      "2025-01-27,UTR3,N/A,112000,",
    ].join("\n");
    const reconciliation = await reconcileFixtureAsync(INVOICES_CSV, payments);

    expect(reconciliation.unallocated.map((item) => [item.payment.label, item.reason])).toEqual([
      ["UTR1", "it references INV-0999, and INV-0999 is not in the invoice register"],
      [
        "UTR2",
        "it references INV-1002, INV-0998, and INV-0998 is not in the invoice register, so the split cannot be confirmed",
      ],
    ]);
    expect(
      reconciliation.lines.find((line) => line.invoice.invoiceNumber === "INV-1003")?.allocations,
    ).toEqual([expect.objectContaining({ method: "amount-match", amount: 112000 })]);
  });

  it("reports unreadable amounts instead of reading them as zero", async () => {
    const invoices = [
      "Invoice No,Invoice Date,Amount",
      "INV-1,2024-01-01,1000",
      "INV-2,2024-01-02,see note",
    ].join("\n");
    const records = readPaymentRecords([await csvDocumentAsync("doc-i", "invoices.csv", invoices)]);

    expect(records.invoices.map((invoice) => invoice.invoiceNumber)).toEqual(["INV-1"]);
    expect(records.unreadable).toEqual([
      expect.objectContaining({
        kind: "invoices",
        reason: "the amount of INV-2 is blank or unreadable",
      }),
    ]);
  });

  it("never reads a quantity total as the invoice amount", async () => {
    const invoices = [
      "Invoice No,Invoice Date,Total Quantity,Amount (INR)",
      "INV-1,2024-01-01,300,100000",
    ].join("\n");
    const records = readPaymentRecords([await csvDocumentAsync("doc-i", "invoices.csv", invoices)]);

    expect(records.invoices[0]).toMatchObject({ amount: 100000, location: { cellRange: "D2" } });
  });

  it("reports a register with several possible amount columns instead of guessing", async () => {
    const invoices = [
      "Invoice No,Invoice Date,Taxable Value,GST Amount",
      "INV-1,2024-01-01,100000,18000",
    ].join("\n");
    const records = readPaymentRecords([await csvDocumentAsync("doc-i", "invoices.csv", invoices)]);

    expect(records.invoices).toEqual([]);
    expect(records.unclassified).toEqual([
      expect.objectContaining({
        recordKind: "invoices",
        reason:
          "several columns could hold the amount (Taxable Value, GST Amount) and none is clearly the one to use",
      }),
    ]);
  });

  it("counts a receipt recorded in two sources once and keeps split allocations", async () => {
    const bank = [
      "Payment Date,UTR,Invoice Ref,Amount Received",
      "2025-01-10,UTR77,INV-1001,40000",
      "2025-01-12,UTR78,INV-1002,30000",
      "2025-01-12,UTR78,INV-1003,30000",
      "2025-01-20,,INV-1004,1000",
      "2025-01-20,,INV-1004,1000",
    ].join("\n");
    const ledger = [
      "Payment Date,UTR,Invoice Ref,Amount Received",
      "2025-01-10,UTR77,INV-1001,40000",
    ].join("\n");
    const documents = [
      await csvDocumentAsync("doc-invoices", "invoices.csv", INVOICES_CSV),
      await csvDocumentAsync("doc-bank", "bank-payments.csv", bank),
      await csvDocumentAsync("doc-ledger", "receipts-payments.csv", ledger),
    ];
    const records = readPaymentRecords(documents);
    const reconciliation = reconcilePayments(records, resolveCreditTerms(documents), {
      asOfDate: "2025-03-31",
    });

    expect(records.payments.map((payment) => payment.label)).toEqual([
      "UTR77",
      "UTR78",
      "UTR78",
      "bank-payments.csv row 5",
      "bank-payments.csv row 6",
    ]);
    expect(
      records.duplicatePayments.map((repeat) => [
        repeat.payment.documentId,
        repeat.payment.label,
        repeat.countedOnce,
      ]),
    ).toEqual([
      ["doc-bank", "bank-payments.csv row 6", false],
      ["doc-ledger", "UTR77", true],
    ]);
    expect(
      reconciliation.lines.find((line) => line.invoice.invoiceNumber === "INV-1001")?.outstanding,
    ).toBe(60000);
  });
});

describe("resolveInvoiceKey", () => {
  const keys = new Set(["INV1001", "INV1002"]);

  it("resolves descriptive labels and bare numbers but keeps series prefixes", () => {
    expect(resolveInvoiceKey("INV-1001", keys)).toBe("INV1001");
    expect(resolveInvoiceKey("Invoice INV-1001", keys)).toBe("INV1001");
    expect(resolveInvoiceKey("Invoice 1001", keys)).toBe("INV1001");
    expect(resolveInvoiceKey("Bill no. 1002", keys)).toBe("INV1002");
    expect(resolveInvoiceKey("1002", keys)).toBe("INV1002");
    expect(resolveInvoiceKey("OLD-1001", keys)).toBeUndefined();
  });
});

describe("credit terms", () => {
  it("reads the agreed credit period verbatim from a page", () => {
    expect(creditTermsInDocuments([AGREEMENT])).toEqual([
      expect.objectContaining({
        creditDays: 60,
        basis: "invoice",
        page: 1,
        quote: "Payment: The Buyer shall pay each invoice within 60 days of the date of invoice.",
      }),
    ]);
  });

  it("ignores deadlines set by a letter", () => {
    const letter = textDocument("doc-letter", "reminder.pdf", [
      "Please pay the balance within 15 days of receipt of this letter.",
    ]);

    expect(creditTermsInDocuments([letter])).toEqual([]);
  });

  it("reports conflicting credit periods and chooses none", () => {
    const order = textDocument("doc-po", "po.pdf", [
      "Payment terms: 30 days from the date of invoice",
    ]);
    const resolution = resolveCreditTerms([AGREEMENT, order]);

    expect(resolution.terms).toBeUndefined();
    expect(resolution.conflicts.map((conflict) => conflict.creditDays)).toEqual([60, 30]);
  });

  it("reads every credit clause on a page so conflicts on one page are caught", () => {
    const order = textDocument("doc-po", "po.pdf", [
      "Payment terms: 30 days from the date of invoice\nRevised payment terms: 60 days from the date of invoice",
    ]);

    expect(resolveCreditTerms([order]).conflicts.map((conflict) => conflict.creditDays)).toEqual([
      30, 60,
    ]);
  });
});

describe("reconcilePayments", () => {
  it("leaves invoices dated after the as-of date out of the totals", async () => {
    const reconciliation = await reconcileFixtureAsync(INVOICES_CSV, PAYMENTS_CSV, "2025-01-01");

    expect(reconciliation.laterInvoices.map((invoice) => invoice.invoiceNumber)).toEqual([
      "INV-1005",
    ]);
    expect(reconciliation.lines.map((line) => line.invoice.invoiceNumber)).not.toContain(
      "INV-1005",
    );
    expect(reconciliation.totals.invoiced).toBe(420000);
  });

  it("computes the exact outstanding amount with seeded partial payments", async () => {
    const reconciliation = await reconcileFixtureAsync();
    const byInvoice = Object.fromEntries(
      reconciliation.lines.map((line) => [line.invoice.invoiceNumber, line.outstanding]),
    );

    expect(byInvoice).toEqual(MSME_EXPECTED.byInvoice);
    expect(reconciliation.totals).toEqual({
      invoiced: MSME_EXPECTED.invoiced,
      received: MSME_EXPECTED.received,
      outstanding: MSME_EXPECTED.outstanding,
      overdue: MSME_EXPECTED.outstanding,
      unallocated: MSME_EXPECTED.unallocated,
    });

    const inv1002 = reconciliation.lines.find((line) => line.invoice.invoiceNumber === "INV-1002");

    expect(inv1002).toMatchObject({ status: "partly-paid", paid: 100000, outstanding: 50000 });
    expect(
      inv1002?.allocations.map((item) => [item.payment.label, item.amount, item.method]),
    ).toEqual([
      ["UTR24122002", 60000, "reference"],
      ["UTR25021004", 40000, "reference"],
    ]);
    expect(outstandingComponents(inv1002!)).toEqual([
      { label: "INV-1002 invoice amount", value: 150000 },
      { label: "UTR24122002 on 2024-12-20", value: -60000 },
      { label: "UTR25021004 on 2025-02-10", value: -40000 },
    ]);
  });

  it("matches a payment without a reference by its amount and flags it as inferred", async () => {
    const reconciliation = await reconcileFixtureAsync();
    const inv1004 = reconciliation.lines.find((line) => line.invoice.invoiceNumber === "INV-1004");

    expect(inv1004).toMatchObject({ status: "paid", outstanding: 0, inferred: true });
    expect(inv1004?.allocations[0]).toMatchObject({ method: "amount-match", amount: 58000 });
  });

  it("never deducts a payment for an invoice that is not in the register", async () => {
    const reconciliation = await reconcileFixtureAsync();

    expect(reconciliation.unallocated).toEqual([
      expect.objectContaining({
        amount: 5000,
        reason: "it references INV-0999, and INV-0999 is not in the invoice register",
      }),
    ]);
  });

  it("counts days overdue from the agreed terms and states the 45-day figure only as an assumption", async () => {
    const reconciliation = await reconcileFixtureAsync();
    const days = Object.fromEntries(
      reconciliation.lines
        .filter((line) => line.outstanding > 0)
        .map((line) => [
          line.invoice.invoiceNumber,
          [
            line.dueDate,
            line.daysOverdue,
            line.statutoryReferenceDate,
            line.daysBeyondStatutoryReference,
          ],
        ]),
    );

    expect(reconciliation.terms?.creditDays).toBe(60);
    expect(days).toEqual({
      "INV-1002": ["2024-12-14", 107, "2024-11-29", 122],
      "INV-1003": ["2025-01-09", 81, "2024-12-25", 96],
      "INV-1005": ["2025-03-09", 22, "2025-02-22", 37],
    });
    expect(
      reconciliation.lines.find((line) => line.invoice.invoiceNumber === "INV-1001"),
    ).toMatchObject({ settledOn: "2024-11-18", daysPaidLate: 0 });
  });

  it("keeps an overpayment and a payment after the as-of date out of the totals", async () => {
    const payments = [
      "Payment Date,UTR,Invoice Ref,Amount Received",
      "2024-11-18,UTR1,INV-1001,120000",
      "2025-04-02,UTR2,INV-1002,150000",
    ].join("\n");
    const reconciliation = await reconcileFixtureAsync(INVOICES_CSV, payments);

    expect(reconciliation.totals.received).toBe(100000);
    expect(reconciliation.unallocated.map((item) => [item.payment.label, item.amount])).toEqual([
      ["UTR1", 20000],
      ["UTR2", 150000],
    ]);
    expect(reconciliation.totals.outstanding).toBe(395000);
  });

  it("uses the register due dates when no credit period is found", async () => {
    const documents = [
      await csvDocumentAsync("doc-invoices", "invoices.csv", INVOICES_CSV),
      await csvDocumentAsync("doc-payments", "payments.csv", PAYMENTS_CSV),
    ];
    const reconciliation = reconcilePayments(
      readPaymentRecords(documents),
      resolveCreditTerms(documents),
      {
        asOfDate: MSME_AS_OF_DATE,
      },
    );
    const inv1002 = reconciliation.lines.find((line) => line.invoice.invoiceNumber === "INV-1002");

    expect(reconciliation.terms).toBeUndefined();
    expect(inv1002).toMatchObject({
      dueDate: "2024-12-14",
      dueDateBasis: "register",
      daysOverdue: 107,
    });
    expect(inv1002?.statutoryReferenceDate).toBeUndefined();
  });

  it("matches equal open balances to the oldest invoice", async () => {
    const invoices = [
      "Invoice No,Invoice Date,Amount",
      "INV-A,2024-01-10,1000",
      "INV-B,2024-01-05,1000",
    ].join("\n");
    const payments = ["Payment Date,UTR,Amount Received", "2024-02-01,UTR9,1000"].join("\n");
    const reconciliation = await reconcileFixtureAsync(invoices, payments);

    expect(
      reconciliation.lines.map((line) => [line.invoice.invoiceNumber, line.outstanding]),
    ).toEqual([
      ["INV-B", 0],
      ["INV-A", 1000],
    ]);
    expect(reconciliation.lines[0]?.allocations[0]?.method).toBe("date-order");
  });
});
