export interface GraphNode {
  id: string;
  dependsOn: readonly string[];
}

export type TaskGraphErrorKind = "cycle" | "missing-dependency" | "duplicate-task";

export class TaskGraphError extends Error {
  constructor(
    message: string,
    readonly kind: TaskGraphErrorKind,
    readonly taskIds: readonly string[],
  ) {
    super(message);
    this.name = "TaskGraphError";
  }
}

function findCycle(nodes: readonly GraphNode[]): string[] | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(id: string): string[] | undefined {
    const current = state.get(id);

    if (current === "done") {
      return undefined;
    }

    if (current === "visiting") {
      return [...stack.slice(stack.indexOf(id)), id];
    }

    state.set(id, "visiting");
    stack.push(id);

    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      const cycle = visit(dependency);

      if (cycle) {
        return cycle;
      }
    }

    stack.pop();
    state.set(id, "done");

    return undefined;
  }

  for (const node of nodes) {
    const cycle = visit(node.id);

    if (cycle) {
      return cycle;
    }
  }

  return undefined;
}

/** Throws a TaskGraphError for duplicate ids, unknown dependencies, or cycles. */
export function validateTaskGraph(nodes: readonly GraphNode[]): void {
  const ids = new Set<string>();

  for (const node of nodes) {
    if (ids.has(node.id)) {
      throw new TaskGraphError(`Task "${node.id}" appears more than once.`, "duplicate-task", [
        node.id,
      ]);
    }

    ids.add(node.id);
  }

  for (const node of nodes) {
    const missing = node.dependsOn.filter((dependency) => !ids.has(dependency));

    if (missing.length > 0) {
      throw new TaskGraphError(
        `Task "${node.id}" depends on unknown task(s): ${missing.join(", ")}.`,
        "missing-dependency",
        [node.id, ...missing],
      );
    }
  }

  const cycle = findCycle(nodes);

  if (cycle) {
    throw new TaskGraphError(
      `Tasks form a dependency cycle: ${cycle.join(" -> ")}.`,
      "cycle",
      cycle,
    );
  }
}

/** Kahn's algorithm, stable with respect to input order. Validates the graph first. */
export function topologicalOrder<T extends GraphNode>(nodes: readonly T[]): T[] {
  validateTaskGraph(nodes);

  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.dependsOn)]));
  const ordered: T[] = [];

  while (ordered.length < nodes.length) {
    const ready = nodes.filter(
      (node) => remaining.has(node.id) && remaining.get(node.id)?.size === 0,
    );

    for (const node of ready) {
      remaining.delete(node.id);
      ordered.push(node);
    }

    for (const dependencies of remaining.values()) {
      for (const node of ready) {
        dependencies.delete(node.id);
      }
    }
  }

  return ordered;
}

/** Every task that depends on `taskId`, directly or transitively. */
export function collectDependents(nodes: readonly GraphNode[], taskId: string): Set<string> {
  const dependents = new Set<string>();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = queue.shift() as string;

    for (const node of nodes) {
      if (node.dependsOn.includes(current) && !dependents.has(node.id)) {
        dependents.add(node.id);
        queue.push(node.id);
      }
    }
  }

  return dependents;
}

/** Every task that `taskId` depends on, directly or transitively. */
export function collectAncestors(nodes: readonly GraphNode[], taskId: string): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Set<string>();
  const queue = [...(byId.get(taskId)?.dependsOn ?? [])];

  while (queue.length > 0) {
    const current = queue.shift() as string;

    if (ancestors.has(current)) {
      continue;
    }

    ancestors.add(current);
    queue.push(...(byId.get(current)?.dependsOn ?? []));
  }

  return ancestors;
}
