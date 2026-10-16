import type { BoundingBox, TextSpan } from "@evianta/core";
import { findQuoteInSpans } from "@/lib/evidence-location";

// Locates a quote in a rendered PDF text layer. Positions are measured from the DOM and
// normalised to the page element, so they line up with the bbox overlay.
export function findQuoteInTextLayer(page: HTMLElement, quote: string): BoundingBox[] | undefined {
  const pageRect = page.getBoundingClientRect();
  if (pageRect.width <= 0 || pageRect.height <= 0) {
    return undefined;
  }

  const spans: TextSpan[] = [];
  for (const element of page.querySelectorAll<HTMLElement>(".textLayer span")) {
    if (element.querySelector("span")) {
      continue;
    }

    const text = element.textContent ?? "";
    const rect = element.getBoundingClientRect();
    if (!text.trim() || rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    spans.push({
      text,
      bbox: {
        x: (rect.left - pageRect.left) / pageRect.width,
        y: (rect.top - pageRect.top) / pageRect.height,
        width: rect.width / pageRect.width,
        height: rect.height / pageRect.height,
      },
    });
  }

  return findQuoteInSpans(quote, spans);
}
