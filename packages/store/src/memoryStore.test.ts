import { describe, expect, it } from "vitest";

import { createInMemoryDocumentStore } from "./documents/memoryDocumentStore.js";
import { createInMemoryStore } from "./memoryStore.js";
import { describeStoreContract } from "./store.contract.js";

describeStoreContract("in-memory", async () => ({
  store: createInMemoryStore(),
  documentStore: createInMemoryDocumentStore(),
}));

describe("in-memory store isolation", () => {
  it("does not leak mutations of returned objects back into the store", async () => {
    const store = createInMemoryStore();
    const created = await store.cases.createCaseAsync({ title: "Case", useCase: "data-analysis" });

    created.title = "Mutated";

    expect((await store.cases.getCaseAsync(created.id))?.title).toBe("Case");
  });

  it("returns unsigned memory URLs for stored files", async () => {
    const documentStore = createInMemoryDocumentStore();
    const path = await documentStore.uploadAsync("case-1", "a.csv", "text/csv", Buffer.from("a,b"));

    expect(await documentStore.getSignedUrlAsync(path)).toBe(path);
    expect(path.startsWith("memory://")).toBe(true);
  });
});
