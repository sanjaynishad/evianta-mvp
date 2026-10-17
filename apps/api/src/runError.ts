import type { RunEvent } from "@evianta/core";

const genericRunError = "The run could not finish. Try again.";
const genericTaskError = "The task could not finish. Review the case inputs and try again.";
const documentsUnavailableEnding = " yet, so the run did not start. Start the run again to retry.";
const documentsUnavailableRunError =
  "One or more documents could not be read yet, so the run did not start. Start the run again to retry.";

export function publicRunError(error: string): string {
  if (error.startsWith("Could not read ") && error.endsWith(documentsUnavailableEnding)) {
    return documentsUnavailableRunError;
  }

  return genericRunError;
}

export function publicTaskError(): string {
  return genericTaskError;
}

export function publicRunEvent(event: RunEvent): RunEvent {
  if (event.type === "run-failed") {
    return { ...event, error: publicRunError(event.error) };
  }

  if (event.type === "task-failed") {
    return { ...event, error: publicTaskError() };
  }

  return event;
}
