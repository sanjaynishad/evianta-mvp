import { createMockAi } from "@evianta/ai";
import type { DocumentMetadata } from "@evianta/core";
import { extractDocumentAsync } from "@evianta/ingest";
import { describe, expect, it } from "vitest";

import { LEDGER_CSV, RETURN_COMPUTATION_CSV, TAX_CREDIT_CSV } from "../../testing/taxNotice.js";
import {
  classifyTaxRecordSource,
  financialPeriodOfDate,
  mapTaxColumns,
  normalizeQuarter,
  parseAmount,
  readTaxRecords,
  selectTaxColumns,
  type TaxRecordDocument,
} from "./records.js";
import {
  discrepancies,
  lineDifferenceComponents,
  primaryTaxDifference,
  reconcileTaxRecords,
} from "./reconcile.js";
import { reconciliationTableMarkdown } from "./render.js";

function metadata(id: string, name: string): DocumentMetadata {
  return {
    id,
    caseId: "case-1",
    name,
    mimeType: "text/csv",
    size: 0,
    gcsPath: `memory://${id}`,
    uploadedAt: "2025-01-20T00:00:00.000Z",
  };
}

async function csvDocumentAsync(id: string, name: string, csv: string): Promise<TaxRecordDocument> {
  const meta = metadata(id, name);
  const { extraction } = await extractDocumentAsync(Buffer.from(csv, "utf8"), meta, {
    ai: createMockAi(),
  });

  return { metadata: meta, extraction };
}

async function fixtureDocumentsAsync(
  overrides: {
    taxCredit?: string;
    ledger?: string | false;
    returnComputation?: string | false;
  } = {},
) {
  const documents = [
    await csvDocumentAsync("doc-26as", "form-26as.csv", overrides.taxCredit ?? TAX_CREDIT_CSV),
  ];

  if (overrides.ledger !== false) {
    documents.push(
      await csvDocumentAsync("doc-ledger", "ledger.csv", overrides.ledger ?? LEDGER_CSV),
    );
  }

  if (overrides.returnComputation !== false) {
    documents.push(
      await csvDocumentAsync(
        "doc-return",
        "itr-computation.csv",
        overrides.returnComputation ?? RETURN_COMPUTATION_CSV,
      ),
    );
  }

  return documents;
}

describe("tax record reading", () => {
  it("maps columns by header and classifies each source", () => {
    expect(
      mapTaxColumns([
        "TAN of deductor",
        "Name of deductor",
        "Section",
        "Transaction date",
        "Amount paid/credited",
        "Tax deducted",
        "Booking status",
      ]),
    ).toEqual({ tan: 0, deductor: 1, section: 2, date: 3, amount: 4, tax: 5 });
    expect(classifyTaxRecordSource("form-26as.csv", "form-26as", [])).toBe("tax-credit");
    expect(classifyTaxRecordSource("AIS export.csv", "AIS export", [])).toBe("tax-credit");
    expect(classifyTaxRecordSource("itr-computation.csv", "itr-computation", [])).toBe("return");
    expect(classifyTaxRecordSource("ledger.csv", "ledger", [])).toBe("ledger");
    expect(classifyTaxRecordSource("data.csv", "data", ["Party", "Voucher"])).toBe("ledger");
    expect(classifyTaxRecordSource("data.csv", "data", ["Deductor", "Amount"])).toBeUndefined();
  });

  it("parses amounts, quarters, and Indian financial periods", () => {
    expect(parseAmount("Rs 1,41,000/-")).toBe(141000);
    expect(parseAmount("(1,200.50)")).toBe(-1200.5);
    expect(parseAmount("Rs -1,200")).toBe(-1200);
    expect(parseAmount("₹-1200")).toBe(-1200);
    expect(parseAmount("-Rs 1,200")).toBe(-1200);
    expect(parseAmount("(Rs 1,200)")).toBe(-1200);
    expect(parseAmount("n/a")).toBeUndefined();
    expect(normalizeQuarter("Q3")).toBe("Q3");
    expect(normalizeQuarter("Jan-Mar")).toBe("Q4");
    expect(financialPeriodOfDate("2024-03-31")).toEqual({
      financialYear: "2023-24",
      quarter: "Q4",
    });
    expect(financialPeriodOfDate("2023-04-01")).toEqual({
      financialYear: "2023-24",
      quarter: "Q1",
    });
  });

  it("reads rows with cell locations and reports tables it cannot use", async () => {
    const documents = [
      ...(await fixtureDocumentsAsync()),
      await csvDocumentAsync("doc-misc", "contacts.csv", "Name,Phone\nA,1\n"),
    ];
    const records = readTaxRecords(documents);
    const taxCredit = records.tables.find((table) => table.source === "tax-credit");

    expect(records.tables.map((table) => table.source)).toEqual(["tax-credit", "ledger", "return"]);
    expect(records.unclassified).toEqual([
      expect.objectContaining({
        documentId: "doc-misc",
        reason: expect.stringContaining("no deductor"),
      }),
    ]);
    expect(taxCredit?.rows[2]).toMatchObject({
      tan: "DELS20002B",
      deductorName: "Sunrise Consulting Pvt Ltd",
      financialYear: "2023-24",
      quarter: "Q1",
      amount: 125000,
      tax: 12500,
      location: { cellRange: "F4", rowRange: { start: 4, end: 4 } },
    });
  });
});

