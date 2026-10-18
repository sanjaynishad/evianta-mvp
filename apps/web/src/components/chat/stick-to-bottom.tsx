"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

export function useStickToBottom(dependency: unknown) {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback(() => {
    following.current = true;
    setAtBottom(true);
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  }, []);

  useEffect(() => {
    let previousScrollY = window.scrollY;

    function update() {
      const distance =
        document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      const nearBottom = distance <= 64;

      if (nearBottom) {
        following.current = true;
      } else if (window.scrollY < previousScrollY) {
        following.current = false;
      }

      previousScrollY = window.scrollY;
      setAtBottom(following.current || nearBottom);
    }

    window.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("scroll", update);
    };
  }, []);

  useLayoutEffect(() => {
    if (!content) {
      return;
    }

    function followContent() {
      if (following.current) {
        scrollToBottom();
      }
    }

    followContent();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(followContent) : undefined;

    observer?.observe(content);

    window.addEventListener("resize", followContent);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", followContent);
    };
  }, [content, dependency, scrollToBottom]);

  return {
    contentRef: setContent,
    atBottom,
    scrollToBottom,
  };
}

export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-auto flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium shadow-elevation-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowDown aria-hidden className="size-3.5" />
      Jump to latest
    </button>
  );
}
