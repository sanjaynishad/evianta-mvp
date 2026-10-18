import {
  agentDirectoryResponseSchema,
  agentProfileSchema,
  apiErrorBodySchema,
  approveCaseRequestSchema,
  approveCaseResponseSchema,
  askDeltaSchema,
  askRequestSchema,
  askResultSchema,
  caseListResponseSchema,
  caseSchema,
  caseStateSchema,
  createCaseRequestSchema,
  deliverableSchema,
  documentDetailResponseSchema,
  openQuestionUpdateResponseSchema,
  reviewNoteRequestSchema,
  runStartResponseSchema,
  sampleReadOnlyErrorBodySchema,
  sectionUpdateRequestSchema,
  uploadDocumentsResponseSchema,
  usageCasesResponseSchema,
  usageSummarySchema,
  visitorHeaderName,
  type AgentRole,
  type AskResult,
  type ExportFormat,
} from "@evianta/core";
import type { CaseDataSource, RunStreamHandlers, RunStreamOptions } from "@/lib/data/types";
import {
  ApiError,
  ApiNetworkError,
  ApiResponseValidationError,
  SampleReadOnlyError,
  type ResponseIssue,
} from "./errors";
import { subscribeToRunEvents, type EventSourceFactory } from "./run-stream";
import { readServerSentEventsAsync } from "./sse";

interface ResponseSchema<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: ResponseIssue[] } };
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  getVisitorId?: () => string | undefined;
  eventSourceFactory?: EventSourceFactory;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  json?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  accept?: string;
}

export type ApiClient = CaseDataSource;

// Matches the field apps/api reads uploads from.
export const uploadFieldName = "files";

function segment(value: string): string {
  return encodeURIComponent(value);
}

function casePath(caseId: string): string {
  return `/cases/${segment(caseId)}`;
}

function usagePath(usageViewPath: string): string {
  return `/${usageViewPath.split("/").filter(Boolean).map(segment).join("/")}`;
}

