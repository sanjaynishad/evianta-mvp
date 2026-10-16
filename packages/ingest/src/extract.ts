import type {
  DocumentMetadata,
  ExtractedDocument,
  ExtractedPage,
  ExtractionMethod,
  TokenUsage,
} from "@evianta/core";
import { extractedDocumentSchema } from "@evianta/core";
import {
  addUsage,
  AiError,
  AiNonTransientError,
  emptyUsage,
  HANDWRITING_CONFIDENCE_CAP,
  roundCost,
  type AiClient,
  type Cost,
  type ImageExtractionMode,
  type ModelId,
  type VisionModelTier,
} from "@evianta/ai";

import { detectDocumentFormat } from "./detect.js";
import { DocumentExtractionError, OcrExtractionError } from "./errors.js";
import {
  createPdfPageSplitterAsync,
  MIN_TEXT_LAYER_CHARS,
  readPdfTextLayerAsync,
  type PdfPageSplitter,
  type PdfTextPage,
} from "./pdf.js";
import {
  decodeText,
  parseDelimitedText,
  parseWorkbook,
  type TabularParseResult,
} from "./spreadsheet.js";
import type { DateOrder } from "./tabular.js";

export const LOW_CONFIDENCE_THRESHOLD = 0.75;
export const DEFAULT_OCR_TIER: VisionModelTier = "cheap";
export const DEFAULT_OCR_MAX_OUTPUT_TOKENS = 6144;
export const DEFAULT_MAX_OCR_PAGES = 50;
export const DEFAULT_OCR_CONCURRENCY = 4;

export type HandwritingMode = "auto" | "always" | "never";

export interface ExtractionOptions {
  /** "always" treats every OCR page as handwriting; "auto" trusts the model's handwriting hint. */
  handwriting?: HandwritingMode;
  /** Vision tier for OCR. The high tier is never used for OCR. */
  ocrTier?: VisionModelTier;
  maxOutputTokensPerPage?: number;
  lowConfidenceThreshold?: number;
  /** Pages past this limit are not sent to OCR and are reported as partial. */
  maxOcrPages?: number;
  ocrConcurrency?: number;
  /** Non-whitespace characters a PDF page needs before its text layer is trusted. */
  minTextLayerChars?: number;
  /** Order for ambiguous numeric dates such as 03/04/2024. Defaults to "dmy". */
  dateOrder?: DateOrder;
}

export interface ExtractionDeps {
  ai: Pick<AiClient, "extractFromImageAsync">;
}

export interface PageOcrUsage {
  pageIndex: number;
  method: "ocr" | "handwriting";
  tier: VisionModelTier;
  model?: ModelId;
  usage: TokenUsage;
  cost: Cost;
  attempts: number;
  failed: boolean;
}

export interface ExtractionOutcome {
  extraction: ExtractedDocument;
  /** Model usage across every OCR call, including failed attempts. Zero for deterministic paths. */
  usage: TokenUsage;
  cost: Cost;
  pageUsage: PageOcrUsage[];
  /** Pages whose OCR call failed; the extraction is incomplete and should not be cached. */
  failedPages: number[];
}

/** Turns stored bytes into an ExtractedDocument; swap in another backend (for example Document AI). */
export interface Extractor {
  readonly name: string;
  extractAsync(
    buffer: Uint8Array,
    metadata: DocumentMetadata,
    options?: ExtractionOptions,
  ): Promise<ExtractionOutcome>;
}

interface ResolvedOptions {
  mode: ImageExtractionMode;
  tier: VisionModelTier;
  maxOutputTokens: number;
  lowConfidenceThreshold: number;
  maxOcrPages: number;
  concurrency: number;
  minTextLayerChars: number;
  dateOrder: DateOrder;
}

