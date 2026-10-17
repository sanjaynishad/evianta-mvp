export interface ScrollIntoPaneOptions {
  block?: "start" | "center";
  behavior?: ScrollBehavior;
}

const scrollableOverflow = /(auto|scroll)/;

// Scrolls only the element's scrollable ancestors, so a target inside a pane never scrolls the
// whole page. Falls back to scrollIntoView when no ancestor scrolls (the stacked small-screen layout).
export function scrollIntoPane(element: HTMLElement, options: ScrollIntoPaneOptions = {}): void {
  const { block = "center", behavior = "auto" } = options;
  let scrolled = false;
  let parent = element.parentElement;
  while (parent && parent !== document.body) {
    const style = getComputedStyle(parent);
    const canScrollY =
      scrollableOverflow.test(style.overflowY) && parent.scrollHeight > parent.clientHeight;
    const canScrollX =
      scrollableOverflow.test(style.overflowX) && parent.scrollWidth > parent.clientWidth;
    if (canScrollY || canScrollX) {
      const parentRect = parent.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const top = canScrollY
        ? parent.scrollTop +
          rect.top -
          parentRect.top -
          (block === "center" ? (parent.clientHeight - rect.height) / 2 : 12)
        : parent.scrollTop;
      const left = canScrollX
        ? parent.scrollLeft + rect.left - parentRect.left - (parent.clientWidth - rect.width) / 2
        : parent.scrollLeft;
      if (typeof parent.scrollTo === "function") {
        parent.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior });
      }

      scrolled = scrolled || canScrollY;
    }

    parent = parent.parentElement;
  }

  if (!scrolled) {
    element.scrollIntoView?.({ block, behavior });
  }
}
