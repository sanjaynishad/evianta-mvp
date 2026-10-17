import { describe, expect, it } from "vitest";

import {
  chartSpecSchema,
  dashboardSpecSchema,
  parseChartSpecContent,
  type ChartSpecInput,
} from "./index.js";

const monthlySales: ChartSpecInput = {
  id: "chart-monthly-sales",
  type: "bar",
  title: "Net sales by month",
  categoryKey: "month",
  series: [{ key: "netSales", label: "Net sales" }],
  data: [
    { month: "Apr", netSales: 1250000 },
    { month: "May", netSales: 1410000 },
  ],
  yAxis: { format: "currency-inr" },
  source: { aggregation: "Sum of net sales by invoice month" },
};

describe("chartSpecSchema", () => {
  it("applies axis and source defaults", () => {
    const parsed = chartSpecSchema.parse(monthlySales);

    expect(parsed.yAxis?.format).toBe("currency-inr");
    expect(parsed.source?.evidenceIds).toEqual([]);
  });

  it("requires exactly one series for a pie chart", () => {
    const result = chartSpecSchema.safeParse({
      ...monthlySales,
      type: "pie",
      series: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("accepts every supported chart type", () => {
    for (const type of ["bar", "line", "area"] as const) {
      expect(chartSpecSchema.parse({ ...monthlySales, type }).type).toBe(type);
    }
  });

  it("rejects an unknown chart type", () => {
    expect(chartSpecSchema.safeParse({ ...monthlySales, type: "radar" }).success).toBe(false);
  });
});

describe("dashboardSpecSchema", () => {
  it("needs at least one chart", () => {
    expect(dashboardSpecSchema.safeParse({ charts: [] }).success).toBe(false);
    expect(dashboardSpecSchema.parse({ charts: [monthlySales] }).charts).toHaveLength(1);
  });
});

describe("parseChartSpecContent", () => {
  it("parses a JSON chart section", () => {
    const result = parseChartSpecContent(JSON.stringify(monthlySales));

    expect(result.success && result.spec.id).toBe("chart-monthly-sales");
  });

  it("reports invalid JSON and invalid specs", () => {
    expect(parseChartSpecContent("{not json").success).toBe(false);
    expect(parseChartSpecContent(JSON.stringify({ id: "x" })).success).toBe(false);
  });
});
