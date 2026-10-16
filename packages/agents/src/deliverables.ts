import {
  deliverableSchema,
  type Deliverable,
  type DeliverableSection,
  type Task,
} from "@evianta/core";

import { PRIMARY_DELIVERABLE_KEY, type DeliverableSpec } from "./findings.js";
import type { PlannedSection } from "./record.js";

export function deliverableIdFor(key: string): string {
  return `deliverable-${key}`;
}

export interface AssembleDeliverablesInput {
  caseId: string;
  /** Tasks in plan (topological) order; section order follows it. */
  orderedTasks: readonly Task[];
  existing: readonly Deliverable[];
  /** Sections produced by tasks that completed in this run, keyed by task id. */
  producedByTask: ReadonlyMap<string, readonly PlannedSection[]>;
  primary: Omit<DeliverableSpec, "key">;
  specs: readonly DeliverableSpec[];
}

function taskIndexOf(sectionId: string, orderedTasks: readonly Task[]): number {
  const index = orderedTasks.findIndex((task) => sectionId.startsWith(`${task.id}-section-`));

  return index === -1 ? orderedTasks.length : index;
}

function sectionNumberOf(sectionId: string): number {
  const match = /-section-(\d+)$/.exec(sectionId);

  return match ? Number(match[1]) : 0;
}

/**
 * Rebuilds each affected deliverable: sections from tasks that ran in this run replace their
 * earlier versions, sections from untouched tasks (and their reviewer edits) are kept.
 */
export function assembleDeliverables(input: AssembleDeliverablesInput): Deliverable[] {
  const rerunTaskIds = new Set(input.producedByTask.keys());
  const sectionsByKey = new Map<string, PlannedSection[]>();

  for (const sections of input.producedByTask.values()) {
    for (const section of sections) {
      const list = sectionsByKey.get(section.deliverableKey) ?? [];
      list.push(section);
      sectionsByKey.set(section.deliverableKey, list);
    }
  }

  const specsByKey = new Map<string, DeliverableSpec>([
    [PRIMARY_DELIVERABLE_KEY, { key: PRIMARY_DELIVERABLE_KEY, ...input.primary }],
  ]);

  for (const spec of input.specs) {
    specsByKey.set(spec.key, { ...specsByKey.get(spec.key), ...spec });
  }

  const keys = new Set<string>([...sectionsByKey.keys(), ...input.specs.map((spec) => spec.key)]);

  for (const deliverable of input.existing) {
    const key = deliverable.id.replace(/^deliverable-/, "");
    const touched = deliverable.sections.some((section) =>
      [...rerunTaskIds].some((taskId) => section.id.startsWith(`${taskId}-section-`)),
    );

    if (touched) {
      keys.add(key);
    }
  }

  const assembled: Deliverable[] = [];

  for (const key of keys) {
    const id = deliverableIdFor(key);
    const prior = input.existing.find((deliverable) => deliverable.id === id);
    const spec = specsByKey.get(key);
    const kept = (prior?.sections ?? []).filter(
      (section) => ![...rerunTaskIds].some((taskId) => section.id.startsWith(`${taskId}-section-`)),
    );
    const produced: DeliverableSection[] = (sectionsByKey.get(key) ?? []).map(
      ({ deliverableKey: _deliverableKey, ...section }) => ({
        ...section,
        findingIds: section.findingIds,
        evidenceIds: section.evidenceIds,
        reviewStatus: "pending",
      }),
    );
    const sections = [...kept, ...produced].sort(
      (left, right) =>
        taskIndexOf(left.id, input.orderedTasks) - taskIndexOf(right.id, input.orderedTasks) ||
        sectionNumberOf(left.id) - sectionNumberOf(right.id),
    );
    const title = spec?.title ?? prior?.title ?? key;
    const format = spec?.format ?? prior?.format ?? "report";
    const content = spec?.content ?? prior?.content;

    assembled.push(
      deliverableSchema.parse({
        id,
        caseId: input.caseId,
        title,
        format,
        ...(content !== undefined ? { content } : {}),
        sections,
      }),
    );
  }

  return assembled;
}
