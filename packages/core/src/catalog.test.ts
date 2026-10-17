import { describe, expect, it } from "vitest";

import {
  inferUseCaseFromText,
  lowerFirstWord,
  isSupportedUploadFile,
  matchChecklistItem,
  partitionUploadFiles,
  useCaseDefinitions,
} from "./catalog.js";
import { sourceConnectorCatalog } from "./sources.js";

describe("inferUseCaseFromText", () => {
  it("recognises an income-tax notice request", () => {
    expect(inferUseCaseFromText("I got an intimation under 143(1) about TDS").useCase).toBe(
      "tax-notice",
    );
  });

  it("recognises a delayed MSME payment request", () => {
    expect(
      inferUseCaseFromText("My buyer has not paid for 90 days. I am a Udyam registered MSME.")
        .useCase,
    ).toBe("msme-payment");
  });

  it("recognises a sales analysis request", () => {
    expect(inferUseCaseFromText("Analyse last quarter's sales by region").useCase).toBe(
      "data-analysis",
    );
  });

  it("uses file names when the text is empty", () => {
    expect(inferUseCaseFromText("", ["Form26AS_2025.pdf", "notice-143.pdf"]).useCase).toBe(
      "tax-notice",
    );
  });

  it("returns no use case for an unrelated or ambiguous request", () => {
    expect(inferUseCaseFromText("Write me a poem").useCase).toBeUndefined();
    expect(inferUseCaseFromText("hello").useCase).toBeUndefined();
  });
});

describe("lowerFirstWord", () => {
  it("lowercases ordinary words and keeps acronyms and proper nouns", () => {
    expect(lowerFirstWord("Invoices")).toBe("invoices");
    expect(lowerFirstWord("MSME delayed-payment dispute")).toBe("MSME delayed-payment dispute");
    expect(lowerFirstWord("Udyam registration certificate")).toBe("Udyam registration certificate");
    expect(lowerFirstWord("Form 26AS / AIS")).toBe("Form 26AS / AIS");
  });
});

describe("upload helpers", () => {
  it("accepts plain text and email files", () => {
    expect(isSupportedUploadFile({ name: "thread.txt", type: "" })).toBe(true);
    expect(isSupportedUploadFile({ name: "reminder.eml", type: "message/rfc822" })).toBe(true);
    expect(isSupportedUploadFile({ name: "archive.zip", type: "application/zip" })).toBe(false);
  });

  it("partitions files by support", () => {
    const result = partitionUploadFiles([
      { name: "a.csv", type: "text/csv" },
      { name: "b.exe", type: "application/octet-stream" },
    ]);

    expect(result.supported.map((file) => file.name)).toEqual(["a.csv"]);
    expect(result.unsupported.map((file) => file.name)).toEqual(["b.exe"]);
  });

  it("matches file names to checklist items", () => {
    const checklist = useCaseDefinitions["tax-notice"].checklist;

    expect(matchChecklistItem("Form26AS.pdf", checklist)?.id).toBe("form-26as");
    expect(matchChecklistItem("tally-ledger.xlsx", checklist)?.id).toBe("ledger");
  });
});

describe("source connector catalog", () => {
  it("only references checklist items that exist", () => {
    const itemIds = new Set(
      Object.values(useCaseDefinitions).flatMap((definition) =>
        definition.checklist.map((item) => item.id),
      ),
    );

    for (const connector of sourceConnectorCatalog) {
      for (const dataset of connector.datasets) {
        for (const itemId of dataset.satisfies) {
          expect(itemIds.has(itemId), `${connector.id}/${dataset.id} -> ${itemId}`).toBe(true);
        }
      }
    }
  });

  it("uses checklist ids that are unique across use cases", () => {
    const ids = Object.values(useCaseDefinitions).flatMap((definition) =>
      definition.checklist.map((item) => item.id),
    );

    expect(new Set(ids).size).toBe(ids.length);
  });
});
