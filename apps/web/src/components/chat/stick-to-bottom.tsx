"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

// Keeps the page pinned to the newest message unless the reader scrolled up to read history.
export function useStickToBottom(dependency: unknown) {
  const endRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    function update() {
      const distance =
        document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      setAtBottom(distance < 160);
    }

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (atBottom) {
      endRef.current?.scrollIntoView?.({ block: "end" });
    }
    // Only new content should scroll; reaching the bottom by hand must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependency]);

  return {
    endRef,
    atBottom,
    scrollToBottom: () => endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" }),
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
