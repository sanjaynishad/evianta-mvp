import {
  AiError,
  AiNonTransientError,
  AiOutputValidationError,
  AiTransientError,
} from "@evianta/ai";

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

/** A short, user-readable reason for a failed task, stored as the task's lastError. */
export function describeTaskError(error: unknown): string {
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
