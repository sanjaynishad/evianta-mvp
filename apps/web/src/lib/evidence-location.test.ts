import { describe, expect, it } from "vitest";
import type { ExtractedPage, ExtractedTable } from "@evianta/core";
import {
  columnLabel,
  columnNumber,
  findQuoteInSpans,
  findQuoteRange,
  findTableForLocation,
  locationMatchesSheet,
  parseCellRange,
  rangeContainsCell,
  resolveRegionHighlight,
  sheetRangeOf,
  splitSheetQualifier,
  tableLayout,
  toPercentStyle,
  unionBoxes,
} from "./evidence-location";

const page: ExtractedPage = {
  index: 2,
  text: "Particulars\nDifference\n12,400",
  method: "pdf-text",
  confidence: 0.98,
  spans: [
    { text: "Particulars", bbox: { x: 0.1, y: 0.43, width: 0.2, height: 0.02 } },
    { text: "Difference", bbox: { x: 0.1, y: 0.51, width: 0.15, height: 0.02 } },
    { text: "12,400", bbox: { x: 0.7, y: 0.51, width: 0.08, height: 0.02 } },
  ],
};

describe("findQuoteInSpans", () => {
  it("finds a quote that spans several text runs, ignoring case and spacing", () => {
    expect(findQuoteInSpans("difference   12,400", page.spans ?? [])).toEqual([
      page.spans?.[1]?.bbox,
      page.spans?.[2]?.bbox,
    ]);
  });

  it("returns undefined when the quote is not on the page", () => {
    expect(findQuoteInSpans("Total TDS", page.spans ?? [])).toBeUndefined();
  });

  it("matches a quote split inside a number across spans", () => {
    const spans = [
      { text: "Difference", bbox: { x: 0.1, y: 0.5, width: 0.15, height: 0.02 } },
      { text: "12", bbox: { x: 0.7, y: 0.5, width: 0.02, height: 0.02 } },
      { text: ",400", bbox: { x: 0.72, y: 0.5, width: 0.04, height: 0.02 } },
    ];

    expect(findQuoteInSpans("12,400", spans)).toEqual([spans[1]!.bbox, spans[2]!.bbox]);
    expect(findQuoteInSpans("Difference 12,400", spans)).toHaveLength(3);
  });
});

describe("findQuoteRange", () => {
  it("matches across line breaks and repeated spaces and returns original offsets", () => {
    const text = "Particulars\nDifference\n12,400 due";
    const range = findQuoteRange(text, "difference  12,400");

    expect(range).toEqual({ start: 12, end: 29 });
    expect(text.slice(range!.start, range!.end)).toBe("Difference\n12,400");
    expect(findQuoteRange("Total\t\tTDS   1,86,600", "Total TDS 1,86,600")).toEqual({
      start: 0,
      end: 21,
    });
    expect(findQuoteRange(text, "missing")).toBeUndefined();
  });
});

describe("resolveRegionHighlight", () => {
  it("prefers the evidence bbox", () => {
    const bbox = { x: 0.08, y: 0.42, width: 0.84, height: 0.12 };
    expect(resolveRegionHighlight({ page: 2, bbox, textQuote: "Difference" }, page)).toEqual({
      page: 2,
      boxes: [bbox],
      source: "bbox",
      approximate: false,
    });
  });

  it("falls back to the quoted text, then to the whole page", () => {
    expect(resolveRegionHighlight({ page: 2, textQuote: "Difference 12,400" }, page)).toMatchObject(
      { source: "quote", boxes: [page.spans?.[1]?.bbox, page.spans?.[2]?.bbox] },
    );
    expect(resolveRegionHighlight({ page: 2, textQuote: "Not there" }, page)).toMatchObject({
      page: 2,
      source: "page",
      boxes: [],
    });
  });

  it("marks OCR and handwriting positions as approximate and clamps the page", () => {
    expect(
      resolveRegionHighlight({ page: 9 }, { ...page, method: "ocr" }, { pageCount: 4 }),
    ).toMatchObject({ page: 1, approximate: true });
  });
});

describe("boxes", () => {
  it("unions boxes and converts them to percentages", () => {
    const union = unionBoxes([
      { x: 0.1, y: 0.5, width: 0.1, height: 0.02 },
      { x: 0.7, y: 0.51, width: 0.08, height: 0.02 },
    ]);
    expect(union?.x).toBeCloseTo(0.1);
    expect(union?.width).toBeCloseTo(0.68);
    expect(toPercentStyle({ x: 0.08, y: 0.42, width: 0.84, height: 0.12 })).toEqual({
      left: "8%",
      top: "42%",
      width: "84%",
      height: "12%",
    });
  });
});

describe("sheet ranges", () => {
  it("parses A1 ranges and labels columns", () => {
    expect(parseCellRange("B14:F29")).toEqual({
      startRow: 14,
      endRow: 29,
      startColumn: 2,
      endColumn: 6,
    });
    expect(parseCellRange("Sales!H2")).toEqual({
      startRow: 2,
      endRow: 2,
      startColumn: 8,
      endColumn: 8,
    });
    expect(parseCellRange("not a range")).toBeUndefined();
    expect(columnNumber("AB")).toBe(28);
    expect(columnLabel(28)).toBe("AB");
  });

  it("reads row ranges and cell ranges from evidence locations", () => {
    const rows = sheetRangeOf({ sheet: "Receipts", rowRange: { start: 190, end: 182 } });
    expect(rows).toEqual({ startRow: 182, endRow: 190 });
    expect(rows && rangeContainsCell(rows, 184, 5)).toBe(true);
    const cells = sheetRangeOf({ cellRange: "B14:F29" });
    expect(cells && rangeContainsCell(cells, 20, 1)).toBe(false);
    expect(cells && rangeContainsCell(cells, 20, 2)).toBe(true);
  });

  it("maps table rows to worksheet rows from the table range", () => {
    const table: ExtractedTable = { name: "SOA", range: "C3:H20", columns: [], rows: [] };
    expect(tableLayout(table)).toEqual({ headerRow: 3, firstDataRow: 4, firstColumn: 3 });
  });

  it("uses the sheet named in a qualified cell range", () => {
    const expenses: ExtractedTable = { name: "Expenses", sheet: "Expenses", columns: [], rows: [] };
    const sales: ExtractedTable = { name: "Sales", sheet: "Sales", columns: [], rows: [] };
    const quarter: ExtractedTable = { name: "Q2 Sales", sheet: "Q2 Sales", columns: [], rows: [] };
    const tables = [expenses, sales, quarter];

    expect(splitSheetQualifier("'Q2 Sales'!A1:B4")).toEqual({
      sheet: "Q2 Sales",
      reference: "A1:B4",
    });
    expect(splitSheetQualifier("H2")).toEqual({ reference: "H2" });
    expect(findTableForLocation(tables, { cellRange: "Sales!H2" })).toBe(sales);
    expect(findTableForLocation(tables, { cellRange: "'Q2 Sales'!A1" })).toBe(quarter);
    expect(locationMatchesSheet({ cellRange: "Sales!H2" }, expenses)).toBe(false);
    expect(locationMatchesSheet({ cellRange: "Sales!H2" }, sales)).toBe(true);
    expect(sheetRangeOf({ cellRange: "'Q2 Sales'!B2:C3" })).toMatchObject({
      startRow: 2,
      endColumn: 3,
    });
  });
});
