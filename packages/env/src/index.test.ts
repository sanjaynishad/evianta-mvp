import { afterEach, describe, expect, it } from "vitest";

import { getUsageViewPath, normalizeUsageViewPath, parseAiProvider } from "./index.js";
import { normalizeApiBaseUrl } from "./public.js";

describe("parseAiProvider", () => {
  it("accepts the supported providers", () => {
    expect(parseAiProvider("googleai")).toBe("googleai");
    expect(parseAiProvider("vertexai")).toBe("vertexai");
    expect(parseAiProvider(" MOCK ")).toBe("mock");
  });

  it("defaults to googleai for missing or unknown values", () => {
    expect(parseAiProvider(undefined)).toBe("googleai");
    expect(parseAiProvider("")).toBe("googleai");
    expect(parseAiProvider("openai")).toBe("googleai");
  });
});

describe("usage view path", () => {
  const original = process.env.EVIANTA_USAGE_VIEW_PATH;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.EVIANTA_USAGE_VIEW_PATH;
    } else {
      process.env.EVIANTA_USAGE_VIEW_PATH = original;
    }
  });

  it("trims whitespace and slashes", () => {
    expect(normalizeUsageViewPath(" /owner-view-3f9a/ ")).toBe("owner-view-3f9a");
    expect(normalizeUsageViewPath(undefined)).toBe("");
  });

  it("reads the current value on every call", () => {
    process.env.EVIANTA_USAGE_VIEW_PATH = "first";
    expect(getUsageViewPath()).toBe("first");

    process.env.EVIANTA_USAGE_VIEW_PATH = "/second/";
    expect(getUsageViewPath()).toBe("second");
  });
});

describe("normalizeApiBaseUrl", () => {
  it("drops trailing slashes and treats blank values as unset", () => {
    expect(normalizeApiBaseUrl(" https://api.example.test/// ")).toBe("https://api.example.test");
    expect(normalizeApiBaseUrl("  ")).toBeUndefined();
    expect(normalizeApiBaseUrl(undefined)).toBeUndefined();
  });
});
