import { OrchestratorError, type OrchestratorErrorCode } from "@evianta/agents";
import { DocumentExtractionError, UnsupportedDocumentTypeError } from "@evianta/ingest";
import { StoreConflictError, StoreNotFoundError } from "@evianta/store";
import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";

import { messageOf, type ApiLogger } from "./logger.js";

/** Every error response body: a stable `error` code, a readable `message`, and optional details. */
export interface ErrorBody {
  error: string;
  message: string;
  [detail: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  toBody(): ErrorBody {
    return { error: this.code, message: this.message, ...this.details };
  }
}

export function notFoundError(entity: string): ApiError {
  return new ApiError(404, "not-found", `The ${entity} was not found.`);
}

export function sampleReadOnlyError(caseId: string): ApiError {
  return new ApiError(
    409,
    "sample-read-only",
    "Sample cases are read-only. Copy the case to work on it.",
    { reason: "sample-read-only", copyUrl: `/cases/${encodeURIComponent(caseId)}/copy` },
  );
}

const ORCHESTRATOR_STATUS: Record<OrchestratorErrorCode, number> = {
  "case-not-found": 404,
  "use-case-missing": 422,
  "run-in-progress": 409,
  "nothing-to-retry": 409,
};

interface HttpParserError {
  type: string;
  status: number;
}

function isHttpParserError(error: unknown): error is HttpParserError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as HttpParserError).type === "string" &&
    typeof (error as HttpParserError).status === "number" &&
    (error as HttpParserError).status >= 400 &&
    (error as HttpParserError).status < 500
  );
}

const MULTER_MESSAGES: Partial<Record<multer.ErrorCode, [number, string, string]>> = {
  LIMIT_FILE_SIZE: [413, "file-too-large", "A file is larger than the upload size limit."],
  LIMIT_FILE_COUNT: [400, "too-many-files", "Too many files were sent in one upload."],
  LIMIT_UNEXPECTED_FILE: [400, "unexpected-file-field", 'Send files in the "files" field.'],
};

export function toApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new ApiError(400, "invalid-request", "The request is invalid.", {
      issues: error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  if (error instanceof StoreNotFoundError) {
    return new ApiError(404, "not-found", `The ${error.entity} was not found.`, {
      entity: error.entity,
    });
  }

  if (error instanceof StoreConflictError) {
    return new ApiError(409, "conflict", `The ${error.entity} already exists.`, {
      entity: error.entity,
    });
  }

  if (error instanceof OrchestratorError) {
    return new ApiError(ORCHESTRATOR_STATUS[error.code], error.code, error.message);
  }

  if (error instanceof UnsupportedDocumentTypeError) {
    return new ApiError(415, "unsupported-media-type", error.message);
  }

  if (error instanceof DocumentExtractionError) {
    return new ApiError(422, "extraction-failed", error.message);
  }

  if (error instanceof multer.MulterError) {
    const [status, code, message] = MULTER_MESSAGES[error.code] ?? [
      400,
      "invalid-upload",
      "The upload could not be read.",
    ];

    return new ApiError(status, code, message);
  }

  if (isHttpParserError(error)) {
    if (error.type === "entity.parse.failed") {
      return new ApiError(400, "invalid-json", "The request body is not valid JSON.");
    }

    if (error.type === "entity.too.large") {
      return new ApiError(413, "body-too-large", "The request body is too large.");
    }

    return new ApiError(error.status, "invalid-request", "The request body could not be read.");
  }

  return undefined;
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "not-found", message: "Not found." } satisfies ErrorBody);
};

/** Maps known errors to JSON responses; anything else is logged and returned as a generic 500. */
export function createErrorHandler(logger: ApiLogger): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    const apiError = toApiError(error);

    if (!apiError || apiError.status >= 500) {
      logger.error("Request failed.", {
        method: req.method,
        path: req.path,
        error: messageOf(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    if (res.headersSent) {
      res.end();

      return;
    }

    if (!apiError) {
      res
        .status(500)
        .json({ error: "internal-error", message: "Something went wrong." } satisfies ErrorBody);

      return;
    }

    res.status(apiError.status).json(apiError.toBody());
  };
}
