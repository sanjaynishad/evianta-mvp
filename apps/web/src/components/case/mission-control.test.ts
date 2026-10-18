import { describe, expect, it } from "vitest";
import type { TaskProgress } from "@/lib/run-progress";
import { layoutTaskGraph } from "./mission-control";

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
});
