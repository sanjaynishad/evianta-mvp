import { describe, expect, it } from "vitest";
import { parseFigure, parseTextTable, parseTextTimeline } from "./section-content";

describe("parseTextTable", () => {
  it("parses a reconciliation and flags rows with a difference", () => {
    const table = parseTextTable(
      "Deductor            Ledger TDS   Form 26AS TDS   Difference\nMehta Exports           12,400               0       12,400\nOther deductors       1,86,600        1,86,600            0\nTotal                 1,99,000        1,86,600       12,400",
    );

    expect(table?.headers).toEqual(["Deductor", "Ledger TDS", "Form 26AS TDS", "Difference"]);
    expect(table?.differenceColumn).toBe(3);
    expect(table?.rows.map((row) => [row.cells[0], row.discrepancy])).toEqual([
      ["Mehta Exports", true],
      ["Other deductors", false],
    ]);
    expect(table?.total?.values).toEqual([undefined, 199000, 186600, 12400]);
    expect(table?.numericColumns).toEqual([false, true, true, true]);
  });

  it("treats a blank difference as unknown rather than a match", () => {
    const table = parseTextTable(
      "Party        Ledger   Statement   Difference\nAlpha         1,000       1,000            0\nBeta          2,000       1,500\nTotal         3,000       2,500",
    );

    expect(table?.rows.map((row) => row.discrepancy)).toEqual([false, undefined]);
    expect(table?.total?.discrepancy).toBeUndefined();
  });

  it("places right-aligned values by full column width and keeps complete rows in order", () => {
    const header = `${"Party".padEnd(20)}${"Ledger".padEnd(12)}${"Statement".padEnd(12)}Difference`;
    const complete = `${"Alpha".padEnd(20)}${"1".padStart(11)} ${"1,000".padStart(11)} ${"-999".padStart(10)}`;
    const sparse = `${"Beta".padEnd(20)}${" ".repeat(12)}${"1,000".padStart(11)} ${"-999".padStart(10)}`;
    const table = parseTextTable([header, complete, sparse].join("\n"));

    expect(table?.rows.map((row) => row.cells)).toEqual([
      ["Alpha", "1", "1,000", "-999"],
      ["Beta", "", "1,000", "-999"],
    ]);
  });

  it("falls back to plain text when two values land in one column", () => {
    expect(
      parseTextTable("Party        Amount\nAlpha   10   20   30\nBeta    1,000"),
    ).toBeUndefined();
  });

  it("aligns sparse rows under their headers", () => {
    const table = parseTextTable(
      "Invoice        Amount   Days overdue   Interest\nKF-2025-104  2,40,000            148     28,410\nTotal        8,42,000                    61,870",
    );

    expect(table?.differenceColumn).toBeUndefined();
    expect(table?.rows[0]?.discrepancy).toBeUndefined();
    expect(table?.total?.cells).toEqual(["Total", "8,42,000", "", "61,870"]);
  });

  it("returns undefined for text without columns", () => {
    expect(parseTextTable("Just one line")).toBeUndefined();
  });

  it("parses Indian-format figures", () => {
    expect(parseFigure("1,86,600")).toBe(186600);
    expect(parseFigure("Rs 12,400")).toBe(12400);
    expect(parseFigure("Mehta")).toBeUndefined();
  });

  it("keeps escaped pipes inside a Markdown table cell", () => {
    const table = parseTextTable(
      "| Document | Summary |\n| --- | --- |\n| invoice.pdf | Buyer \\| seller correspondence |",
    );

    expect(table?.headers).toEqual(["Document", "Summary"]);
    expect(table?.rows[0]?.cells).toEqual(["invoice.pdf", "Buyer | seller correspondence"]);
  });

  it("parses Markdown tables without rendering their syntax as plain text", () => {
    const table = parseTextTable(
      "| Invoice | Amount | Difference |\n| --- | ---: | ---: |\n| INV-1 | ₹12,400 | ₹400 |\n| Total | ₹12,400 | ₹400 |",
    );

    expect(table?.headers).toEqual(["Invoice", "Amount", "Difference"]);
    expect(table?.rows).toEqual([
      {
        cells: ["INV-1", "₹12,400", "₹400"],
        values: [undefined, 12400, 400],
        discrepancy: true,
      },
    ]);
    expect(table?.total?.cells).toEqual(["Total", "₹12,400", "₹400"]);
    expect(table?.differenceColumn).toBe(2);
  });
});

describe("parseTextTimeline", () => {
  it("reads leading dates in several formats", () => {
    expect(
      parseTextTimeline(
        "14 Mar 2023  Udyam registration\n2026-05-05 Invoice accepted\n12/06/2026  First reminder",
      ),
    ).toEqual([
      { id: "entry-0", date: "2023-03-14", text: "Udyam registration" },
      { id: "entry-1", date: "2026-05-05", text: "Invoice accepted" },
      { id: "entry-2", date: "2026-06-12", text: "First reminder" },
    ]);
  });

  it("gives up when a line has no date", () => {
    expect(parseTextTimeline("14 Mar 2023  Registered\nNo date here")).toBeUndefined();
    expect(parseTextTimeline("31 Feb 2026  Not a day")).toBeUndefined();
  });
});
