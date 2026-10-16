import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatIndianCompact,
  formatInr,
  formatInrCompact,
  formatNumber,
  formatPercent,
} from "./format";

describe("en-IN number formatting", () => {
  it("groups digits in lakh and crore positions", () => {
    expect(formatNumber(123_456_789)).toBe("12,34,56,789");
    expect(formatNumber(100_000)).toBe("1,00,000");
    expect(formatNumber(1234.567)).toBe("1,234.57");
  });

  it("formats rupee amounts with Indian grouping", () => {
    expect(formatInr(4_820_000)).toBe("₹48,20,000");
    expect(formatInr(48_200_000)).toBe("₹4,82,00,000");
    expect(formatInr(1234.5)).toBe("₹1,234.5");
    expect(formatInr(1234.5, { minimumFractionDigits: 2 })).toBe("₹1,234.50");
    expect(formatInr(-42_000)).toBe("-₹42,000");
  });

  it("abbreviates large rupee amounts to lakh and crore", () => {
    expect(formatInrCompact(48_200_000)).toBe("₹4.82 crore");
    expect(formatInrCompact(10_000_000)).toBe("₹1 crore");
    expect(formatInrCompact(4_820_000)).toBe("₹48.2 lakh");
    expect(formatInrCompact(100_000)).toBe("₹1 lakh");
    expect(formatInrCompact(1_875_000, 1)).toBe("₹18.8 lakh");
    expect(formatInrCompact(-2_500_000)).toBe("-₹25 lakh");
    expect(formatInrCompact(95_000)).toBe("₹95,000");
    expect(formatInrCompact(0.25)).toBe("₹0.25");
    expect(formatInrCompact(1234.5, 2)).toBe("₹1,234.5");
    expect(formatInrCompact(2_500_000_000)).toBe("₹250 crore");
  });

  it("abbreviates plain numbers to lakh and crore", () => {
    expect(formatIndianCompact(1_843_000)).toBe("18.43 lakh");
    expect(formatIndianCompact(32_000_000)).toBe("3.2 crore");
    expect(formatIndianCompact(42_000)).toBe("42,000");
    expect(formatIndianCompact(1234.5, 2)).toBe("1,234.5");
  });

  it("formats percentages", () => {
    expect(formatPercent(0.125)).toBe("12.5%");
    expect(formatPercent(0.98, 0)).toBe("98%");
  });
});

describe("en-IN date formatting", () => {
  it("formats dates in India Standard Time", () => {
    expect(formatDate("2026-01-12T10:00:00+05:30")).toBe("12 Jan 2026");
    expect(formatDate("2026-01-11T20:00:00Z")).toBe("12 Jan 2026");
    expect(formatDate(new Date(Date.UTC(2026, 9, 15, 6, 0)))).toBe("15 Oct 2026");
  });

  it("formats date and time in India Standard Time", () => {
    expect(formatDateTime("2026-10-15T14:05:00+05:30")).toMatch(/^15 Oct 2026, 2:05\spm$/i);
  });
});
