import { renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { getMotionPresets, motionDurationMs } from "@/lib/motion";
import { stubMatchMedia } from "@/test/match-media";
import { useMotionSafe } from "./use-motion-safe";

beforeAll(() => {
  stubMatchMedia(true);
});

describe("useMotionSafe with prefers-reduced-motion: reduce", () => {
  it("returns reduced, instant presets", () => {
    const { result } = renderHook(() => useMotionSafe());

    expect(result.current.reduced).toBe(true);
    expect(result.current.transition).toEqual({ duration: 0 });
    expect(result.current.pressScale).toBe(1);
    expect(result.current.fadeSlide.hidden).toEqual({ opacity: 0 });
    expect(result.current.fadeSlide.visible).toMatchObject({ transition: { duration: 0 } });
    expect(result.current.staggerContainer.visible).toMatchObject({
      transition: { staggerChildren: 0 },
    });
  });

  it("matches the pure reduced presets", () => {
    const { result } = renderHook(() => useMotionSafe());
    expect(result.current).toEqual(getMotionPresets(true));
  });
});

describe("getMotionPresets without reduced motion", () => {
  it("uses token durations and spatial offsets", () => {
    const presets = getMotionPresets(false);

    expect(presets.reduced).toBe(false);
    expect(presets.transition).toMatchObject({ duration: motionDurationMs.base / 1000 });
    expect(presets.fadeSlide.hidden).toMatchObject({ y: 6 });
    expect(presets.pressScale).toBeLessThan(1);
  });
});
