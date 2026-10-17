import { createMockAi } from "@evianta/ai";
import type { DocumentMetadata, ExtractedDocument } from "@evianta/core";
import { extractDocumentAsync } from "@evianta/ingest";
import { utils, write } from "xlsx";

export const SALES_HEADER = [
  "Order ID",
  "Order Date",
  "Region",
  "Product",
  "Channel",
  "Quantity",
  "Amount (INR)",
] as const;

type FixtureCell = string | number | null;

/**
 * Six months of synthetic sales with a steady +1,000 per month trend and an April spike.
 * Intentional issues: two dates in other formats (rows 10-11), a negative return (row 22), a
 * missing region (row 25), an exact duplicate (row 27), a non-numeric amount (row 28), and a
 * missing amount (row 29). Row numbers are sheet rows; the header is row 1.
 */
export const SALES_ROWS: readonly (readonly FixtureCell[])[] = [
  ["SO-1001", "2024-01-05", "North", "Widget", "Online", 10, 2500],
  ["SO-1002", "2024-01-12", "South", "Gadget", "Retail", 5, 3000],
  ["SO-1003", "2024-01-19", "East", "Widget", "Online", 8, 2000],
  ["SO-1004", "2024-01-26", "West", "Gizmo", "Distributor", 4, 2500],
  ["SO-1005", "2024-02-02", "North", "Widget", "Online", 12, 3000],
  ["SO-1006", "2024-02-09", "South", "Gadget", "Retail", 6, 3600],
  ["SO-1007", "2024-02-16", "East", "Gizmo", "Distributor", 5, 2400],
  ["SO-1008", "2024-02-23", "West", "Widget", "Online", 8, 2000],
  ["SO-1009", "15/03/2024", "North", "Widget", "Online", 14, 3500],
  ["SO-1010", "03/22/2024", "South", "Gadget", "Retail", 7, 4200],
  ["SO-1011", "2024-03-08", "East", "Widget", "Online", 9, 2300],
  ["SO-1012", "2024-03-29", "West", "Gizmo", "Distributor", 5, 2000],
  ["SO-1013", "2024-04-05", "North", "Widget", "Online", 40, 10000],
  ["SO-1014", "2024-04-12", "South", "Gadget", "Retail", 25, 15000],
  ["SO-1015", "2024-04-19", "East", "Widget", "Online", 10, 2500],
  ["SO-1016", "2024-04-26", "West", "Gizmo", "Distributor", 6, 2500],
  ["SO-1017", "2024-05-03", "North", "Widget", "Online", 16, 4000],
  ["SO-1018", "2024-05-10", "South", "Gadget", "Retail", 9, 5400],
  ["SO-1019", "2024-05-17", "East", "Widget", "Online", 12, 3000],
  ["SO-1020", "2024-05-24", "West", "Gizmo", "Distributor", 6, 2600],
  ["SO-1021", "2024-05-28", "West", "Gizmo", "Distributor", -2, -1000],
  ["SO-1022", "2024-06-07", "North", "Widget", "Online", 18, 4500],
  ["SO-1023", "2024-06-14", "South", "Gadget", "Retail", 10, 6000],
  ["SO-1024", "2024-06-21", null, "Widget", "Online", 11, 2500],
  ["SO-1025", "2024-06-28", "West", "Gizmo", "Distributor", 6, 2000],
  ["SO-1025", "2024-06-28", "West", "Gizmo", "Distributor", 6, 2000],
  ["SO-1026", "2024-06-30", "East", "Gadget", "Retail", 3, "pending"],
  ["SO-1027", "2024-06-30", "North", "Gizmo", "Online", 2, null],
];

export const SALES_EXPECTED = {
  dataRows: 28,
  analyzedRows: 27,
  rowsWithAmount: 25,
  totalAmount: 92000,
  averageAmount: 3680,
  totalQuantity: 265,
  monthlyTotals: [
    ["2024-01", 10000],
    ["2024-02", 11000],
    ["2024-03", 12000],
    ["2024-04", 30000],
    ["2024-05", 14000],
    ["2024-06", 15000],
  ] as const,
  monthlyChangePct: [10, 9.09, 150, -53.33, 7.14],
  growthFirstToLastPct: 50,
  trendSlopePerMonth: 1000,
  regionTotals: [
    ["South", 37200, 40.43],
    ["North", 27500, 29.89],
    ["West", 12600, 13.7],
    ["East", 12200, 13.26],
    ["Unassigned", 2500, 2.72],
  ] as const,
  anomaly: { period: "2024-04", value: 30000, expected: 13000, deviationPct: 130.77 },
} as const;

function csvCell(cell: FixtureCell): string {
  if (cell === null) {
    return "";
  }

  const text = String(cell);

  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function salesCsv(rows: readonly (readonly FixtureCell[])[] = SALES_ROWS): string {
  return [SALES_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function salesWorkbook(
  rows: readonly (readonly FixtureCell[])[] = SALES_ROWS,
  sheetName = "Sales",
): Uint8Array {
  const sheet = utils.aoa_to_sheet([[...SALES_HEADER], ...rows.map((row) => [...row])]);
  const workbook = utils.book_new();

  utils.book_append_sheet(workbook, sheet, sheetName);

  return write(workbook, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
}

export const CSV_MIME = "text/csv";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function fixtureMetadata(
  id: string,
  name: string,
  mimeType: string,
  size: number,
  caseId = "case-1",
): DocumentMetadata {
  return {
    id,
    caseId,
    name,
    mimeType,
    size,
    gcsPath: `cases/${caseId}/${id}`,
    uploadedAt: "2024-07-01T00:00:00.000Z",
  };
}

/** Parses a fixture with the real ingestion layer; tabular formats never call the model. */
export async function extractFixtureAsync(
  buffer: Uint8Array,
  metadata: DocumentMetadata,
): Promise<ExtractedDocument> {
  const outcome = await extractDocumentAsync(buffer, metadata, { ai: createMockAi({}) });

  return outcome.extraction;
}
