import { describe, expect, it } from "vitest";

import { parseAiProvider } from "./index.js";

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
