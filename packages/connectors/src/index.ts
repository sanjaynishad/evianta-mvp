import { sourceConnectorCatalog, type SourceConnectorId } from "@evianta/core";

import { busyConnector } from "./connectors/busy.js";
import { gmailConnector } from "./connectors/gmail.js";
import { googleDriveConnector } from "./connectors/googleDrive.js";
import { outlookConnector } from "./connectors/outlook.js";
import { shopifyConnector } from "./connectors/shopify.js";
import { tallyConnector } from "./connectors/tally.js";
import { zohoBooksConnector } from "./connectors/zohoBooks.js";
import { company } from "./data/business.js";
import type { SourceConnector } from "./demo.js";

export { SourceItemNotFoundError, type ImportedFile, type SourceConnector } from "./demo.js";

const connectors: Record<SourceConnectorId, SourceConnector> = {
  tally: tallyConnector,
  busy: busyConnector,
  "zoho-books": zohoBooksConnector,
  shopify: shopifyConnector,
  gmail: gmailConnector,
  outlook: outlookConnector,
  "google-drive": googleDriveConnector,
};

const demoAccounts: Record<SourceConnectorId, string> = {
  tally: company.name,
  busy: company.name,
  "zoho-books": company.name,
  shopify: `${company.name} online store`,
  gmail: company.accountsEmail,
  outlook: company.salesEmail,
  "google-drive": `${company.name} shared drive`,
};

export function getSourceConnector(connectorId: SourceConnectorId): SourceConnector {
  const connector = connectors[connectorId] as SourceConnector | undefined;

  if (!connector) {
    throw new Error(`Unknown source connector "${connectorId}".`);
  }

  return connector;
}

/** Every connector, in catalog order. */
export function listSourceConnectors(): SourceConnector[] {
  return sourceConnectorCatalog.map((definition) => getSourceConnector(definition.id));
}

/** The simulated account a demo connection is made to, shown as the connection's account label. */
export function demoAccountLabel(connectorId: SourceConnectorId): string {
  return `Demo account: ${demoAccounts[connectorId]}`;
}
