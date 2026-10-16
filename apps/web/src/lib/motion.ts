import type { Transition, Variants } from "framer-motion";

export const motionDurationMs = {
  fast: 120,
  base: 200,
  slow: 320,
} as const;

export const motionEasing = {
  standard: [0.2, 0, 0, 1],
  emphasized: [0.05, 0.7, 0.1, 1],
} as const;

export type MotionDurationName = keyof typeof motionDurationMs;
export type MotionEasingName = keyof typeof motionEasing;

export function toCubicBezier(easing: MotionEasingName): string {
  return `cubic-bezier(${motionEasing[easing].join(", ")})`;
}

export function motionTransition(
  duration: MotionDurationName = "base",
  easing: MotionEasingName = "standard",
): Transition {
  return { duration: motionDurationMs[duration] / 1000, ease: [...motionEasing[easing]] };
}

export const instantTransition: Transition = { duration: 0 };

export interface MotionPresets {
  reduced: boolean;
  transition: Transition;
  fade: Variants;
  fadeSlide: Variants;
  staggerContainer: Variants;
  evidencePulse: Variants;
  pressScale: number;
}

export function getMotionPresets(reduced: boolean): MotionPresets {
  if (reduced) {
    return {
      reduced,
      transition: instantTransition,
      fade: {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: instantTransition },
        exit: { opacity: 0, transition: instantTransition },
      },
      fadeSlide: {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: instantTransition },
        exit: { opacity: 0, transition: instantTransition },
      },
      staggerContainer: {
        hidden: {},
        visible: { transition: { staggerChildren: 0 } },
      },
      evidencePulse: {
        idle: { scale: 1 },
        pulse: { scale: 1, transition: instantTransition },
      },
      pressScale: 1,
    };
  }

  return {
    reduced,
    transition: motionTransition("base", "standard"),
    fade: {
      hidden: { opacity: 0 },
      visible: { opacity: 1, transition: motionTransition("base", "standard") },
      exit: { opacity: 0, transition: motionTransition("fast", "standard") },
    },
    fadeSlide: {
      hidden: { opacity: 0, y: 6 },
      visible: { opacity: 1, y: 0, transition: motionTransition("base", "emphasized") },
      exit: { opacity: 0, y: -4, transition: motionTransition("fast", "standard") },
    },
    staggerContainer: {
      hidden: {},
      visible: { transition: { staggerChildren: 0.04 } },
    },
    evidencePulse: {
      idle: { scale: 1 },
      pulse: {
        scale: [1, 1.04, 1],
        transition: { duration: (motionDurationMs.slow * 2) / 1000, ease: "easeOut" },
      },
    },
    pressScale: 0.98,
  };
}
