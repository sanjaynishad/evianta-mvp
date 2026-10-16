import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UsageViewPage, { metadata } from "./page";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

function pageProps(segment: string) {
  return {
    params: Promise.resolve({ usageViewPath: segment }),
    searchParams: Promise.resolve({}),
  };
}

describe("usage view page", () => {
  const original = process.env.EVIANTA_USAGE_VIEW_PATH;

  beforeEach(() => {
    process.env.EVIANTA_USAGE_VIEW_PATH = "/owner-view-3f9a/";
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.EVIANTA_USAGE_VIEW_PATH;
    } else {
      process.env.EVIANTA_USAGE_VIEW_PATH = original;
    }
  });

  it("is never indexed", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("returns 404 for any other segment", async () => {
    await expect(UsageViewPage(pageProps("cases"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("returns 404 when the path is not configured", async () => {
    process.env.EVIANTA_USAGE_VIEW_PATH = "";

    await expect(UsageViewPage(pageProps(""))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("lists every case with totals on the configured segment", async () => {
    render(await UsageViewPage(pageProps("owner-view-3f9a")));

    expect(screen.getByRole("heading", { name: "Platform usage" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Totals per use case" })).toBeInTheDocument();
    expect(screen.getByText("Quarterly sales review - Northwind Traders")).toBeInTheDocument();
    expect(screen.getByText(/Showing fixture data/)).toBeInTheDocument();
  });
});
