import { renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { stubMatchMedia } from "@/test/match-media";
import { useMotionSafe } from "./use-motion-safe";

beforeAll(() => {
  stubMatchMedia(false);
});

describe("useMotionSafe without a reduced-motion preference", () => {
  it("returns full motion presets", () => {
    const { result } = renderHook(() => useMotionSafe());

    expect(result.current.reduced).toBe(false);
    expect(result.current.fadeSlide.hidden).toMatchObject({ opacity: 0, y: 6 });
    expect(result.current.pressScale).toBeLessThan(1);
  });
});