describe("reconcileTaxRecords", () => {
  it("finds the seeded TDS mismatch and matches the rest", async () => {
    const reconciliation = reconcileTaxRecords(readTaxRecords(await fixtureDocumentsAsync()));
    const [mismatch] = discrepancies(reconciliation);

    expect(reconciliation.providedSources).toEqual(["return", "ledger", "tax-credit"]);
    expect(reconciliation.lines.map((line) => [line.ref, line.deductorName, line.status])).toEqual([
      ["R-01", "Asha Salaries Ltd", "matched"],
      ["R-02", "Northwind Bank Ltd", "matched"],
      ["R-03", "Sunrise Consulting Pvt Ltd", "mismatched"],
    ]);
    expect(mismatch).toMatchObject({
      ref: "R-03",
      tan: "DELS20002B",
      period: "FY 2023-24",
      values: {
        return: { tax: 50000, amount: 500000 },
        ledger: { tax: 50000, amount: 500000 },
        "tax-credit": { tax: 37600, amount: 376000 },
      },
      returnVsTaxCredit: { tax: 12400, amount: 124000 },
      ledgerVsTaxCredit: { tax: 12400, amount: 124000 },
      returnVsLedger: { tax: 0, amount: 0 },
    });
    expect(mismatch?.values.ledger?.rows).toHaveLength(4);
    expect(primaryTaxDifference(mismatch!)).toBe(12400);
    expect(lineDifferenceComponents(mismatch!)).toEqual([
      { label: "TDS per Return", value: 50000 },
      { label: "TDS per 26AS/AIS", value: -37600 },
    ]);
    expect(reconciliation.totals).toMatchObject({
      bySource: {
        return: { tax: 141000, amount: 1410000, rowCount: 3 },
        ledger: { tax: 141000, rowCount: 10 },
        "tax-credit": { tax: 128600, amount: 1286000, rowCount: 9 },
      },
      returnVsTaxCredit: { tax: 12400, amount: 124000 },
      ledgerVsTaxCredit: { tax: 12400 },
    });
  });

  it("reports items missing on either side and treats small differences within tolerance", async () => {
    const taxCredit = `${TAX_CREDIT_CSV}\nKOLX40004D,Eastern Traders,194C,2023-11-15,20000,200,F`;
    const returnComputation = RETURN_COMPUTATION_CSV.replace("500000,50000", "376000,37600.4");
    const reconciliation = reconcileTaxRecords(
      readTaxRecords(await fixtureDocumentsAsync({ taxCredit, returnComputation, ledger: false })),
    );
    const byName = new Map(reconciliation.lines.map((line) => [line.deductorName, line]));

    expect(reconciliation.missingSources).toEqual(["ledger"]);
    expect(byName.get("Sunrise Consulting Pvt Ltd")?.status).toBe("matched");
    expect(byName.get("Eastern Traders")).toMatchObject({
      status: "missing",
      missingIn: ["return"],
      returnVsTaxCredit: { tax: -200, amount: -20000 },
    });
    expect(reconciliation.totals.returnVsTaxCredit?.tax).toBeCloseTo(-199.6, 6);
  });

  it("reconciles by quarter when every source carries a period", async () => {
    const reconciliation = reconcileTaxRecords(
      readTaxRecords(await fixtureDocumentsAsync({ returnComputation: false })),
    );
    const sunrise = reconciliation.lines.filter((line) => line.tan === "DELS20002B");

    expect(sunrise.map((line) => [line.period, line.status, line.missingIn])).toEqual([
      ["FY 2023-24 Q1", "matched", []],
      ["FY 2023-24 Q2", "matched", []],
      ["FY 2023-24 Q3", "matched", []],
      ["FY 2023-24 Q4", "missing", ["tax-credit"]],
    ]);
    expect(sunrise[3]?.ledgerVsTaxCredit).toEqual({ tax: 12400, amount: 124000 });
  });

  it("renders a table with differences, statuses, and source cells", async () => {
    const reconciliation = reconcileTaxRecords(readTaxRecords(await fixtureDocumentsAsync()));
    const table = reconciliationTableMarkdown(reconciliation);

    expect(table).toContain(
      "| R-03 | Sunrise Consulting Pvt Ltd (DELS20002B) | 194J | FY 2023-24 | 50,000 | 50,000 | 37,600 | 12,400 |",
    );
    expect(table).toContain("Mismatch");
    expect(table).toContain("form-26as.csv F4");
    expect(table).toContain("| Total |  |  |  | 1,41,000 | 1,41,000 | 1,28,600 | 12,400 |");
  });
});

