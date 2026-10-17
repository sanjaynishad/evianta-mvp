import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createOrchestrator, type Orchestrator, type TaskHandlerRegistry } from "@evianta/agents";
import { createMockAi, type MockAiClient, type MockScript, type MockStep } from "@evianta/ai";
import type { UseCase } from "@evianta/core";
import {
  createInMemoryDocumentStore,
  createInMemoryStore,
  type DocumentStore,
  type Store,
} from "@evianta/store";
import type { Response, Test } from "supertest";

import { createApp, type EviantaApp } from "../app.js";
import type { ApiConfig } from "../context.js";
import type { IngestFunction } from "../ingestion.js";
import { silentApiLogger } from "../logger.js";

export interface TestHarness {
  app: EviantaApp;
  store: Store;
  documentStore: DocumentStore;
  ai: MockAiClient;
  orchestrator: Orchestrator;
}

export interface TestHarnessOptions {
  script?: MockScript;
  config?: Partial<ApiConfig>;
  handlers?: TaskHandlerRegistry;
  ingest?: IngestFunction;
  store?: Store;
  documentStore?: DocumentStore;
}

export function createTestHarness(options: TestHarnessOptions = {}): TestHarness {
  const store = options.store ?? createInMemoryStore();
  const documentStore = options.documentStore ?? createInMemoryDocumentStore();
  const ai = createMockAi(options.script ?? {});
  const orchestrator = createOrchestrator({
    store,
    ai,
    ...(options.handlers ? { handlers: options.handlers } : {}),
  });
  const app = createApp({
    store,
    documentStore,
    ai,
    orchestrator,
    logger: silentApiLogger,
    ...(options.ingest ? { ingest: options.ingest } : {}),
    config: { sseHeartbeatMs: 50, ...options.config },
  });

  return { app, store, documentStore, ai, orchestrator };
}

export const VISITOR_A = "visitor-a";
export const VISITOR_B = "visitor-b";

export function specialistStep(
  findings: unknown[],
  section?: { title: string; kind?: string; content: string },
): MockStep {
  return {
    output: { findings, openQuestions: [], ...(section ? { section } : {}) },
    usage: { input: 1200, output: 300 },
  };
}

export function finding(summary: string, extra: Record<string, unknown> = {}) {
  return { summary, severity: "medium", confidence: "high", evidence: [], ...extra };
}

export const SALES_CSV = [
  "month,region,revenue",
  "2024-01,North,120000",
  "2024-02,North,95000",
  "2024-03,South,143000",
].join("\n");

export async function seedSampleAsync(store: Store, useCase: UseCase = "data-analysis") {
  const sample = await store.cases.createCaseAsync({
    title: `Sample ${useCase}`,
    useCase,
    isSample: true,
    status: "completed",
  });

  await store.deliverables.saveDeliverableAsync({
    id: "deliverable-primary",
    caseId: sample.id,
    title: "Analysis report",
    format: "report",
    sections: [
      {
        id: "t1-section-1",
        title: "Overview",
        kind: "text",
        content: "Revenue grew in March.",
        producedByRole: "business-data-analyst",
      },
    ],
  });

  return sample;
}

/** A supertest parser that keeps an SSE body as text. */
export function asText(test: Test): Test {
  return test.buffer(true).parse((res: IncomingMessage, callback) => {
    let text = "";

    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      text += chunk;
    });
    res.on("end", () => callback(null, text));
  });
}

export interface SseFrame {
  id?: string;
  event: string;
  data: unknown;
}

export function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = [];

  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.length > 0 && !line.startsWith(":"));
    const fields = new Map<string, string>();

    for (const line of lines) {
      const separator = line.indexOf(":");
      const name = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

      fields.set(
        name,
        fields.has(name) && name === "data" ? `${fields.get(name)}\n${value}` : value,
      );
    }

    if (!fields.has("data")) {
      continue;
    }

    frames.push({
      ...(fields.has("id") ? { id: fields.get("id") as string } : {}),
      event: fields.get("event") ?? "message",
      data: JSON.parse(fields.get("data") as string),
    });
  }

  return frames;
}

export function sseFramesOf(res: Response): SseFrame[] {
  return parseSseFrames(res.body as string);
}

export async function listenAsync(app: EviantaApp): Promise<{ baseUrl: string; server: Server }> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const { port } = server.address() as AddressInfo;

  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

export async function closeServerAsync(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface LiveSseClient {
  readonly frames: SseFrame[];
  readonly comments: string[];
  /** Resolves when the server ends the stream. */
  readonly ended: Promise<void>;
  waitForFramesAsync(count: number, timeoutMs?: number): Promise<SseFrame[]>;
  close(): void;
}

/** A streaming SSE client that exposes frames as they arrive, so a test can disconnect mid-run. */
export function openLiveSse(url: string, headers: Record<string, string> = {}): LiveSseClient {
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  const waiters: (() => void)[] = [];
  let buffer = "";
  let resolveEnded: () => void = () => {};

  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const request = httpRequest(url, { headers: { Accept: "text/event-stream", ...headers } });

  request.on("response", (response) => {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);

        buffer = buffer.slice(boundary + 2);

        if (block.startsWith(":")) {
          comments.push(block.slice(1).trim());
        } else {
          frames.push(...parseSseFrames(block));
        }

        boundary = buffer.indexOf("\n\n");
      }

      for (const waiter of waiters.splice(0)) {
        waiter();
      }
    });
    response.on("end", resolveEnded);
    response.on("close", resolveEnded);
  });
  request.on("error", resolveEnded);
  request.end();

  return {
    frames,
    comments,
    ended,
    async waitForFramesAsync(count, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;

      while (frames.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${count} SSE frames; got ${frames.length}.`);
        }

        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }

      return frames.slice(0, count);
    },
    close() {
      request.destroy();
    },
  };
}

export async function waitForAsync(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
