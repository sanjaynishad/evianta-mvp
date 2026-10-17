import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createTestDataSource, renderWithDataSource } from "@/test/render-with-data";
import { HomeView } from "./home-view";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/",
}));

describe("HomeView", () => {
  it("shows the samples and an empty Your cases list to a fresh visitor", async () => {
    renderWithDataSource(<HomeView />);

    const samples = await screen.findByRole("region", { name: "Sample cases" });
    expect(await within(samples).findAllByRole("button", { name: /^Try / })).toHaveLength(3);
    expect(within(samples).getAllByRole("link", { name: /^Open / })).toHaveLength(3);
    const yours = screen.getByRole("region", { name: "Your cases" });
    expect(await within(yours).findByText("No cases yet")).toBeInTheDocument();
  });

  it("adds a copy to Your cases with Try this case", async () => {
    const dataSource = createTestDataSource();
    const { unmount } = renderWithDataSource(<HomeView />, dataSource);

    fireEvent.click(await screen.findByRole("button", { name: /^Try ITR intimation/ }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    unmount();

    renderWithDataSource(<HomeView />, dataSource);
    const yours = await screen.findByRole("region", { name: "Your cases" });
    expect(await within(yours).findByText(/ITR intimation 143\(1\)\(a\)/)).toBeInTheDocument();
    expect(within(yours).queryByText("Sample")).not.toBeInTheDocument();
  });
});
