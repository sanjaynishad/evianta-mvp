import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it.each([{ disabled: true }, { loading: true }])(
    "blocks navigation and click handlers for an inactive asChild link (%o)",
    (props) => {
      const onClick = vi.fn();
      const onChildClick = vi.fn();
      const onParentClick = vi.fn();
      render(
        <div onClick={onParentClick}>
          <Button asChild {...props} onClick={onClick}>
            <a href="#destination" onClick={onChildClick}>
              Continue
            </a>
          </Button>
        </div>,
      );
      const link = screen.getByRole("link", { name: "Continue" });
      expect(fireEvent.click(link)).toBe(false);
      expect(onClick).not.toHaveBeenCalled();
      expect(onChildClick).not.toHaveBeenCalled();
      expect(onParentClick).not.toHaveBeenCalled();
      expect(link).toHaveAttribute("aria-disabled", "true");
      expect(link).toHaveAttribute("data-disabled");
      expect(link).toHaveAttribute("tabindex", "-1");
      expect(link).toHaveClass("pointer-events-none", "opacity-50");
    },
  );

  it("marks a loading asChild link as busy and disabled", () => {
    render(
      <Button asChild loading>
        <a href="#destination">Continue</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Continue" });
    expect(link).toHaveAttribute("aria-busy", "true");
    expect(link).toHaveAttribute("aria-disabled", "true");
  });

  it.each([{ disabled: true }, { loading: true }])(
    "disables an inactive asChild native button (%o)",
    (props) => {
      render(
        <Button asChild {...props}>
          <button type="button">Continue</button>
        </Button>,
      );
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    },
  );

  it("preserves click handlers and navigation for an active asChild link", () => {
    const onClick = vi.fn();
    const onChildClick = vi.fn();
    render(
      <Button asChild onClick={onClick}>
        <a href="#destination" onClick={onChildClick}>
          Continue
        </a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Continue" });
    expect(fireEvent.click(link)).toBe(true);
    expect(onClick).toHaveBeenCalledOnce();
    expect(onChildClick).toHaveBeenCalledOnce();
    expect(link).not.toHaveAttribute("aria-disabled");
    expect(link).not.toHaveAttribute("tabindex");
  });

  it("keeps a loading native button disabled and busy", () => {
    render(<Button loading>Continue</Button>);
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});
