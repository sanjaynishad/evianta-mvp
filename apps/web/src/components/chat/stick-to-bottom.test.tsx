import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JumpToLatest, useStickToBottom } from "./stick-to-bottom";

let scrollY: number;
let scrollHeight: number;
let resizeContent: () => void;
const scrollTo = vi.fn();
const disconnect = vi.fn();

function Chat({ version = 0, loaded = true }: { version?: number; loaded?: boolean }) {
  const { contentRef, atBottom, scrollToBottom } = useStickToBottom(version);

  if (!loaded) {
    return null;
  }

  return (
    <div ref={contentRef}>
      <div>Conversation</div>
      {!atBottom ? <JumpToLatest onClick={scrollToBottom} /> : null}
      <div style={{ height: 300 }}>Composer</div>
    </div>
  );
}

beforeEach(() => {
  scrollY = 0;
  scrollHeight = 2000;
  scrollTo.mockReset().mockImplementation((options: ScrollToOptions) => {
    scrollY = Math.max(0, Math.min(options.top ?? 0, scrollHeight - window.innerHeight));
  });
  disconnect.mockReset();
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(() => scrollHeight);
  vi.stubGlobal("scrollTo", scrollTo);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeContent = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useStickToBottom", () => {
  it("starts following when an empty conversation finishes loading", () => {
    const { rerender } = render(<Chat loaded={false} />);
    expect(scrollTo).not.toHaveBeenCalled();

    rerender(<Chat />);
    expect(scrollY + window.innerHeight).toBe(scrollHeight);

    scrollHeight = 2400;
    act(() => resizeContent());
    expect(scrollY + window.innerHeight).toBe(2400);
  });

  it("scrolls past the composer to the page bottom without showing the jump button", () => {
    render(<Chat />);
    fireEvent.scroll(window);

    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "instant" });
    expect(scrollY + window.innerHeight).toBe(scrollHeight);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });

  it("follows new messages and asynchronous layout changes while pinned", () => {
    const { rerender } = render(<Chat />);
    scrollHeight = 2400;
    rerender(<Chat version={1} />);
    expect(scrollY + window.innerHeight).toBe(2400);

    scrollHeight = 2800;
    act(() => resizeContent());
    fireEvent.scroll(window);
    expect(scrollY + window.innerHeight).toBe(2800);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });

  it("preserves the reader's position during updates and resumes when requested", () => {
    const { rerender } = render(<Chat />);
    fireEvent.scroll(window);
    scrollY -= 400;
    fireEvent.scroll(window);
    const readingPosition = scrollY;
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
    scrollTo.mockClear();

    scrollHeight = 2400;
    rerender(<Chat version={1} />);
    act(() => resizeContent());
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollY).toBe(readingPosition);

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    fireEvent.scroll(window);
    expect(scrollY + window.innerHeight).toBe(2400);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();

    scrollHeight = 2600;
    act(() => resizeContent());
    expect(scrollY + window.innerHeight).toBe(2600);
  });

  it("resumes following after the reader manually returns to the bottom", () => {
    render(<Chat />);
    fireEvent.scroll(window);
    scrollY -= 400;
    fireEvent.scroll(window);
    scrollY = scrollHeight - window.innerHeight;
    fireEvent.scroll(window);

    scrollHeight = 2400;
    act(() => resizeContent());
    expect(scrollY + window.innerHeight).toBe(2400);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).not.toBeInTheDocument();
  });

  it("disconnects layout observation when unmounted", () => {
    const { unmount } = render(<Chat />);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
