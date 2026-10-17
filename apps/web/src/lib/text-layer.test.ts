import { afterEach, describe, expect, it, vi } from "vitest";
import { findQuoteInTextLayer } from "./text-layer";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findQuoteInTextLayer", () => {
  it("measures the matching spans relative to the page", () => {
    const page = document.createElement("div");
    page.innerHTML =
      '<div class="textLayer"><span data-r="50,100,200,20">Date of Udyam</span><span data-r="250,100,150,20">Registration 14/03/2023</span><span data-r="50,140,200,20">Other text</span></div>';
    document.body.append(page);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === page) {
        return rect(0, 0, 500, 1000);
      }

      const values = this.dataset.r?.split(",").map(Number) ?? [0, 0, 0, 0];
      return rect(values[0]!, values[1]!, values[2]!, values[3]!);
    });

    expect(findQuoteInTextLayer(page, "Date of Udyam Registration 14/03/2023")).toEqual([
      { x: 0.1, y: 0.1, width: 0.4, height: 0.02 },
      { x: 0.5, y: 0.1, width: 0.3, height: 0.02 },
    ]);
    expect(findQuoteInTextLayer(page, "missing")).toBeUndefined();
    page.remove();
  });

  it("gives up when the page has no size yet", () => {
    const page = document.createElement("div");
    expect(findQuoteInTextLayer(page, "anything")).toBeUndefined();
  });
});
