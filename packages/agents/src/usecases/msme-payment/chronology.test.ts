import type { Finding } from "@evianta/core";
import { describe, expect, it } from "vitest";

import {
  INVOICES_CSV,
  MSME_DOCUMENT_IDS,
  PAYMENTS_CSV,
  reconcileMsmeFixtureAsync,
} from "../../testing/msmePayment.js";
import {
  buildChronology,
  chronologyTimelineText,
  documentEventDateKey,
  documentFactsFromFindings,
  findInconsistencies,
  findMissingDocuments,
  parseDocumentEventKey,
} from "./chronology.js";
import { statedInvoiceAmountFigureKey } from "./constants.js";

function documentFinding(
  id: string,
  documentId: string,
  page: number,
  dates: Finding["dates"],
  extra: Partial<Finding> = {},
): Finding {
  return {
    id,
    taskId: "task-documents",
    summary: `Finding ${id}`,
    severity: "info",
    confidence: "high",
    evidence: [
      {
        id: `ev-${id}`,
        sourceRef: `${documentId}.pdf p.${page}`,
        description: `Source of ${id}`,
        documentId,
        location: { page },
      },
    ],
    assumptions: [],
    openQuestions: [],
    dates,
    ...extra,
  };
}

const DOCUMENT_FINDINGS: Finding[] = [
  documentFinding("f-po", MSME_DOCUMENT_IDS.purchaseOrder, 1, [
    {
      key: documentEventDateKey("purchase-order", [], "PO-4471"),
      label: "Purchase order PO-4471 issued",
      date: "2024-09-02",
    },
  ]),
  ...[
    ["DC-501", "2024-09-18", "INV-1001"],
    ["DC-502", "2024-10-14", "INV-1002"],
    ["DC-503", "2024-11-10", "INV-1003"],
    ["DC-504", "2024-12-04", "INV-1004"],
  ].map(([reference = "", date = "", invoice = ""]) =>
    documentFinding(`f-${reference}`, MSME_DOCUMENT_IDS.deliveries, 1, [
      {
        key: documentEventDateKey("delivery", [invoice], reference),
        label: `Goods delivered under ${reference} for ${invoice}`,
        date,
      },
    ]),
  ),
  documentFinding(
    "f-letter",
    MSME_DOCUMENT_IDS.correspondence,
    2,
    [
      {
        key: documentEventDateKey("correspondence", ["INV-1003", "INV-2000"], "3"),
        label: "Letter acknowledging INV-1003",
        date: "2025-03-12",
      },
    ],
    {
      confidence: "low",
      figures: [
        {
          key: statedInvoiceAmountFigureKey("INV1003", 0),
          label: "INV-1003 amount stated in a document",
          value: 118000,
        },
      ],
    },
  ),
  documentFinding("f-register", MSME_DOCUMENT_IDS.invoices, 1, [
    { key: "invoice-date:INV1001", label: "Not an event key", date: "2024-09-20" },
  ]),
];

describe("document facts", () => {
  it("round-trips event keys with their invoices", () => {
    const key = documentEventDateKey("delivery", ["INV-1001", "inv 1002"], "DC 501: lot 1");

    expect(key).toBe("event:delivery:INV1001+INV1002:DC-501-lot-1");
    expect(parseDocumentEventKey(key)).toEqual({
      kind: "delivery",
      invoiceKeys: ["INV1001", "INV1002"],
    });
    expect(parseDocumentEventKey("due-date:INV1001")).toBeUndefined();
  });

  it("reads events and stated invoice amounts from document findings only", () => {
    const facts = documentFactsFromFindings(DOCUMENT_FINDINGS);

    expect(facts.events.map((event) => [event.kind, event.date, event.invoiceKeys])).toEqual([
      ["purchase-order", "2024-09-02", []],
      ["delivery", "2024-09-18", ["INV1001"]],
      ["delivery", "2024-10-14", ["INV1002"]],
      ["delivery", "2024-11-10", ["INV1003"]],
      ["delivery", "2024-12-04", ["INV1004"]],
      ["correspondence", "2025-03-12", ["INV1003", "INV2000"]],
    ]);
    expect(facts.statedAmounts).toEqual([
      expect.objectContaining({ invoiceKey: "INV1003", amount: 118000, confidence: "low" }),
    ]);
  });
});

