"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

// A stable function that always calls the latest render's callback, for use inside effects.
// Stands in for React's useEffectEvent, which the React build bundled with Next.js 15 lacks.
export function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
