import { apiErrorCodes } from "@evianta/core";
import { hasApiErrorCode } from "./errors";

export interface UploadConflictRetryOptions {
  attempts?: number;
  delayMs?: number;
}

// The API rejects run and retry with 409 upload-in-progress while documents are still being
// stored, so a start is retried with a growing delay until the uploads finish.
export async function retryWhileUploadingAsync<T>(
  startAsync: () => Promise<T>,
  { attempts = 5, delayMs = 1000 }: UploadConflictRetryOptions = {},
): Promise<T> {
  let attempt = 1;
  while (attempt < attempts) {
    try {
      return await startAsync();
    } catch (error) {
      if (!hasApiErrorCode(error, apiErrorCodes.uploadInProgress)) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    attempt += 1;
  }

  return startAsync();
}
