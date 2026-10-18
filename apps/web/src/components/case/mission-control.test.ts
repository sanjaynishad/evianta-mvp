import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskProgress } from "@/lib/run-progress";
import { layoutTaskGraph, MissionControl } from "./mission-control";

function task(id: string, dependsOn: string[] = []): TaskProgress {
  return {
    id,
    title: id,
    assignedRole: "case-analysis",
    status: "pending",
    dependsOn,
    attempts: 0,
    findingIds: [],
  };
}

describe("layoutTaskGraph", () => {
  it("places dependent work in later stages and keeps independent work parallel", () => {
    const layout = layoutTaskGraph([
      task("intake"),
      task("research", ["intake"]),
      task("reconcile", ["intake"]),
      task("review", ["research", "reconcile"]),
    ]);

    expect(layout.columns).toBe(3);
    expect(layout.rows).toBe(2);
    expect(layout.nodes).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: "intake" }),
        column: 0,
        row: 0,
      }),
      expect.objectContaining({
        task: expect.objectContaining({ id: "research" }),
        column: 1,
        row: 0,
      }),
      expect.objectContaining({
        task: expect.objectContaining({ id: "reconcile" }),
        column: 1,
        row: 1,
      }),
      expect.objectContaining({
        task: expect.objectContaining({ id: "review" }),
        column: 2,
        row: 0,
      }),
    ]);
  });

  it("returns a usable empty layout before a run has planned tasks", () => {
    expect(layoutTaskGraph([])).toEqual({ nodes: [], columns: 1, rows: 1 });
  });

  it("shows task dependencies in each card and its accessible name", () => {
    const tasks = [
      { ...task("source"), title: "Check data quality" },
      {
        ...task("follow-up", ["source"]),
        title: "Compute sales metrics",
      },
    ];

    render(
      createElement(MissionControl, {
        progress: {
          mode: "run",
          status: "running",
          tasks,
          findings: [],
          totalTokens: 0,
          totalCost: 0,
          lastSeq: 0,
          announcement: "",
        },
      }),
    );

    const dependentCards = screen.getAllByRole("article", {
      name: /Compute sales metrics.*Depends on: Check data quality/,
    });
    expect(dependentCards.length).toBeGreaterThan(0);
    expect(
      dependentCards.every((card) => card.textContent?.includes("Depends on: Check data quality")),
    ).toBe(true);
    expect(screen.getAllByText("Depends on: Check data quality").length).toBeGreaterThan(0);
  });
});
