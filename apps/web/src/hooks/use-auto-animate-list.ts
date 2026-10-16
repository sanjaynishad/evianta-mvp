"use client";

import { useEffect } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useMotionSafe } from "@/hooks/use-motion-safe";
import { motionDurationMs, toCubicBezier } from "@/lib/motion";

export function useAutoAnimateList<T extends HTMLElement>() {
  const { reduced } = useMotionSafe();
  const [listRef, setAnimationsEnabled] = useAutoAnimate<T>({
    duration: motionDurationMs.base,
    easing: toCubicBezier("standard"),
  });

  useEffect(() => {
    setAnimationsEnabled(!reduced);
  }, [reduced, setAnimationsEnabled]);

  return listRef;
}
