import {
  matchChecklistItem,
  sourceConnectorCatalog,
  sourceItemSchema,
  useCaseDefinitions,
  useCaseOrder,
  type SourceConnection,
  type SourceConnectorId,
} from "@evianta/core";
import { describe, expect, it } from "vitest";

import {
  demoAccountLabel,
  getSourceConnector,
  listSourceConnectors,
  SourceItemNotFoundError,
} from "./index.js";

function connectionFor(connectorId: SourceConnectorId): SourceConnection {
  return {
    id: `conn-${connectorId}`,
    visitorId: "visitor-1",
    connectorId,
    accountLabel: demoAccountLabel(connectorId),
    status: "connected",
    connectedAt: "2026-10-15T09:00:00.000Z",
  };
}

const connectorIds = sourceConnectorCatalog.map((definition) => definition.id);

describe("demo source connectors", () => {
  it("implements every catalog connector in catalog order", () => {
    expect(listSourceConnectors().map((connector) => connector.definition.id)).toEqual(
      connectorIds,
    );

    for (const connectorId of connectorIds) {
      expect(getSourceConnector(connectorId).definition.id).toBe(connectorId);
      expect(demoAccountLabel(connectorId)).toMatch(/^Demo account: \S/);
    }
  });

  it.each(connectorIds)("lists one item per dataset for %s", async (connectorId) => {
    const connector = getSourceConnector(connectorId);
    const connection = connectionFor(connectorId);
    const items = await connector.listItemsAsync(connection);

    expect(items.map((item) => item.id)).toEqual(
      connector.definition.datasets.map((dataset) => dataset.id),
    );

    for (const [index, item] of items.entries()) {
      const dataset = connector.definition.datasets[index];

      expect(sourceItemSchema.parse(item)).toEqual(item);
      expect(item.datasetId).toBe(item.id);
      expect(item.connectionId).toBe(connection.id);
      expect(item.connectorId).toBe(connectorId);
      expect(item.satisfies).toEqual(dataset?.satisfies);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.detail?.length).toBeGreaterThan(0);
    }
  });

  it.each(connectorIds)(
    "names %s files so the checklist matches every item they satisfy",
    async (connectorId) => {
      const items = await getSourceConnector(connectorId).listItemsAsync(
        connectionFor(connectorId),
      );

      for (const item of items) {
        const checks = item.satisfies.flatMap((checklistItemId) =>
          useCaseOrder
            .map((useCase) => useCaseDefinitions[useCase].checklist)
            .filter((checklist) => checklist.some((entry) => entry.id === checklistItemId))
            .map((checklist) => ({
              expected: checklistItemId,
              matched: matchChecklistItem(item.fileName, checklist)?.id,
            })),
        );

        expect(checks.length).toBeGreaterThanOrEqual(item.satisfies.length);

        for (const check of checks) {
          expect({ fileName: item.fileName, matched: check.matched }).toEqual({
            fileName: item.fileName,
            matched: check.expected,
          });
        }
      }
    },
  );

  it.each(connectorIds)("imports %s items deterministically", async (connectorId) => {
    const connector = getSourceConnector(connectorId);
    const connection = connectionFor(connectorId);

    for (const item of await connector.listItemsAsync(connection)) {
      const first = await connector.importAsync(connection, item.id);
      const second = await connector.importAsync(connection, item.id);

      expect(first.name).toBe(item.fileName);
      expect(first.mimeType).toBe(item.mimeType);
      expect(second.buffer.equals(first.buffer)).toBe(true);

      if (item.mimeType === "application/pdf") {
        expect(item.fileName.endsWith(".pdf")).toBe(true);
        expect(first.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
        expect(first.buffer.includes("/BaseFont /Helvetica")).toBe(true);
        continue;
      }

      const text = first.buffer.toString("utf8");

      expect(text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(text).not.toMatch(/\u2014|\u2013|\u20b9/);

      if (item.mimeType === "text/csv") {
        const [header, ...rows] = text.trimEnd().split("\n");
        const columnCount = header?.split(",").length ?? 0;

        expect(item.fileName.endsWith(".csv")).toBe(true);
        expect(columnCount).toBeGreaterThan(2);
        expect(header).toMatch(/^[A-Za-z]/);
        expect(rows.length).toBeGreaterThan(2);
      } else {
        expect(item.mimeType).toBe("text/plain");
        expect(item.fileName.endsWith(".txt")).toBe(true);
        expect(text).toMatch(/^From: .+\nTo: .+\n(Cc: .+\n)?Date: .+\nSubject: .+\n\n/);
      }
    }
  });

  it("rejects an unknown item id", async () => {
    const connector = getSourceConnector("tally");

    await expect(connector.importAsync(connectionFor("tally"), "no-such-item")).rejects.toThrow(
      SourceItemNotFoundError,
    );
    await expect(connector.importAsync(connectionFor("tally"), "invoices")).rejects.toBeInstanceOf(
      SourceItemNotFoundError,
    );
  });

  it("rejects a connection made to another connector", async () => {
    await expect(
      getSourceConnector("gmail").listItemsAsync(connectionFor("outlook")),
    ).rejects.toThrow(/belongs to outlook/);
  });
});
