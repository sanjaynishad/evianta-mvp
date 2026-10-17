"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLatestCallback } from "@/hooks/use-latest-callback";

interface ResourceResult<T> {
  key: string;
  version: number;
  data?: T;
  error?: unknown;
}

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  mutate: (update: (current: T) => T) => void;
}

// Loads data for a key on the client, keeping the previous data visible while reloading. A load
// that was in flight when `mutate` ran is discarded and loaded again, so a stale response never
// overwrites the newer local state.
export function useResource<T>(key: string | null, loadAsync: () => Promise<T>): Resource<T> {
  const [result, setResult] = useState<ResourceResult<T>>();
  const [version, setVersion] = useState(0);
  const mutationsRef = useRef(0);
  const load = useLatestCallback(loadAsync);

  useEffect(() => {
    if (key === null) {
      return;
    }

    let cancelled = false;
    const mutationsAtStart = mutationsRef.current;
    const isStale = () => mutationsRef.current !== mutationsAtStart;
    load().then(
      (data) => {
        if (cancelled) {
          return;
        }

        if (isStale()) {
          setVersion((current) => current + 1);
          return;
        }

        setResult({ key, version, data });
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }

        if (isStale()) {
          setVersion((current) => current + 1);
          return;
        }

        setResult((current) => ({
          key,
          version,
          data: current?.key === key ? current.data : undefined,
          error,
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, version, load]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);
  const mutate = useCallback((update: (current: T) => T) => {
    mutationsRef.current += 1;
    setResult((current) =>
      current?.data === undefined ? current : { ...current, data: update(current.data) },
    );
  }, []);

  const matches = key !== null && result?.key === key;
  return {
    data: matches ? result.data : undefined,
    error: matches ? result.error : undefined,
    loading: key !== null && (!matches || result.version !== version),
    reload,
    mutate,
  };
}
