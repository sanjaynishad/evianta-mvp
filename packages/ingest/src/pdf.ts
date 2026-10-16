import { createRequire } from "node:module";
import path from "node:path";

import type { TextSpan } from "@evianta/core";
import { PDFDocument } from "pdf-lib";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

export const MIN_TEXT_LAYER_CHARS = 20;

const MIN_READABLE_RATIO = 0.5;
const BBOX_PRECISION = 10_000;

export interface PdfTextPage {
  /** 1-based. */
  index: number;
  /** Page size in PDF points, after rotation. */
  width: number;
  height: number;
  text: string;
  spans: TextSpan[];
  hasUsableTextLayer: boolean;
}

interface PdfjsAssetUrls {
  cMapUrl: string;
  standardFontDataUrl: string;
}

let assetUrls: PdfjsAssetUrls | undefined;

// pdf.js reads these with fs in Node and requires forward slashes with a trailing slash.
function pdfjsAssetUrls(): PdfjsAssetUrls {
  if (!assetUrls) {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve("pdfjs-dist/package.json")).replaceAll("\\", "/");
    assetUrls = { cMapUrl: `${root}/cmaps/`, standardFontDataUrl: `${root}/standard_fonts/` };
  }

  return assetUrls;
}

export function hasUsableTextLayer(text: string, minChars = MIN_TEXT_LAYER_CHARS): boolean {
  const visible = text.replace(/\s+/g, "");

  if (visible.length < minChars) {
    return false;
  }

  const readable = visible.match(/[\p{L}\p{N}]/gu)?.length ?? 0;

  return readable / visible.length >= MIN_READABLE_RATIO;
}

function roundUnit(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * BBOX_PRECISION) / BBOX_PRECISION;
}

type Matrix = readonly number[];

function applyMatrix(matrix: Matrix, x: number, y: number): [number, number] {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix;

  return [a * x + c * y + e, b * x + d * y + f];
}

/** Normalized box of a text run, projected corner by corner so rotated pages and text stay exact. */
export function textRunBox(
  run: { transform: Matrix; width: number; height: number },
  viewport: { transform: Matrix; width: number; height: number },
): TextSpan["bbox"] | undefined {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return undefined;
  }

  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = run.transform;
  const baseLength = Math.hypot(a, b) || 1;
  const upLength = Math.hypot(c, d) || 1;
  const along = [(a / baseLength) * run.width, (b / baseLength) * run.width] as const;
  const height = run.height > 0 ? run.height : upLength;
  const up = [(c / upLength) * height, (d / upLength) * height] as const;
  const corners = [
    [e, f],
    [e + along[0], f + along[1]],
    [e + up[0], f + up[1]],
    [e + along[0] + up[0], f + along[1] + up[1]],
  ].map(([x = 0, y = 0]) => applyMatrix(viewport.transform, x, y));
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x0 = roundUnit(Math.min(...xs) / viewport.width);
  const x1 = roundUnit(Math.max(...xs) / viewport.width);
  const y0 = roundUnit(Math.min(...ys) / viewport.height);
  const y1 = roundUnit(Math.max(...ys) / viewport.height);

  if (x1 - x0 <= 0 || y1 - y0 <= 0) {
    return undefined;
  }

  return { x: x0, y: y0, width: roundUnit(x1 - x0), height: roundUnit(y1 - y0) };
}

function tidyText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

function roundPoints(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Reads the text layer of every page with pdf.js; no rendering, no worker thread. */
export async function readPdfTextLayerAsync(
  bytes: Uint8Array,
  options: { minTextChars?: number } = {},
): Promise<PdfTextPage[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    ...pdfjsAssetUrls(),
    cMapPacked: true,
    verbosity: VerbosityLevel.ERRORS,
    disableFontFace: true,
    useSystemFonts: false,
  });

  try {
    const pdf = await loadingTask.promise;
    const pages: PdfTextPage[] = [];

    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const spans: TextSpan[] = [];
      let text = "";

      for (const item of content.items) {
        if (!("str" in item)) {
          continue;
        }

        text += item.str;

        if (item.hasEOL) {
          text += "\n";
        }

        if (!item.str.trim()) {
          continue;
        }

        const bbox = textRunBox(item, viewport);

        if (bbox) {
          spans.push({ text: item.str, bbox });
        }
      }

      const pageText = tidyText(text);
      pages.push({
        index,
        width: roundPoints(viewport.width),
        height: roundPoints(viewport.height),
        text: pageText,
        spans,
        hasUsableTextLayer: hasUsableTextLayer(pageText, options.minTextChars),
      });
      page.cleanup();
    }

    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

export interface PdfPageSplitter {
  pageBytesAsync(pageIndex: number): Promise<Uint8Array>;
}

/** Copies single pages into standalone PDFs so OCR only receives the page that needs it. */
export async function createPdfPageSplitterAsync(
  bytes: Uint8Array,
  pageCount: number,
): Promise<PdfPageSplitter> {
  if (pageCount === 1) {
    return { pageBytesAsync: async () => bytes };
  }

  const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });

  return {
    async pageBytesAsync(pageIndex) {
      const single = await PDFDocument.create({ updateMetadata: false });
      const [copied] = await single.copyPages(source, [pageIndex - 1]);

      if (!copied) {
        throw new Error(`Page ${pageIndex} could not be copied.`);
      }

      single.addPage(copied);

      return single.save();
    },
  };
}