const MODE_BY_HANDWRITING: Record<HandwritingMode, ImageExtractionMode> = {
  auto: "auto",
  always: "handwriting",
  never: "printed",
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveOptions(options: ExtractionOptions): ResolvedOptions {
  const tier = options.ocrTier ?? DEFAULT_OCR_TIER;

  if (tier !== "cheap" && tier !== "mid") {
    throw new RangeError(`OCR runs on the cheap or mid tier only, got "${String(tier)}".`);
  }

  return {
    mode: MODE_BY_HANDWRITING[options.handwriting ?? "auto"],
    tier,
    maxOutputTokens: positiveInteger(options.maxOutputTokensPerPage, DEFAULT_OCR_MAX_OUTPUT_TOKENS),
    lowConfidenceThreshold: options.lowConfidenceThreshold ?? LOW_CONFIDENCE_THRESHOLD,
    maxOcrPages: Math.max(0, Math.floor(options.maxOcrPages ?? DEFAULT_MAX_OCR_PAGES)),
    concurrency: positiveInteger(options.ocrConcurrency, DEFAULT_OCR_CONCURRENCY),
    minTextLayerChars: Math.max(0, options.minTextLayerChars ?? MIN_TEXT_LAYER_CHARS),
    dateOrder: options.dateOrder ?? "dmy",
  };
}

function formatConfidence(value: number): string {
  return value.toFixed(2);
}

interface OcrPageRequest {
  pageIndex: number;
  mimeType: string;
  bytesAsync: () => Promise<Uint8Array>;
  width?: number;
  height?: number;
}

interface PageResult {
  page: ExtractedPage;
  warnings: string[];
  usage?: PageOcrUsage;
  error?: unknown;
}

function isConfigurationError(error: unknown): boolean {
  return (
    error instanceof AiNonTransientError &&
    (error.reason === "not-configured" || error.reason === "permission-denied")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ocrPageAsync(
  deps: ExtractionDeps,
  request: OcrPageRequest,
  settings: ResolvedOptions,
): Promise<PageResult> {
  const { pageIndex } = request;
  const size = {
    ...(request.width === undefined ? {} : { width: request.width }),
    ...(request.height === undefined ? {} : { height: request.height }),
  };
  const expectedMethod = settings.mode === "handwriting" ? "handwriting" : "ocr";

  try {
    const result = await deps.ai.extractFromImageAsync({
      image: await request.bytesAsync(),
      mimeType: request.mimeType,
      mode: settings.mode,
      tier: settings.tier,
      lineBoxes: true,
      maxOutputTokens: settings.maxOutputTokens,
    });
    const handwriting =
      settings.mode === "handwriting" || result.handwriting || result.method === "handwriting";
    const confidence = handwriting
      ? Math.min(result.confidence, HANDWRITING_CONFIDENCE_CAP)
      : result.confidence;
    const method = handwriting ? "handwriting" : "ocr";
    const text = result.text.trim();
    const warnings: string[] = [];

    if (handwriting) {
      warnings.push(
        `Page ${pageIndex}: handwritten content transcribed with confidence ${formatConfidence(confidence)} (capped at ${HANDWRITING_CONFIDENCE_CAP}); verify it against the original before relying on it.`,
      );
    } else if (confidence < settings.lowConfidenceThreshold) {
      warnings.push(
        `Page ${pageIndex}: OCR confidence ${formatConfidence(confidence)} is below ${settings.lowConfidenceThreshold}; verify it against the original before relying on it.`,
      );
    }

    if (!text) {
      warnings.push(`Page ${pageIndex}: no text was recognized.`);
    } else if (/\[illegible\]/i.test(text)) {
      warnings.push(
        `Page ${pageIndex}: parts of the page are illegible; the transcription is partial.`,
      );
    }

    return {
      page: {
        index: pageIndex,
        text,
        ...size,
        method,
        confidence,
        ...(result.lines.length > 0 ? { spans: result.lines } : {}),
      },
      warnings,
      usage: {
        pageIndex,
        method,
        tier: result.tier,
        model: result.model,
        usage: result.usage,
        cost: result.cost,
        attempts: result.attempts,
        failed: false,
      },
    };
  } catch (error) {
    if (isConfigurationError(error) || !(error instanceof Error)) {
      throw error;
    }

    const aiError = error instanceof AiError ? error : undefined;

    return {
      page: { index: pageIndex, text: "", ...size, method: expectedMethod, confidence: 0 },
      warnings: [
        `Page ${pageIndex}: extraction failed (${errorMessage(error)}); the page content is missing.`,
      ],
      usage: {
        pageIndex,
        method: expectedMethod,
        tier: settings.tier,
        usage: aiError?.usage ?? emptyUsage(),
        cost: aiError?.cost ?? 0,
        attempts: aiError?.attempts ?? 0,
        failed: true,
      },
      error,
    };
  }
}

async function mapWithConcurrencyAsync<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function workerAsync(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index] as T);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => workerAsync()),
  );

  return results;
}

