import type { ExtractedTable } from "@evianta/core";
import { describe, expect, it } from "vitest";

import { profileColumns, selectRoles } from "./columns.js";

function table(columns: string[], rows: ExtractedTable["rows"]): ExtractedTable {
  return {
    name: "data",
    columns: columns.map((name) => ({ name, type: "string" })),
    rows,
  };
}

describe("column roles", () => {
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
});
