export const visitorStorageKey = "evianta.visitorId";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let memoryVisitorId: string | undefined;

function createVisitorId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function isVisitorId(value: string | null | undefined): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

// The anonymous visitor id scopes "Your cases" to this browser. It is not an account.
export function getVisitorId(storage: Storage | undefined = getStorage()): string {
  if (storage) {
    try {
      const stored = storage.getItem(visitorStorageKey);
      if (isVisitorId(stored)) {
        return stored;
      }

      const visitorId = createVisitorId();
      storage.setItem(visitorStorageKey, visitorId);
      return visitorId;
    } catch {
      // Storage can throw in private modes; fall back to an id kept for this page load.
    }
  }

  memoryVisitorId ??= createVisitorId();
  return memoryVisitorId;
}
