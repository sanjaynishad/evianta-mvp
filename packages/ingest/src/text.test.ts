import { describe, expect, it } from "vitest";

import {
  normalizeText,
  paginateText,
  parseMarkdown,
  parsePlainText,
  splitTableRow,
} from "./text.js";

const options = { dateOrder: "dmy" as const };

describe("paginateText", () => {
  it("prefers a paragraph break, then a line break, then a space, then a hard cut", () => {
    expect(paginateText("aaaa\n\nbbbb\ncc", 10).map((page) => page.text)).toEqual([
      "aaaa\n\n",
      "bbbb\ncc",
    ]);
    expect(paginateText("aaaaaa\nbbbbbb", 10).map((page) => page.text)).toEqual([
      "aaaaaa\n",
      "bbbbbb",
    ]);
    expect(paginateText("aaaaaa bbbbbb", 10).map((page) => page.text)).toEqual([
      "aaaaaa ",
      "bbbbbb",
    ]);
    expect(paginateText("abcdefghijkl", 5).map((page) => page.text)).toEqual([
      "abcde",
      "fghij",
      "kl",
    ]);
  });

  it("does not split a surrogate pair on a hard cut", () => {
    const pages = paginateText("abcd\u{1F600}efgh", 5).map((page) => page.text);

    expect(pages.join("")).toBe("abcd\u{1F600}efgh");
    expect(pages[0]).toBe("abcd");
  });

  it("starts a page at each form feed and drops trailing blank pages", () => {
    expect(paginateText("one\ftwo\f\n")).toEqual([
      { text: "one", start: 0 },
      { text: "two", start: 4 },
    ]);
    expect(paginateText("")).toEqual([{ text: "", start: 0 }]);
  });
});

describe("parsePlainText", () => {
  it("normalizes line endings and a byte order mark", () => {
    expect(normalizeText("\uFEFFa\r\nb\rc")).toBe("a\nb\nc");
    expect(parsePlainText("\uFEFFa\r\nb")).toEqual({ pages: ["a\nb"], tables: [], warnings: [] });
  });

  it("warns when the file has no text", () => {
    expect(parsePlainText(" \n\t\n").warnings).toEqual(["The file has no text."]);
  });
});

describe("splitTableRow", () => {
  it("strips outer pipes and keeps escaped pipes in cells", () => {
    expect(splitTableRow("| a | b \\| c |  |")).toEqual(["a", "b | c", ""]);
    expect(splitTableRow("a|b")).toEqual(["a", "b"]);
  });
});

describe("parseMarkdown", () => {
  it("reads pipe tables, naming them after the nearest heading", () => {
    const result = parseMarkdown(
      [
        "## Payments",
        "Date | Amount",
        "--- | ---",
        "05/03/2024 | 1,000",
        "06/03/2024 | 2,000 | extra",
        "",
        "Text between tables.",
        "",
        "| Note |",
        "|:-----|",
        "| short |",
      ].join("\n"),
      options,
    );

    expect(result.tables).toEqual([
      {
        name: "Payments",
        pageIndex: 1,
        range: "A1:B3",
        columns: [
          { name: "Date", type: "date" },
          { name: "Amount", type: "number" },
        ],
        rows: [
          ["2024-03-05", 1000],
          ["2024-03-06", 2000],
        ],
      },
      {
        name: "Payments (2)",
        pageIndex: 1,
        range: "A1:A2",
        columns: [{ name: "Note", type: "string" }],
        rows: [["short"]],
      },
    ]);
  });

  it("falls back to numbered names and pads short rows", () => {
    const result = parseMarkdown("| a | b |\n|---|---|\n| 1 |\n", options);

    expect(result.tables[0]).toMatchObject({
      name: "Table 1",
      rows: [[1, null]],
    });
  });

  it("ignores tables inside fenced code and rows that are not tables", () => {
    const result = parseMarkdown(
      [
        "```",
        "| a | b |",
        "|---|---|",
        "```",
        "~~~~",
        "| c | d |",
        "|---|---|",
        "~~~~",
        "Total | 5",
        "---",
      ].join("\n"),
      options,
    );

    expect(result.tables).toEqual([]);
  });

  it("records the page that holds each table", () => {
    const result = parseMarkdown(`intro\f| a |\n|---|\n| 1 |`, options);

    expect(result.pages).toEqual(["intro", "| a |\n|---|\n| 1 |"]);
    expect(result.tables[0]?.pageIndex).toBe(2);
  });

  it("enforces the expanded cell limit across tables", () => {
    const header = `| ${Array.from({ length: 1000 }, (_unused, index) => `c${index}`).join(" | ")} |`;
    const delimiter = `|${"---|".repeat(1000)}`;
    const row = `|${" 1 |".repeat(1000)}`;
    const table = (rows: number) =>
      [header, delimiter, ...Array.from({ length: rows }, () => row)].join("\n");

    expect(() => parseMarkdown(`${table(1)}\n\n${table(999)}`, options)).toThrow(RangeError);
  });
});
