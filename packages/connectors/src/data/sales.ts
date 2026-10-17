import { productBySku, type Region } from "./business.js";
import { apexInvoices } from "./receivables.js";

export const SALES_PERIOD_LABEL = "Apr to Sep 2026";

export interface SalesRegisterLine {
  date: string;
  voucher: string;
  party: string;
  /** Null where the region was left blank in the books. */
  region: Region | null;
  sku: string;
  /** Negative for credit notes (sales returns). */
  quantity: number;
}

const partyRegions: Record<string, Region> = {
  "Apex Retail Pvt Ltd": "West",
  "Patil Home Needs": "West",
  "Gupta Distributors": "North",
  "Sri Lakshmi Agencies": "South",
  "Bose Trading Co": "East",
};

function line(
  date: string,
  voucher: string,
  party: string,
  sku: string,
  quantity: number,
  region: Region | null = partyRegions[party] ?? null,
): SalesRegisterLine {
  return { date, voucher, party, region, sku, quantity };
}

// Distributor sales other than Apex Retail. Seeded data-quality issues: a blank region on
// SHI/26-27/111 and an exact duplicate line on SHI/26-27/128. Credit notes are sales returns.
const otherDistributorLines: readonly SalesRegisterLine[] = [
  line("2026-04-07", "SHI/26-27/006", "Gupta Distributors", "SHI-BTL-1000", 150),
  line("2026-04-07", "SHI/26-27/006", "Gupta Distributors", "SHI-BTL-750", 300),
  line("2026-04-24", "SHI/26-27/019", "Sri Lakshmi Agencies", "SHI-LBX-3C", 200),
  line("2026-04-29", "SHI/26-27/023", "Bose Trading Co", "SHI-CNT-1000", 250),
  line("2026-05-06", "SHI/26-27/028", "Patil Home Needs", "SHI-ORG-SPICE", 120),
  line("2026-05-06", "SHI/26-27/028", "Patil Home Needs", "SHI-ORG-TRAY", 150),
  line("2026-05-16", "SHI/26-27/036", "Gupta Distributors", "SHI-CNT-SET3", 180),
  line("2026-05-27", "SHI/26-27/042", "Sri Lakshmi Agencies", "SHI-BTL-1000", 160),
  line("2026-05-27", "SHI/26-27/042", "Sri Lakshmi Agencies", "SHI-LBX-INS", 80),
  line("2026-06-03", "SHI/26-27/049", "Bose Trading Co", "SHI-BTL-750", 280),
  line("2026-06-15", "SHI/26-27/058", "Gupta Distributors", "SHI-LBX-INS", 140),
  line("2026-06-15", "SHI/26-27/058", "Gupta Distributors", "SHI-LBX-3C", 160),
  line("2026-06-22", "SHI/26-27/063", "Sri Lakshmi Agencies", "SHI-CNT-SET3", 120),
  line("2026-07-04", "SHI/26-27/072", "Patil Home Needs", "SHI-CNT-1000", 300),
  line("2026-07-11", "SHI/26-27/078", "Gupta Distributors", "SHI-BTL-1000", 220),
  line("2026-07-11", "SHI/26-27/078", "Gupta Distributors", "SHI-BTL-750", 250),
  line("2026-07-25", "SHI/26-27/088", "Bose Trading Co", "SHI-LBX-3C", 150),
  line("2026-07-29", "CN/26-27/004", "Sri Lakshmi Agencies", "SHI-LBX-INS", -20),
  line("2026-08-05", "SHI/26-27/094", "Sri Lakshmi Agencies", "SHI-ORG-SPICE", 200),
  line("2026-08-05", "SHI/26-27/094", "Sri Lakshmi Agencies", "SHI-ORG-TRAY", 180),
  line("2026-08-19", "SHI/26-27/105", "Gupta Distributors", "SHI-CNT-SET3", 260),
  line("2026-08-26", "SHI/26-27/111", "Bose Trading Co", "SHI-BTL-1000", 120, null),
  line("2026-09-02", "SHI/26-27/117", "Patil Home Needs", "SHI-LBX-INS", 100),
  line("2026-09-09", "SHI/26-27/122", "Gupta Distributors", "SHI-LBX-INS", 220),
  line("2026-09-09", "SHI/26-27/122", "Gupta Distributors", "SHI-BTL-1000", 260),
  line("2026-09-16", "SHI/26-27/128", "Sri Lakshmi Agencies", "SHI-CNT-SET3", 240),
  line("2026-09-16", "SHI/26-27/128", "Sri Lakshmi Agencies", "SHI-LBX-3C", 220),
  line("2026-09-16", "SHI/26-27/128", "Sri Lakshmi Agencies", "SHI-LBX-3C", 220),
  line("2026-09-23", "SHI/26-27/133", "Bose Trading Co", "SHI-ORG-SPICE", 160),
  line("2026-09-28", "CN/26-27/007", "Gupta Distributors", "SHI-BTL-750", -40),
];

/** Item-level distributor sales, including every Apex Retail invoice line. */
export function salesRegisterLines(): SalesRegisterLine[] {
  const apexLines = apexInvoices.flatMap((invoice) =>
    invoice.lines.map((invoiceLine) =>
      line(
        invoice.date,
        invoice.number,
        "Apex Retail Pvt Ltd",
        invoiceLine.sku,
        invoiceLine.quantity,
      ),
    ),
  );

  return [...otherDistributorLines, ...apexLines].sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.voucher.localeCompare(right.voucher),
  );
}

