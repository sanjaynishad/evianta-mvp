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
  // Acceptance dates of the unpaid invoices match the claim's chronology and interest table.
  const acceptedOn: Record<number, string> = {
    104: "2026-05-05",
    107: "2026-06-12",
    111: "2026-07-10",
    115: "2026-07-31",
  };
  const open: TableCell[][] = [];
  for (let number = 104; number <= 118; number += 1) {
    const offset = (number - 104) * 7;
    const amount = unpaid[number] ?? 150000 + ((number * 7919) % 9) * 10000;
    const paid = unpaid[number] ? 0 : amount;
    const accepted = acceptedOn[number] ?? isoDay("2026-05-05", offset);
    open.push(invoiceRow(number, isoDay(accepted, -3), accepted, amount, paid));
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

// Integer shares of total in proportion to weights, summing exactly to total.
function splitTotal(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  const shares = weights.map((weight) => Math.floor((total * weight) / sum));
  let remainder = total - shares.reduce((acc, share) => acc + share, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % shares.length) {
    shares[index]! += 1;
    remainder -= 1;
  }

  return shares;
}

type SalesRegion = "West" | "North" | "South" | "Unassigned";

const salesRegions: SalesRegion[] = ["West", "North", "South", "Unassigned"];

// Net sales and returns per month (July, August, September) and region. These reconcile with the
// data-analysis sample: monthly totals, the regional split, 142 rows without a region worth 9.45
// lakh, and West returns at 9.2% of gross in August.
export const salesFixtureTargets: Record<SalesRegion, { net: number[]; returns: number[] }> = {
  West: { net: [1580000, 1750000, 1990000], returns: [67550, 177310, 80760] },
  North: { net: [1230000, 1300000, 1380000], returns: [48590, 54170, 51540] },
  South: { net: [1085000, 1260000, 1295000], returns: [49940, 56610, 55370] },
  Unassigned: { net: [315000, 315000, 315000], returns: [13130, 13130, 13130] },
};

// Return notes RTN-0812 to RTN-0868 from the Pune distributor: 71% of West's August returns.
export const puneReturnRows = { start: 812, end: 868, returns: 125890 };

export const missingRegionRowCount = 142;

function salesExtraction(): ExtractedDocumentInput {
  const random = createRandom(2026);
  const customers: Record<Exclude<SalesRegion, "Unassigned">, string[]> = {
    West: ["Konkan Retail, Mumbai", "Sahyadri Stores, Nashik"],
    North: ["Ganga Traders, Lucknow", "Capital Stores, Delhi"],
    South: ["Cauvery Mart, Mysuru", "Bay Supplies, Chennai"],
  };
  const products = ["Steel tumbler set", "Pressure cooker 5L", "Non-stick tawa", "Mixer jar"];
  const rowCount = 1840;
  const monthOf = (row: number) => (row < 615 ? 0 : row < 1230 ? 1 : 2);
  const isPune = (row: number) => row >= puneReturnRows.start && row <= puneReturnRows.end;
  const blank = new Set<number>();
  for (const step of [5, 9]) {
    for (let index = step; index < rowCount && blank.size < missingRegionRowCount; index += 13) {
      if (!isPune(index + 2)) {
        blank.add(index);
      }
    }
  }

  const regions: SalesRegion[] = Array.from({ length: rowCount }, (_, index) =>
    isPune(index + 2)
      ? "West"
      : blank.has(index)
        ? "Unassigned"
        : (["West", "North", "South"] as const)[Math.floor(random() * 3)]!,
  );
  const net = new Array<number>(rowCount).fill(0);
  const returns = new Array<number>(rowCount).fill(0);
  for (const region of salesRegions) {
    for (let month = 0; month < 3; month += 1) {
      const indexes = regions
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate, index }) => candidate === region && monthOf(index + 2) === month)
        .map(({ index }) => index);
      const netShares = splitTotal(
        salesFixtureTargets[region].net[month]!,
        indexes.map((index) => (isPune(index + 2) ? 0.3 : 0.6 + random())),
      );
      indexes.forEach((index, position) => {
        net[index] = netShares[position]!;
      });

      const pune = indexes.filter((index) => isPune(index + 2));
      const others = indexes.filter((index) => !isPune(index + 2) && random() < 0.07);
      const returnRows = others.length > 0 ? others : indexes.slice(0, 3);
      const otherReturns =
        salesFixtureTargets[region].returns[month]! -
        (pune.length > 0 ? puneReturnRows.returns : 0);
      splitTotal(
        puneReturnRows.returns,
        pune.map(() => 1),
      ).forEach((value, position) => {
        returns[pune[position]!] = value;
      });
      splitTotal(
        otherReturns,
        returnRows.map(() => 0.5 + random()),
      ).forEach((value, position) => {
        const target = returnRows[position]!;
        returns[target] = (returns[target] ?? 0) + value;
      });
    }
  }

  const rows: TableCell[][] = regions.map((region, index) => {
    const row = index + 2;
    const customer = isPune(row)
      ? "Deccan Distributors, Pune"
      : region === "Unassigned"
        ? "Counter sale"
        : customers[region][Math.floor(random() * 2)]!;
    const gross = net[index]! + returns[index]!;
    return [
      isPune(row) ? `RTN-${String(row).padStart(4, "0")}` : `INV-${String(row).padStart(4, "0")}`,
      isoDay(["2025-07-01", "2025-08-01", "2025-09-01"][monthOf(row)]!, Math.floor(random() * 28)),
      customer,
      products[Math.floor(random() * products.length)]!,
      region === "Unassigned" ? null : region,
      gross,
      returns[index]!,
      net[index]!,
    ];
  });
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
