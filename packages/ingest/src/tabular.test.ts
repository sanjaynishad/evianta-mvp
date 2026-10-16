import { describe, expect, it } from "vitest";

import {
  buildTable,
  cellAddress,
  columnLetters,
  resolveColumn,
  tableCellAddress,
  tableEvidenceLocation,
  type RawCell,
} from "./tabular.js";

const text = (value: string): RawCell => ({ kind: "text", text: value });

function grid(rows: string[][]): RawCell[][] {
  return rows.map((row) => row.map(text));
}

describe("resolveColumn", () => {
  it("infers numbers, including grouped digits", () => {
    expect(resolveColumn(["1,234.50", "12,34,567", "-7", "3e2"].map(text), "dmy")).toEqual({
      type: "number",
      cells: [1234.5, 1234567, -7, 300],
    });
  });

  it("keeps identifiers with leading zeros or too many digits as strings", () => {
    expect(resolveColumn(["00123", "456"].map(text), "dmy").type).toBe("string");
    expect(resolveColumn(["1234567890123456789"].map(text), "dmy").type).toBe("string");
  });

  it.each(["9,007,199,254,740,993", "-9,007,199,254,740,993", "0,012", "+0,012"])(
    "preserves grouped identifier %s exactly",
    (value) => {
      expect(resolveColumn([text(value)], "dmy")).toEqual({
        type: "string",
        cells: [value],
      });
    },
  );

  it("infers booleans and keeps empty cells as null", () => {
    expect(resolveColumn([text("TRUE"), text(" "), text("false")], "dmy")).toEqual({
      type: "boolean",
      cells: [true, null, false],
    });
  });

  it("normalizes ISO and named-month dates", () => {
    expect(resolveColumn(["2024-03-01", "5 Jan 2024", "Feb 29, 2024"].map(text), "dmy")).toEqual({
      type: "date",
      cells: ["2024-03-01", "2024-01-05", "2024-02-29"],
    });
  });

  it("accepts valid timestamps and keeps invalid times or offsets as strings", () => {
    expect(
      resolveColumn(["2024-03-01T23:59:59Z", "2024-03-01 10:30+05:30"].map(text), "dmy"),
    ).toEqual({
      type: "date",
      cells: ["2024-03-01T23:59:59Z", "2024-03-01T10:30+05:30"],
    });

    for (const value of [
      "2024-03-01T99:99:99Z",
      "2024-03-01T24:00",
      "2024-03-01T10:60",
      "2024-03-01T10:00:60",
      "2024-03-01T10:00+15:00",
      "2024-03-01T10:00-05:60",
    ]) {
      expect(resolveColumn([text(value)], "dmy")).toEqual({ type: "string", cells: [value] });
    }
  });

  it("resolves numeric date order per column", () => {
    expect(resolveColumn(["03/04/2024", "25/12/2024"].map(text), "mdy").cells).toEqual([
      "2024-04-03",
      "2024-12-25",
    ]);
    expect(resolveColumn(["03/04/2024", "12/25/2024"].map(text), "dmy").cells).toEqual([
      "2024-03-04",
      "2024-12-25",
    ]);
    expect(resolveColumn(["03/04/2024"].map(text), "dmy").cells).toEqual(["2024-04-03"]);
    expect(resolveColumn(["13/04/2024", "04/13/2024"].map(text), "dmy").type).toBe("string");
  });

  it("falls back to the original text for mixed columns", () => {
    expect(resolveColumn([text("12"), text("N/A"), { kind: "empty" }], "dmy")).toEqual({
      type: "string",
      cells: ["12", "N/A", null],
    });
  });

  it("reports all-empty columns as empty", () => {
    expect(resolveColumn([{ kind: "empty" }, text("")], "dmy")).toEqual({
      type: "empty",
      cells: [null, null],
    });
  });
});

describe("buildTable", () => {
  it("uses the first non-blank row as the header and keeps interior blank rows", () => {
    const table = buildTable(
      grid([
        [],
        ["", "Invoice", "Amount", "Invoice"],
        ["", "INV-1", "100", "x"],
        ["", "", "", ""],
        ["", "INV-2", "250.5", ""],
        ["", "", ""],
      ]),
      { name: "data", dateOrder: "dmy" },
    );

    expect(table).toEqual({
      name: "data",
      range: "B2:D5",
      columns: [
        { name: "Invoice", type: "string" },
        { name: "Amount", type: "number" },
        { name: "Invoice (2)", type: "string" },
      ],
      rows: [
        ["INV-1", 100, "x"],
        [null, null, null],
        ["INV-2", 250.5, null],
      ],
    });
  });

  it("names blank headers after their column letter", () => {
    const table = buildTable(
      grid([
        ["", "b"],
        ["1", "2"],
      ]),
      {
        name: "t",
        sheet: "S",
        origin: { row: 2, column: 1 },
        dateOrder: "dmy",
      },
    );

    expect(table?.columns.map((column) => column.name)).toEqual(["Column B", "b"]);
    expect(table?.range).toBe("B3:C4");
    expect(table?.sheet).toBe("S");
  });

  it("returns undefined for an empty grid", () => {
    expect(buildTable(grid([[""], []]), { name: "t", dateOrder: "dmy" })).toBeUndefined();
  });

  it("keeps generated header suffixes unique across literal suffixed headers", () => {
    const names = (headers: string[]) =>
      buildTable(grid([headers, headers.map(() => "x")]), {
        name: "t",
        dateOrder: "dmy",
      })?.columns.map((column) => column.name);

    expect(names(["Amount", "Amount", "Amount (2)"])).toEqual([
      "Amount",
      "Amount (2)",
      "Amount (2) (2)",
    ]);
    expect(names(["Amount (2)", "Amount", "Amount"])).toEqual([
      "Amount (2)",
      "Amount",
      "Amount (3)",
    ]);
    expect(names(["", "Column A"])).toEqual(["Column A", "Column A (2)"]);
  });
});

describe("cell references", () => {
  it("encodes column letters and addresses", () => {
    expect([0, 25, 26, 701, 702].map(columnLetters)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    expect(cellAddress(0, 0)).toBe("A1");
  });

  it("maps table rows and columns to sheet addresses and evidence locations", () => {
    const table = {
      range: "B3:D10",
      sheet: "Sales",
      columns: [
        { name: "a", type: "string" as const },
        { name: "b", type: "number" as const },
        { name: "c", type: "number" as const },
      ],
    };

    expect(tableCellAddress(table, 0, 0)).toBe("B4");
    expect(tableCellAddress(table, 2, 1)).toBe("C6");
    expect(tableEvidenceLocation(table, { rowStart: 0, rowEnd: 2 })).toEqual({
      sheet: "Sales",
      cellRange: "B4:D6",
      rowRange: { start: 4, end: 6 },
    });
    expect(tableEvidenceLocation(table, { rowStart: 1, columnStart: 2 })).toEqual({
      sheet: "Sales",
      cellRange: "D5",
      rowRange: { start: 5, end: 5 },
    });
  });

  it("assumes an A1 origin when the table has no range", () => {
    expect(tableCellAddress({}, 0, 0)).toBe("A2");
  });
});
