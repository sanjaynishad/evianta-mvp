import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getSampleStateForUseCase } from "@/fixtures";
import { buildEvidenceIndex } from "@/lib/evidence";
import { EvidenceDrawer } from "./evidence-drawer";
import { ExportMenu } from "./export-menu";

describe("EvidenceDrawer", () => {
  it("scrolls its content so long evidence stays reachable", () => {
    const state = getSampleStateForUseCase("tax-notice");
    const entry = buildEvidenceIndex(state).values().next().value;

    render(<EvidenceDrawer entry={entry} findingTitles={new Map()} onOpenChange={vi.fn()} />);

    expect(screen.getByRole("dialog")).toHaveClass("overflow-y-auto");
  });
});

describe("ExportMenu", () => {
  it("keeps the open menu out of print", () => {
    render(<ExportMenu deliverableTitle="Response pack" onPrint={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Export Response pack" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(screen.getByRole("menu")).toHaveClass("print:hidden");
  });
});