async function readBodyAsync(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  function resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  function toApiError(status: number, body: unknown): ApiError {
    if (status === 409) {
      const readOnly = sampleReadOnlyErrorBodySchema.safeParse(body);
      if (readOnly.success) {
        return new SampleReadOnlyError(resolveUrl(readOnly.data.copyUrl), readOnly.data.message);
      }
    }

    const parsed = apiErrorBodySchema.safeParse(body);
    const details = parsed.success ? parsed.data : {};
    const message = details.message ?? `The request failed with status ${status}. Try again.`;
    return new ApiError(message, status, { code: details.error, body });
  }

  async function sendAsync(path: string, request: RequestOptions = {}): Promise<Response> {
    const headers = new Headers({ Accept: request.accept ?? "application/json" });
    const visitorId = options.getVisitorId?.();
    if (visitorId) {
      headers.set(visitorHeaderName, visitorId);
    }

    let body: BodyInit | undefined;
    if (request.formData) {
      body = request.formData;
    } else if (request.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(request.json);
    }

    let response: Response;
    try {
      response = await fetchImpl(resolveUrl(path), {
        method: request.method ?? "GET",
        headers,
        body,
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      throw new ApiNetworkError("Could not reach the Evianta API. Check your connection.", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw toApiError(response.status, await readBodyAsync(response));
    }

    return response;
  }

  async function requestAsync<T>(
    path: string,
    schema: ResponseSchema<T>,
    request: RequestOptions = {},
  ): Promise<T> {
    const response = await sendAsync(path, request);
    const parsed = schema.safeParse(await readBodyAsync(response));
    if (!parsed.success) {
      throw new ApiResponseValidationError(path, parsed.error.issues);
    }

    return parsed.data;
  }

  return {
    mode: "live",

    listAgentsAsync({ enabledOnly } = {}) {
      return requestAsync(
        enabledOnly ? "/agents?enabled=true" : "/agents",
        agentDirectoryResponseSchema,
      );
    },

    getAgentAsync(role: AgentRole) {
      return requestAsync(`/agents/${segment(role)}`, agentProfileSchema);
    },

    async listSamplesAsync() {
      const response = await requestAsync("/samples", caseListResponseSchema);
      return response.cases;
    },

    async listCasesAsync() {
      const response = await requestAsync("/cases", caseListResponseSchema);
      return response.cases;
    },

    createCaseAsync(request) {
      return requestAsync("/cases", caseSchema, {
        method: "POST",
        json: createCaseRequestSchema.parse(request),
      });
    },

    copyCaseAsync(caseId) {
      return requestAsync(`${casePath(caseId)}/copy`, caseSchema, { method: "POST" });
    },

    getCaseStateAsync(caseId) {
      return requestAsync(casePath(caseId), caseStateSchema);
    },

    getDocumentAsync(caseId, documentId) {
      return requestAsync(
        `${casePath(caseId)}/documents/${segment(documentId)}`,
        documentDetailResponseSchema,
      );
    },

    getDocumentFileUrl(caseId, documentId) {
      return resolveUrl(`${casePath(caseId)}/documents/${segment(documentId)}/file`);
    },

    async uploadDocumentAsync(caseId, file, uploadOptions = {}) {
      const path = `${casePath(caseId)}/documents`;
      const formData = new FormData();
      formData.append(uploadFieldName, file, file.name);
      const response = await requestAsync(path, uploadDocumentsResponseSchema, {
        method: "POST",
        formData,
        signal: uploadOptions.signal,
      });
      const [document] = response.documents;
      if (!document) {
        throw new ApiResponseValidationError(path, [
          { path: ["documents"], message: "No document was returned" },
        ]);
      }

      return document;
    },

    startRunAsync(caseId) {
      return requestAsync(`${casePath(caseId)}/run`, runStartResponseSchema, { method: "POST" });
    },

    retryRunAsync(caseId) {
      return requestAsync(`${casePath(caseId)}/retry`, runStartResponseSchema, {
        method: "POST",
      });
    },

    subscribeToRun(caseId: string, handlers: RunStreamHandlers, streamOptions?: RunStreamOptions) {
      return subscribeToRunEvents(resolveUrl(`${casePath(caseId)}/stream`), handlers, {
        ...streamOptions,
        eventSourceFactory: options.eventSourceFactory,
      });
    },

    getDeliverableAsync(caseId, deliverableId) {
      return requestAsync(
        `${casePath(caseId)}/deliverables/${segment(deliverableId)}`,
        deliverableSchema,
      );
    },

    getExportUrl(caseId: string, deliverableId: string, format: ExportFormat) {
      return resolveUrl(
        `${casePath(caseId)}/deliverables/${segment(deliverableId)}/export?format=${format}`,
      );
    },

    async askAsync(caseId, question, askOptions = {}) {
      const path = `${casePath(caseId)}/ask`;
      const response = await sendAsync(path, {
        method: "POST",
        json: askRequestSchema.parse({ question }),
        signal: askOptions.signal,
        accept: "text/event-stream",
      });
      if (!response.body) {
        throw new ApiNetworkError("The answer did not arrive. Try again.");
      }

      let result: AskResult | undefined;
      let failure: ApiError | undefined;
      await readServerSentEventsAsync(response.body, ({ event, data }) => {
        const payload = parseJson(data);
        if (event === "answer-delta") {
          const delta = askDeltaSchema.safeParse(payload);
          if (delta.success) {
            askOptions.onDelta?.(delta.data.text);
          }

          return;
        }

        if (event === "answer") {
          const parsed = askResultSchema.safeParse(payload);
          if (!parsed.success) {
            throw new ApiResponseValidationError(path, parsed.error.issues);
          }

          result = parsed.data;
          return;
        }

        if (event === "error") {
          const parsed = apiErrorBodySchema.safeParse(payload);
          const details = parsed.success ? parsed.data : {};
          failure = new ApiError(
            details.message ?? "The assistant could not answer right now. Try again.",
            response.status,
            { code: details.error ?? "ask-failed", body: payload },
          );
        }
      });

      if (failure) {
        throw failure;
      }

      if (!result) {
        throw new ApiNetworkError("The answer stream ended early. Try again.");
      }

      return result;
    },

    updateSectionAsync(caseId, deliverableId, sectionId, update) {
      return requestAsync(
        `${casePath(caseId)}/deliverables/${segment(deliverableId)}/sections/${segment(sectionId)}`,
        deliverableSchema,
        { method: "PATCH", json: sectionUpdateRequestSchema.parse(update) },
      );
    },

    async resolveOpenQuestionAsync(caseId, questionId, note) {
      const response = await requestAsync(
        `${casePath(caseId)}/open-questions/${segment(questionId)}/resolve`,
        openQuestionUpdateResponseSchema,
        {
          method: "POST",
          json: reviewNoteRequestSchema.parse({ note: note?.trim() || undefined }),
        },
      );
      return response.finding;
    },

    async dismissOpenQuestionAsync(caseId, questionId, note) {
      const response = await requestAsync(
        `${casePath(caseId)}/open-questions/${segment(questionId)}/dismiss`,
        openQuestionUpdateResponseSchema,
        {
          method: "POST",
          json: reviewNoteRequestSchema.parse({ note: note?.trim() || undefined }),
        },
      );
      return response.finding;
    },

    approveCaseAsync(caseId, note, acknowledgeIncompleteReview) {
      return requestAsync(`${casePath(caseId)}/approve`, approveCaseResponseSchema, {
        method: "POST",
        json: approveCaseRequestSchema.parse({
          note: note?.trim() || undefined,
          ...(acknowledgeIncompleteReview ? { acknowledgeIncompleteReview: true } : {}),
        }),
      });
    },

    listUsageCasesAsync(usageViewPath, query = {}) {
      const params = new URLSearchParams();
      if (query.cursor) {
        params.set("cursor", query.cursor);
      }

      if (query.limit) {
        params.set("limit", String(query.limit));
      }

      const search = params.size > 0 ? `?${params.toString()}` : "";
      return requestAsync(`${usagePath(usageViewPath)}/cases${search}`, usageCasesResponseSchema);
    },

    getUsageSummaryAsync(usageViewPath) {
      return requestAsync(`${usagePath(usageViewPath)}/summary`, usageSummarySchema);
    },
  };
}
