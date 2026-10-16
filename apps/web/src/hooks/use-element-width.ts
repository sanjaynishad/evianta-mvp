"use client";

import { useEffect, useState, type RefObject } from "react";

export function useElementWidth(ref: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number>();

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const measure = () => {
      const measured = element.getBoundingClientRect().width;
      setWidth(measured > 0 ? Math.round(measured) : undefined);
    };

    measure();
    if (typeof ResizeObserver !== "function") {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