describe("reconciliation edge cases", () => {
  it("prefers the claimed TDS column in a return and skips tables with ambiguous TDS columns", async () => {
    const returnWithBoth = [
      "TAN,Deductor,Financial year,Income offered,TDS deducted,TDS claimed",
      "MUMN10001A,Northwind Bank Ltd,2023-24,10000,1000,1000",
      "DELS20002B,Sunrise Consulting Pvt Ltd,2023-24,500000,37600,50000",
      "BLRA30003C,Asha Salaries Ltd,2023-24,900000,90000,90000",
    ].join("\n");
    const ambiguousCredit = TAX_CREDIT_CSV.replace(
      "Tax deducted,",
      "TDS deducted,Tax deducted,",
    ).replace(/,F$/gm, ",0,F");

    expect(selectTaxColumns(returnWithBoth.split("\n")[0]!.split(","), "return").columns.tax).toBe(
      5,
    );

    const records = readTaxRecords(
      await fixtureDocumentsAsync({
        returnComputation: returnWithBoth,
        taxCredit: ambiguousCredit,
      }),
    );
    const reconciliation = reconcileTaxRecords(
      readTaxRecords(await fixtureDocumentsAsync({ returnComputation: returnWithBoth })),
    );

    expect(records.unclassified).toEqual([
      expect.objectContaining({
        documentId: "doc-26as",
        reason: expect.stringContaining("several TDS columns (TDS deducted, Tax deducted)"),
      }),
    ]);
    expect(reconciliation.totals.returnVsTaxCredit?.tax).toBe(12400);
  });

  it("excludes total rows but keeps deductors whose names start with Total", async () => {
    const ledger = [
      LEDGER_CSV,
      "2023-08-01,Total Solutions Pvt Ltd,194C,5000,50,TS-01",
      ",Total,,1415000,141050,",
    ].join("\n");
    const records = readTaxRecords(await fixtureDocumentsAsync({ ledger }));
    const reconciliation = reconcileTaxRecords(records);
    const ledgerTable = records.tables.find((table) => table.source === "ledger");

    expect(ledgerTable?.aggregateRowIndexes).toEqual([11]);
    expect(ledgerTable?.rows.some((row) => row.deductorName === "Total Solutions Pvt Ltd")).toBe(
      true,
    );
    expect(reconciliation.totals.bySource.ledger?.tax).toBe(141050);
    expect(reconciliation.excludedRows).toEqual([
      expect.objectContaining({
        documentId: "doc-ledger",
        location: { rowRange: { start: 13, end: 13 } },
      }),
    ]);
  });

  it("never treats a blank or unreadable TDS cell as zero", async () => {
    const taxCredit = TAX_CREDIT_CSV.replace("2024-03-31,6000,600,F", "2024-03-31,6000,,F");
    const reconciliation = reconcileTaxRecords(
      readTaxRecords(await fixtureDocumentsAsync({ taxCredit })),
    );
    const northwind = reconciliation.lines.find((line) => line.tan === "MUMN10001A");

    expect(northwind).toMatchObject({
      status: "incomplete",
      values: { "tax-credit": { unreadable: ["tax"] } },
    });
    expect(northwind?.values["tax-credit"]?.tax).toBeUndefined();
    expect(northwind?.returnVsTaxCredit).toEqual({ amount: 0 });
    expect(reconciliation.totals.bySource["tax-credit"]).toMatchObject({ unreadable: ["tax"] });
    expect(reconciliation.totals.bySource["tax-credit"]?.tax).toBeUndefined();
    expect(reconciliation.totals.returnVsTaxCredit).toEqual({ amount: 124000 });
    expect(reconciliationTableMarkdown(reconciliation)).toContain("Unreadable values in 26AS/AIS");
  });

  it("does not guess a TAN for a name shared by several TANs", async () => {
    const taxCredit = `${TAX_CREDIT_CSV}\nPUNE50005E,Northwind Bank Ltd,194A,2023-12-31,2000,200,F`;
    const reconciliation = reconcileTaxRecords(
      readTaxRecords(await fixtureDocumentsAsync({ taxCredit, returnComputation: false })),
    );

    expect(reconciliation.ambiguousDeductors).toEqual([
      { name: "Northwind Bank Ltd", tans: ["MUMN10001A", "PUNE50005E"] },
    ]);
    expect(
      reconciliation.lines
        .filter((line) => line.deductorKey === "name:northwind bank")
        .map((line) => [line.status, line.missingIn]),
    ).toEqual([
      ["missing", ["tax-credit"]],
      ["missing", ["tax-credit"]],
    ]);
  });
});
