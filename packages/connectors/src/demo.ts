import {
  findSourceConnector,
  type SourceConnection,
  type SourceConnectorDefinition,
  type SourceConnectorId,
  type SourceItem,
} from "@evianta/core";

export interface ImportedFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface SourceConnector {
  definition: SourceConnectorDefinition;
  listItemsAsync(connection: SourceConnection): Promise<SourceItem[]>;
  importAsync(connection: SourceConnection, itemId: string): Promise<ImportedFile>;
}

export class SourceItemNotFoundError extends Error {
  readonly connectorId: SourceConnectorId;
  readonly itemId: string;

  constructor(connectorId: SourceConnectorId, itemId: string) {
    super(`No item "${itemId}" in the ${connectorId} demo source.`);
    this.name = "SourceItemNotFoundError";
    this.connectorId = connectorId;
    this.itemId = itemId;
  }
}

export const CSV_MIME_TYPE = "text/csv";
export const TEXT_MIME_TYPE = "text/plain";
export const PDF_MIME_TYPE = "application/pdf";

/** One importable demo item; its dataset id doubles as the item id. */
export interface DemoItem {
  label: string;
  detail: string;
  fileName: string;
  mimeType: string;
  buildAsync(): Promise<Buffer>;
}

export function textFile(text: string): Promise<Buffer> {
  return Promise.resolve(Buffer.from(text, "utf8"));
}

function assertConnection(connectorId: SourceConnectorId, connection: SourceConnection): void {
  if (connection.connectorId !== connectorId) {
    throw new Error(
      `Connection ${connection.id} belongs to ${connection.connectorId}, not ${connectorId}.`,
    );
  }
}

/** A simulated connector serving exactly one synthetic item per catalog dataset. */
export function createDemoConnector(
  connectorId: SourceConnectorId,
  items: Readonly<Record<string, DemoItem>>,
): SourceConnector {
  const definition = findSourceConnector(connectorId);

  if (!definition) {
    throw new Error(`Connector ${connectorId} is not in the source catalog.`);
  }

  const datasetIds = definition.datasets.map((dataset) => dataset.id);
  const missing = datasetIds.filter((id) => !(id in items));
  const unexpected = Object.keys(items).filter((id) => !datasetIds.includes(id));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Demo items for ${connectorId} do not match its catalog datasets (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
    );
  }

  const itemFor = (itemId: string): DemoItem | undefined =>
    datasetIds.includes(itemId) ? items[itemId] : undefined;

  return {
    definition,
    async listItemsAsync(connection) {
      assertConnection(connectorId, connection);

      return definition.datasets.map((dataset) => {
        const item = itemFor(dataset.id) as DemoItem;

        return {
          id: dataset.id,
          connectionId: connection.id,
          connectorId: connection.connectorId,
          datasetId: dataset.id,
          label: item.label,
          detail: item.detail,
          fileName: item.fileName,
          mimeType: item.mimeType,
          satisfies: [...dataset.satisfies],
        };
      });
    },
    async importAsync(connection, itemId) {
      assertConnection(connectorId, connection);

      const item = itemFor(itemId);

      if (!item) {
        throw new SourceItemNotFoundError(connectorId, itemId);
      }

      return { name: item.fileName, mimeType: item.mimeType, buffer: await item.buildAsync() };
    },
  };
}
