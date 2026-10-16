import { describe, expect, it } from "vitest";

import { parseDelimitedText } from "./spreadsheet.js";

describe("parseDelimitedText", () => {
  it("guesses the delimiter even with blank lines", () => {
    const result = parseDelimitedText("Party;Due\n\nAcme;1.200,50\nBeta;300\n\n", {
      name: "dues",
      dateOrder: "dmy",
    });

    expect(result.warnings).toEqual([]);
    expect(result.tables[0]).toEqual({
      name: "dues",
      range: "A1:B4",
      columns: [
        { name: "Party", type: "string" },
        { name: "Due", type: "string" },
      ],
      rows: [
        [null, null],
        ["Acme", "1.200,50"],
        ["Beta", "300"],
      ],
    });
  });

  it("keeps quoted multi-line fields in one row", () => {
    const result = parseDelimitedText('Note,Amount\n"Line one\nLine two",5\n', {
      name: "notes",
      dateOrder: "dmy",
    });

    expect(result.tables[0]?.rows).toEqual([["Line one\nLine two", 5]]);
  });

  it("reports malformed rows as warnings", () => {
    const result = parseDelimitedText('a,b\n"unterminated,1\n', { name: "bad", dateOrder: "dmy" });

    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns when there is no data", () => {
    expect(parseDelimitedText("\n\n", { name: "empty", dateOrder: "dmy" })).toEqual({
      tables: [],
      warnings: ["The file has no data."],
    });
  });
});
