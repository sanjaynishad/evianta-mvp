import { isTerminalRunEvent, runEventSchema, runEventTypes, type RunEvent } from "@evianta/core";
import type { RunStreamHandlers, RunStreamOptions, Unsubscribe } from "@/lib/data/types";
import { ApiNetworkError, ApiResponseValidationError } from "./errors";

export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface SubscribeToRunEventsOptions extends RunStreamOptions {
  eventSourceFactory?: EventSourceFactory;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
}

export const lastEventIdParam = "lastEventId";

export function parseRunEventData(data: unknown): RunEvent {
  let raw: unknown;
  try {
    raw = typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    throw new ApiResponseValidationError("run stream", [
      { path: [], message: "Event data is not JSON" },
    ]);
  }

  const parsed = runEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiResponseValidationError("run stream", parsed.error.issues);
  }

  return parsed.data;
}

// EventSource cannot set headers on a fresh connection, so a manual resume passes the last
// seen sequence as a query parameter. Automatic browser reconnects send Last-Event-ID.
export function withLastEventId(streamUrl: string, lastEventId: number): string {
  if (lastEventId <= 0) {
    return streamUrl;
  }

  const url = new URL(streamUrl);
  url.searchParams.set(lastEventIdParam, String(lastEventId));
  return url.toString();
}

function defaultEventSourceFactory(url: string): EventSourceLike {
  return new EventSource(url);
}

export interface PacedRunStreamHandlers {
  handlers: RunStreamHandlers;
  cancel: () => void;
}

// Persisted events replay in one burst; pacing lets a replay read like the original run.
export function paceRunStreamHandlers(
  handlers: RunStreamHandlers,
  intervalMs: number,
): PacedRunStreamHandlers {
  const queue: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  function drain() {
    timer = undefined;
    const next = queue.shift();
    if (cancelled || !next) {
      return;
    }

    next();
    if (queue.length > 0) {
      timer = setTimeout(drain, intervalMs);
    }
  }

  function enqueue(action: () => void) {
    if (cancelled) {
      return;
    }

    queue.push(action);
    timer ??= setTimeout(drain, queue.length === 1 ? 0 : intervalMs);
  }

  return {
    handlers: {
      onEvent: (event) => enqueue(() => handlers.onEvent(event)),
      onTerminal: (event) => enqueue(() => handlers.onTerminal?.(event)),
      onError: handlers.onError,
      onConnectionChange: handlers.onConnectionChange,
    },
    cancel: () => {
      cancelled = true;
      queue.length = 0;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

export function subscribeToRunEvents(
  streamUrl: string,
  handlers: RunStreamHandlers,
  options: SubscribeToRunEventsOptions = {},
): Unsubscribe {
  const createEventSource = options.eventSourceFactory ?? defaultEventSourceFactory;
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  let lastSeq = options.lastEventId ?? 0;
  let source: EventSourceLike | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  let closed = false;

  function close() {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }

    source?.close();
    source = undefined;
  }

  function handleMessage(message: MessageEvent) {
    if (closed) {
      return;
    }

    let event: RunEvent;
    try {
      event = parseRunEventData(message.data);
    } catch (error) {
      handlers.onError?.(error as Error);
      return;
    }

    if (event.seq <= lastSeq) {
      return;
    }

    lastSeq = event.seq;
    reconnectAttempts = 0;
    if (options.runId && event.runId !== options.runId) {
      return;
    }

    handlers.onEvent(event);
    if (isTerminalRunEvent(event)) {
      close();
      handlers.onConnectionChange?.("closed");
      handlers.onTerminal?.(event);
    }
  }

  function connect() {
    if (closed) {
      return;
    }

    handlers.onConnectionChange?.(reconnectAttempts === 0 ? "connecting" : "reconnecting");
    const current = createEventSource(withLastEventId(streamUrl, lastSeq));
    source = current;
    for (const type of runEventTypes) {
      current.addEventListener(type, handleMessage);
    }

    current.addEventListener("message", handleMessage);
    current.onopen = () => {
      if (!closed) {
        handlers.onConnectionChange?.("open");
      }
    };

    // Native EventSource retries forever while CONNECTING, so every error goes through the
    // bounded manual reconnect, which also resumes from the last seen sequence number.
    current.onerror = () => {
      if (closed || source !== current) {
        return;
      }

      current.close();
      source = undefined;
      reconnectAttempts += 1;
      if (reconnectAttempts > maxReconnectAttempts) {
        close();
        handlers.onConnectionChange?.("closed");
        handlers.onError?.(
          new ApiNetworkError("Lost the connection to live progress. Refresh to reconnect."),
        );
        return;
      }

      handlers.onConnectionChange?.("reconnecting");
      reconnectTimer = setTimeout(connect, reconnectDelayMs * reconnectAttempts);
    };
  }

  connect();
  return close;
}
