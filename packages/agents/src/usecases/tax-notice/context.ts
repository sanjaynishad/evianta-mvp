import type { AgentRole } from "@evianta/core";
import { LOW_CONFIDENCE_THRESHOLD, pagesNeedingReview } from "@evianta/ingest";

import type { Agent, AgentResult } from "../../agent.js";
import {
  createAgentTaskHandler,
  type TaskExecutionContext,
  type TaskHandler,
  type TaskOutput,
} from "../../handlers.js";
import { readTaxRecords, type TaxRecordDocument, type TaxRecordSet } from "./records.js";
import {
  reconcileTaxRecords,
  type TaxReconcileOptions,
  type TaxReconciliation,
} from "./reconcile.js";

export async function loadCaseDocumentsAsync(
  ctx: Pick<TaskExecutionContext, "documentMetadata" | "loadExtractionAsync">,
): Promise<TaxRecordDocument[]> {
  return Promise.all(
    ctx.documentMetadata.map(async (metadata) => ({
      metadata,
      extraction: await ctx.loadExtractionAsync(metadata.id),
    })),
  );
}

export interface CaseRecords {
  documents: TaxRecordDocument[];
  records: TaxRecordSet;
  reconciliation: TaxReconciliation;
}

export async function reconcileCaseAsync(
  ctx: Pick<TaskExecutionContext, "documentMetadata" | "loadExtractionAsync">,
  options: TaxReconcileOptions = {},
): Promise<CaseRecords> {
  const documents = await loadCaseDocumentsAsync(ctx);
  const records = readTaxRecords(documents);

  return { documents, records, reconciliation: reconcileTaxRecords(records, options) };
}

export interface ReviewPage {
  documentId: string;
  documentName: string;
  page: number;
  confidence: number;
  method: string;
}

/** OCR or handwritten pages below the confidence threshold that a person should check. */
export function pagesToVerify(
  documents: readonly TaxRecordDocument[],
  threshold = LOW_CONFIDENCE_THRESHOLD,
): ReviewPage[] {
  return documents.flatMap(({ metadata, extraction }) => {
    if (!extraction) {
      return [];
    }

    const flagged = new Set(pagesNeedingReview(extraction, threshold));

    return extraction.pages
      .filter((page) => flagged.has(page.index))
      .map((page) => ({
        documentId: metadata.id,
        documentName: metadata.name,
        page: page.index,
        confidence: page.confidence,
        method: page.method,
      }));
  });
}

export interface PreparedTaskHooks<P, I, O> {
  /** Deterministic pre-step with no model cost. */
  prepareAsync(ctx: TaskExecutionContext): Promise<P>;
  buildInput(ctx: TaskExecutionContext, prepared: P): I;
  toTaskOutput(
    result: AgentResult<O>,
    ctx: TaskExecutionContext,
    prepared: P,
  ): TaskOutput | Promise<TaskOutput>;
}

/**
 * Runs a deterministic pre-step, then the agent through createAgentTaskHandler. The agent is
 * resolved per execution, so a registry override (custom prompt or tier) takes effect.
 */
export function createPreparedTaskHandler<P, I, O>(
  role: AgentRole,
  resolveAgent: (ctx: TaskExecutionContext) => Agent<I, O>,
  hooks: PreparedTaskHooks<P, I, O>,
): TaskHandler {
  return {
    role,
    async executeAsync(ctx) {
      const prepared = await hooks.prepareAsync(ctx);

      return createAgentTaskHandler(resolveAgent(ctx), {
        prepareInputAsync: async () => hooks.buildInput(ctx, prepared),
        toTaskOutput: (result) => hooks.toTaskOutput(result, ctx, prepared),
      }).executeAsync(ctx);
    },
  };
}

/** The pinned agent, else the one registered for the role, else the use-case default. */
export function resolveTaskAgent<A>(
  ctx: TaskExecutionContext,
  role: AgentRole,
  pinned: A | undefined,
  createDefault: () => A,
): A {
  return pinned ?? (ctx.agents.get(role) as A | undefined) ?? createDefault();
}
