import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import DefaultCaseContext from "@/app/@caseContext/default";
import HomeCaseContext from "@/app/@caseContext/page";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell, CaseContextLabel } from "./app-shell";
import { isCommandPaletteShortcut } from "./command-palette";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/design",
  useRouter: () => ({ push }),
}));

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

beforeEach(() => {
  push.mockReset();
});

function renderShell() {
  return render(
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <TooltipProvider>
        <AppShell caseContext={<CaseContextLabel eyebrow="Case" title="ITR notice 143(2)" />}>
          <p>Page body</p>
        </AppShell>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("AppShell", () => {
  it("uses the workspace context for both the home route and the full-load fallback", () => {
    expect(HomeCaseContext).toBe(DefaultCaseContext);
    render(<HomeCaseContext />);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("All cases")).toBeInTheDocument();
  });

  it("renders navigation, the case context slot, and the main region", () => {
    renderShell();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getByText("ITR notice 143(2)")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("Page body");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
  });

  it("marks the active route in the sidebar", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "Design system" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Cases" })).not.toHaveAttribute("aria-current");
  });

  it("offers the theme toggle and command palette trigger", () => {
    renderShell();
    expect(screen.getByRole("button", { name: "Toggle color theme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Search or jump to/ })).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+K Meta+K",
    );
  });

  it.each(["Escape", "Close"])(
    "returns mobile navigation focus to its trigger after %s",
    async (closeAction) => {
      renderShell();
      const trigger = screen.getByRole("button", { name: "Open navigation" });
      trigger.focus();
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", { name: "Navigation" });

      if (closeAction === "Escape") {
        fireEvent.keyDown(dialog, { key: "Escape" });
      } else {
        fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      }

      await waitFor(() => expect(trigger).toHaveFocus());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("still closes mobile navigation when selecting a page", async () => {
    renderShell();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Navigation" });
    const link = within(dialog).getByRole("link", { name: "Cases" });
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe("CommandPalette focus", () => {
  it("returns focus to the search button after opening it by click", async () => {
    renderShell();
    screen.getByRole("button", { name: "Toggle color theme" }).focus();
    const trigger = screen.getByRole("button", { name: /Search or jump to/ });
    fireEvent.click(trigger);
    const input = await screen.findByRole("combobox");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "returns focus to the shortcut opener after Escape (%o)",
    async (modifier) => {
      renderShell();
      render(<input aria-label="Case notes" />);
      const opener = screen.getByRole("textbox", { name: "Case notes" });
      opener.focus();
      fireEvent.keyDown(window, { key: "k", ...modifier });
      const input = await screen.findByRole("combobox");
      expect(input).toHaveFocus();
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(opener).toHaveFocus());
    },
  );

  it("keeps the original focus target when the shortcut closes the palette", async () => {
    renderShell();
    const opener = screen.getByRole("button", { name: "Toggle color theme" });
    opener.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await screen.findByRole("combobox");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("falls back to the search button when navigation removes the opener", async () => {
    renderShell();
    const page = render(<input aria-label="Case notes" />);
    const opener = screen.getByRole("textbox", { name: "Case notes" });
    opener.focus();
    push.mockImplementationOnce(() => page.rerender(<p>Destination page</p>));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const command = await screen.findByRole("option", { name: "Design system" });
    fireEvent.click(command);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Search or jump to/ })).toHaveFocus(),
    );
    expect(push).toHaveBeenCalledWith("/design");
    expect(opener).not.toBeInTheDocument();
  });

  it("restores focus after a non-navigation command", async () => {
    renderShell();
    const opener = screen.getByRole("button", { name: "Toggle color theme" });
    opener.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const command = await screen.findByRole("option", { name: /Switch to dark theme/ });
    fireEvent.click(command);
    await waitFor(() => expect(opener).toHaveFocus());
    expect(push).not.toHaveBeenCalled();
  });
});

describe("isCommandPaletteShortcut", () => {
  it("matches Ctrl+K and Cmd+K only", () => {
    expect(isCommandPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false })).toBe(true);
    expect(isCommandPaletteShortcut({ key: "K", ctrlKey: false, metaKey: true })).toBe(true);
    expect(isCommandPaletteShortcut({ key: "k", ctrlKey: false, metaKey: false })).toBe(false);
  });
});
