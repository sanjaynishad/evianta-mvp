import type { BoundingBox, TextSpan } from "@evianta/core";
import { z } from "zod";

import type { ImageExtractionMode, ImageExtractionRequest, ModelMedia } from "./types.js";

export const IMAGE_EXTRACTION_KEY = "extract-from-image";

export const HANDWRITING_CONFIDENCE_CAP = 0.6;

export const DEFAULT_IMAGE_MAX_OUTPUT_TOKENS = 8192;

export const imageExtractionModelOutputSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  handwriting: z.boolean(),
  lines: z
    .array(
      z.object({
        text: z.string(),
        // [ymin, xmin, ymax, xmax] normalized to 0..1000, the native Gemini box format.
        box_2d: z.array(z.number()),
      }),
    )
    .default([]),
});

export type ImageExtractionModelOutput = z.infer<typeof imageExtractionModelOutputSchema>;

export const imageExtractionInputSchema = z.object({
  mode: z.enum(["printed", "handwriting", "auto"]),
  lineBoxes: z.boolean(),
});

const modeInstructions: Record<ImageExtractionMode, string> = {
  printed: "The page is expected to be printed or typed text.",
  handwriting: "The page is expected to contain handwriting. Set handwriting to true.",
  auto: "Set handwriting to true if any meaningful part of the text is handwritten.",
};

export function imageExtractionSystemPrompt(mode: ImageExtractionMode, lineBoxes: boolean): string {
  return [
    "You transcribe a single document page image for an evidence-based professional workflow.",
    "Transcribe exactly what is visible, in reading order, one line per output line. Preserve numbers, dates, amounts, and identifiers character for character.",
    "Never guess or complete missing text. Write [illegible] for anything you cannot read.",
    "Set confidence between 0 and 1 to reflect how legible and complete the transcription is.",
    modeInstructions[mode],
    lineBoxes
      ? "For each line, return its text and box_2d as [ymin, xmin, ymax, xmax] normalized to 0-1000."
      : "Return an empty lines array.",
  ].join("\n");
}

function clampPermille(value: number): number {
  return Math.min(1000, Math.max(0, value));
}

export function boxToBoundingBox(box: number[]): BoundingBox | undefined {
  if (box.length !== 4 || box.some((value) => !Number.isFinite(value))) {
    return undefined;
  }

  const [yA, xA, yB, xB] = box.map(clampPermille) as [number, number, number, number];
  const width = Math.abs(xB - xA);
  const height = Math.abs(yB - yA);

  if (width === 0 || height === 0) {
    return undefined;
  }

  return {
    x: Math.min(xA, xB) / 1000,
    y: Math.min(yA, yB) / 1000,
    width: width / 1000,
    height: height / 1000,
  };
}

export function toTextSpans(lines: ImageExtractionModelOutput["lines"]): TextSpan[] {
  return lines.flatMap((line) => {
    const bbox = boxToBoundingBox(line.box_2d);

    return bbox && line.text.trim() ? [{ text: line.text, bbox }] : [];
  });
}

export function toImageMedia(
  request: Pick<ImageExtractionRequest, "image" | "mimeType">,
): ModelMedia {
  const { image, mimeType } = request;

  if (typeof image === "string") {
    const url = image.startsWith("data:") ? image : `data:${mimeType};base64,${image}`;

    return { url, contentType: mimeType };
  }

  return {
    url: `data:${mimeType};base64,${Buffer.from(image).toString("base64")}`,
    contentType: mimeType,
  };
}
