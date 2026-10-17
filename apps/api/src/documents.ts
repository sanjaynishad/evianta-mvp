import type { DocumentMetadata, DocumentProvenance } from "@evianta/core";
import { detectDocumentFormat, SUPPORTED_MIME_TYPES } from "@evianta/ingest";

import { getMutableCaseAsync, type ApiContext } from "./context.js";
import { ApiError } from "./errors.js";

const SUPPORTED_MIME_TYPE_SET: ReadonlySet<string> = new Set(SUPPORTED_MIME_TYPES);

export interface ValidatedUpload {
  name: string;
  mimeType: string;
  buffer: Buffer;
  provenance?: DocumentProvenance;
}

export function validateDocumentBuffer(
  name: string,
  declaredMimeType: string,
  buffer: Buffer,
): ValidatedUpload {
  if (buffer.length === 0) {
    throw new ApiError(400, "empty-file", `"${name}" is empty.`);
  }

  const detected = detectDocumentFormat(buffer, { mimeType: declaredMimeType, name });

  if (!SUPPORTED_MIME_TYPE_SET.has(detected.mimeType)) {
    throw new ApiError(415, "unsupported-media-type", `"${name}" is not a supported file type.`);
  }

  return { name, mimeType: detected.mimeType, buffer };
}

export const casePlannedMessage =
  "Documents cannot be added after the case has been planned. Start a new case to use different documents.";

/** Throws unless the case can still change its inputs: editable, idle, and not yet planned. */
export async function requireUnplannedCaseAsync(
  ctx: ApiContext,
  caseId: string,
  action = "uploading",
) {
  const caseRecord = await getMutableCaseAsync(ctx, caseId);

  if (ctx.runs.isActive(caseId)) {
    throw new ApiError(409, "run-in-progress", `Wait for the run to finish before ${action}.`);
  }

  // Completed tasks are reused by later runs, so documents added after planning would be ignored.
  if ((await ctx.store.tasks.getTasksForCaseAsync(caseId)).length > 0) {
    throw new ApiError(409, "case-already-planned", casePlannedMessage);
  }

  return caseRecord;
}

/**
 * Stores documents for an unplanned case and queues their extraction. The upload is registered
 * before the checks so a run cannot start between them and the stored metadata.
 */
export async function addDocumentsAsync(
  ctx: ApiContext,
  caseId: string,
  readUploadsAsync: () => Promise<ValidatedUpload[]>,
): Promise<DocumentMetadata[]> {
  const endUpload = ctx.uploads.begin(caseId);
  const documents: DocumentMetadata[] = [];

  try {
    await requireUnplannedCaseAsync(ctx, caseId);

    const uploads = await readUploadsAsync();

    for (const item of uploads) {
      const gcsPath = await ctx.documentStore.uploadAsync(
        caseId,
        item.name,
        item.mimeType,
        item.buffer,
      );

      documents.push(
        await ctx.store.documents.addDocumentMetadataAsync({
          id: ctx.newId(),
          caseId,
          name: item.name,
          mimeType: item.mimeType,
          size: item.buffer.length,
          gcsPath,
          uploadedAt: ctx.now().toISOString(),
          ...(item.provenance ? { provenance: item.provenance } : {}),
        }),
      );
    }
  } finally {
    // Documents stored before a later file failed still get extracted.
    for (const document of documents) {
      ctx.ingestion.enqueue(document);
    }

    endUpload();
  }

  return documents;
}