function documentMethod(pages: readonly ExtractedPage[]): ExtractionMethod {
  const methods = new Set(pages.map((page) => page.method));
  const [only] = methods;

  return methods.size === 1 && only ? only : "mixed";
}

function buildOutcome(
  metadata: DocumentMetadata,
  results: readonly PageResult[],
  extraWarnings: readonly string[] = [],
): ExtractionOutcome {
  const pages = results
    .map((result) => result.page)
    .sort((left, right) => left.index - right.index);
  const pageUsage = results.flatMap((result) => (result.usage ? [result.usage] : []));
  const failed = results.filter((result) => result.error !== undefined);
  const usage = pageUsage.reduce((total, entry) => addUsage(total, entry.usage), emptyUsage());
  const cost = roundCost(pageUsage.reduce((total, entry) => total + entry.cost, 0));

  if (pages.length > 0 && failed.length === pages.length) {
    throw new OcrExtractionError(
      metadata.id,
      { usage, cost, pageUsage },
      failed.map((result) => result.error),
    );
  }

  const extraction = extractedDocumentSchema.parse({
    documentId: metadata.id,
    kind: "text",
    method: documentMethod(pages),
    confidence: pages.reduce((lowest, page) => Math.min(lowest, page.confidence), 1),
    pages,
    tables: [],
    warnings: [...extraWarnings, ...results.flatMap((result) => result.warnings)],
  });

  return {
    extraction,
    usage,
    cost,
    pageUsage,
    failedPages: failed.map((result) => result.page.index),
  };
}

function textLayerPage(page: PdfTextPage): PageResult {
  return {
    page: {
      index: page.index,
      text: page.text,
      width: page.width,
      height: page.height,
      method: "pdf-text",
      confidence: 1,
      ...(page.spans.length > 0 ? { spans: page.spans } : {}),
    },
    warnings: [],
  };
}

function skippedPage(page: PdfTextPage, settings: ResolvedOptions): PageResult {
  return {
    page: {
      index: page.index,
      text: page.text,
      width: page.width,
      height: page.height,
      method: "ocr",
      confidence: 0,
    },
    warnings: [
      `Page ${page.index}: not sent to OCR because the document exceeds the ${settings.maxOcrPages}-page OCR limit; the page content is missing.`,
    ],
  };
}

