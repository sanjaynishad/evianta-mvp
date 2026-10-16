import {
  extractedDocumentSchema,
  type ExtractedDocument,
  type ExtractedDocumentInput,
  type ExtractionMethod,
  type TableCell,
} from "@evianta/core";
import { layoutSpans, layoutText, sourceLayouts, type SourceLayout } from "./source-layouts";

export const fixtureAssetBasePath = "/fixtures";

const layoutMethods: Record<string, ExtractionMethod> = {
  "b-doc-notice": "pdf-text",
  "b-doc-26as": "ocr",
  "b-doc-note": "handwriting",
  "c-doc-invoices": "mixed",
  "c-doc-udyam": "pdf-text",
  "c-doc-reminders": "pdf-text",
};

function fromLayout(layout: SourceLayout): ExtractedDocumentInput {
  const pages = layout.pages.map((page, index) => ({
    index: index + 1,
    text: layoutText(page),
    width: layout.fileName.endsWith(".pdf") ? 595 : undefined,
    height: layout.fileName.endsWith(".pdf") ? 842 : undefined,
    method: page.method,
    confidence: page.confidence,
    spans: page.keepSpans ? layoutSpans(page) : undefined,
  }));
  return {
    documentId: layout.documentId,
    kind: "text",
    method: layoutMethods[layout.documentId] ?? "pdf-text",
    confidence: Math.min(...pages.map((page) => page.confidence)),
    pages,
  };
}

