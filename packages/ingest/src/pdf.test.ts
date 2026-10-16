import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { hasUsableTextLayer, readPdfTextLayerAsync, textRunBox } from "./pdf.js";

describe("hasUsableTextLayer", () => {
  it("requires enough readable characters", () => {
    expect(hasUsableTextLayer("Page 1")).toBe(false);
    expect(hasUsableTextLayer("A typed notice paragraph with words")).toBe(true);
    expect(hasUsableTextLayer("\ufffd".repeat(40))).toBe(false);
    expect(hasUsableTextLayer("Page 1", 3)).toBe(true);
  });
});

describe("textRunBox", () => {
  const viewport = { transform: [1, 0, 0, -1, 0, 100], width: 200, height: 100 };

  it("normalizes an upright run to top-left page coordinates", () => {
    expect(
      textRunBox({ transform: [10, 0, 0, 10, 20, 50], width: 100, height: 10 }, viewport),
    ).toEqual({
      x: 0.1,
      y: 0.4,
      width: 0.5,
      height: 0.1,
    });
  });

  it("clamps runs that extend past the page and drops empty runs", () => {
    expect(
      textRunBox({ transform: [10, 0, 0, 10, 150, 50], width: 100, height: 10 }, viewport)?.width,
    ).toBe(0.25);
    expect(
      textRunBox({ transform: [10, 0, 0, 10, 20, 50], width: 0, height: 10 }, viewport),
    ).toBeUndefined();
  });
});

describe("readPdfTextLayerAsync", () => {
  it("returns tall boxes for text on a page rotated by 90 degrees", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([300, 400]);
    page.setRotation(degrees(90));
    page.drawText("Rotated page with enough text to count", { x: 20, y: 300, size: 10, font });

    const [result] = await readPdfTextLayerAsync(await pdf.save());
    const box = result?.spans[0]?.bbox;

    expect(result).toMatchObject({ width: 400, height: 300, hasUsableTextLayer: true });
    expect(box).toBeDefined();
    expect(box!.height * 300).toBeGreaterThan(box!.width * 400);
  });
});
