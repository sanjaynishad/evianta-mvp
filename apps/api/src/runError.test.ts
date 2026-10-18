import { describe, expect, it } from "vitest";

import { publicTaskError } from "./runError.js";

describe("publicTaskError", () => {
  it("gives a safe retry action for transient provider failures", () => {
    expect(
      publicTaskError(
        "The model service was unavailable after 3 attempt(s). Retry the run to try again.",
      ),
    ).toBe(
      "The model service was unavailable. Retry the failed step when the service is available.",
    );
  });

  it("does not expose unexpected task error details", () => {
    expect(publicTaskError("The task input was invalid: private document text")).toBe(
      "The task could not finish. Review the case inputs and try again.",
    );
  });
});
