import {
  connectSourceRequestSchema,
  sourceConnectorCatalog,
  sourceImportRequestSchema,
  sourceProposalActionRequestSchema,
  sourceProposalId,
  type Case,
  type CaseIntake,
  type SourceConnection,
} from "@evianta/core";
import { demoAccountLabel, SourceItemNotFoundError } from "@evianta/connectors";
import { Router } from "express";
import { z } from "zod";

import { toDocumentView, type DocumentView } from "../caseState.js";
import { type ApiContext } from "../context.js";
import {
  addDocumentsAsync,
  requireUnplannedCaseAsync,
  validateDocumentBuffer,
  type ValidatedUpload,
} from "../documents.js";
import { ApiError, notFoundError } from "../errors.js";
import { asyncRoute, caseParamsSchema, idSchema, requireVisitorId } from "../http.js";
import {
  getOwnedConnectionAsync,
  intakeOf,
  listOwnedConnectionsAsync,
  updateIntakeAsync,
} from "../intake.js";
import { messageOf } from "../logger.js";

const connectionParamsSchema = z.object({ connectionId: idSchema });

interface PlannedImport {
  connection: SourceConnection;
  itemId: string;
  checklistItemId?: string;
  proposalId?: string;
}

export function createSourceRoutes(ctx: ApiContext): Router {
  const router = Router();
  const { store } = ctx;

  async function requireConnectionAsync(visitorId: string, connectionId: string) {
    const connection = await getOwnedConnectionAsync(ctx, visitorId, connectionId);

    if (!connection) {
      throw notFoundError("data source connection");
    }

    return connection;
  }

  async function readImportAsync(planned: PlannedImport): Promise<ValidatedUpload> {
    const connector = ctx.sources.get(planned.connection.connectorId);

    try {
      const file = await connector.importAsync(planned.connection, planned.itemId);
      const items = await connector.listItemsAsync(planned.connection);
      const item = items.find((candidate) => candidate.id === planned.itemId);
      const upload = validateDocumentBuffer(file.name, file.mimeType, file.buffer);

      return {
        ...upload,
        provenance: {
          connectorId: planned.connection.connectorId,
          connectionId: planned.connection.id,
          itemId: planned.itemId,
          ...(item ? { label: item.label } : {}),
        },
      };
    } catch (error) {
      if (error instanceof SourceItemNotFoundError) {
        throw new ApiError(404, "not-found", "This item could not be found in the data source.");
      }

      throw error;
    }
  }

  // Imports the items as case documents, then records them on the intake in one update.
  async function importItemsAsync(
    caseId: string,
    visitorId: string,
    planned: PlannedImport[],
  ): Promise<{ views: DocumentView[]; intakeCase: Case }> {
    const documents = await addDocumentsAsync(ctx, caseId, () =>
      Promise.all(planned.map(readImportAsync)),
    );
    const views = documents.map((document) => toDocumentView(document, undefined, ctx.ingestion));
    const now = ctx.now().toISOString();

    for (const connectionId of new Set(planned.map((entry) => entry.connection.id))) {
      try {
        await store.connections.touchConnectionAsync(connectionId, now);
      } catch (error) {
        ctx.logger.warn("Could not record the data-source import time.", {
          connectionId,
          error: messageOf(error),
        });
      }
    }

    const intakeCase = await updateIntakeAsync(ctx, caseId, visitorId, (intake) => {
      const documentItems = { ...intake.documentItems };
      const attachedByProposal = new Map<string, string>();

      planned.forEach((entry, index) => {
        const document = documents[index];

        if (!document) {
          return;
        }

        if (entry.checklistItemId) {
          documentItems[document.id] = entry.checklistItemId;
        }

        attachedByProposal.set(
          entry.proposalId ?? sourceProposalId(entry.connection.id, entry.itemId),
          document.id,
        );
      });

      return {
        ...intake,
        documentItems,
        proposals: intake.proposals.map((proposal) => {
          const documentId = attachedByProposal.get(proposal.id);

          return documentId
            ? {
                ...proposal,
                status: "attached" as const,
                documentIds: [...proposal.documentIds, documentId],
              }
            : proposal;
        }),
      };
    });

    return { views, intakeCase };
  }

  router.get(
    "/sources/catalog",
    asyncRoute(async (_req, res) => {
      res.json({ connectors: sourceConnectorCatalog });
    }),
  );

  router.get(
    "/sources/connections",
    asyncRoute(async (req, res) => {
      const visitorId = requireVisitorId(req);

      res.json({ connections: await listOwnedConnectionsAsync(ctx, visitorId) });
    }),
  );

  router.post(
    "/sources/connections",
    asyncRoute(async (req, res) => {
      const visitorId = requireVisitorId(req);
      const { connectorId } = connectSourceRequestSchema.parse(req.body);
      const existing = (await listOwnedConnectionsAsync(ctx, visitorId)).find(
        (connection) => connection.connectorId === connectorId,
      );

      if (existing) {
        res.json(existing);

        return;
      }

      const created = await store.connections.createConnectionAsync({
        id: ctx.newId(),
        visitorId,
        connectorId,
        accountLabel: demoAccountLabel(connectorId),
        connectedAt: ctx.now().toISOString(),
      });

      res.status(201).json(created);
    }),
  );

  router.delete(
    "/sources/connections/:connectionId",
    asyncRoute(async (req, res) => {
      const visitorId = requireVisitorId(req);
      const { connectionId } = connectionParamsSchema.parse(req.params);

      await requireConnectionAsync(visitorId, connectionId);
      await store.connections.deleteConnectionAsync(connectionId);

      res.status(204).end();
    }),
  );

  router.get(
    "/sources/connections/:connectionId/items",
    asyncRoute(async (req, res) => {
      const visitorId = requireVisitorId(req);
      const { connectionId } = connectionParamsSchema.parse(req.params);
      const connection = await requireConnectionAsync(visitorId, connectionId);

      res.json({
        items: await ctx.sources.get(connection.connectorId).listItemsAsync(connection),
      });
    }),
  );

  router.post(
    "/cases/:caseId/sources/proposals",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);
      const visitorId = requireVisitorId(req);
      const request = sourceProposalActionRequestSchema.parse(req.body);
      const caseRecord = await requireUnplannedCaseAsync(ctx, caseId, "changing the case");
      const selected = new Set(request.proposalIds);

      if (request.action === "dismiss") {
        const updated = await updateIntakeAsync(ctx, caseId, visitorId, (intake: CaseIntake) => ({
          ...intake,
          proposals: intake.proposals.map((proposal) =>
            selected.has(proposal.id) && proposal.status === "proposed"
              ? { ...proposal, status: "dismissed" as const }
              : proposal,
          ),
        }));

        res.json({ documents: [], case: updated });

        return;
      }

      const planned: PlannedImport[] = [];

      for (const proposal of intakeOf(caseRecord).proposals) {
        if (!selected.has(proposal.id) || proposal.status !== "proposed") {
          continue;
        }

        const connection = await getOwnedConnectionAsync(ctx, visitorId, proposal.connectionId);

        if (connection) {
          planned.push({
            connection,
            itemId: proposal.itemId,
            checklistItemId: proposal.checklistItemId,
            proposalId: proposal.id,
          });
        }
      }

      if (planned.length === 0) {
        throw new ApiError(
          409,
          "nothing-to-attach",
          "These suggestions were already handled or their data source is no longer connected.",
        );
      }

      const { views, intakeCase } = await importItemsAsync(caseId, visitorId, planned);

      res.status(201).json({ documents: views, case: intakeCase });
    }),
  );

  router.post(
    "/cases/:caseId/sources/import",
    asyncRoute(async (req, res) => {
      const { caseId } = caseParamsSchema.parse(req.params);
      const visitorId = requireVisitorId(req);
      const request = sourceImportRequestSchema.parse(req.body);
      const connection = await requireConnectionAsync(visitorId, request.connectionId);
      const { views, intakeCase } = await importItemsAsync(caseId, visitorId, [
        {
          connection,
          itemId: request.itemId,
          ...(request.checklistItemId ? { checklistItemId: request.checklistItemId } : {}),
        },
      ]);

      res.status(201).json({ documents: views, case: intakeCase });
    }),
  );

  return router;
}
