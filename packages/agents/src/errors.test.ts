import { AiOutputValidationError } from "@evianta/ai";
import { describe, expect, it } from "vitest";

import { BilledTaskError, describeTaskError, modelFailureDetails } from "./errors.js";

function truncatedOutputError() {
  return new AiOutputValidationError("private response text", ["invalid JSON"], "private text", {
    attempts: 2,
    diagnostics: [
      {
        provider: "vertexai",
        model: "gemini-2.5-flash",
        key: "legal-research",
        attempt: 2,
        maxOutputTokens: 16384,
        finishReason: "length",
        failure: "truncated",
        outputTokens: 12000,
        thinkingTokens: 4384,
      },
    ],
  });
}

describe("model failure reporting", () => {
  it("logs model diagnostics without response text, including through billed wrappers", () => {
    const error = truncatedOutputError();
    const wrapped = new BilledTaskError(error, error.usage, error.cost);

    expect(modelFailureDetails(wrapped)).toEqual({
      error: "AiOutputValidationError",
      modelAttempts: error.diagnostics,
    });
    expect(JSON.stringify(modelFailureDetails(wrapped))).not.toContain("private");
  });

  it("gives a safe response-limit explanation after recovery is exhausted", () => {
    expect(describeTaskError(truncatedOutputError())).toBe(
      "The agent reached its response limit after automatic recovery. Retry the failed step.",
    );
  });

  it("preserves the existing explanation for invalid but complete output", () => {
    expect(
      describeTaskError(new AiOutputValidationError("private text", ["missing field"], "{}")),
    ).toBe("The agent returned output in an unexpected format. Retry the run to try again.");
  });
});
