import type { RunEventBus } from "@evianta/agents";
import { isTerminalRunEvent, type RunEvent } from "@evianta/core";
import type { Store } from "@evianta/store";
import type { Request, Response } from "express";
import { z } from "zod";

import { ApiError, notFoundError } from "./errors.js";
import { messageOf, type ApiLogger } from "./logger.js";
import type { RunLauncher } from "./runs.js";
import { openEventStream } from "./sse.js";

export interface RunStreamOptions {
  store: Store;
  events: RunEventBus;
  runs: RunLauncher;
  logger: ApiLogger;
  heartbeatMs: number;
}

const cursorSchema = z.coerce.number().int().nonnegative();

function parseCursor(value: unknown, source: string): number {
  if (value === undefined || value === "") {
    return 0;
  }

  const parsed = cursorSchema.safeParse(value);

  if (!parsed.success) {
    throw new ApiError(400, "invalid-request", `${source} must be a non-negative integer seq.`);
  }

  return parsed.data;
}

/** Resumes after the larger of the Last-Event-ID header (reconnects) and the `after` query. */
export function resolveStreamCursor(req: Request): number {
  const query = typeof req.query.after === "string" ? req.query.after : undefined;

  if (req.query.after !== undefined && query === undefined) {
    throw new ApiError(400, "invalid-request", "after must be a single value.");
  }

  return Math.max(
    parseCursor(req.get("Last-Event-ID"), "Last-Event-ID"),
    parseCursor(query, "after"),
  );
}

/**
 * Replays persisted events after the cursor, then tails the live bus, deduplicating by seq and
 * filling any gap from the store. Closes after a terminal event once the run has released the case,
 * so a client that sees the stream end can immediately retry or approve.
 */
export async function streamRunEventsAsync(
  req: Request,
  res: Response,
  caseId: string,
  options: RunStreamOptions,
): Promise<void> {
  const { store, events, runs, logger, heartbeatMs } = options;
  const cursor = resolveStreamCursor(req);

  const caseRecord = await store.cases.getCaseAsync(caseId);

  if (res.destroyed) {
    return;
  }

  if (!caseRecord) {
    throw notFoundError("case");
  }

  const writer = openEventStream(res);
  let lastSentSeq = cursor;
  let latest: RunEvent | undefined;
  let replayed = false;
  let finished = false;
  let queue: Promise<void> = Promise.resolve();
  const buffered: RunEvent[] = [];

  const send = (event: RunEvent) => {
    if (latest === undefined || event.seq > latest.seq) {
      latest = event;
    }

    if (finished || event.seq <= lastSentSeq) {
      return;
    }

    writer.send(event.type, event, event.seq);
    lastSentSeq = event.seq;
  };

  const finishIfDone = () => {
    if (latest && isTerminalRunEvent(latest) && !runs.isActive(caseId)) {
      finish();
    }
  };

  const deliverAsync = async (event: RunEvent) => {
    if (finished || event.seq <= lastSentSeq) {
      return;
    }

    if (event.seq > lastSentSeq + 1) {
      for (const missing of await store.events.listEventsAsync(caseId, lastSentSeq)) {
        if (missing.seq < event.seq) {
          send(missing);
        }
      }
    }

    send(event);
    finishIfDone();
  };

  const enqueue = (work: () => Promise<void> | void) => {
    queue = queue
      .then(async () => {
        if (!finished) {
          await work();
        }
      })
      .catch((error: unknown) => {
        logger.warn("Run stream failed.", { caseId, error: messageOf(error) });
        finish();
      });
  };

  const unsubscribe = events.subscribe(caseId, (event) => {
    if (!replayed) {
      buffered.push(event);

      return;
    }

    enqueue(() => deliverAsync(event));
  });
  const unsubscribeSettled = runs.onSettled(caseId, () => enqueue(finishIfDone));
  // The settle listener closes the stream once the run's lock is released; the heartbeat check
  // also covers runs started outside the launcher.
  const heartbeat = setInterval(() => {
    writer.comment("heartbeat");
    enqueue(finishIfDone);
  }, heartbeatMs);

  heartbeat.unref();

  function finish() {
    if (finished) {
      return;
    }

    finished = true;
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeSettled();
    writer.close();
  }

  res.on("close", finish);

  // Starting one before the cursor also loads the newest event when nothing is new.
  enqueue(async () => {
    for (const event of await store.events.listEventsAsync(caseId, Math.max(0, cursor - 1))) {
      send(event);
    }

    replayed = true;

    for (const event of buffered.splice(0)) {
      await deliverAsync(event);
    }

    finishIfDone();
  });

  await queue;
}
