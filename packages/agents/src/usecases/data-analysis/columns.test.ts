import type { ExtractedTable } from "@evianta/core";
import { describe, expect, it } from "vitest";

import {
  columnDisplayNames,
  MAX_COLUMN_NAME_CHARS,
  profileColumns,
  selectRoles,
} from "./columns.js";

function table(columns: string[], rows: ExtractedTable["rows"]): ExtractedTable {
  return {
    name: "data",
    columns: columns.map((name) => ({ name, type: "string" })),
    rows,
  };
}

describe("column roles", () => {
  it("bounds long display names without colliding with other columns", () => {
    const long = "Region ".repeat(100);
    const reserved = `${long.slice(0, MAX_COLUMN_NAME_CHARS - 7)}... (1)`;
    const names = columnDisplayNames([{ name: long }, { name: long }, { name: reserved }]);

    expect(names.every((name) => name.length <= MAX_COLUMN_NAME_CHARS)).toBe(true);
    expect(new Set(names).size).toBe(3);
    expect(names[2]).toBe(reserved);
  });

  it("tells prices, quantities, identifiers, and amounts apart by name", () => {
    const data = table(
      ["Invoice No", "Txn Date", "Unit Price", "Units", "Total Cost", "Net Sales", "Store"],
      [
        ["INV-1", "2024-01-02", 10, 3, 20, 30, "Pune"],
        ["INV-2", "2024-01-03", 12, 2, 15, 24, "Pune"],
        ["INV-3", "2024-01-04", 11, 4, 30, 44, "Delhi"],
      ],
    );
    const { columns } = profileColumns(data, [0, 1, 2]);
    const roles = selectRoles(columns);

    expect(columns.map((column) => column.role)).toEqual([
      "identifier",
      "date",
      "unit-price",
      "quantity",
      "amount",
      "amount",
      "category",
    ]);
    expect(roles.amount?.name).toBe("Net Sales");
    expect(roles.unitPrice?.name).toBe("Unit Price");
    expect(roles.categories.map((column) => column.name)).toEqual(["Store"]);
  });

  it("falls back to an unnamed numeric measure and keeps repeated order ids out of categories", () => {
    const data = table(
      ["Order ID", "Figure"],
      [
        ["A-1", "100"],
        ["A-1", "250"],
        ["A-2", "75"],
      ],
    );
    const { columns } = profileColumns(data, [0, 1, 2]);
    const roles = selectRoles(columns);

    expect(columns[0]?.role).toBe("identifier");
    expect(roles.amount).toMatchObject({ name: "Figure", role: "amount" });
    expect(roles.categories).toEqual([]);
  });

  it("keeps unit prices and numeric ids out of the amount even with amount words", () => {
    const data = table(
      ["Sales ID", "Sales Order No", "Net Unit Price", "Total Price", "Invoice Amount"],
      [
        [1001, 7001, 10, 30, 30],
        [1002, 7002, 12, 24, 24],
        [1003, 7003, 11, 44, 44],
      ],
    );
    const { columns } = profileColumns(data, [0, 1, 2]);

    expect(columns.map((column) => column.role)).toEqual([
      "identifier",
      "identifier",
      "unit-price",
      "amount",
      "amount",
    ]);
    expect(selectRoles(columns).amount?.name).toBe("Invoice Amount");
  });
});
