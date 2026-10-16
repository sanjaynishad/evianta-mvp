import {
  addUsage,
  AiError,
  AiNonTransientError,
  AiOutputValidationError,
  AiTransientError,
  roundCost,
  type Cost,
} from "@evianta/ai";
import type { TokenUsage } from "@evianta/core";

import { truncate } from "./text.js";

export type OrchestratorErrorCode =
  "case-not-found" | "use-case-missing" | "run-in-progress" | "nothing-to-retry";

export class OrchestratorError extends Error {
  constructor(
    readonly code: OrchestratorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BilledUsage {
  usage: TokenUsage;
  cost: Cost;
}

/** A task handler failure after billed model calls; carries their usage so the attempt is charged. */
export class BilledTaskError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly usage: TokenUsage,
    readonly cost: Cost,
  ) {
    super(messageOf(cause), { cause });
    this.name = "BilledTaskError";
  }
}

/** Usage already billed when a task failed, from a model error or a failed handler step. */
export function billedUsageOf(error: unknown): BilledUsage | undefined {
  if (error instanceof AiError || error instanceof BilledTaskError) {
    return { usage: error.usage, cost: error.cost };
  }

  return undefined;
}

/** Wraps a failing step that runs after a billed call so the call's usage is not lost. */
export async function withBilledUsageAsync<T>(
  billed: BilledUsage,
  stepAsync: () => T | Promise<T>,
): Promise<T> {
  try {
    return await stepAsync();
  } catch (error) {
    const inner = billedUsageOf(error);

    throw new BilledTaskError(
      error instanceof BilledTaskError ? error.cause : error,
      inner ? addUsage(billed.usage, inner.usage) : billed.usage,
      roundCost(billed.cost + (inner?.cost ?? 0)),
    );
  }
}

/** A short, user-readable reason for a failed task, stored as the task's lastError. */
export function describeTaskError(error: unknown): string {
  if (error instanceof BilledTaskError) {
    return describeTaskError(error.cause);
  }

  if (error instanceof AiOutputValidationError) {
    return "The agent returned output in an unexpected format. Retry the run to try again.";
  }

  if (error instanceof AiTransientError) {
    return `The model service was unavailable after ${error.attempts} attempt(s). Retry the run to try again.`;
  }

  if (error instanceof AiNonTransientError) {
    switch (error.reason) {
      case "blocked":
        return "The model declined to respond to this task.";
      case "permission-denied":
        return "The model provider rejected the request credentials.";
      case "not-configured":
        return "The model provider is not configured for this task.";
      case "invalid-input":
        return truncate(`The task input was invalid: ${error.message}`, 300);
      default:
        return truncate(`The model request failed: ${error.message}`, 300);
    }
  }

  if (error instanceof AiError) {
    return truncate(`The model request failed: ${error.message}`, 300);
  }

  return truncate(messageOf(error), 300);
}