async function extractPdfAsync(
  buffer: Uint8Array,
  metadata: DocumentMetadata,
  deps: ExtractionDeps,
  settings: ResolvedOptions,
): Promise<ExtractionOutcome> {
  let textPages: PdfTextPage[];

  try {
    textPages = await readPdfTextLayerAsync(buffer, { minTextChars: settings.minTextLayerChars });
  } catch (error) {
    throw new DocumentExtractionError(
      metadata.id,
      `"${metadata.name}" could not be read as a PDF: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (textPages.length === 0) {
    throw new DocumentExtractionError(metadata.id, `"${metadata.name}" has no pages.`);
  }

  const scannedPages = textPages.filter((page) => !page.hasUsableTextLayer);
  const ocrPages = scannedPages.slice(0, settings.maxOcrPages);
  const skippedIndexes = new Set(
    scannedPages.slice(settings.maxOcrPages).map((page) => page.index),
  );
  let splitter: Promise<PdfPageSplitter> | undefined;
  const pageBytesAsync = (pageIndex: number) => {
    splitter ??= createPdfPageSplitterAsync(buffer, textPages.length);

    return splitter.then((value) => value.pageBytesAsync(pageIndex));
  };

  const ocrResults = await mapWithConcurrencyAsync(ocrPages, settings.concurrency, (page) =>
    ocrPageAsync(
      deps,
      {
        pageIndex: page.index,
        mimeType: "application/pdf",
        bytesAsync: () => pageBytesAsync(page.index),
        width: page.width,
        height: page.height,
      },
      settings,
    ),
  );
  const ocrByIndex = new Map(ocrResults.map((result) => [result.page.index, result]));
  const results = textPages.map((page) => {
    if (page.hasUsableTextLayer) {
      return textLayerPage(page);
    }

    if (skippedIndexes.has(page.index)) {
      return skippedPage(page, settings);
    }

    return ocrByIndex.get(page.index) as PageResult;
  });

  return buildOutcome(metadata, results);
}

function tabularOutcome(metadata: DocumentMetadata, parsed: TabularParseResult): ExtractionOutcome {
  return {
    extraction: extractedDocumentSchema.parse({
      documentId: metadata.id,
      kind: "tabular",
      method: "parse",
      confidence: 1,
      pages: [],
      tables: parsed.tables,
      warnings: parsed.warnings,
    }),
    usage: emptyUsage(),
    cost: 0,
    pageUsage: [],
    failedPages: [],
  };
}

function tableNameFor(metadata: DocumentMetadata): string {
  return metadata.name.replace(/\.[^./\\]+$/, "") || metadata.name;
}

/** Pure extraction: no store access. Deterministic formats never call the model. */
export async function extractDocumentAsync(
  buffer: Uint8Array,
  metadata: DocumentMetadata,
  deps: ExtractionDeps,
  options: ExtractionOptions = {},
): Promise<ExtractionOutcome> {
  const settings = resolveOptions(options);
  const detected = detectDocumentFormat(buffer, metadata);

  switch (detected.format) {
    case "csv":
    case "tsv": {
      const decoded = decodeText(buffer);
      const parsed = parseDelimitedText(decoded.text, {
        name: tableNameFor(metadata),
        delimiter: detected.format === "tsv" ? "\t" : undefined,
        dateOrder: settings.dateOrder,
      });

      return tabularOutcome(metadata, {
        tables: parsed.tables,
        warnings: decoded.warning ? [decoded.warning, ...parsed.warnings] : parsed.warnings,
      });
    }

    case "xlsx":
    case "xls": {
      let parsed: TabularParseResult;

      try {
        parsed = parseWorkbook(buffer, { dateOrder: settings.dateOrder });
      } catch (error) {
        throw new DocumentExtractionError(
          metadata.id,
          `"${metadata.name}" could not be read as a spreadsheet: ${errorMessage(error)}`,
          { cause: error },
        );
      }

      return tabularOutcome(metadata, parsed);
    }

    case "pdf":
      return extractPdfAsync(buffer, metadata, deps, settings);
    case "image": {
      const result = await ocrPageAsync(
        deps,
        { pageIndex: 1, mimeType: detected.mimeType, bytesAsync: async () => buffer },
        settings,
      );

      return buildOutcome(metadata, [result]);
    }
  }
}

export function createGeminiExtractor(deps: ExtractionDeps): Extractor {
  return {
    name: "gemini",
    extractAsync: (buffer, metadata, options) =>
      extractDocumentAsync(buffer, metadata, deps, options),
  };
}

/** Page indexes whose content should be reviewed by a person before it is relied on. */
export function pagesNeedingReview(
  extraction: Pick<ExtractedDocument, "pages">,
  threshold = LOW_CONFIDENCE_THRESHOLD,
): number[] {
  return extraction.pages
    .filter((page) => page.method === "handwriting" || page.confidence < threshold)
    .map((page) => page.index);
}