describe("buildChronology", () => {
  it("orders events by date, then by kind, and links each one to its source evidence", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const events = buildChronology(reconciliation, documentFactsFromFindings(DOCUMENT_FINDINGS));
    const dates = events.map((event) => event.date);

    expect(dates).toEqual([...dates].sort());
    expect(events.map((event) => event.kind)).toEqual([
      "purchase-order",
      "delivery",
      "invoice",
      "delivery",
      "invoice",
      "delivery",
      "invoice",
      "payment",
      "delivery",
      "invoice",
      "due-date",
      "payment",
      "invoice",
      "due-date",
      "payment",
      "payment",
      "payment",
      "payment",
      "due-date",
      "correspondence",
    ]);

    const sameDay = events.filter((event) => event.date === "2024-11-10");

    expect(sameDay.map((event) => event.kind)).toEqual(["delivery", "invoice"]);

    for (const event of events) {
      expect(event.evidence.length).toBeGreaterThan(0);
    }

    const invoice = events.find((event) => event.dateKey === "invoice-date:INV1002");

    expect(invoice).toMatchObject({
      title: "Invoice INV-1002 raised for Rs 1,50,000 against PO-4471",
      source: "invoices.csv D3",
      documentId: MSME_DOCUMENT_IDS.invoices,
      evidence: [
        expect.objectContaining({
          documentId: MSME_DOCUMENT_IDS.invoices,
          cellRange: "D3",
          rowStart: 3,
          rowEnd: 3,
        }),
      ],
    });

    const delivery = events.find((event) => event.kind === "delivery");

    expect(delivery).toMatchObject({
      source: `${MSME_DOCUMENT_IDS.deliveries}.pdf p.1`,
      documentId: MSME_DOCUMENT_IDS.deliveries,
      invoiceNumbers: ["INV-1001"],
      evidence: [expect.objectContaining({ evidenceId: "ev-f-DC-501" })],
    });

    const due = events.find((event) => event.dateKey === "due-date:INV1002");

    expect(due).toMatchObject({
      date: "2024-12-14",
      title: "INV-1002 payment due under the agreed 60-day credit period",
      evidence: [
        expect.objectContaining({ cellRange: "D3" }),
        expect.objectContaining({ documentId: "doc-agreement", page: 1 }),
      ],
    });

    const unmatched = events.find((event) => event.title.includes("UTR25030506"));

    expect(unmatched?.title).toBe(
      "Payment UTR25030506 of Rs 5,000 received (not matched to an invoice)",
    );
  });

  it("renders a dated, source-labelled timeline and marks low-confidence events", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const text = chronologyTimelineText(
      buildChronology(reconciliation, documentFactsFromFindings(DOCUMENT_FINDINGS)),
    );
    const lines = text.split("\n");

    expect(lines[0]).toBe(
      `2024-09-02  Purchase order PO-4471 issued [${MSME_DOCUMENT_IDS.purchaseOrder}.pdf p.1]`,
    );
    expect(lines.at(-1)).toBe(
      `2025-03-12  Letter acknowledging INV-1003 (low-confidence transcription, verify) [${MSME_DOCUMENT_IDS.correspondence}.pdf p.2]`,
    );
  });
});

describe("evidence gaps", () => {
  it("finds missing delivery proof and invoices that are not in the register", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const gaps = findMissingDocuments(reconciliation, documentFactsFromFindings(DOCUMENT_FINDINGS));

    expect(gaps.map((gap) => [gap.severity, gap.summary])).toEqual([
      [
        "high",
        "[INV-1005] No delivery record or proof of acceptance was found for an invoice with Rs 75,000 outstanding",
      ],
      [
        "medium",
        `[INV2000] Invoice mentioned in ${MSME_DOCUMENT_IDS.correspondence}.pdf p.2 is not in the invoice register`,
      ],
    ]);
    expect(gaps[0]?.evidence[0]).toMatchObject({ cellRange: "D6" });
  });

  it("does not ask to register an invoice that is registered but dated after the as-of date", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync(
      INVOICES_CSV,
      PAYMENTS_CSV,
      "2025-01-01",
    );
    const mention = documentFinding("f-mention", MSME_DOCUMENT_IDS.correspondence, 1, [
      {
        key: documentEventDateKey("correspondence", ["INV-1005"], "9"),
        label: "Email about INV-1005",
        date: "2024-12-30",
      },
    ]);
    const gaps = findMissingDocuments(reconciliation, documentFactsFromFindings([mention]));

    expect(gaps.map((gap) => gap.summary).join("\n")).not.toContain("not in the invoice register");
  });

  it("flags a missing agreement when no credit period is known", async () => {
    const reconciliation = await reconcileMsmeFixtureAsync();
    const gaps = findMissingDocuments(
      { ...reconciliation, terms: undefined },
      { events: [], statedAmounts: [] },
    );

    expect(gaps.at(-1)?.summary).toBe(
      "No purchase order or agreement stating the payment terms was found",
    );
  });

  it("finds amount and due-date mismatches", async () => {
    const invoices = INVOICES_CSV.replace("2025-03-09", "2025-03-01");
    const reconciliation = await reconcileMsmeFixtureAsync(invoices, PAYMENTS_CSV);
    const gaps = findInconsistencies(reconciliation, documentFactsFromFindings(DOCUMENT_FINDINGS));

    expect(gaps.map((gap) => gap.summary)).toEqual([
      `[INV-1003] Amount mismatch: Rs 1,12,000 in invoices.csv D4 but Rs 1,18,000 in ${MSME_DOCUMENT_IDS.correspondence}.pdf p.2 (low-confidence transcription)`,
      "[INV-1005] Due date mismatch: the register shows 2025-03-01 but the agreed terms give 2025-03-09",
    ]);
    expect(gaps[0]?.evidence).toEqual([
      expect.objectContaining({ documentId: MSME_DOCUMENT_IDS.invoices, cellRange: "D4" }),
      expect.objectContaining({ evidenceId: "ev-f-letter" }),
    ]);
  });
});
