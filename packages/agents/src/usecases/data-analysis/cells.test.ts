import { describe, expect, it } from "vitest";

import { parseNumericCell } from "./cells.js";

describe("parseNumericCell", () => {
  it("rejects long whitespace-padded non-numeric currency values", () => {
    expect(parseNumericCell(`₹${" ".repeat(12_000)}X`)).toBeUndefined();
  });
});
