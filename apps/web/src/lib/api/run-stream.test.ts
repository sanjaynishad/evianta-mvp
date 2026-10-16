import type { RunEvent } from "@evianta/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  paceRunStreamHandlers,
  parseRunEventData,
  subscribeToRunEvents,
  withLastEventId,
  type EventSourceLike,
} from "./run-stream";

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(event: RunEvent, named = true) {
    const message = new MessageEvent(named ? event.type : "message", {
      data: JSON.stringify(event),
      lastEventId: String(event.seq),
    });
    for (const listener of this.listeners.get(named ? event.type : "message") ?? []) {
      listener(message);
    }
  }

  emitRaw(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }

  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

const base = { caseId: "case-1", timestamp: "2026-10-01T10:00:00.000Z" };
const usage = { input: 10, output: 5, total: 15 };

function runStarted(seq: number, runId = "run-1"): RunEvent {
  return { ...base, runId, seq, type: "run-started", mode: "run", taskIds: ["t1"] };
}

function taskStarted(seq: number, runId = "run-1"): RunEvent {
  return {
    ...base,
    runId,
    seq,
    type: "task-started",
    taskId: "t1",
    title: "Reconcile",
    assignedRole: "reconciliation",
    attempt: 1,
  };
}

function runCompleted(seq: number, runId = "run-1"): RunEvent {
  return {
    ...base,
    runId,
    seq,
    type: "run-completed",
    deliverableIds: [],
    totalTokenUsage: usage,
    totalCostEstimate: 0.01,
  };
}

const streamUrl = "https://api.example.test/cases/case-1/stream";

function subscribe(options: Parameters<typeof subscribeToRunEvents>[2] = {}) {
  const handlers = {
    onEvent: vi.fn(),
    onTerminal: vi.fn(),
    onError: vi.fn(),
    onConnectionChange: vi.fn(),
  };
  const unsubscribe = subscribeToRunEvents(streamUrl, handlers, {
    eventSourceFactory: (url) => new FakeEventSource(url),
    reconnectDelayMs: 100,
    ...options,
  });
  return { handlers, unsubscribe, source: () => FakeEventSource.instances.at(-1)! };
}

describe("parseRunEventData", () => {
  it("parses a typed run event", () => {
    expect(parseRunEventData(JSON.stringify(taskStarted(2))).type).toBe("task-started");
  });

  it("rejects non-JSON and unknown events", () => {
    expect(() => parseRunEventData("{")).toThrow();
    expect(() => parseRunEventData(JSON.stringify({ ...base, type: "mystery", seq: 1 }))).toThrow();
  });
});

describe("withLastEventId", () => {
  it("adds the resume id only when there is one", () => {
    expect(withLastEventId(streamUrl, 0)).toBe(streamUrl);
    expect(withLastEventId(streamUrl, 7)).toBe(`${streamUrl}?lastEventId=7`);
  });
});

describe("subscribeToRunEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers named and unnamed events, drops duplicates, and closes on the terminal event", () => {
    const { handlers, source } = subscribe();
    const eventSource = source();

    eventSource.emit(runStarted(1));
    eventSource.emit(taskStarted(2), false);
    eventSource.emit(taskStarted(2));
    eventSource.emit(runCompleted(3));

    expect(handlers.onEvent.mock.calls.map(([event]) => event.seq)).toEqual([1, 2, 3]);
    expect(handlers.onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run-completed" }),
    );
    expect(eventSource.closed).toBe(true);
    expect(handlers.onConnectionChange).toHaveBeenLastCalledWith("closed");
  });

  it("starts from a resume id and skips events at or before it", () => {
    const { handlers, source } = subscribe({ lastEventId: 2 });

    expect(source().url).toBe(`${streamUrl}?lastEventId=2`);
    source().emit(taskStarted(2));
    source().emit(runCompleted(3));

    expect(handlers.onEvent).toHaveBeenCalledTimes(1);
  });

  it("filters by run id so an earlier run's terminal event does not close the stream", () => {
    const { handlers, source } = subscribe({ runId: "run-2" });

    source().emit(runStarted(1, "run-1"));
    source().emit(runCompleted(2, "run-1"));
    source().emit(runStarted(3, "run-2"));

    expect(source().closed).toBe(false);
    expect(handlers.onEvent.mock.calls.map(([event]) => event.seq)).toEqual([3]);
    expect(handlers.onTerminal).not.toHaveBeenCalled();
  });

  it("reports invalid payloads without closing", () => {
    const { handlers, source } = subscribe();

    source().emitRaw("task-started", "{");

    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(source().closed).toBe(false);
  });

  it("reconnects with the last seen id when the browser gives up", () => {
    const { handlers, source } = subscribe();
    const first = source();
    first.emit(runStarted(1));
    first.emit(taskStarted(2));

    first.fail(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(handlers.onConnectionChange).toHaveBeenLastCalledWith("reconnecting");

    first.fail(2);
    vi.advanceTimersByTime(100);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(source().url).toBe(`${streamUrl}?lastEventId=2`);
  });

  it("stops after too many reconnect attempts", () => {
    const { handlers, source } = subscribe({ maxReconnectAttempts: 1 });

    source().fail(2);
    vi.advanceTimersByTime(100);
    source().fail(2);

    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onConnectionChange).toHaveBeenLastCalledWith("closed");
  });

  it("closes the source on unsubscribe", () => {
    const { handlers, unsubscribe, source } = subscribe();

    unsubscribe();
    source().emit(runStarted(1));

    expect(source().closed).toBe(true);
    expect(handlers.onEvent).not.toHaveBeenCalled();
  });
});

describe("paceRunStreamHandlers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spreads a burst of events over time and can be cancelled", () => {
    const onEvent = vi.fn();
    const paced = paceRunStreamHandlers({ onEvent }, 300);

    paced.handlers.onEvent(runStarted(1));
    paced.handlers.onEvent(taskStarted(2));
    paced.handlers.onEvent(runCompleted(3));
    vi.advanceTimersByTime(0);
    expect(onEvent).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    expect(onEvent).toHaveBeenCalledTimes(2);

    paced.cancel();
    vi.advanceTimersByTime(1000);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
