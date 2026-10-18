import {
  buildIntakeRequirements,
  createCaseIntake,
  refreshSourceProposals,
  type Case,
  type CaseIntake,
  type SourceConnection,
  type SourceItem,
} from "@evianta/core";

import { getCaseOrThrowAsync, type ApiContext } from "./context.js";
import { messageOf } from "./logger.js";

export function intakeOf(caseRecord: Case): CaseIntake {
  return caseRecord.intake ?? createCaseIntake("form");
}

export async function listOwnedConnectionsAsync(
  ctx: ApiContext,
  visitorId: string,
): Promise<SourceConnection[]> {
  return ctx.store.connections.listConnectionsForVisitorAsync(visitorId);
}

export async function getOwnedConnectionAsync(
  ctx: ApiContext,
  visitorId: string,
  connectionId: string,
): Promise<SourceConnection | undefined> {
  const connection = await ctx.store.connections.getConnectionAsync(connectionId);

  return connection?.visitorId === visitorId ? connection : undefined;
}

// Items from the visitor's connections plus any connection the case already enabled.
async function collectSourceItemsAsync(
  ctx: ApiContext,
  visitorId: string | undefined,
  enabledConnectionIds: readonly string[],
): Promise<SourceItem[]> {
  const connections = new Map<string, SourceConnection>();

  if (visitorId) {
    for (const connection of await listOwnedConnectionsAsync(ctx, visitorId)) {
      connections.set(connection.id, connection);
    }
  }

  for (const connectionId of enabledConnectionIds) {
    if (connections.has(connectionId)) {
      continue;
    }

    const connection = await ctx.store.connections.getConnectionAsync(connectionId);

    if (connection) {
      connections.set(connection.id, connection);
    }
  }

  const items: SourceItem[] = [];

  for (const connection of connections.values()) {
    try {
      items.push(...(await ctx.sources.get(connection.connectorId).listItemsAsync(connection)));
    } catch (error) {
      ctx.logger.warn("Could not list data-source items.", {
        connectionId: connection.id,
        error: messageOf(error),
      });
    }
  }

  return items;
}

/**
 * Applies an intake change and recomputes data-source proposals for the case's current use case,
 * in one atomic intake update.
 */
export async function updateIntakeAsync(
  ctx: ApiContext,
  caseId: string,
  visitorId: string | undefined,
  change: (intake: CaseIntake, caseRecord: Case) => CaseIntake = (intake) => intake,
): Promise<Case> {
  const current = await getCaseOrThrowAsync(ctx, caseId);
  const documents = await ctx.store.documents.getDocumentsForCaseAsync(caseId);
  const items = await collectSourceItemsAsync(
    ctx,
    visitorId,
    intakeOf(current).enabledConnectionIds,
  );

  return ctx.store.cases.updateIntakeAsync(caseId, (intake, caseRecord) => {
    const next = change(intake ?? createCaseIntake("form"), caseRecord);

    if (!caseRecord.useCase) {
      return next;
    }

    return refreshSourceProposals(
      next,
      buildIntakeRequirements(caseRecord.useCase, documents, next),
      items,
    );
  });
}

/** Like updateIntakeAsync, but logs instead of failing; used after the primary change succeeded. */
export async function refreshIntakeQuietlyAsync(
  ctx: ApiContext,
  caseId: string,
  visitorId: string | undefined,
): Promise<Case | undefined> {
  try {
    return await updateIntakeAsync(ctx, caseId, visitorId);
  } catch (error) {
    ctx.logger.warn("Could not refresh the case intake.", { caseId, error: messageOf(error) });

    return undefined;
  }
}