export function lineAmount(registerLine: Pick<SalesRegisterLine, "sku" | "quantity">): number {
  return productBySku(registerLine.sku).rate * registerLine.quantity;
}

export interface MonthlyRegionFigure {
  month: string;
  region: Region;
  amount: number;
}

/** Monthly distributor sales budget before GST, set at the start of FY 2026-27. */
export const distributorBudget: readonly MonthlyRegionFigure[] = [
  ["2026-04", 55_000, 40_000, 25_000, 210_000],
  ["2026-05", 55_000, 45_000, 25_000, 230_000],
  ["2026-06", 60_000, 45_000, 25_000, 240_000],
  ["2026-07", 65_000, 50_000, 30_000, 240_000],
  ["2026-08", 70_000, 55_000, 30_000, 240_000],
  ["2026-09", 100_000, 80_000, 35_000, 250_000],
].flatMap(([month, north, south, east, west]) =>
  (
    [
      ["North", north],
      ["South", south],
      ["East", east],
      ["West", west],
    ] as const
  ).map(([region, amount]) => ({ month: String(month), region, amount: Number(amount) })),
);

/** Monthly online-store targets on order value including GST. */
export const onlineTargets: readonly MonthlyRegionFigure[] = [
  ["2026-07", 2_000, 2_000, 500, 2_000],
  ["2026-08", 3_500, 3_000, 1_000, 2_500],
  ["2026-09", 4_000, 4_000, 1_000, 3_000],
].flatMap(([month, north, south, east, west]) =>
  (
    [
      ["North", north],
      ["South", south],
      ["East", east],
      ["West", west],
    ] as const
  ).map(([region, amount]) => ({ month: String(month), region, amount: Number(amount) })),
);

export interface ShopifyOrderLine {
  order: string;
  /** ISO date, except one order entered in a different format as a seeded data-quality issue. */
  date: string;
  region: Region | null;
  sku: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  status: "paid" | "refunded";
}

function order(
  orderName: string,
  date: string,
  region: Region | null,
  sku: string,
  quantity: number,
  discount = 0,
  status: ShopifyOrderLine["status"] = "paid",
): ShopifyOrderLine {
  return {
    order: orderName,
    date,
    region,
    sku,
    quantity,
    unitPrice: productBySku(sku).mrp,
    discount,
    status,
  };
}

// Seeded issues: order #1212 has a day-first date, #1215 has no region, and #1210 was part refunded.
export const shopifyOrderLines: readonly ShopifyOrderLine[] = [
  order("#1201", "2026-07-02", "North", "SHI-BTL-1000", 2),
  order("#1202", "2026-07-03", "West", "SHI-CNT-SET3", 1),
  order("#1203", "2026-07-06", "South", "SHI-LBX-INS", 1, 60),
  order("#1203", "2026-07-06", "South", "SHI-BTL-750", 2),
  order("#1204", "2026-07-11", "East", "SHI-ORG-SPICE", 1),
  order("#1205", "2026-07-15", "West", "SHI-LBX-3C", 2),
  order("#1206", "2026-07-19", "North", "SHI-CNT-1000", 4),
  order("#1207", "2026-07-24", "South", "SHI-BTL-1000", 1),
  order("#1208", "2026-07-28", "West", "SHI-ORG-TRAY", 2),
  order("#1209", "2026-08-03", "North", "SHI-LBX-INS", 2, 120),
  order("#1210", "2026-08-08", "West", "SHI-CNT-SET3", 2, 100),
  order("#1211", "2026-08-12", "South", "SHI-BTL-1000", 3, 135),
  order("#1211", "2026-08-12", "South", "SHI-BTL-750", 2),
  order("#1212", "14/08/2026", "East", "SHI-CNT-SET3", 1, 50),
  order("#1213", "2026-08-15", "North", "SHI-LBX-3C", 3, 105),
  order("#1214", "2026-08-15", "West", "SHI-BTL-1000", 2, 90),
  order("#1215", "2026-08-16", null, "SHI-ORG-SPICE", 2, 60),
  order("#1216", "2026-08-21", "South", "SHI-CNT-1000", 6),
  order("#1210", "2026-08-24", "West", "SHI-CNT-SET3", -1, -50, "refunded"),
  order("#1217", "2026-08-29", "East", "SHI-LBX-INS", 1),
  order("#1218", "2026-09-02", "North", "SHI-BTL-1000", 4),
  order("#1219", "2026-09-05", "South", "SHI-LBX-INS", 2),
  order("#1219", "2026-09-05", "South", "SHI-LBX-3C", 2),
  order("#1220", "2026-09-09", "West", "SHI-CNT-SET3", 3),
  order("#1221", "2026-09-12", "North", "SHI-ORG-TRAY", 3),
  order("#1222", "2026-09-16", "East", "SHI-BTL-1000", 2),
  order("#1223", "2026-09-19", "South", "SHI-CNT-SET3", 2),
  order("#1224", "2026-09-22", "West", "SHI-LBX-INS", 2),
  order("#1225", "2026-09-25", "North", "SHI-ORG-SPICE", 3),
  order("#1226", "2026-09-28", "South", "SHI-BTL-750", 4),
  order("#1227", "2026-09-30", "North", "SHI-LBX-3C", 2),
];

export function shopifyLineTotal(orderLine: ShopifyOrderLine): number {
  return orderLine.unitPrice * orderLine.quantity - orderLine.discount;
}

export function monthLabel(month: string): string {
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const [year, monthNumber] = month.split("-");

  return `${names[Number(monthNumber) - 1] ?? month} ${year ?? ""}`.trim();
}
