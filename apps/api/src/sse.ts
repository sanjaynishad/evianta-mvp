import type { Response } from "express";

export interface SseWriter {
  readonly closed: boolean;
  send(event: string, data: unknown, id?: number | string): void;
  comment(text: string): void;
  close(): void;
}

export const SSE_RETRY_MS = 3000;

/** Starts an SSE response. Event data is single-line JSON, so one `data:` line per frame. */
export function openEventStream(res: Response): SseWriter {
  let closed = false;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);
  res.on("close", () => {
    closed = true;
  });

  return {
    get closed() {
      return closed || res.writableEnded;
    },
    send(event, data, id) {
      if (this.closed) {
        return;
      }

      const idLine = id === undefined ? "" : `id: ${id}\n`;

      res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (this.closed) {
        return;
      }

      res.write(`: ${text}\n\n`);
    },
    close() {
      if (!res.writableEnded) {
        res.end();
      }

      closed = true;
    },
  };
}
