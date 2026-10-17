import { EventEmitter } from "node:events";

import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { openEventStream } from "./sse.js";

function createResponse() {
  let destroyed = false;
  let writableLength = 0;
  const response = Object.assign(new EventEmitter(), {
    get destroyed() {
      return destroyed;
    },
    writableEnded: false,
    get writableLength() {
      return writableLength;
    },
    status: vi.fn(),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((frame: string) => {
      writableLength += Buffer.byteLength(frame);

      return false;
    }),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    end: vi.fn(),
  });

  return response;
}

describe("SSE output buffering", () => {
  it.each([
    [
      "event",
      (writer: ReturnType<typeof openEventStream>) =>
        writer.send("update", "x".repeat(1024 * 1024)),
    ],
    [
      "heartbeat",
      (writer: ReturnType<typeof openEventStream>) => writer.comment("x".repeat(1024 * 1024)),
    ],
  ])("disconnects when a %s exceeds the output buffer limit", (_kind, writeFrame) => {
    const response = createResponse();
    const writer = openEventStream(response as unknown as Response);

    writeFrame(writer);

    expect(response.destroy).toHaveBeenCalledOnce();
    expect(writer.closed).toBe(true);
    expect(response.write).toHaveBeenCalledOnce();
  });
});
