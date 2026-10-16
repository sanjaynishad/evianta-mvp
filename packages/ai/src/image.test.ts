import { describe, expect, it } from "vitest";

import { AiInputValidationError } from "./errors.js";
import { boxToBoundingBox, HANDWRITING_CONFIDENCE_CAP, IMAGE_EXTRACTION_KEY } from "./image.js";
import { createMockAi, MOCK_IMAGE_TOKENS, mockImageExtractionStep } from "./mock.js";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("extractFromImageAsync", () => {
  it("returns printed text, confidence, and normalized line boxes", async () => {
    const ai = createMockAi({
      [IMAGE_EXTRACTION_KEY]: mockImageExtractionStep({
        text: "Notice under section 143(1)\nDemand: 12,500",
        confidence: 0.94,
        lines: [
          {
            text: "Notice under section 143(1)",
            bbox: { x: 0.1, y: 0.05, width: 0.6, height: 0.04 },
          },
          { text: "Demand: 12,500", bbox: { x: 0.1, y: 0.12, width: 0.3, height: 0.04 } },
        ],
        usage: { input: 300, output: 40 },
      }),
    });

    const result = await ai.extractFromImageAsync({ image: pngBytes, mimeType: "image/png" });

    expect(result).toMatchObject({
      text: "Notice under section 143(1)\nDemand: 12,500",
      confidence: 0.94,
      method: "ocr",
      handwriting: false,
      tier: "cheap",
      model: "gemini-2.5-flash-lite",
      attempts: 1,
      usage: { input: 300, output: 40, total: 340 },
    });
    expect(result.cost).toBeGreaterThan(0);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]?.text).toBe("Notice under section 143(1)");
    expect(result.lines[0]?.bbox.x).toBeCloseTo(0.1, 6);
    expect(result.lines[0]?.bbox.y).toBeCloseTo(0.05, 6);
    expect(result.lines[0]?.bbox.width).toBeCloseTo(0.6, 6);
    expect(result.lines[0]?.bbox.height).toBeCloseTo(0.04, 6);
  });

  it("sends the image as a data URL with the vision tier model", async () => {
    const ai = createMockAi({
      [IMAGE_EXTRACTION_KEY]: mockImageExtractionStep({ text: "x", confidence: 0.9 }),
    });

    await ai.extractFromImageAsync({ image: pngBytes, mimeType: "image/png", tier: "mid" });

    expect(ai.calls[0]).toMatchObject({
      key: IMAGE_EXTRACTION_KEY,
      tier: "mid",
      model: "gemini-2.5-flash",
      grounding: false,
      media: {
        url: `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`,
        contentType: "image/png",
      },
    });
  });

  it("accepts base64 strings and data URLs", async () => {
    const ai = createMockAi({ "*": mockImageExtractionStep({ text: "x", confidence: 0.9 }) });

    await ai.extractFromImageAsync({ image: "AAAA", mimeType: "image/jpeg" });
    await ai.extractFromImageAsync({
      image: "data:image/webp;base64,BBBB",
      mimeType: "image/webp",
    });

    expect(ai.calls.map((call) => call.media?.url)).toEqual([
      "data:image/jpeg;base64,AAAA",
      "data:image/webp;base64,BBBB",
    ]);
  });

  it("marks handwriting with capped confidence", async () => {
    const ai = createMockAi({
      [IMAGE_EXTRACTION_KEY]: [
        mockImageExtractionStep({
          text: "Paid 5,000 on 3 March",
          confidence: 0.9,
          handwriting: true,
        }),
        mockImageExtractionStep({ text: "Received", confidence: 0.95 }),
      ],
    });

    const detected = await ai.extractFromImageAsync({ image: pngBytes, mimeType: "image/png" });
    const forced = await ai.extractFromImageAsync({
      image: pngBytes,
      mimeType: "image/png",
      mode: "handwriting",
    });

    expect(detected).toMatchObject({
      method: "handwriting",
      handwriting: true,
      confidence: HANDWRITING_CONFIDENCE_CAP,
    });
    expect(forced).toMatchObject({ method: "handwriting", confidence: HANDWRITING_CONFIDENCE_CAP });
    expect(ai.calls[1]?.system).toMatch(/handwriting/i);
  });

  it("omits line boxes when not requested and uses synthetic image usage", async () => {
    const ai = createMockAi({
      [IMAGE_EXTRACTION_KEY]: mockImageExtractionStep({
        text: "Line",
        confidence: 0.8,
        lines: [{ text: "Line", bbox: { x: 0, y: 0, width: 1, height: 0.1 } }],
      }),
    });

    const result = await ai.extractFromImageAsync({
      image: pngBytes,
      mimeType: "image/png",
      lineBoxes: false,
    });

    expect(result.lines).toEqual([]);
    expect(result.usage.input).toBeGreaterThan(MOCK_IMAGE_TOKENS);
    expect(ai.calls[0]?.system).toMatch(/empty lines array/);
  });

  it("rejects the high tier and empty images without calling the model", async () => {
    const ai = createMockAi({ "*": mockImageExtractionStep({ text: "x", confidence: 1 }) });

    await expect(
      ai.extractFromImageAsync({
        image: pngBytes,
        mimeType: "image/png",
        tier: "high" as unknown as "mid",
      }),
    ).rejects.toBeInstanceOf(AiInputValidationError);
    await expect(
      ai.extractFromImageAsync({ image: new Uint8Array(), mimeType: "image/png" }),
    ).rejects.toBeInstanceOf(AiInputValidationError);
    expect(ai.calls).toHaveLength(0);
  });
});

describe("boxToBoundingBox", () => {
  it("converts Gemini 0-1000 boxes to clamped 0..1 boxes", () => {
    expect(boxToBoundingBox([100, 200, 300, 600])).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.4,
      height: 0.2,
    });
    expect(boxToBoundingBox([300, 600, 100, 200])).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.4,
      height: 0.2,
    });
    expect(boxToBoundingBox([-50, 0, 1200, 500])).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
  });

  it("rejects malformed or empty boxes", () => {
    expect(boxToBoundingBox([1, 2, 3])).toBeUndefined();
    expect(boxToBoundingBox([100, 100, 100, 400])).toBeUndefined();
    expect(boxToBoundingBox([0, 0, Number.NaN, 10])).toBeUndefined();
  });
});
