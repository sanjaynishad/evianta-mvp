import { describe, expect, it } from "vitest";

import { parseAiProvider, parseWebOrigins } from "./index.js";

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

describe("parseWebOrigins", () => {
  it("splits a comma-separated list and drops trailing slashes", () => {
    expect(parseWebOrigins(" https://app.example.com/ , http://localhost:3000")).toEqual([
      "https://app.example.com",
      "http://localhost:3000",
    ]);
  });

  it("returns no origins when unset or blank", () => {
    expect(parseWebOrigins(undefined)).toEqual([]);
    expect(parseWebOrigins(" , ")).toEqual([]);
  });
});
