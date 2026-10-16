"use client";

import { useMemo } from "react";
import { useReducedMotion } from "framer-motion";
import { getMotionPresets, type MotionPresets } from "@/lib/motion";

export function useMotionSafe(): MotionPresets {
  const prefersReducedMotion = useReducedMotion() ?? false;
  return useMemo(() => getMotionPresets(prefersReducedMotion), [prefersReducedMotion]);
}
