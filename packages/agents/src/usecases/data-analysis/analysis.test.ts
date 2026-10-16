import type { ExtractedTable } from "@evianta/core";
import { describe, expect, it } from "vitest";

import {
  CSV_MIME,
  extractFixtureAsync,
  fixtureMetadata,
  SALES_EXPECTED,
  salesCsv,
  salesWorkbook,
  XLSX_MIME,
} from "../../testing/salesFixture.js";
import {
  analyzeTable,
  DataAnalysisError,
  selectAnalysisSource,
  type DataAnalysis,
} from "./analysis.js";

async function csvTableAsync(csv = salesCsv()): Promise<ExtractedTable> {
  const buffer = new TextEncoder().encode(csv);
  const extraction = await extractFixtureAsync(
    buffer,
    fixtureMetadata("doc-csv", "sales.csv", CSV_MIME, buffer.byteLength),
  );

  return extraction.tables[0] as ExtractedTable;
}

async function xlsxTableAsync(): Promise<ExtractedTable> {
  const buffer = salesWorkbook();
  const extraction = await extractFixtureAsync(
    buffer,
    fixtureMetadata("doc-xlsx", "sales.xlsx", XLSX_MIME, buffer.byteLength),
  );

  return extraction.tables[0] as ExtractedTable;
}

function metricValue(analysis: DataAnalysis, id: string): number | undefined {
  return analysis.metricsById.get(id)?.value;
}

function issue(analysis: DataAnalysis, id: string) {
  return analysis.issues.find((candidate) => candidate.id === id);
}

describe("ingested sales fixtures", () => {
  it("parses the CSV with mixed types kept as text", async () => {
    const table = await csvTableAsync();

    expect(table.range).toBe("A1:G29");
    expect(table.rows).toHaveLength(SALES_EXPECTED.dataRows);
    expect(table.columns.map((column) => column.type)).toEqual([
      "string",
      "string",
      "string",
      "string",
      "string",
      "number",
      "string",
    ]);
  });

  it("parses the Excel variant into the same shape on a named sheet", async () => {
    const table = await xlsxTableAsync();

    expect(table.sheet).toBe("Sales");
    expect(table.range).toBe("A1:G29");
    expect(table.rows).toHaveLength(SALES_EXPECTED.dataRows);
    expect(table.columns[6]?.type).toBe("string");
  });
});

