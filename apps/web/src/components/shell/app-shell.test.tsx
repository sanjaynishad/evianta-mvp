import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell, CaseContextLabel } from "./app-shell";
import { isCommandPaletteShortcut } from "./command-palette";

vi.mock("next/navigation", () => ({
  usePathname: () => "/design",
  useRouter: () => ({ push: vi.fn() }),
}));

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
});

describe("isCommandPaletteShortcut", () => {
  it("matches Ctrl+K and Cmd+K only", () => {
    expect(isCommandPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false })).toBe(true);
    expect(isCommandPaletteShortcut({ key: "K", ctrlKey: false, metaKey: true })).toBe(true);
    expect(isCommandPaletteShortcut({ key: "k", ctrlKey: false, metaKey: false })).toBe(false);
  });
});
