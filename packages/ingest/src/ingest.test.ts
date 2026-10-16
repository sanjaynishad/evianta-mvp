import { createMockAi, IMAGE_EXTRACTION_KEY, mockImageExtractionStep } from "@evianta/ai";
import type { DocumentMetadata } from "@evianta/core";
import { createInMemoryDocumentStore, createInMemoryStore } from "@evianta/store";
import { describe, expect, it } from "vitest";

import { createPdfAsync, documentMetadata } from "./__fixtures__/fixtures.js";
import { DocumentExtractionError } from "./errors.js";
import type { Extractor } from "./extract.js";
import { ingestDocumentAsync } from "./ingest.js";

const CASE_ID = "case-1";

async function setupAsync(buffer: Buffer, name: string, mimeType: string) {
  const store = createInMemoryStore();
  const documentStore = createInMemoryDocumentStore();
  const gcsPath = await documentStore.uploadAsync(CASE_ID, name, mimeType, buffer);
  const document: DocumentMetadata = documentMetadata({
    caseId: CASE_ID,
    name,
    mimeType,
    gcsPath,
    size: buffer.length,
  });

  return { store, documentStore, document };
}

async function mixedPdfAsync() {
  return createPdfAsync([
    { text: ["Notice under section 16 of the MSMED Act", "Invoice INV-204 dated 2024-01-15"] },
    { image: true },
  ]);
}

describe("ingestDocumentAsync", () => {
  it("caches the extraction so a second run does not call OCR again", async () => {
    const ai = createMockAi({
      [IMAGE_EXTRACTION_KEY]: mockImageExtractionStep({
        text: "Delivery challan 77",
        confidence: 0.88,
      }),
    });
    const { store, documentStore, document } = await setupAsync(
      await mixedPdfAsync(),
      "dispute.pdf",
      "application/pdf",
    );

    const first = await ingestDocumentAsync({
      caseId: CASE_ID,
      document,
      store,
      documentStore,
      ai,
    });

    expect(first.cached).toBe(false);
    expect(first.extraction.method).toBe("mixed");
    expect(first.usage.total).toBeGreaterThan(0);
    expect(ai.calls).toHaveLength(1);
    expect(await store.documents.getExtractionAsync(CASE_ID, document.id)).toEqual(
      first.extraction,
    );

    const second = await ingestDocumentAsync({
      caseId: CASE_ID,
      document,
      store,
      documentStore,
      ai,
    });

    expect(second).toEqual({
      extraction: first.extraction,
      usage: { input: 0, output: 0, total: 0 },
      cost: 0,
      pageUsage: [],
      failedPages: [],
      cached: true,
    });
    expect(ai.calls).toHaveLength(1);

    const forced = await ingestDocumentAsync({
      caseId: CASE_ID,
      document,
      store,
      documentStore,
      ai,
      options: { force: true },
    });

    expect(forced.cached).toBe(false);
    expect(ai.calls).toHaveLength(2);
  });

  it("does not cache an extraction with failed pages", async () => {
    const ai = createMockAi({
      [IMAGE_EXTRACTION_KEY]: [
        { error: "non-transient" },
        mockImageExtractionStep({ text: "Delivery challan 77", confidence: 0.88 }),
      ],
    });
    const { store, documentStore, document } = await setupAsync(
      await mixedPdfAsync(),
      "dispute.pdf",
      "application/pdf",
    );

    const first = await ingestDocumentAsync({
      caseId: CASE_ID,
      document,
      store,
      documentStore,
      ai,
    });

    expect(first.failedPages).toEqual([2]);
    expect(await store.documents.getExtractionAsync(CASE_ID, document.id)).toBeUndefined();

    const retry = await ingestDocumentAsync({
      caseId: CASE_ID,
      document,
      store,
      documentStore,
      ai,
    });

    expect(retry.failedPages).toEqual([]);
    expect(retry.extraction.pages[1]?.text).toBe("Delivery challan 77");
    expect(ai.calls).toHaveLength(2);
  });

  it("caches deterministic extractions without any model call", async () => {
    const ai = createMockAi();
    const { store, documentStore, document } = await setupAsync(
      Buffer.from("Item,Qty\nBolts,40\n"),
      "stock.csv",
      "text/csv",
    );

    const result = await ingestDocumentAsync({
      caseId: CASE_ID,
      document,
      store,
      documentStore,
      ai,
    });

    expect(result.extraction.kind).toBe("tabular");
    expect(ai.calls).toEqual([]);
    expect(await store.documents.getExtractionAsync(CASE_ID, document.id)).toEqual(
      result.extraction,
    );
  });

  it("uses a custom extractor when one is provided", async () => {
    const { store, documentStore, document } = await setupAsync(Buffer.from("x"), "a.bin", "x/y");
    const extractor: Extractor = {
      name: "document-ai",
      async extractAsync(_buffer, metadata) {
        return {
          extraction: {
            documentId: metadata.id,
            kind: "text",
            method: "ocr",
            confidence: 0.99,
            pages: [{ index: 1, text: "from document ai", method: "ocr", confidence: 0.99 }],
            tables: [],
            warnings: [],
          },
          usage: { input: 0, output: 0, total: 0 },
          cost: 0,
          pageUsage: [],
          failedPages: [],
        };
      },
    };

    const result = await ingestDocumentAsync({
      caseId: CASE_ID,
      document,
      store,
      documentStore,
      extractor,
    });

    expect(result.extraction.pages[0]?.text).toBe("from document ai");
  });

  it("rejects a document from another case", async () => {
    const ai = createMockAi();
    const { store, documentStore, document } = await setupAsync(
      Buffer.from("a\n1\n"),
      "a.csv",
      "text/csv",
    );

    await expect(
      ingestDocumentAsync({ caseId: "other-case", document, store, documentStore, ai }),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
  });
});
