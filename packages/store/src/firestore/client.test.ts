import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  firestoreDatabaseId: "(default)",
  app: { name: "test-app" },
  client: { settings: vi.fn() },
  getApps: vi.fn(),
  initializeApp: vi.fn(),
  getFirestore: vi.fn(),
}));

vi.mock("@evianta/env", () => ({
  get firestoreDatabaseId() {
    return mocks.firestoreDatabaseId;
  },
}));

vi.mock("firebase-admin/app", () => ({
  getApps: mocks.getApps,
  initializeApp: mocks.initializeApp,
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: mocks.getFirestore,
}));

describe("getFirestoreClient", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.firestoreDatabaseId = "(default)";
    mocks.getApps.mockReturnValue([mocks.app]);
    mocks.initializeApp.mockReturnValue(mocks.app);
    mocks.getFirestore.mockReturnValue(mocks.client);
  });

  it("uses the default database and caches the configured client", async () => {
    const { getFirestoreClient } = await import("./client.js");

    expect(getFirestoreClient()).toBe(mocks.client);
    expect(getFirestoreClient()).toBe(mocks.client);
    expect(mocks.getFirestore).toHaveBeenCalledOnce();
    expect(mocks.getFirestore).toHaveBeenCalledWith(mocks.app, "(default)");
    expect(mocks.client.settings).toHaveBeenCalledOnce();
    expect(mocks.client.settings).toHaveBeenCalledWith({
      ignoreUndefinedProperties: true,
    });
  });

  it("selects a named database without confusing it with the default database", async () => {
    mocks.firestoreDatabaseId = "default";
    mocks.getApps.mockReturnValue([]);
    const { getFirestoreClient } = await import("./client.js");

    expect(getFirestoreClient()).toBe(mocks.client);
    expect(mocks.initializeApp).toHaveBeenCalledOnce();
    expect(mocks.getFirestore).toHaveBeenCalledOnce();
    expect(mocks.getFirestore).toHaveBeenCalledWith(mocks.app, "default");
  });
});
