export interface MatchMediaOptions {
  // Width used to answer min-width and max-width queries; narrower than any breakpoint by default.
  viewportWidth?: number;
}

function matchesWidth(query: string, width: number): boolean | undefined {
  const min = /min-width:\s*(\d+)px/.exec(query);
  if (min) {
    return width >= Number(min[1]);
  }

  const max = /max-width:\s*(\d+)px/.exec(query);
  if (max) {
    return width <= Number(max[1]);
  }

  return undefined;
}

export function stubMatchMedia(
  prefersReducedMotion: boolean,
  { viewportWidth = 0 }: MatchMediaOptions = {},
): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches:
        matchesWidth(query, viewportWidth) ??
        (prefersReducedMotion &&
          query.includes("prefers-reduced-motion") &&
          !query.includes("no-preference")),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
