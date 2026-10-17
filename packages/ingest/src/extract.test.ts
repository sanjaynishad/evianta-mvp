import {
  AiNonTransientError,
  AiOutputValidationError,
  AiTransientError,
  createMockAi,
  IMAGE_EXTRACTION_KEY,
  mockImageExtractionStep,
} from "@evianta/ai";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";

import {
  createPdfAsync,
  createPng,
  createWorkbook,
  documentMetadata,
} from "./__fixtures__/fixtures.js";
import {
  DocumentExtractionError,
  OcrConfigurationError,
  OcrExtractionError,
  UnsupportedDocumentTypeError,
} from "./errors.js";
import {
  createGeminiExtractor,
  DEFAULT_OCR_MAX_OUTPUT_TOKENS,
  extractDocumentAsync,
  LOW_CONFIDENCE_THRESHOLD,
  pagesNeedingReview,
} from "./extract.js";
import { tableEvidenceLocation } from "./tabular.js";

const NOTICE_LINES = [
  "Intimation under section 143(1) of the Income-tax Act",
  "Assessment year 2024-25",
  "Demand payable: Rs 48,250",
];

const scannedLine = {
  text: "Annexure A: TDS certificate",
  bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.04 },
};

function scannedPageStep(confidence = 0.92, handwriting = false) {
  return mockImageExtractionStep({
    text: "Annexure A: TDS certificate\nTotal TDS 12,000",
    confidence,
    handwriting,
    lines: [scannedLine],
  });
}

function mediaBytes(url: string | undefined): Buffer {
  return Buffer.from((url ?? "").split(",")[1] ?? "", "base64");
}

