import { beforeEach, describe, expect, it } from "vitest";
import { getVisitorId, isVisitorId, visitorStorageKey } from "./visitor";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("getVisitorId", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("creates a UUID once and persists it", () => {
    const first = getVisitorId(storage);

    expect(isVisitorId(first)).toBe(true);
    expect(storage.getItem(visitorStorageKey)).toBe(first);
    expect(getVisitorId(storage)).toBe(first);
  });

  it("replaces a malformed stored value", () => {
    storage.setItem(visitorStorageKey, "not-a-uuid");

    const visitorId = getVisitorId(storage);

    expect(isVisitorId(visitorId)).toBe(true);
    expect(storage.getItem(visitorStorageKey)).toBe(visitorId);
  });

  it("falls back to a stable in-memory id when storage throws", () => {
    const broken = new MemoryStorage();
    broken.getItem = () => {
      throw new Error("blocked");
    };

    const first = getVisitorId(broken);

    expect(isVisitorId(first)).toBe(true);
    expect(getVisitorId(broken)).toBe(first);
  });

  it("uses window.localStorage by default", () => {
    window.localStorage.clear();

    const visitorId = getVisitorId();

    expect(window.localStorage.getItem(visitorStorageKey)).toBe(visitorId);
  });
});
