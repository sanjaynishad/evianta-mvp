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

export function publicTaskError(error?: string): string {
  if (error === "The agent returned output in an unexpected format. Retry the run to try again.") {
    return "The agent returned a response the task could not use. Retry the failed step; if it fails again, review the case inputs.";
  }

  if (/^The model service was unavailable after \d+ attempt\(s\)\./.test(error ?? "")) {
    return "The model service was unavailable. Retry the failed step when the service is available.";
  }

  if (error === "The model declined to respond to this task.") {
    return "The model declined this task. Review the case inputs and retry the failed step.";
  }

  if (error === "The model provider rejected the request credentials.") {
    return "The model provider rejected its credentials. Contact an administrator before retrying.";
  }

  if (error === "The model provider is not configured for this task.") {
    return "The model provider is not configured for this task. Contact an administrator.";
  }

  return genericTaskError;
}

export function publicRunEvent(event: RunEvent): RunEvent {
  if (event.type === "run-failed") {
    return { ...event, error: publicRunError(event.error) };
  }

  if (event.type === "task-failed") {
    return { ...event, error: publicTaskError(event.error) };
  }

  return event;
}
