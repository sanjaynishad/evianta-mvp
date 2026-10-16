export interface DocumentStore {
  /** Stores the bytes and returns the `gcsPath` to persist in document metadata. */
  uploadAsync(caseId: string, fileName: string, mimeType: string, buffer: Buffer): Promise<string>;
  readBufferAsync(gcsPath: string): Promise<Buffer>;
  getSignedUrlAsync(gcsPath: string, options?: SignedUrlOptions): Promise<string>;
}

export interface SignedUrlOptions {
  expiresInSeconds?: number;
}

export const defaultSignedUrlTtlSeconds = 15 * 60;

const maxFileNameLength = 120;

export function sanitizeFileName(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).pop() ?? "";
  const sanitized = baseName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-maxFileNameLength);

  return sanitized.length > 0 ? sanitized : "file";
}

export function buildObjectName(caseId: string, documentKey: string, fileName: string): string {
  return `cases/${encodeURIComponent(caseId)}/documents/${documentKey}/${sanitizeFileName(fileName)}`;
}

export interface ParsedStoragePath {
  bucket: string;
  objectName: string;
}

export function parseStoragePath(path: string, scheme: string): ParsedStoragePath {
  const prefix = `${scheme}://`;

  if (!path.startsWith(prefix)) {
    throw new Error(`Expected a ${prefix} path but received "${path}"`);
  }

  const rest = path.slice(prefix.length);
  const separator = rest.indexOf("/");

  if (separator <= 0 || separator === rest.length - 1) {
    throw new Error(`Invalid storage path "${path}"`);
  }

  return { bucket: rest.slice(0, separator), objectName: rest.slice(separator + 1) };
}