describe("extractDocumentAsync: deterministic paths", () => {
  it("parses CSV without calling the model", async () => {
    const ai = createMockAi();
    const csv =
      'Invoice,Date,Amount,Paid\nINV-1,2024-01-05,"1,200.50",true\nINV-2,2024-02-10,300,false\n';
    const outcome = await extractDocumentAsync(
      Buffer.from(csv),
      documentMetadata({ name: "sales.csv", mimeType: "text/csv" }),
      { ai },
    );

    expect(ai.calls).toEqual([]);
    expect(outcome.usage).toEqual({ input: 0, output: 0, total: 0 });
    expect(outcome.cost).toBe(0);
    expect(outcome.extraction).toMatchObject({
      documentId: "doc-1",
      kind: "tabular",
      method: "parse",
      confidence: 1,
      pages: [],
      warnings: [],
    });
    expect(outcome.extraction.tables).toEqual([
      {
        name: "sales",
        range: "A1:D3",
        columns: [
          { name: "Invoice", type: "string" },
          { name: "Date", type: "date" },
          { name: "Amount", type: "number" },
          { name: "Paid", type: "boolean" },
        ],
        rows: [
          ["INV-1", "2024-01-05", 1200.5, true],
          ["INV-2", "2024-02-10", 300, false],
        ],
      },
    ]);
  });

  it("parses TSV and decodes non-UTF-8 text with a warning", async () => {
    const ai = createMockAi();
    const tsv = Buffer.from("Name\tCity\nJos\u00e9\tPune\n", "latin1");
    const outcome = await extractDocumentAsync(
      tsv,
      documentMetadata({ name: "people.tsv", mimeType: "text/tab-separated-values" }),
      { ai },
    );

    expect(ai.calls).toEqual([]);
    expect(outcome.extraction.tables[0]?.rows).toEqual([["Jos\u00e9", "Pune"]]);
    expect(outcome.extraction.warnings).toEqual([
      "The file is not valid UTF-8; it was decoded as Windows-1252.",
    ]);
  });

  it("parses JSON records as tables without calling the model", async () => {
    const ai = createMockAi();
    const json = JSON.stringify({
      seller: { gstin: "27AAACB1234C1Z5" },
      invoices: [
        { number: "INV-1", date: "2024-01-05", amount: 1200.5, buyer: { name: "Apex" } },
        { number: "INV-2", date: "2024-02-10", amount: 300, buyer: { name: "Kite" } },
      ],
    });
    const outcome = await extractDocumentAsync(
      Buffer.from(json),
      documentMetadata({ name: "ledger.json", mimeType: "application/json" }),
      { ai },
    );

    expect(ai.calls).toEqual([]);
    expect(outcome.usage).toEqual({ input: 0, output: 0, total: 0 });
    expect(outcome.extraction).toMatchObject({
      kind: "tabular",
      method: "parse",
      confidence: 1,
      pages: [],
      warnings: [],
    });
    expect(outcome.extraction.tables).toEqual([
      {
        name: "invoices",
        sheet: "invoices",
        range: "A1:D3",
        columns: [
          { name: "number", type: "string" },
          { name: "date", type: "date" },
          { name: "amount", type: "number" },
          { name: "buyer.name", type: "string" },
        ],
        rows: [
          ["INV-1", "2024-01-05", 1200.5, "Apex"],
          ["INV-2", "2024-02-10", 300, "Kite"],
        ],
      },
      {
        name: "ledger fields",
        sheet: "ledger fields",
        range: "A1:B2",
        columns: [
          { name: "field", type: "string" },
          { name: "value", type: "string" },
        ],
        rows: [["seller.gstin", "27AAACB1234C1Z5"]],
      },
    ]);
  });

  it("reads JSON without record arrays as pretty-printed text", async () => {
    const outcome = await extractDocumentAsync(
      Buffer.from('{"status":"ok","count":2}'),
      documentMetadata({ name: "status.json", mimeType: "application/json" }),
      { ai: createMockAi() },
    );

    expect(outcome.extraction).toMatchObject({
      kind: "text",
      method: "parse",
      confidence: 1,
      tables: [],
      pages: [
        {
          index: 1,
          text: '{\n  "status": "ok",\n  "count": 2\n}',
          method: "parse",
          confidence: 1,
        },
      ],
      warnings: ["No arrays of records were found, so the file was read as text."],
    });
    expect(outcome.failedPages).toEqual([]);
  });

  it("parses JSON Lines and warns about invalid lines", async () => {
    const outcome = await extractDocumentAsync(
      Buffer.from('{"id":1,"ok":true}\n\nnot json\n{"id":2,"ok":false}\n'),
      documentMetadata({ name: "events.jsonl", mimeType: "" }),
      { ai: createMockAi() },
    );

    expect(outcome.extraction.kind).toBe("tabular");
    expect(outcome.extraction.tables).toEqual([
      {
        name: "events",
        range: "A1:B3",
        columns: [
          { name: "id", type: "number" },
          { name: "ok", type: "boolean" },
        ],
        rows: [
          [1, true],
          [2, false],
        ],
      },
    ]);
    expect(outcome.extraction.warnings).toHaveLength(1);
    expect(outcome.extraction.warnings[0]).toMatch(/^Line 3: /);
  });

  it("parses every xlsx sheet with typed columns and cell references", async () => {
    const ai = createMockAi();
    const workbook = createWorkbook([
      {
        name: "Sales",
        origin: "B3",
        rows: [
          ["Region", "Month", "Revenue", "Target met"],
          ["North", 0, 1500.25, true],
          ["South", 0, 980, false],
        ],
        dateCells: { C4: 45306, C5: 45337 },
      },
      { name: "Empty", rows: [] },
    ]);
    const outcome = await extractDocumentAsync(
      workbook,
      documentMetadata({
        name: "sales.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      { ai },
    );

    expect(ai.calls).toEqual([]);
    expect(outcome.extraction.method).toBe("parse");
    expect(outcome.extraction.warnings).toEqual(['Sheet "Empty" is empty.']);

    const [table] = outcome.extraction.tables;

    expect(table).toEqual({
      name: "Sales",
      sheet: "Sales",
      range: "B3:E5",
      columns: [
        { name: "Region", type: "string" },
        { name: "Month", type: "date" },
        { name: "Revenue", type: "number" },
        { name: "Target met", type: "boolean" },
      ],
      rows: [
        ["North", "2024-01-15", 1500.25, true],
        ["South", "2024-02-15", 980, false],
      ],
    });
    expect(tableEvidenceLocation(table!, { rowStart: 1, columnStart: 2 })).toEqual({
      sheet: "Sales",
      cellRange: "D5",
      rowRange: { start: 5, end: 5 },
    });
  });

  it("parses legacy xls workbooks", async () => {
    const ai = createMockAi();
    const workbook = createWorkbook(
      [
        {
          name: "Ledger",
          rows: [
            ["Party", "Due"],
            ["Acme", 1200],
          ],
        },
      ],
      "xls",
    );
    const outcome = await extractDocumentAsync(
      workbook,
      documentMetadata({ name: "ledger.xls", mimeType: "application/vnd.ms-excel" }),
      { ai },
    );

    expect(ai.calls).toEqual([]);
    expect(outcome.extraction.tables).toEqual([
      {
        name: "Ledger",
        sheet: "Ledger",
        range: "A1:B2",
        columns: [
          { name: "Party", type: "string" },
          { name: "Due", type: "number" },
        ],
        rows: [["Acme", 1200]],
      },
    ]);
  });

  it("reads a native-text PDF with page sizes and normalized spans", async () => {
    const ai = createMockAi();
    const pdf = await createPdfAsync([
      { text: NOTICE_LINES },
      { text: ["Page two has a typed reply"] },
    ]);
    const outcome = await extractDocumentAsync(
      pdf,
      documentMetadata({ name: "notice.pdf", mimeType: "application/pdf" }),
      { ai },
    );

    expect(ai.calls).toEqual([]);
    expect(outcome.pageUsage).toEqual([]);

    const { extraction } = outcome;

    expect(extraction).toMatchObject({
      kind: "text",
      method: "pdf-text",
      confidence: 1,
      warnings: [],
    });
    expect(
      extraction.pages.map((page) => [page.index, page.method, page.width, page.height]),
    ).toEqual([
      [1, "pdf-text", 612, 792],
      [2, "pdf-text", 612, 792],
    ]);
    expect(extraction.pages[0]?.text).toContain(NOTICE_LINES[0]);
    expect(extraction.pages[0]?.text).toContain("Demand payable: Rs 48,250");

    const span = extraction.pages[0]?.spans?.find((candidate) =>
      candidate.text.startsWith("Intimation"),
    );

    expect(span?.bbox.x).toBeCloseTo(72 / 612, 2);
    expect(span?.bbox.y).toBeCloseTo((792 - 720 - 12) / 792, 1);
    expect(span?.bbox.height).toBeGreaterThan(0);

    for (const page of extraction.pages) {
      for (const { bbox } of page.spans ?? []) {
        expect(bbox.x + bbox.width).toBeLessThanOrEqual(1);
        expect(bbox.y + bbox.height).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("extractDocumentAsync: OCR paths", () => {
  it("sends images to the cheap vision tier with capped output tokens", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep() });
    const outcome = await extractDocumentAsync(
      createPng(),
      documentMetadata({ name: "scan.png", mimeType: "image/png" }),
      { ai },
    );

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]).toMatchObject({
      tier: "cheap",
      maxOutputTokens: DEFAULT_OCR_MAX_OUTPUT_TOKENS,
      media: { contentType: "image/png" },
    });
    expect(outcome.extraction).toMatchObject({
      kind: "text",
      method: "ocr",
      confidence: 0.92,
      warnings: [],
      pages: [
        {
          index: 1,
          method: "ocr",
          confidence: 0.92,
          text: "Annexure A: TDS certificate\nTotal TDS 12,000",
          spans: [scannedLine],
        },
      ],
    });
    expect(outcome.usage.total).toBeGreaterThan(0);
    expect(outcome.cost).toBeGreaterThan(0);
    expect(outcome.pageUsage).toEqual([
      expect.objectContaining({ pageIndex: 1, method: "ocr", tier: "cheap", failed: false }),
    ]);
  });

  it("allows the mid tier but never the high tier", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep() });
    const metadata = documentMetadata({ name: "scan.png", mimeType: "image/png" });

    await extractDocumentAsync(createPng(), metadata, { ai }, { ocrTier: "mid" });

    expect(ai.calls[0]?.tier).toBe("mid");
    await expect(
      extractDocumentAsync(createPng(), metadata, { ai }, { ocrTier: "high" as "mid" }),
    ).rejects.toThrow(RangeError);
  });

  it("flags low-confidence OCR", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep(0.5) });
    const outcome = await extractDocumentAsync(
      createPng(),
      documentMetadata({ name: "scan.png", mimeType: "image/png" }),
      { ai },
    );

    expect(outcome.extraction.confidence).toBe(0.5);
    expect(outcome.extraction.warnings).toEqual([
      `Page 1: OCR confidence 0.50 is below ${LOW_CONFIDENCE_THRESHOLD}; verify it against the original before relying on it.`,
    ]);
    expect(pagesNeedingReview(outcome.extraction)).toEqual([1]);
  });

  it("caps and flags handwriting detected by the model", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep(0.95, true) });
    const outcome = await extractDocumentAsync(
      createPng(),
      documentMetadata({ name: "letter.jpg", mimeType: "image/jpeg" }),
      { ai },
    );

    expect(outcome.extraction).toMatchObject({ method: "handwriting", confidence: 0.6 });
    expect(outcome.extraction.pages[0]).toMatchObject({ method: "handwriting", confidence: 0.6 });
    expect(outcome.extraction.warnings).toEqual([
      "Page 1: handwritten content transcribed with confidence 0.60 (capped at 0.6); verify it against the original before relying on it.",
    ]);
    expect(pagesNeedingReview(outcome.extraction)).toEqual([1]);
  });

  it("forces handwriting mode through the option", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep(0.9, false) });
    const outcome = await extractDocumentAsync(
      createPng(),
      documentMetadata({ name: "note.png", mimeType: "image/png" }),
      { ai },
      { handwriting: "always" },
    );

    expect(ai.calls[0]?.system).toContain("expected to contain handwriting");
    expect(outcome.extraction.method).toBe("handwriting");
    expect(outcome.extraction.confidence).toBeLessThanOrEqual(0.6);
  });

  it("flags illegible and empty transcriptions as partial", async () => {
    const ai = createMockAi({
      [IMAGE_EXTRACTION_KEY]: mockImageExtractionStep({
        text: "Received Rs [illegible] on 12/03",
        confidence: 0.9,
      }),
    });
    const outcome = await extractDocumentAsync(
      createPng(),
      documentMetadata({ name: "receipt.png", mimeType: "image/png" }),
      { ai },
    );

    expect(outcome.extraction.warnings).toEqual([
      "Page 1: parts of the page are illegible; the transcription is partial.",
    ]);
  });

  it("sends only the scanned page of a mixed PDF to OCR, as a one-page PDF", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep() });
    const pdf = await createPdfAsync([{ text: NOTICE_LINES }, { image: true }]);
    const outcome = await extractDocumentAsync(
      pdf,
      documentMetadata({ name: "notice-with-annexure.pdf", mimeType: "application/pdf" }),
      { ai },
    );

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]?.media?.contentType).toBe("application/pdf");

    const sentPage = await PDFDocument.load(mediaBytes(ai.calls[0]?.media?.url));

    expect(sentPage.getPageCount()).toBe(1);
    expect(outcome.extraction).toMatchObject({ method: "mixed", confidence: 0.92 });
    expect(outcome.extraction.pages.map((page) => [page.index, page.method])).toEqual([
      [1, "pdf-text"],
      [2, "ocr"],
    ]);
    expect(outcome.extraction.pages[1]).toMatchObject({ width: 612, height: 792 });
    expect(outcome.pageUsage.map((entry) => entry.pageIndex)).toEqual([2]);
  });

  it("sends a single-page scanned PDF unchanged", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep() });
    const pdf = await createPdfAsync([{ image: true }]);
    const outcome = await extractDocumentAsync(
      pdf,
      documentMetadata({ name: "scan.pdf", mimeType: "application/pdf" }),
      { ai },
    );

    expect(mediaBytes(ai.calls[0]?.media?.url).equals(pdf)).toBe(true);
    expect(outcome.extraction.method).toBe("ocr");
  });

  it("keeps the text pages when a scanned page fails and reports the failed page", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: { error: "non-transient" } });
    const pdf = await createPdfAsync([{ text: NOTICE_LINES }, { image: true }]);
    const outcome = await extractDocumentAsync(
      pdf,
      documentMetadata({ name: "notice.pdf", mimeType: "application/pdf" }),
      { ai },
    );

    expect(outcome.failedPages).toEqual([2]);
    expect(outcome.extraction.pages[1]).toMatchObject({ index: 2, text: "", confidence: 0 });
    expect(outcome.extraction.warnings[0]).toMatch(/^Page 2: extraction failed/);
    expect(outcome.pageUsage[0]).toMatchObject({ pageIndex: 2, failed: true });
  });

  it("throws when nothing could be extracted", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: { error: "non-transient" } });

    await expect(
      extractDocumentAsync(
        createPng(),
        documentMetadata({ name: "a.png", mimeType: "image/png" }),
        {
          ai,
        },
      ),
    ).rejects.toThrow(/Mock non-transient failure/);
  });

  it("retains total spend and original failure classifications when all pages fail", async () => {
    const errors = [
      new AiOutputValidationError("Invalid output", ["Missing text"], "{}", {
        usage: { input: 100, output: 20, total: 120 },
        cost: 0.001,
        attempts: 1,
      }),
      new AiTransientError("Unavailable", {
        usage: { input: 200, output: 30, total: 230 },
        cost: 0.002,
        attempts: 2,
      }),
    ];
    const ai = {
      extractFromImageAsync: vi
        .fn()
        .mockRejectedValueOnce(errors[0])
        .mockRejectedValueOnce(errors[1]),
    };
    const pdf = await createPdfAsync([{ image: true }, { image: true }]);
    const error = await extractDocumentAsync(
      pdf,
      documentMetadata({ name: "scanned.pdf", mimeType: "application/pdf" }),
      { ai },
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(OcrExtractionError);

    if (!(error instanceof OcrExtractionError)) {
      throw new Error("Expected OcrExtractionError");
    }

    expect(error.documentId).toBe("doc-1");
    expect(error.usage).toEqual({ input: 300, output: 50, total: 350 });
    expect(error.cost).toBe(0.003);
    expect(error.pageUsage).toEqual([
      expect.objectContaining({ pageIndex: 1, attempts: 1, failed: true, cost: 0.001 }),
      expect.objectContaining({ pageIndex: 2, attempts: 2, failed: true, cost: 0.002 }),
    ]);
    expect(error.errors[0]).toBe(errors[0]);
    expect(error.errors[1]).toBe(errors[1]);
    expect(error.cause).toBeInstanceOf(AggregateError);
  });

  it("skips OCR past the page limit and reports partial pages", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep() });
    const pdf = await createPdfAsync([{ text: NOTICE_LINES }, { image: true }]);
    const outcome = await extractDocumentAsync(
      pdf,
      documentMetadata({ name: "notice.pdf", mimeType: "application/pdf" }),
      { ai },
      { maxOcrPages: 0 },
    );

    expect(ai.calls).toEqual([]);
    expect(outcome.failedPages).toEqual([]);
    expect(outcome.extraction.warnings).toEqual([
      "Page 2: not sent to OCR because the document exceeds the 0-page OCR limit; the page content is missing.",
    ]);
  });

  it("honors a zero OCR page limit for images without calling the model", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep() });
    const outcome = await extractDocumentAsync(
      createPng(),
      documentMetadata({ name: "a.png", mimeType: "image/png" }),
      { ai },
      { maxOcrPages: 0 },
    );

    expect(ai.calls).toEqual([]);
    expect(outcome.usage).toEqual({ input: 0, output: 0, total: 0 });
    expect(outcome.failedPages).toEqual([]);
    expect(outcome.extraction.pages).toEqual([
      { index: 1, text: "", method: "ocr", confidence: 0 },
    ]);
    expect(outcome.extraction.warnings).toEqual([
      "Page 1: not sent to OCR because the document exceeds the 0-page OCR limit; the page content is missing.",
    ]);
  });

  it("throws when every OCR page failed even if other pages were skipped", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: { error: "non-transient" } });
    const pdf = await createPdfAsync([{ image: true }, { image: true }]);

    await expect(
      extractDocumentAsync(
        pdf,
        documentMetadata({ name: "scanned.pdf", mimeType: "application/pdf" }),
        { ai },
        { maxOcrPages: 1 },
      ),
    ).rejects.toBeInstanceOf(OcrExtractionError);
  });

  it("stops scheduling OCR after a configuration error and keeps in-flight accounting", async () => {
    const configurationError = new AiNonTransientError("Model not configured", {
      reason: "not-configured",
      usage: { input: 10, output: 0, total: 10 },
      cost: 0.0001,
      attempts: 1,
    });
    const inFlightError = new AiTransientError("Unavailable", {
      usage: { input: 200, output: 30, total: 230 },
      cost: 0.002,
      attempts: 2,
    });
    const ai = {
      extractFromImageAsync: vi
        .fn()
        .mockRejectedValueOnce(configurationError)
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(inFlightError), 20);
            }),
        ),
    };
    const pdf = await createPdfAsync([
      { image: true },
      { image: true },
      { image: true },
      { image: true },
    ]);
    const error = await extractDocumentAsync(
      pdf,
      documentMetadata({ name: "scanned.pdf", mimeType: "application/pdf" }),
      { ai },
      { ocrConcurrency: 2 },
    ).catch((failure: unknown) => failure);

    expect(ai.extractFromImageAsync).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(OcrConfigurationError);

    if (!(error instanceof OcrConfigurationError)) {
      throw new Error("Expected OcrConfigurationError");
    }

    expect(error.cause).toBe(configurationError);
    expect(error.errors).toEqual([configurationError, inFlightError]);
    expect(error.usage).toEqual({ input: 210, output: 30, total: 240 });
    expect(error.cost).toBe(0.0021);
    expect(error.pageUsage.map((entry) => entry.pageIndex)).toEqual([1, 2]);
    expect(error.pageUsage.every((entry) => entry.failed)).toBe(true);
  });
});

