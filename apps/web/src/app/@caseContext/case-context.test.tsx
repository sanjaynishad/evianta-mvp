import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import CatchAllCaseContext from "./[...segments]/page";
import UsageCaseContext from "./[usageViewPath]/page";
import DesignCaseContext from "./design/page";
import HomeCaseContext from "./page";

function usageProps(segment: string) {
  return { params: Promise.resolve({ usageViewPath: segment }) };
}

describe("case context slot", () => {
  const original = process.env.EVIANTA_USAGE_VIEW_PATH;

  beforeEach(() => {
    process.env.EVIANTA_USAGE_VIEW_PATH = "owner-view-3f9a";
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.EVIANTA_USAGE_VIEW_PATH;
    } else {
      process.env.EVIANTA_USAGE_VIEW_PATH = original;
    }
  });

  it("resets to the workspace label on home and unmatched routes", () => {
    const { unmount } = render(<HomeCaseContext />);
    expect(screen.getByText("All cases")).toBeInTheDocument();
    unmount();

    render(<CatchAllCaseContext />);
    expect(screen.getByText("All cases")).toBeInTheDocument();
  });

  it("labels the design gallery", () => {
    render(<DesignCaseContext />);

    expect(screen.getByText("Design system")).toBeInTheDocument();
  });

  it("labels only the configured usage path", async () => {
    const { unmount } = render(await UsageCaseContext(usageProps("owner-view-3f9a")));
    expect(screen.getByText("Usage")).toBeInTheDocument();
    unmount();

    render(await UsageCaseContext(usageProps("guess")));
    expect(screen.getByText("All cases")).toBeInTheDocument();
    expect(screen.queryByText("Usage")).not.toBeInTheDocument();
  });
});
