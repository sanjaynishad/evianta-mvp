import { describe, expect, it } from "vitest";

import { detectPeriodAnomalies } from "./anomalies.js";
import { isMissingCell, parseNumericCell, resolveDateColumn } from "./cells.js";
import { robustZScores, roundTo, theilSenFit } from "./stats.js";

function series(values: readonly number[]) {
  return values.map((total, index) => ({
    period: `2024-${String(index + 1).padStart(2, "0")}`,
    total,
    rows: [index],
  }));
}

describe("parseNumericCell", () => {
  it("reads numbers written with grouping, currency, signs, and parentheses", () => {
    expect(parseNumericCell(1250.5)).toBe(1250.5);
    expect(parseNumericCell("1,23,456.75")).toBe(123456.75);
    expect(parseNumericCell("₹ 2,500")).toBe(2500);
    expect(parseNumericCell("Rs. 1,000")).toBe(1000);
    expect(parseNumericCell("-₹300")).toBe(-300);
    expect(parseNumericCell("(1,200)")).toBe(-1200);
    expect(parseNumericCell("pending")).toBeUndefined();
    expect(parseNumericCell("12 boxes")).toBeUndefined();
    expect(parseNumericCell(true)).toBeUndefined();
  });

  it("treats blanks and placeholders as missing", () => {
    expect(isMissingCell(null)).toBe(true);
    expect(isMissingCell("  ")).toBe(true);
    expect(isMissingCell("N/A")).toBe(true);
    expect(isMissingCell("-")).toBe(true);
    expect(isMissingCell(0)).toBe(false);
  });
});

describe("resolveDateColumn", () => {
  it("reads each numeric date in the only order it fits and reports the conflict", () => {
    const resolution = resolveDateColumn(["15/03/2024", "03/22/2024", "2024-03-01", "05/04/2024"]);

    expect(resolution.conflictingOrders).toBe(true);
    expect(resolution.dates.map((date) => date?.iso)).toEqual([
      "2024-03-15",
      "2024-03-22",
      "2024-03-01",
      "2024-04-05",
    ]);
    expect(resolution.dates.map((date) => date?.format)).toEqual([
      "dd/mm/yyyy",
      "mm/dd/yyyy",
      "yyyy-mm-dd",
      "dd/mm/yyyy",
    ]);
    expect(resolution.ambiguousCount).toBe(1);
  });

  it("uses the order the column implies for ambiguous dates", () => {
    const resolution = resolveDateColumn(["04/13/2024", "05/06/2024"]);

    expect(resolution.order).toBe("mdy");
    expect(resolution.dates[1]?.iso).toBe("2024-05-06");
  });

  it("reads named-month dates and rejects impossible ones", () => {
    const resolution = resolveDateColumn(["7 Mar 2024", "Mar 8, 2024", "31/02/2024", 45000]);

    expect(resolution.dates.map((date) => date?.iso)).toEqual([
      "2024-03-07",
      "2024-03-08",
      undefined,
      undefined,
    ]);
  });
});

describe("robust statistics", () => {
  it("fits the Theil-Sen trend through an outlier", () => {
    expect(theilSenFit([10, 11, 12, 30, 14, 15])).toEqual({ slope: 1, intercept: 10 });
  });

  it("scores with the median absolute deviation and falls back when it is zero", () => {
    expect(robustZScores([1, 2, 3, 4, 100])?.method).toBe("median-absolute-deviation");
    expect(robustZScores([0, 0, 0, 0, 10])?.method).toBe("mean-absolute-deviation");
    expect(robustZScores([5, 5, 5])).toBeUndefined();
  });

  it("rounds half away from zero", () => {
    expect(roundTo(1.005)).toBe(1.01);
    expect(roundTo(-1.005)).toBe(-1.01);
    expect(roundTo(130.7692307)).toBe(130.77);
  });
});

describe("detectPeriodAnomalies", () => {
  it("does not flag a steady growth trend", () => {
    expect(detectPeriodAnomalies(series([100, 112, 119, 131, 140, 152, 158, 171]))).toEqual([]);
  });

  it("flags a drop in a noisy series with the median absolute deviation", () => {
    const anomalies = detectPeriodAnomalies(series([100, 104, 97, 102, 99, 40, 101, 98, 103]));

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      period: "2024-06",
      direction: "drop",
      method: "median-absolute-deviation",
      rows: [5],
    });
    expect(anomalies[0]?.score).toBeLessThan(-3.5);
  });

  it("needs at least four periods", () => {
    expect(detectPeriodAnomalies(series([10, 10, 1000]))).toEqual([]);
  });
});
