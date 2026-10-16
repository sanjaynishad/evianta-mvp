import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExportMenu } from "./export-menu";

describe("ExportMenu", () => {
  it("keeps the open menu out of print", () => {
    render(<ExportMenu deliverableTitle="Response pack" onPrint={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Export Response pack" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(screen.getByRole("menu")).toHaveClass("print:hidden");
  });
});
