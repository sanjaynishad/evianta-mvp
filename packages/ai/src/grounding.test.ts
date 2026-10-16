import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractCitations, VERIFY_AGAINST_CURRENT_LAW } from "./grounding.js";

const groundingResponse: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/grounding-response.json", import.meta.url), "utf8"),
);

describe("extractCitations", () => {
  it("returns deduplicated citations with supporting snippets from a raw Gemini response", () => {
    expect(extractCitations(groundingResponse)).toEqual([
      {
        title: "incometaxindia.gov.in",
        url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc123",
        snippet:
          "Section 143(1) intimations must be issued within nine months from the end of the financial year in which the return was filed.",
      },
      {
        title: "Section 143 of the Income-tax Act",
        url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def456",
        snippet: "Section 143(1) intimations must be issued within nine months",
      },
    ]);
  });

  it("reads grounding metadata from a Genkit response custom field or directly", () => {
    const metadata = (groundingResponse as { candidates: { groundingMetadata: unknown }[] })
      .candidates[0]?.groundingMetadata;

    expect(extractCitations({ custom: groundingResponse })).toHaveLength(2);
    expect(extractCitations(metadata)).toHaveLength(2);
    expect(extractCitations({ groundingMetadata: metadata })).toHaveLength(2);
  });

  it("falls back to the hostname when a chunk has no title and keeps retrieved context text", () => {
    const citations = extractCitations({
      groundingChunks: [
        { web: { uri: "https://example.gov/act" } },
        {
          retrievedContext: {
            uri: "gs://bucket/circular.pdf",
            title: "Circular 1",
            text: "Relevant text",
          },
        },
      ],
    });

    expect(citations).toEqual([
      { title: "example.gov", url: "https://example.gov/act", snippet: "" },
      { title: "Circular 1", url: "gs://bucket/circular.pdf", snippet: "Relevant text" },
    ]);
  });

  it("returns an empty list when there is no grounding metadata", () => {
    expect(extractCitations(undefined)).toEqual([]);
    expect(extractCitations({ candidates: [{ content: { parts: [] } }] })).toEqual([]);
    expect(extractCitations("text")).toEqual([]);
  });

  it("exposes the verification note for ungrounded claims", () => {
    expect(VERIFY_AGAINST_CURRENT_LAW).toBe("Verify against current law");
  });
});
