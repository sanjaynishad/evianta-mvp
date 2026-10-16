import type { TaskHandlerRegistry } from "../../handlers.js";
import type { DeterministicCheckOptions } from "../../verification.js";
import { createCaseAnalysisTaskHandler, type CaseAnalysisAgent } from "./caseAnalysis.js";
import type { ReconcileOptions } from "./reconcile.js";
import { createReconciliationTaskHandler, type ReconciliationAgent } from "./reconciliationTask.js";
import { createTaxResearchTaskHandler, type TaxResearchAgent } from "./research.js";
import { createResponsePreparationTaskHandler, type ResponsePreparationAgent } from "./response.js";
import { createTaxNoticeReviewTaskHandler } from "./review.js";

export * from "./caseAnalysis.js";
export * from "./constants.js";
export * from "./context.js";
export * from "./reconcile.js";
export * from "./reconciliationTask.js";
export * from "./records.js";
export * from "./render.js";
export * from "./research.js";
export * from "./response.js";
export * from "./review.js";

export interface TaxNoticeHandlerOptions {
  reconciliation?: ReconcileOptions;
  review?: DeterministicCheckOptions;
  agents?: {
    caseAnalysis?: CaseAnalysisAgent;
    reconciliation?: ReconciliationAgent;
    taxResearch?: TaxResearchAgent;
    responsePreparation?: ResponsePreparationAgent;
  };
}

/**
 * Registers the tax-notice specialists and wraps the registered independent-review handler so
 * tax-notice cases get the reconciliation and draft-figure checks while other use cases keep it.
 */
export function registerTaxNoticeHandlers(
  registry: TaskHandlerRegistry,
  options: TaxNoticeHandlerOptions = {},
): TaskHandlerRegistry {
  const { agents = {} } = options;

  return registry
    .register(createCaseAnalysisTaskHandler({ agent: agents.caseAnalysis }))
    .register(
      createReconciliationTaskHandler({ ...options.reconciliation, agent: agents.reconciliation }),
    )
    .register(createTaxResearchTaskHandler({ agent: agents.taxResearch }))
    .register(
      createResponsePreparationTaskHandler({
        ...options.reconciliation,
        agent: agents.responsePreparation,
      }),
    )
    .register(
      createTaxNoticeReviewTaskHandler({
        ...options.review,
        fallback: registry.get("independent-review"),
      }),
    );
}
