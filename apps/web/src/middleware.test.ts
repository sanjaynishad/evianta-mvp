import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { middleware } from "./middleware";

describe("static chunk URL normalization", () => {
  it.each([
    "%40caseContext/cases/%5BcaseId%5D",
    "@caseContext/cases/%5BcaseId%5D",
    "%40caseContext/cases/[caseId]",
    "%40caseContext/%5b...segments%5d",
  ])("normalizes encoded route delimiters in %s", (route) => {
    const response = middleware(
      new NextRequest(`https://example.test/_next/static/chunks/app/${route}/page.js?v=1`),
    );
    const rewritten = new URL(response.headers.get("x-middleware-rewrite")!);

    expect(rewritten.pathname).not.toMatch(/%40|%5b|%5d/i);
    expect(rewritten.search).toBe("?v=1");
    expect(rewritten.origin).toBe("https://example.test");
  });

  it("leaves ordinary chunks and already decoded paths alone", () => {
    for (const path of ["webpack-abc.js", "app/@caseContext/cases/[caseId]/page.js"]) {
      const response = middleware(
        new NextRequest(`https://example.test/_next/static/chunks/${path}`),
      );

      expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    }
  });

  it("does not decode separators or double-encoded input", () => {
    const response = middleware(
      new NextRequest(
        "https://example.test/_next/static/chunks/%40caseContext/%2F%5C%252e%2540/page.js",
      ),
    );

    expect(response.headers.get("x-middleware-rewrite")).toContain(
      "/@caseContext/%2F%5C%252e%2540/page.js",
    );
  });
});