describe("analyzeTable", () => {
  it("infers column roles", async () => {
    const analysis = analyzeTable({
      documentId: "doc-csv",
      documentName: "sales.csv",
      table: await csvTableAsync(),
    });

    expect(analysis.columns.map((column) => column.role)).toEqual([
      "identifier",
      "date",
      "category",
      "category",
      "category",
      "quantity",
      "amount",
    ]);
    expect(analysis.roles.amount.name).toBe("Amount (INR)");
    expect(analysis.roles.date?.name).toBe("Order Date");
    expect(analysis.roles.categories.map((column) => column.name)).toEqual([
      "Region",
      "Product",
      "Channel",
    ]);
    expect(analysis.currency).toBe("INR");
  });

  it("computes exact metrics, excluding duplicates and non-numeric amounts", async () => {
    const analysis = analyzeTable({
      documentId: "doc-csv",
      documentName: "sales.csv",
      table: await csvTableAsync(),
    });

    expect(analysis.analyzedRows).toHaveLength(SALES_EXPECTED.analyzedRows);
    expect(metricValue(analysis, "rows-analyzed")).toBe(SALES_EXPECTED.analyzedRows);
    expect(metricValue(analysis, "rows-with-amount")).toBe(SALES_EXPECTED.rowsWithAmount);
    expect(metricValue(analysis, "total-amount")).toBe(SALES_EXPECTED.totalAmount);
    expect(metricValue(analysis, "average-amount")).toBe(SALES_EXPECTED.averageAmount);
    expect(metricValue(analysis, "total-quantity")).toBe(SALES_EXPECTED.totalQuantity);
    expect(analysis.periods.map((period) => [period.period, period.total])).toEqual(
      SALES_EXPECTED.monthlyTotals,
    );
    expect(
      analysis.periods.flatMap((period) =>
        period.changePct === undefined ? [] : [period.changePct],
      ),
    ).toEqual(SALES_EXPECTED.monthlyChangePct);
    expect(metricValue(analysis, "period-2024-04-change-pct")).toBe(150);
    expect(metricValue(analysis, "growth-first-to-last-pct")).toBe(
      SALES_EXPECTED.growthFirstToLastPct,
    );
    expect(metricValue(analysis, "average-monthly-change-pct")).toBe(24.58);
    expect(metricValue(analysis, "trend-slope-per-month")).toBe(SALES_EXPECTED.trendSlopePerMonth);
    expect(metricValue(analysis, "period-count")).toBe(6);
  });

  it("ranks segments with shares and groups blanks as Unassigned", async () => {
    const analysis = analyzeTable({
      documentId: "doc-csv",
      documentName: "sales.csv",
      table: await csvTableAsync(),
    });
    const region = analysis.segments[0];

    expect(region?.column).toBe("Region");
    expect(
      region?.segments.map((segment) => [segment.label, segment.total, segment.sharePct]),
    ).toEqual(SALES_EXPECTED.regionTotals);
    expect(region?.top?.label).toBe("South");
    expect(region?.bottom?.label).toBe("East");
    expect(metricValue(analysis, "segment-region-south-total")).toBe(37200);
    expect(metricValue(analysis, "segment-region-south-share-pct")).toBe(40.43);
    expect(metricValue(analysis, "segment-region-unassigned-total")).toBe(2500);
    expect(analysis.segments[1]?.segments.map((segment) => [segment.label, segment.total])).toEqual(
      [
        ["Widget", 41800],
        ["Gadget", 37200],
        ["Gizmo", 13000],
      ],
    );
  });

  it("reports each data-quality issue with cell-range evidence", async () => {
    const analysis = analyzeTable({
      documentId: "doc-csv",
      documentName: "sales.csv",
      table: await csvTableAsync(),
    });

    expect(analysis.issues.map((item) => item.id)).toEqual([
      "dq-duplicate-rows",
      "dq-missing-values-region",
      "dq-missing-values-amount-inr",
      "dq-type-mismatch-amount-inr",
      "dq-negative-values-quantity",
      "dq-negative-values-amount-inr",
      "dq-inconsistent-date-formats-order-date",
    ]);
    expect(issue(analysis, "dq-duplicate-rows")).toMatchObject({
      severity: "medium",
      rows: [25],
      locations: [{ cellRange: "A27:G27", rowRange: { start: 27, end: 27 } }],
    });
    expect(issue(analysis, "dq-missing-values-region")?.locations).toEqual([
      { cellRange: "C25", rowRange: { start: 25, end: 25 } },
    ]);
    expect(issue(analysis, "dq-missing-values-amount-inr")?.locations[0]?.cellRange).toBe("G29");
    expect(issue(analysis, "dq-type-mismatch-amount-inr")).toMatchObject({
      examples: ["pending"],
      locations: [{ cellRange: "G28" }],
    });
    expect(issue(analysis, "dq-negative-values-amount-inr")?.locations[0]?.cellRange).toBe("G22");
    expect(issue(analysis, "dq-negative-values-quantity")?.severity).toBe("low");
    expect(issue(analysis, "dq-inconsistent-date-formats-order-date")).toMatchObject({
      rows: [8, 9],
      locations: [{ cellRange: "B10:B11", rowRange: { start: 10, end: 11 } }],
    });
    expect(issue(analysis, "dq-inconsistent-date-formats-order-date")?.message).toContain(
      "yyyy-mm-dd (26), dd/mm/yyyy (1), mm/dd/yyyy (1)",
    );
    expect(metricValue(analysis, "dq-duplicate-rows-rows")).toBe(1);
  });

  it("flags the April spike against the robust trend and nothing else", async () => {
    const analysis = analyzeTable({
      documentId: "doc-csv",
      documentName: "sales.csv",
      table: await csvTableAsync(),
    });

    expect(analysis.anomalies).toHaveLength(1);
    expect(analysis.anomalies[0]).toMatchObject({
      ...SALES_EXPECTED.anomaly,
      direction: "spike",
      id: "anomaly-2024-04",
    });
    expect(analysis.anomalies[0]?.score).toBeGreaterThan(3.5);
    expect(metricValue(analysis, "anomaly-2024-04-expected")).toBe(13000);
    expect(metricValue(analysis, "anomaly-2024-04-deviation-pct")).toBe(130.77);
  });

  it("gives the same results for the Excel variant, with sheet-qualified locations", async () => {
    const csv = analyzeTable({
      documentId: "doc-csv",
      documentName: "sales.csv",
      table: await csvTableAsync(),
    });
    const xlsx = analyzeTable({
      documentId: "doc-xlsx",
      documentName: "sales.xlsx",
      table: await xlsxTableAsync(),
    });

    expect(xlsx.metrics.map(({ id, value }) => [id, value])).toEqual(
      csv.metrics.map(({ id, value }) => [id, value]),
    );
    expect(xlsx.issues.map((item) => [item.id, item.rows])).toEqual(
      csv.issues.map((item) => [item.id, item.rows]),
    );
    expect(issue(xlsx, "dq-type-mismatch-amount-inr")?.locations[0]).toEqual({
      sheet: "Sales",
      cellRange: "G28",
      rowRange: { start: 28, end: 28 },
    });
    expect(xlsx.locations.amount).toMatchObject({ sheet: "Sales", cellRange: "G2:G29" });
  });

  it("flags out-of-range and unreadable dates and keeps them out of the trend", async () => {
    const table = await csvTableAsync(
      [
        "Date,Amount",
        "2024-01-10,100",
        "2024-02-10,110",
        "2024-03-10,120",
        "1924-03-11,500",
        "someday,50",
      ].join("\n"),
    );
    const analysis = analyzeTable({ documentId: "doc", documentName: "small.csv", table });

    expect(analysis.issues.map((item) => [item.id, item.rows])).toEqual([
      ["dq-type-mismatch-date", [4]],
      ["dq-out-of-range-date", [3]],
    ]);
    expect(analysis.periods.map((period) => period.period)).toEqual([
      "2024-01",
      "2024-02",
      "2024-03",
    ]);
    expect(metricValue(analysis, "total-amount")).toBe(880);
  });

  it("asks to confirm zero-filled months and the order chosen for ambiguous dates", async () => {
    const table = await csvTableAsync(
      ["Date,Amount", "2024-01-10,100", "15/03/2024,120", "03/22/2024,50", "05/04/2024,70"].join(
        "\n",
      ),
    );
    const analysis = analyzeTable({ documentId: "doc", documentName: "gaps.csv", table });

    expect(analysis.periods.map((period) => [period.period, period.total])).toEqual([
      ["2024-01", 100],
      ["2024-02", 0],
      ["2024-03", 170],
      ["2024-04", 70],
    ]);
    expect(analysis.questions.map((question) => question.severity)).toEqual(["medium", "medium"]);
    expect(analysis.questions[0]?.text).toContain("day/month/year");
    expect(analysis.questions[1]?.text).toContain("(2024-02) mean no sales");
  });

  it("gives colliding column names distinct issue ids", async () => {
    const table = await csvTableAsync(
      [
        "Sales Region,Sales-Region,Amount",
        "North,,10",
        ",East,20",
        "South,West,30",
        "North,East,40",
      ].join("\n"),
    );
    const analysis = analyzeTable({ documentId: "doc", documentName: "regions.csv", table });

    expect(
      analysis.issues.map((item) => [item.id, item.column, item.locations[0]?.cellRange]),
    ).toEqual([
      ["dq-missing-values-sales-region", "Sales Region", "A3"],
      ["dq-missing-values-sales-region-2", "Sales-Region", "B2"],
    ]);
  });

  it("rounds averages on their decimal value", async () => {
    const positive = analyzeTable({
      documentId: "doc",
      documentName: "small.csv",
      table: await csvTableAsync("Amount\n10.07\n10.08"),
    });
    const negative = analyzeTable({
      documentId: "doc",
      documentName: "small.csv",
      table: await csvTableAsync("Amount\n-10.07\n-10.08"),
    });

    expect(metricValue(positive, "average-amount")).toBe(10.08);
    expect(metricValue(negative, "average-amount")).toBe(-10.08);
  });
  it("leaves amounts in another currency out of the totals and flags them", async () => {
    const analysis = analyzeTable({
      documentId: "doc",
      documentName: "fx.csv",
      table: await csvTableAsync("Amount\n₹100\n$100\n₹50"),
    });

    expect(analysis.currency).toBe("INR");
    expect(metricValue(analysis, "total-amount")).toBe(150);
    expect(analysis.issues.map((item) => [item.id, item.rows, item.severity])).toEqual([
      ["dq-mixed-currencies-amount", [1], "high"],
    ]);
  });

  it("does not let exact repeats move the date baseline", async () => {
    const repeated = Array.from({ length: 5 }, () => "1924-03-11,500");
    const analysis = analyzeTable({
      documentId: "doc",
      documentName: "repeats.csv",
      table: await csvTableAsync(
        ["Date,Amount", "2024-01-10,100", "2024-02-10,110", "2024-03-10,120", ...repeated].join(
          "\n",
        ),
      ),
    });

    expect(analysis.issues.find((item) => item.kind === "out-of-range")?.rows).toEqual([
      3, 4, 5, 6, 7,
    ]);
    expect(analysis.periods.map((period) => period.period)).toEqual([
      "2024-01",
      "2024-02",
      "2024-03",
    ]);
  });

  it("reads exponent and trailing-dot numbers in a mixed column", async () => {
    const analysis = analyzeTable({
      documentId: "doc",
      documentName: "mixed.csv",
      table: await csvTableAsync("Amount\n100\n200.\n300\n1e3\npending"),
    });

    expect(metricValue(analysis, "total-amount")).toBe(1600);
    expect(analysis.issues.map((item) => [item.id, item.rows])).toEqual([
      ["dq-type-mismatch-amount", [4]],
    ]);
  });

  it("averages the unrounded total", async () => {
    const analysis = analyzeTable({
      documentId: "doc",
      documentName: "small.csv",
      table: await csvTableAsync("Amount\n1.004\n1.005"),
    });

    expect(metricValue(analysis, "total-amount")).toBe(2.01);
    expect(metricValue(analysis, "average-amount")).toBe(1);
  });
  it("fails clearly when a table has no amount column", async () => {
    const table = await csvTableAsync("Region,Owner\nNorth,Asha\nSouth,Ravi");

    expect(() => analyzeTable({ documentId: "doc", documentName: "people.csv", table })).toThrow(
      DataAnalysisError,
    );
    expect(selectAnalysisSource([{ documentId: "doc", documentName: "people.csv", table }])).toBe(
      undefined,
    );
  });
});
