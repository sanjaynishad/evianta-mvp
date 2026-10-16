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

/** createAgentTaskHandler with a deterministic pre-step whose result is also given to the output mapping. */
export function createPreparedTaskHandler<P, I, O>(
  agent: Agent<I, O>,
  hooks: PreparedTaskHooks<P, I, O>,
): TaskHandler {
  const preparedByContext = new WeakMap<TaskExecutionContext, P>();

  return createAgentTaskHandler(agent, {
    async prepareInputAsync(ctx) {
      const prepared = await hooks.prepareAsync(ctx);

      preparedByContext.set(ctx, prepared);

      return hooks.buildInput(ctx, prepared);
    },
    toTaskOutput(result, ctx) {
      const prepared = preparedByContext.get(ctx) as P;

      preparedByContext.delete(ctx);

      return hooks.toTaskOutput(result, ctx, prepared);
    },
  });
}