describe("extractDocumentAsync: errors", () => {
  it.each(["II*\u0000rest", "MM\u0000*rest", "GIF87a", "GIF89a"])(
    "rejects TIFF and GIF before any model call (%j)",
    async (header) => {
      const ai = createMockAi();

      await expect(
        extractDocumentAsync(
          Buffer.from(header, "latin1"),
          documentMetadata({ name: "scan.png", mimeType: "image/png" }),
          { ai },
        ),
      ).rejects.toBeInstanceOf(UnsupportedDocumentTypeError);
      expect(ai.calls).toEqual([]);
    },
  );

  it("rejects unsupported types before any model call", async () => {
    const ai = createMockAi({ [IMAGE_EXTRACTION_KEY]: scannedPageStep() });

    await expect(
      extractDocumentAsync(
        Buffer.from("plain notes"),
        documentMetadata({ name: "notes.md", mimeType: "text/markdown" }),
        { ai },
      ),
    ).rejects.toBeInstanceOf(UnsupportedDocumentTypeError);
    expect(ai.calls).toEqual([]);
  });

  it("wraps unreadable PDFs and spreadsheets in a DocumentExtractionError", async () => {
    const ai = createMockAi();

    await expect(
      extractDocumentAsync(
        Buffer.from("%PDF-1.7\nbroken"),
        documentMetadata({ name: "broken.pdf", mimeType: "application/pdf" }),
        { ai },
      ),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
    await expect(
      extractDocumentAsync(
        Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("xl/workbook.xml")]),
        documentMetadata({ name: "broken.xlsx", mimeType: "application/zip" }),
        { ai },
      ),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
  });

  it("wraps malformed JSON and JSON Lines in a DocumentExtractionError", async () => {
    const ai = createMockAi();

    await expect(
      extractDocumentAsync(
        Buffer.from('{"a": 1,'),
        documentMetadata({ name: "broken.json", mimeType: "application/json" }),
        { ai },
      ),
    ).rejects.toThrow(/"broken\.json" could not be read as JSON: /);
    await expect(
      extractDocumentAsync(
        Buffer.from("nope\nstill nope\n"),
        documentMetadata({ name: "broken.jsonl", mimeType: "" }),
        { ai },
      ),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
    expect(ai.calls).toEqual([]);
  });

  it("reports oversized delimited text as a DocumentExtractionError", async () => {
    const header = Array.from({ length: 10_000 }, (_unused, index) => `H${index}`).join(",");

    await expect(
      extractDocumentAsync(
        Buffer.from(`${header}\n${"1\n".repeat(10_000)}`),
        documentMetadata({ name: "wide.csv", mimeType: "text/csv" }),
        { ai: createMockAi() },
      ),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
  });
});

describe("createGeminiExtractor", () => {
  it("delegates to extractDocumentAsync", async () => {
    const ai = createMockAi();
    const extractor = createGeminiExtractor({ ai });
    const outcome = await extractor.extractAsync(
      Buffer.from("a\n1\n"),
      documentMetadata({ name: "a.csv", mimeType: "text/csv" }),
    );

    expect(extractor.name).toBe("gemini");
    expect(outcome.extraction.tables[0]?.columns).toEqual([{ name: "a", type: "number" }]);
  });
});
