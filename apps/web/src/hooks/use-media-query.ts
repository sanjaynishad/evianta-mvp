"use client";

import { useCallback, useSyncExternalStore } from "react";

// Matches on the server so wide layouts render first; the client corrects it after hydration.
export function useMediaQuery(query: string, serverValue = true): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") {
        return () => {};
      }

      const media = window.matchMedia(query);
      media.addEventListener?.("change", onChange);
      return () => media.removeEventListener?.("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () =>
      typeof window.matchMedia === "function" ? window.matchMedia(query).matches : serverValue,
    [query, serverValue],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => serverValue);
}

export const wideLayoutQuery = "(min-width: 1024px)";
