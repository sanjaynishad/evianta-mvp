import { describe, expect, it, vi } from "vitest";
import { read, utils, write } from "xlsx";

import { parseDelimitedText, parseWorkbook } from "./spreadsheet.js";

vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>();

  return { ...actual, read: vi.fn(actual.read) };
});

describe("parseWorkbook", () => {
  it.each(["XFD1048576", "ALL1001"])(
    "rejects sparse grids ending at %s before dense allocation",
    (lastCell) => {
      vi.mocked(read).mockReturnValueOnce({
        SheetNames: ["Sparse"],
        Sheets: {
          Sparse: { A1: { t: "s", v: "Header" }, [lastCell]: { t: "n", v: 1 } },
        },
      });

      expect(() => parseWorkbook(new Uint8Array(), { dateOrder: "dmy" })).toThrow(
        /1,000,000-cell expanded grid limit/,
      );
    },
  );

  it("applies the expanded cell budget across sheets", () => {
    const sheet = {
      A1: { t: "s" as const, v: "Header" },
      SG1000: { t: "n" as const, v: 1 },
    };
    vi.mocked(read).mockReturnValueOnce({
      SheetNames: ["First", "Second"],
      Sheets: { First: sheet, Second: sheet },
    });

    expect(() => parseWorkbook(new Uint8Array(), { dateOrder: "dmy" })).toThrow(
      /expanded grid limit/,
    );
  });

  it("preserves formatted numeric identifiers without changing numbers or dates", () => {
    const sheet = utils.aoa_to_sheet([
      ["Identifier", "Amount", "Date"],
      [123, 12.5, 45306],
      [456, 30, 45337],
    ]);
    sheet.A2 = { t: "n", v: 123, z: "00000" };
    sheet.B2 = { t: "n", v: 12.5, z: "0.00" };
    sheet.C2 = { t: "n", v: 45306, z: "yyyy-mm-dd" };
    sheet.C3 = { t: "n", v: 45337, z: "yyyy-mm-dd" };
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Data");
    const buffer: Uint8Array = write(workbook, { type: "buffer", bookType: "xlsx" });
    const result = parseWorkbook(buffer, { dateOrder: "dmy" });

    expect(result.tables[0]?.columns.map((column) => column.type)).toEqual([
      "string",
      "number",
      "date",
    ]);
    expect(result.tables[0]?.rows).toEqual([
      ["00123", 12.5, "2024-01-15"],
      ["456", 30, "2024-02-15"],
    ]);
  });
});

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
