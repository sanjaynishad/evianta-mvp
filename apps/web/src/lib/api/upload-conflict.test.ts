import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import { retryWhileUploadingAsync } from "./upload-conflict";

const uploadInProgress = () =>
  new ApiError("Wait for the upload to finish before running.", 409, {
    code: "upload-in-progress",
  });

describe("retryWhileUploadingAsync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts again once the upload finishes", async () => {
    const start = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(uploadInProgress())
      .mockResolvedValueOnce("run-1");

    const result = retryWhileUploadingAsync(start, { delayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe("run-1");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const start = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new ApiError("Busy", 409, { code: "run-in-progress" }));

    await expect(retryWhileUploadingAsync(start, { delayMs: 100 })).rejects.toThrow("Busy");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt", async () => {
    const start = vi.fn<() => Promise<string>>().mockRejectedValue(uploadInProgress());

    const result = retryWhileUploadingAsync(start, { attempts: 3, delayMs: 10 });
    const settled = expect(result).rejects.toBeInstanceOf(ApiError);
    await vi.advanceTimersByTimeAsync(100);

    await settled;
    expect(start).toHaveBeenCalledTimes(3);
  });
});
