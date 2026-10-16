import { describe, expect, it } from "vitest";

import {
  collectAncestors,
  collectDependents,
  TaskGraphError,
  topologicalOrder,
  validateTaskGraph,
} from "./dag.js";

describe("task graph", () => {
  it("orders a branching graph topologically and stably", () => {
    const nodes = [
      { id: "draft", dependsOn: ["reconcile", "research"] },
      { id: "analyze", dependsOn: [] },
      { id: "reconcile", dependsOn: ["analyze"] },
      { id: "research", dependsOn: ["analyze"] },
      { id: "review", dependsOn: ["draft"] },
    ];

    expect(topologicalOrder(nodes).map((node) => node.id)).toEqual([
      "analyze",
      "reconcile",
      "research",
      "draft",
      "review",
    ]);
  });

  it("detects cycles", () => {
    const nodes = [
      { id: "a", dependsOn: ["c"] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ];

    expect(() => validateTaskGraph(nodes)).toThrow(TaskGraphError);

    try {
      validateTaskGraph(nodes);
    } catch (error) {
      expect((error as TaskGraphError).kind).toBe("cycle");
      expect((error as TaskGraphError).message).toMatch(/cycle/);
    }
  });

  it("detects missing dependencies and duplicates", () => {
    expect(() => validateTaskGraph([{ id: "a", dependsOn: ["ghost"] }])).toThrow(
      /unknown task\(s\): ghost/,
    );
    expect(() =>
      validateTaskGraph([
        { id: "a", dependsOn: [] },
        { id: "a", dependsOn: [] },
      ]),
    ).toThrow(/more than once/);
  });

  it("collects transitive dependents and ancestors", () => {
    const nodes = [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
      { id: "d", dependsOn: [] },
    ];

    expect(collectDependents(nodes, "a")).toEqual(new Set(["b", "c"]));
    expect(collectAncestors(nodes, "c")).toEqual(new Set(["a", "b"]));
    expect(collectDependents(nodes, "d").size).toBe(0);
  });
});
