import { storageEmulatorHost } from "@evianta/env";
import { Storage } from "@google-cloud/storage";

import { StoreNotFoundError } from "../errors.js";
import { newId } from "../mutations.js";
import {
  buildObjectName,
  defaultSignedUrlTtlSeconds,
  parseStoragePath,
  type DocumentStore,
} from "./documentStore.js";

export interface GcsDocumentStoreOptions {
  storage?: Storage;
  /** Defaults to `STORAGE_EMULATOR_HOST`; when set, URLs point at the emulator unsigned. */
  emulatorHost?: string;
}

function toEmulatorBaseUrl(host: string): string {
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;

  return withScheme.replace(/\/+$/, "");
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === 404
  );
}

export function createGcsDocumentStore(
  bucketName: string,
  options: GcsDocumentStoreOptions = {},
): DocumentStore {
  if (bucketName.trim().length === 0) {
    throw new Error("A GCS bucket name is required; set GCS_BUCKET");
  }

  const emulatorHost = options.emulatorHost ?? storageEmulatorHost;
  const emulatorBaseUrl = emulatorHost ? toEmulatorBaseUrl(emulatorHost) : undefined;
  const storage = options.storage ?? new Storage();

  function fileFor(gcsPath: string) {
    const { bucket, objectName } = parseStoragePath(gcsPath, "gs");

    return { bucket, objectName, file: storage.bucket(bucket).file(objectName) };
  }

  return {
    async uploadAsync(caseId, fileName, mimeType, buffer) {
      const objectName = buildObjectName(caseId, newId(), fileName);

      await storage.bucket(bucketName).file(objectName).save(buffer, {
        contentType: mimeType,
        resumable: false,
      });

      return `gs://${bucketName}/${objectName}`;
    },
    async readBufferAsync(gcsPath) {
      const { file } = fileFor(gcsPath);

      try {
        const [contents] = await file.download();

        return contents;
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new StoreNotFoundError("file", gcsPath);
        }

        throw error;
      }
    },
    async getSignedUrlAsync(gcsPath, urlOptions) {
      const { bucket, objectName, file } = fileFor(gcsPath);

      // The Storage emulator cannot sign URLs, so return its direct media URL instead.
      if (emulatorBaseUrl) {
        return `${emulatorBaseUrl}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
      }

      const expiresInSeconds = urlOptions?.expiresInSeconds ?? defaultSignedUrlTtlSeconds;
      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + expiresInSeconds * 1000,
      });

      return url;
    },
  };
}
