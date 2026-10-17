import { EventEmitter } from "node:events";

import type { Request, Response } from "express";
import { createRunEventBus } from "@evianta/agents";
import { createInMemoryStore } from "@evianta/store";
import { describe, expect, it, vi } from "vitest";

import { silentApiLogger } from "./logger.js";
import { streamRunEventsAsync } from "./runStream.js";
import type { RunLauncher } from "./runs.js";

describe("run stream initialization", () => {
  it("does not subscribe or start a heartbeat after disconnect during the case lookup", async () => {
    const store = createInMemoryStore();
    const events = createRunEventBus();
    const caseRecord = await store.cases.createCaseAsync({ title: "Disconnected stream" });
    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    store.cases.getCaseAsync = async () => {
      await gate;

      return caseRecord;
    };

    const subscribe = vi.spyOn(events, "subscribe");
    const listEvents = vi.spyOn(store.events, "listEventsAsync");
    const onSettled = vi.fn();
    const runs = { onSettled, isActive: () => false } as unknown as RunLauncher;
    const req = { query: {}, get: () => undefined } as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      status: vi.fn(),
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
    });
    const interval = vi.spyOn(globalThis, "setInterval");
    const streaming = streamRunEventsAsync(req, res as unknown as Response, caseRecord.id, {
      store,
      events,
      runs,
      logger: silentApiLogger,
      heartbeatMs: 50,
    });

    try {
      res.destroyed = true;
      res.emit("close");
      release();
      await streaming;

      expect(res.status).not.toHaveBeenCalled();
      expect(res.flushHeaders).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
      expect(listEvents).not.toHaveBeenCalled();
      expect(events.listenerCount(caseRecord.id)).toBe(0);
      expect(res.listenerCount("close")).toBe(0);
    } finally {
      release();
      interval.mockRestore();
    }
  });
});
