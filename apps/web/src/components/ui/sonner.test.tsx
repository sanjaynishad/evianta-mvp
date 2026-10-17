import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toast, Toaster } from "./sonner";

describe("Toaster", () => {
  it("maps Sonner's theme variables to design tokens inline", async () => {
    const { container } = render(<Toaster />);

    act(() => {
      toast("Case saved");
    });

    expect(await screen.findByText("Case saved")).toBeInTheDocument();
    const list = container.querySelector<HTMLElement>("[data-sonner-toaster]");
    expect(list).not.toBeNull();
    expect(list?.style.getPropertyValue("--normal-bg")).toBe("hsl(var(--popover))");
    expect(list?.style.getPropertyValue("--normal-text")).toBe("hsl(var(--popover-foreground))");
    expect(list?.style.getPropertyValue("--error-text")).toBe("hsl(var(--danger))");
  });
});
