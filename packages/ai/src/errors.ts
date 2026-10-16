import type { TokenUsage } from "@evianta/core";

import { emptyUsage, type Cost } from "./pricing.js";

export interface AiErrorDetails {
  cause?: unknown;
  attempts?: number;
  usage?: TokenUsage;
  cost?: Cost;
}

export abstract class AiError extends Error {
  abstract readonly transient: boolean;
  readonly attempts: number;
  readonly usage: TokenUsage;
  readonly cost: Cost;

  constructor(message: string, details: AiErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    this.attempts = details.attempts ?? 0;
    this.usage = details.usage ?? emptyUsage();
    this.cost = details.cost ?? 0;
  }
}

export class AiTransientError extends AiError {
  readonly transient = true;
  readonly retryAfterMs?: number;

  constructor(message: string, details: AiErrorDetails & { retryAfterMs?: number } = {}) {
    super(message, details);
    this.retryAfterMs = details.retryAfterMs;
  }
}

export type AiNonTransientReason =
  | "invalid-request"
  | "invalid-input"
  | "blocked"
  | "permission-denied"
  | "not-configured"
  | "unknown";

export class AiNonTransientError extends AiError {
  readonly transient = false;
  readonly reason: AiNonTransientReason;

  constructor(message: string, details: AiErrorDetails & { reason?: AiNonTransientReason } = {}) {
    super(message, details);
    this.reason = details.reason ?? "unknown";
  }
}

export class AiInputValidationError extends AiNonTransientError {
  readonly issues: string[];

  constructor(message: string, issues: string[], details: AiErrorDetails = {}) {
    super(message, { ...details, reason: "invalid-input" });
    this.issues = issues;
  }
}

export class AiOutputValidationError extends AiError {
  readonly transient = false;
  readonly issues: string[];
  readonly rawText: string;

  constructor(message: string, issues: string[], rawText: string, details: AiErrorDetails = {}) {
    super(message, details);
    this.issues = issues;
    this.rawText = rawText;
  }
}

const TRANSIENT_GENKIT_STATUSES = new Set([
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "INTERNAL",
  "DEADLINE_EXCEEDED",
  "ABORTED",
]);

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function readProperty(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  return (error as Record<string, unknown>)[key];
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function httpStatusInMessage(message: string): number | undefined {
  const match = /\[(\d{3})\b/.exec(message);

  return match ? Number(match[1]) : undefined;
}

export function isTransientAiError(error: unknown): boolean {
  if (error instanceof AiError) {
    return error.transient;
  }

  const message = error instanceof Error ? error.message : String(error);
  const name = readProperty(error, "name");
  const status = readProperty(error, "status");

  if (name === "TimeoutError") {
    return true;
  }

  if (typeof status === "string") {
    if (TRANSIENT_GENKIT_STATUSES.has(status)) {
      return true;
    }

    if (status !== "UNKNOWN") {
      return false;
    }

    const httpStatus = httpStatusInMessage(message);

    return httpStatus !== undefined && isTransientHttpStatus(httpStatus);
  }

  const numericStatus = typeof status === "number" ? status : readProperty(error, "statusCode");

  if (typeof numericStatus === "number") {
    return isTransientHttpStatus(numericStatus);
  }

  const code = readProperty(error, "code") ?? readProperty(readProperty(error, "cause"), "code");

  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
    return true;
  }

  return /^Failed to fetch from |fetch failed|socket hang up/i.test(message);
}

export function retryAfterMsOf(error: unknown): number | undefined {
  if (error instanceof AiTransientError) {
    return error.retryAfterMs;
  }

  const retryAfterMs = readProperty(readProperty(error, "responseMetadata"), "retryAfterMs");

  return typeof retryAfterMs === "number" && retryAfterMs >= 0 ? retryAfterMs : undefined;
}

export function nonTransientReasonOf(error: unknown): AiNonTransientReason {
  if (error instanceof AiNonTransientError) {
    return error.reason;
  }

  if (error instanceof Error && error.constructor.name === "GenerationBlockedError") {
    return "blocked";
  }

  const status = readProperty(error, "status");

  if (status === "INVALID_ARGUMENT" || status === "FAILED_PRECONDITION" || status === "NOT_FOUND") {
    return "invalid-request";
  }

  if (status === "PERMISSION_DENIED" || status === "UNAUTHENTICATED") {
    return "permission-denied";
  }

  return "unknown";
}
