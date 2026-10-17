import { describe, expect, it } from "vitest";

import type { Metric } from "./metrics.js";
import { allowedNarrativeValues, findUnverifiedNumbers, renderNarrative } from "./narrative.js";

const metrics = new Map<string, Metric>(
  [
    { id: "total-amount", label: "Total", value: 92000, unit: "currency" as const },
    { id: "growth", label: "Growth", value: 50, unit: "percent" as const },
    { id: "change", label: "Change", value: -53.33, unit: "percent" as const },
    { id: "share", label: "Share", value: 40.43, unit: "percent" as const },
  ].map((metric) => [metric.id, { ...metric, basis: "test" }]),
);

describe("renderNarrative", () => {
  it("replaces placeholders with exact formatted values", () => {
    const rendered = renderNarrative(
      "Sales reached {{total-amount}}, up {{ growth }}; May fell {{change}}.",
      "summary",
      metrics,
      { currency: "INR" },
    );

    expect(rendered.text).toBe("Sales reached ₹92,000, up 50%; May fell -53.33%.");
    expect(rendered.metricIds).toEqual(["total-amount", "growth", "change"]);
    expect(rendered.issues).toEqual([]);
  });

  it("flags unknown placeholders and numbers that match no metric", () => {
    const rendered = renderNarrative(
      "Sales reached 95,000 ({{total-revenue}}), with South at 41% and 3 regions growing.",
      "trends",
      metrics,
    );

    expect(rendered.text).toContain("[figure not computed]");
    expect(rendered.issues.map((issue) => [issue.kind, issue.token])).toEqual([
      ["unverified-number", "95,000"],
      ["unverified-number", "41%"],
      ["unknown-metric", "{{total-revenue}}"],
    ]);
  });
});

describe("findUnverifiedNumbers", () => {
  const allowed = allowedNarrativeValues([
    { value: 92000, unit: "currency" },
    { value: 40.43, unit: "percent" },
    { value: -53.33, unit: "percent" },
    { value: 50, unit: "percent" },
  ]);

  it("accepts computed values, rounded forms, small counts, years, and dates", () => {
    expect(
      findUnverifiedNumbers(
        "Total ₹92,000 (92,000) in 2024; share 40.43% (about 40%); fell 53.3% or -53.33% in 2024-05 across 4 regions on 15/03/2024.",
        allowed,
        { currencyCode: "INR" },
      ),
    ).toEqual([]);
  });

  it("ignores digits inside identifiers", () => {
    expect(findUnverifiedNumbers("Order SO-1027 and FY2025 and Q3", allowed)).toEqual([]);
  });

  it("flags other figures", () => {
    expect(findUnverifiedNumbers("Revenue was 1,05,000 and margin 12.5%", allowed)).toEqual([
      "1,05,000",
      "12.5%",
    ]);
  });

  it("checks signs, currency marks, percent signs, and leading decimals", () => {
    expect(
      findUnverifiedNumbers(
        "Revenue was -92,000, or ₹2024, or Rs. 50, or 92,000%, while margin was .5% and -50%.",
        allowed,
        { currencyCode: "INR" },
      ),
    ).toEqual(["-92,000", "₹2024", "Rs. 50", "92,000%", ".5%", "-50%"]);
  });

  it("requires explicit positive signs to match positive metrics", () => {
    expect(findUnverifiedNumbers("Growth was +53.33%.", allowed)).toEqual(["+53.33%"]);
    expect(findUnverifiedNumbers("Growth fell 53.33%.", allowed)).toEqual([]);
    expect(findUnverifiedNumbers("Growth was +50%.", allowed)).toEqual([]);
  });

  it("validates full scientific-notation values instead of partial numbers", () => {
    expect(findUnverifiedNumbers("Total 95e3; growth 9.5e4; change 1e-1.", allowed)).toEqual([
      "95e3",
      "9.5e4",
      "1e-1",
    ]);
    expect(findUnverifiedNumbers("Total 9.2e4.", [{ value: 92000, unit: "currency" }])).toEqual([]);
  });

  it("flags amounts written in a denomination other than the data's", () => {
    const text = "Sales were $92,000, £92,000, €92,000, USD 92,000, or ₹92,000.";

    expect(findUnverifiedNumbers(text, allowed, { currencyCode: "INR" })).toEqual([
      "$92,000",
      "£92,000",
      "€92,000",
      "USD 92,000",
    ]);
    expect(findUnverifiedNumbers(text, allowed, { currencyCode: "USD" })).toEqual([
      "£92,000",
      "€92,000",
      "₹92,000",
    ]);
    expect(findUnverifiedNumbers("Sales were $92,000.", allowed)).toEqual(["$92,000"]);
  });

  it("validates suffix denominations, attached codes, and conflicting currency markers", () => {
    const text =
      "92,000 USD; 92000USD; 92,000 INR; 92000INR; 95000USD; $92,000 INR; ₹92,000 USD; 92000 EUR; 92000GBP.";

    expect(findUnverifiedNumbers(text, allowed, { currencyCode: "INR" })).toEqual([
      "92,000 USD",
      "92000USD",
      "95000USD",
      "$92,000 INR",
      "₹92,000 USD",
      "92000 EUR",
      "92000GBP",
    ]);
    expect(findUnverifiedNumbers(text, allowed, { currencyCode: "USD" })).toEqual([
      "92,000 INR",
      "92000INR",
      "95000USD",
      "$92,000 INR",
      "₹92,000 USD",
      "92000 EUR",
      "92000GBP",
    ]);
    expect(findUnverifiedNumbers("4 USD; 2024 INR; 92000INR", allowed)).toEqual([
      "4 USD",
      "2024 INR",
      "92000INR",
    ]);
    expect(
      findUnverifiedNumbers(
        "$123; 123 USD; 123 INR; USD123USD",
        [{ value: 123, unit: "currency" }],
        { currencyCode: "USD" },
      ),
    ).toEqual(["123 INR"]);
    expect(findUnverifiedNumbers("92000   USD", allowed, { currencyCode: "INR" })).toEqual([
      "92000   USD",
    ]);
  });
});
