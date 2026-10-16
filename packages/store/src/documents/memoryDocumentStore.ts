import { StoreNotFoundError } from "../errors.js";
import { newId } from "../mutations.js";
import { buildObjectName, parseStoragePath, type DocumentStore } from "./documentStore.js";

const memoryScheme = "memory";
const memoryBucket = "evianta-documents";

export function createInMemoryDocumentStore(): DocumentStore {
  const files = new Map<string, Buffer>();

  function readOrThrow(path: string): Buffer {
    parseStoragePath(path, memoryScheme);
    const contents = files.get(path);

    if (!contents) {
      throw new StoreNotFoundError("file", path);
    }

    return contents;
  }

  return {
    async uploadAsync(caseId, fileName, _mimeType, buffer) {
      const path = `${memoryScheme}://${memoryBucket}/${buildObjectName(caseId, newId(), fileName)}`;

      files.set(path, Buffer.from(buffer));

      return path;
    },
    async readBufferAsync(path) {
      return Buffer.from(readOrThrow(path));
    },
    async getSignedUrlAsync(path) {
      readOrThrow(path);

      return path;
    },
  };
}