function isoDay(start: string, offsetDays: number): string {
  const date = new Date(`${start}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// Deterministic so the fixture rows are stable across reloads and tests.
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function ledgerExtraction(): ExtractedDocumentInput {
  const parties: { name: string; rows: number; gross: number }[] = [
    { name: "Bharat Garments Ltd", rows: 64, gross: 10000 },
    { name: "Lakshmi Retail LLP", rows: 42, gross: 10000 },
    { name: "Orient Fashions Pvt Ltd", rows: 44, gross: 9000 },
    { name: "Sunrise Traders", rows: 41, gross: 10000 },
  ];
  const remaining = parties.map((party) => party.rows);
  const others: { name: string; gross: number }[] = [];
  while (remaining.some((count) => count > 0)) {
    parties.forEach((party, index) => {
      if (remaining[index]! > 0) {
        remaining[index]! -= 1;
        others.push({ name: party.name, gross: party.gross });
      }
    });
  }

  const mehta = [...Array.from({ length: 8 }, () => 14000), 12000].map((gross) => ({
    name: "Mehta Exports",
    gross,
  }));
  // Worksheet rows 182 to 190 hold the Mehta Exports receipts.
  const entries = [...others.slice(0, 180), ...mehta, ...others.slice(180)];
  const rows: TableCell[][] = entries.map((entry, index) => {
    const tds = Math.round(entry.gross * 0.1);
    return [
      isoDay("2024-04-01", Math.floor(index * 1.8)),
      `RCPT-${String(index + 1).padStart(4, "0")}`,
      entry.name,
      entry.gross,
      tds,
      entry.gross - tds,
    ];
  });
  return {
    documentId: "b-doc-ledger",
    kind: "tabular",
    method: "parse",
    confidence: 1,
    tables: [
      {
        name: "Receipts",
        sheet: "Receipts",
        range: `A1:F${rows.length + 1}`,
        columns: [
          { name: "Date", type: "date" },
          { name: "Voucher", type: "string" },
          { name: "Party", type: "string" },
          { name: "Gross receipt", type: "number" },
          { name: "TDS deducted", type: "number" },
          { name: "Net received", type: "number" },
        ],
        rows,
      },
    ],
  };
}

function statementExtraction(): ExtractedDocumentInput {
  const invoiceRow = (
    number: number,
    date: string,
    accepted: string,
    amount: number,
    paid: number,
  ): TableCell[] => [date, `KF-2025-${number}`, accepted, amount, paid, amount - paid];
  const unpaid: Record<number, number> = { 104: 240000, 107: 195000, 111: 212000, 115: 195000 };
  const early = [
    invoiceRow(101, "2026-04-02", "2026-04-04", 180000, 180000),
    invoiceRow(102, "2026-04-10", "2026-04-12", 205000, 205000),
    invoiceRow(103, "2026-04-21", "2026-04-23", 160000, 160000),
  ];
  const payments: TableCell[][] = [
    ["2026-05-08", "Receipt NEFT 4471", null, null, 180000, null],
    ["2026-05-20", "Receipt NEFT 4520", null, null, 205000, null],
    ["2026-06-02", "Receipt NEFT 4602", null, null, 160000, null],
    ["2026-06-25", "Receipt NEFT 4688", null, null, 150000, null],
    ["2026-07-14", "Receipt NEFT 4731", null, null, 210000, null],
    ["2026-07-30", "Receipt NEFT 4790", null, null, 175000, null],
    ["2026-08-12", "Receipt NEFT 4855", null, null, 190000, null],
    ["2026-08-28", "Receipt NEFT 4902", null, null, 165000, null],
    ["2026-09-15", "Receipt NEFT 4960", null, null, 220000, null],
  ];
  const open: TableCell[][] = [];
  for (let number = 104; number <= 118; number += 1) {
    const offset = (number - 104) * 7;
    const amount = unpaid[number] ?? 150000 + ((number * 7919) % 9) * 10000;
    const paid = unpaid[number] ? 0 : amount;
    open.push(
      invoiceRow(number, isoDay("2026-05-02", offset), isoDay("2026-05-05", offset), amount, paid),
    );
  }

  const balance = Object.values(unpaid).reduce((sum, value) => sum + value, 0);
  const rows: TableCell[][] = [
    ...early,
    ...payments,
    ...open,
    ["2026-10-02", "Total outstanding", null, null, null, balance],
  ];
  return {
    documentId: "c-doc-statement",
    kind: "tabular",
    method: "parse",
    confidence: 1,
    tables: [
      {
        name: "SOA",
        sheet: "SOA",
        range: `A1:F${rows.length + 1}`,
        columns: [
          { name: "Date", type: "date" },
          { name: "Invoice or receipt", type: "string" },
          { name: "Accepted on", type: "date" },
          { name: "Amount", type: "number" },
          { name: "Paid", type: "number" },
          { name: "Balance", type: "number" },
        ],
        rows,
      },
    ],
  };
}

function salesExtraction(): ExtractedDocumentInput {
  const random = createRandom(2026);
  const customers = [
    ["Deccan Distributors, Pune", "West"],
    ["Konkan Retail, Mumbai", "West"],
    ["Ganga Traders, Lucknow", "North"],
    ["Capital Stores, Delhi", "North"],
    ["Cauvery Mart, Mysuru", "South"],
    ["Bay Supplies, Chennai", "South"],
  ] as const;
  const products = ["Steel tumbler set", "Pressure cooker 5L", "Non-stick tawa", "Mixer jar"];
  const rows: TableCell[][] = [];
  for (let index = 0; index < 1840; index += 1) {
    const row = index + 2;
    const month = row < 615 ? 0 : row < 1230 ? 1 : 2;
    const isPuneReturn = row >= 812 && row <= 868;
    const [customer, region] = isPuneReturn
      ? customers[0]
      : customers[Math.floor(random() * customers.length)]!;
    const blankRegion = !isPuneReturn && index % 13 === 5;
    const gross = Math.round((8000 + random() * 22000) / 10) * 10;
    const returns = isPuneReturn ? Math.round(gross * 0.6) : random() < 0.05 ? gross : 0;
    rows.push([
      isPuneReturn ? `RTN-${String(row).padStart(4, "0")}` : `INV-${String(row).padStart(4, "0")}`,
      isoDay(["2025-07-01", "2025-08-01", "2025-09-01"][month]!, Math.floor(random() * 28)),
      customer,
      products[Math.floor(random() * products.length)]!,
      blankRegion ? null : region,
      gross,
      returns,
      gross - returns,
    ]);
  }

  return {
    documentId: "a-doc-sales",
    kind: "tabular",
    method: "parse",
    confidence: 1,
    tables: [
      {
        name: "Sales",
        sheet: "Sales",
        range: `A1:H${rows.length + 1}`,
        columns: [
          { name: "Invoice", type: "string" },
          { name: "Date", type: "date" },
          { name: "Customer", type: "string" },
          { name: "Product", type: "string" },
          { name: "Region", type: "string" },
          { name: "Gross", type: "number" },
          { name: "Returns", type: "number" },
          { name: "Net amount", type: "number" },
        ],
        rows,
      },
    ],
  };
}

const extractionFactories: Record<string, () => ExtractedDocumentInput> = {
  ...Object.fromEntries(
    sourceLayouts.map((layout) => [layout.documentId, () => fromLayout(layout)]),
  ),
  "b-doc-ledger": ledgerExtraction,
  "c-doc-statement": statementExtraction,
  "a-doc-sales": salesExtraction,
};

const extractionCache = new Map<string, ExtractedDocument>();

export function getFixtureExtraction(documentId: string): ExtractedDocument | undefined {
  const cached = extractionCache.get(documentId);
  if (cached) {
    return cached;
  }

  const factory = extractionFactories[documentId];
  if (!factory) {
    return undefined;
  }

  const extraction = extractedDocumentSchema.parse(factory());
  extractionCache.set(documentId, extraction);
  return extraction;
}

const assetFiles: Record<string, string> = Object.fromEntries(
  sourceLayouts.map((layout) => [layout.documentId, layout.fileName]),
);

export function getFixtureAssetUrl(documentId: string): string | undefined {
  const fileName = assetFiles[documentId];
  return fileName ? `${fixtureAssetBasePath}/${encodeURIComponent(fileName)}` : undefined;
}
