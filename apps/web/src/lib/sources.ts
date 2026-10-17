import {
  findSourceConnector,
  type DocumentProvenance,
  type SourceConnectorId,
} from "@evianta/core";

export function sourceConnectorName(connectorId: SourceConnectorId): string {
  return findSourceConnector(connectorId)?.name ?? connectorId;
}

// Input side: shown on attachments while the case is being gathered.
export function sourceOriginLabel(provenance: Pick<DocumentProvenance, "connectorId">): string {
  return `From ${sourceConnectorName(provenance.connectorId)}`;
}

// Output side: a detail line on evidence; the evidence itself is never called a source.
export function importedFromLabel(provenance: Pick<DocumentProvenance, "connectorId">): string {
  return `${sourceConnectorName(provenance.connectorId)}, demo connection`;
}
