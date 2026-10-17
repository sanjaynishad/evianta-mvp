import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

import { Analytics } from "./analytics";

const route = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
}));

vi.mock("next/script", () => ({
  default: function MockScript({ src, onReady }: { src: string; onReady: () => void }) {
    useEffect(() => {
      onReady();
    }, [onReady]);

    return <div data-testid="analytics-script" data-src={src} />;
  },
}));

function commands() {
  return (window.dataLayer ?? []).map((entry) => Array.from(entry as IArguments));
}

afterEach(() => {
  cleanup();
  delete window.dataLayer;
  route.pathname = "/";
});

describe("Analytics", () => {
  it("does not load or initialize analytics on a private route", () => {
    route.pathname = "/owner-secret";
    const { container } = render(<Analytics />);

    expect(container.querySelector('[data-testid="analytics-script"]')).toBeNull();
    expect(commands()).toEqual([]);
  });

  it("tracks public pages without query strings or referrers", () => {
    render(<Analytics />);

    expect(commands()).toContainEqual([
      "set",
      { page_location: window.location.origin, page_referrer: "", page_title: "Evianta" },
    ]);
    expect(commands()).toContainEqual([
      "config",
      "G-Z4PMQFXB3L",
      {
        send_page_view: false,
        page_location: window.location.origin,
        page_referrer: "",
        page_title: "Evianta",
      },
    ]);
    expect(commands()).toContainEqual([
      "event",
      "page_view",
      {
        page_location: `${window.location.origin}/`,
        page_referrer: "",
        page_title: "Evianta",
      },
    ]);
  });

  it("does not report private navigation and sanitizes a return to public pages", () => {
    const view = render(<Analytics />);
    const count = commands().length;
    route.pathname = "/owner-secret";
    view.rerender(<Analytics />);

    expect(commands()).toHaveLength(count);

    route.pathname = "/design";
    view.rerender(<Analytics />);

    expect(JSON.stringify(commands())).not.toContain("owner-secret");
    expect(commands().at(-1)).toEqual([
      "event",
      "page_view",
      {
        page_location: `${window.location.origin}/design`,
        page_referrer: "",
        page_title: "Evianta",
      },
    ]);
  });
});
