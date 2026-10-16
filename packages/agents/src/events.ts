import type { NewRunEvent, RunEvent } from "@evianta/core";
import type { Store } from "@evianta/store";

export type RunEventListener = (event: RunEvent) => void;

export type Unsubscribe = () => void;

/** In-process fan-out of persisted run events, used to tail live progress (for example SSE). */
export interface RunEventBus {
  subscribe(caseId: string, listener: RunEventListener): Unsubscribe;
  subscribeAll(listener: RunEventListener): Unsubscribe;
  publish(event: RunEvent): void;
  listenerCount(caseId?: string): number;
}

export interface RunEventBusOptions {
  onListenerError?: (error: unknown, event: RunEvent) => void;
}

export function createRunEventBus(options: RunEventBusOptions = {}): RunEventBus {
  const byCase = new Map<string, Set<RunEventListener>>();
  const global = new Set<RunEventListener>();

  function deliver(listener: RunEventListener, event: RunEvent): void {
    try {
      listener(event);
    } catch (error) {
      options.onListenerError?.(error, event);
    }
  }

  return {
    subscribe(caseId, listener) {
      let listeners = byCase.get(caseId);

      if (!listeners) {
        listeners = new Set();
        byCase.set(caseId, listeners);
      }

      listeners.add(listener);

      return () => {
        const current = byCase.get(caseId);

        current?.delete(listener);

        if (current?.size === 0) {
          byCase.delete(caseId);
        }
      };
    },
    subscribeAll(listener) {
      global.add(listener);

      return () => {
        global.delete(listener);
      };
    },
    publish(event) {
      for (const listener of [...(byCase.get(event.caseId) ?? [])]) {
        deliver(listener, event);
      }

      for (const listener of [...global]) {
        deliver(listener, event);
      }
    },
    listenerCount(caseId) {
      if (caseId === undefined) {
        let count = global.size;

        for (const listeners of byCase.values()) {
          count += listeners.size;
        }

        return count;
      }

      return byCase.get(caseId)?.size ?? 0;
    },
  };
}

export type RunEventEmitter = (event: NewRunEvent) => Promise<RunEvent>;

/**
 * Persists events through the store (which assigns seq) and then publishes them, one at a time,
 * so the published order always matches seq even when tasks finish concurrently.
 */
export function createRunEventEmitter(
  store: Pick<Store, "events">,
  bus: RunEventBus,
  caseId: string,
): RunEventEmitter {
  let chain: Promise<unknown> = Promise.resolve();

  return (event) => {
    const next = chain.then(async () => {
      const persisted = await store.events.appendEventAsync(caseId, event);

      bus.publish(persisted);

      return persisted;
    });

    chain = next.catch(() => undefined);

    return next;
  };
}
