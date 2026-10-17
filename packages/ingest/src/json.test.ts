import { describe, expect, it } from "vitest";

import { parseJsonDocument, parseJsonLines } from "./json.js";

const options = { name: "data", dateOrder: "dmy" as const };

function tabular(result: ReturnType<typeof parseJsonDocument>) {
  if (result.kind !== "tabular") {
    throw new Error(`Expected tabular, got ${result.kind}`);
  }

  return result;
}

describe("parseJsonDocument", () => {
  it("reads a top-level array of records as one table named after the file", () => {
    const result = tabular(
      parseJsonDocument('\uFEFF[{"a":1,"b":"x"},{"b":"y","c":"03/04/2024"}]', options),
    );

    expect(result.warnings).toEqual([]);
    expect(result.tables).toEqual([
      {
        name: "data",
        range: "A1:C3",
        columns: [
          { name: "a", type: "number" },
          { name: "b", type: "string" },
          { name: "c", type: "date" },
        ],
        rows: [
          [1, "x", null],
          [null, "y", "2024-04-03"],
        ],
      },
    ]);
  });

  it("flattens nested objects into dotted columns and keeps nested arrays as JSON text", () => {
    const result = tabular(
      parseJsonDocument(
        JSON.stringify([
          { id: 1, customer: { name: "Apex", address: { city: "Pune" } }, tags: ["a", "b"] },
        ]),
        options,
      ),
    );

    expect(result.tables[0]?.columns.map((column) => column.name)).toEqual([
      "id",
      "customer.name",
      "customer.address.city",
      "tags",
    ]);
    expect(result.tables[0]?.rows).toEqual([[1, "Apex", "Pune", '["a","b"]']]);
  });

  it("stops flattening past the depth limit", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const result = tabular(parseJsonDocument(JSON.stringify([deep]), options));

    expect(result.tables[0]?.columns.map((column) => column.name)).toEqual(["a.b.c.d.e.f"]);
    expect(result.tables[0]?.rows).toEqual([['{"g":1}']]);
  });

  it("turns each record array in an object into its own table, plus a fields table", () => {
    const result = tabular(
      parseJsonDocument(
        JSON.stringify({
          gstin: "27AAACB1234C1Z5",
          period: { from: "2024-04-01" },
          data: { invoices: [{ no: "I-1" }], payments: [{ amount: 10 }] },
          notes: ["checked"],
        }),
        options,
      ),
    );

    expect(result.tables.map((table) => [table.name, table.sheet])).toEqual([
      ["data.invoices", "data.invoices"],
      ["data.payments", "data.payments"],
      ["data fields", "data fields"],
    ]);
    expect(result.tables[2]?.rows).toEqual([
      ["gstin", "27AAACB1234C1Z5"],
      ["period.from", "2024-04-01"],
      ["notes", '["checked"]'],
    ]);
  });

  it("reads arrays of primitives and mixed items into a value column", () => {
    expect(tabular(parseJsonDocument("[1, 2, null, 3]", options)).tables[0]).toMatchObject({
      columns: [{ name: "value", type: "number" }],
      rows: [[1], [2], [null], [3]],
    });
    expect(tabular(parseJsonDocument('[{"a":"x"}, "loose"]', options)).tables[0]?.columns).toEqual([
      { name: "a", type: "string" },
      { name: "value", type: "string" },
    ]);
  });

  it("keeps a literal dotted key separate from the same nested path", () => {
    const result = tabular(
      parseJsonDocument('[{"a.b":1,"a":{"b":2}},{"a":{"b":4},"a.b":3}]', options),
    );

    expect(result.tables[0]?.columns.map((column) => column.name)).toEqual(["a.b", "a.b (2)"]);
    expect(result.tables[0]?.rows).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("keeps a record's value key separate from loose items", () => {
    expect(
      tabular(parseJsonDocument('[{"value":"kept"}, "loose"]', options)).tables[0],
    ).toMatchObject({
      columns: [
        { name: "value", type: "string" },
        { name: "value (2)", type: "string" },
      ],
      rows: [
        ["kept", null],
        [null, "loose"],
      ],
    });
  });

  it("reads an array of arrays like a sheet with a header row", () => {
    expect(
      tabular(parseJsonDocument('[["Item","Qty"],["Bolt",4],["Nut",9]]', options)).tables[0],
    ).toMatchObject({
      columns: [
        { name: "Item", type: "string" },
        { name: "Qty", type: "number" },
      ],
      rows: [
        ["Bolt", 4],
        ["Nut", 9],
      ],
    });
  });

  it("reports an empty array as having no data", () => {
    expect(parseJsonDocument("[]", options)).toEqual({
      kind: "tabular",
      tables: [],
      warnings: ["The file has no data."],
    });
  });

  it("falls back to pretty-printed text when there are no record arrays", () => {
    expect(parseJsonDocument('{"status":"ok","tags":["a"]}', options)).toEqual({
      kind: "text",
      text: '{\n  "status": "ok",\n  "tags": [\n    "a"\n  ]\n}',
      warnings: ["No arrays of records were found, so the file was read as text."],
    });
    expect(parseJsonDocument('"hello"', options)).toMatchObject({ kind: "text", text: '"hello"' });
  });

  it("enforces the expanded cell limit", () => {
    const record = Object.fromEntries(
      Array.from({ length: 1000 }, (_unused, index) => [`k${index}`, index]),
    );

    expect(() =>
      parseJsonDocument(JSON.stringify(Array.from({ length: 1000 }, () => record)), options),
    ).toThrow(RangeError);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseJsonDocument("{", options)).toThrow(SyntaxError);
  });
});

describe("parseJsonLines", () => {
  it("reads one record per line and skips blank lines", () => {
    const result = tabular(parseJsonLines('{"a":1}\r\n\r\n{"a":2,"b":true}\n', options));

    expect(result.warnings).toEqual([]);
    expect(result.tables[0]).toMatchObject({
      name: "data",
      columns: [
        { name: "a", type: "number" },
        { name: "b", type: "boolean" },
      ],
      rows: [
        [1, null],
        [2, true],
      ],
    });
  });

  it("caps warnings for invalid lines", () => {
    const lines = ['{"a":1}', ...Array.from({ length: 7 }, () => "{bad")];
    const result = tabular(parseJsonLines(lines.join("\n"), options));

    expect(result.tables).toHaveLength(1);
    expect(result.warnings).toHaveLength(6);
    expect(result.warnings[0]).toMatch(/^Line 2: /);
    expect(result.warnings[5]).toBe("2 more parse issues were not listed.");
  });

  it("throws when no line is valid JSON", () => {
    expect(() => parseJsonLines("{bad\n[oops\n", options)).toThrow(SyntaxError);
  });

  it("keeps array lines as data instead of reading the first one as a header", () => {
    expect(tabular(parseJsonLines("[1,2]\n[3,4]\n", options)).tables[0]).toMatchObject({
      columns: [{ name: "value", type: "string" }],
      rows: [["[1,2]"], ["[3,4]"]],
    });
  });

  it("reports an empty file as having no data", () => {
    expect(parseJsonLines("\n\n", options)).toEqual({
      kind: "tabular",
      tables: [],
      warnings: ["The file has no data."],
    });
  });
});
