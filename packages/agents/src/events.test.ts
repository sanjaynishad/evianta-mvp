import type { RunEvent } from "@evianta/core";
import { createInMemoryStore } from "@evianta/store";
import { describe, expect, it } from "vitest";

import { createRunEventBus, createRunEventEmitter } from "./events.js";

describe("RunEventBus", () => {
  it("delivers events per case and unsubscribes", () => {
    const bus = createRunEventBus();
    const received: RunEvent[] = [];
    const all: RunEvent[] = [];
    const unsubscribe = bus.subscribe("case-1", (event) => received.push(event));
    const unsubscribeAll = bus.subscribeAll((event) => all.push(event));
    const event = (caseId: string, seq: number): RunEvent => ({
      type: "run-started",
      caseId,
      runId: "run-1",
      seq,
      timestamp: "2025-01-01T00:00:00.000Z",
      mode: "run",
      taskIds: [],
    });

    bus.publish(event("case-1", 1));
    bus.publish(event("case-2", 1));
    expect(bus.listenerCount("case-1")).toBe(1);
    unsubscribe();
    bus.publish(event("case-1", 2));
    unsubscribeAll();

    expect(received.map((item) => item.seq)).toEqual([1]);
    expect(all).toHaveLength(3);
    expect(bus.listenerCount()).toBe(0);
  });

  it("isolates listener errors", () => {
    const errors: unknown[] = [];
    const bus = createRunEventBus({ onListenerError: (error) => errors.push(error) });
    const received: number[] = [];

    bus.subscribe("case-1", () => {
      throw new Error("listener broke");
    });
    bus.subscribe("case-1", (event) => received.push(event.seq));
    bus.publish({
      type: "run-failed",
      caseId: "case-1",
      runId: "run-1",
      seq: 1,
      timestamp: "2025-01-01T00:00:00.000Z",
      error: "x",
      failedTaskIds: [],
    });

    expect(received).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it("persists before publishing and keeps seq order under concurrency", async () => {
    const store = createInMemoryStore();
    const bus = createRunEventBus();
    const published: number[] = [];

    bus.subscribe("case-1", (event) => published.push(event.seq));

    const emit = createRunEventEmitter(store, bus, "case-1");

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        emit({ type: "run-started", runId: `run-${index}`, mode: "run", taskIds: [] }),
      ),
    );

    const persisted = await store.events.listEventsAsync("case-1");

    expect(published).toEqual([1, 2, 3, 4, 5]);
    expect(persisted.map((event) => event.runId)).toEqual([
      "run-0",
      "run-1",
      "run-2",
      "run-3",
      "run-4",
    ]);
  });
});
