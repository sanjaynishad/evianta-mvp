import {
  agentDirectoryResponseSchema,
  agentProfileSchema,
  apiErrorBodySchema,
  askRequestSchema,
  askResponseSchema,
  caseDocumentSchema,
  caseListResponseSchema,
  caseSchema,
  caseStateSchema,
  createCaseRequestSchema,
  deliverableSchema,
  deliverableSectionSchema,
  openQuestionSchema,
  reviewNoteRequestSchema,
  runStartResponseSchema,
  sampleReadOnlyErrorBodySchema,
  sectionUpdateRequestSchema,
  usageCasesResponseSchema,
  usageSummarySchema,
  visitorHeaderName,
  type AgentRole,
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
}

export type ApiClient = CaseDataSource;

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
    const message =
      details.message ?? details.error ?? `The request failed with status ${status}. Try again.`;
    return new ApiError(message, status, { reason: details.reason, body });
  }

  async function requestAsync<T>(
    path: string,
    schema: ResponseSchema<T>,
    request: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
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

    const payload = await readBodyAsync(response);
    if (!response.ok) {
      throw toApiError(response.status, payload);
    }

    const parsed = schema.safeParse(payload);
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

    uploadDocumentAsync(caseId, file, uploadOptions = {}) {
      const formData = new FormData();
      formData.append("file", file, file.name);
      return requestAsync(`${casePath(caseId)}/documents`, caseDocumentSchema, {
        method: "POST",
        formData,
        signal: uploadOptions.signal,
      });
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

    askAsync(caseId, question) {
      return requestAsync(`${casePath(caseId)}/ask`, askResponseSchema, {
        method: "POST",
        json: askRequestSchema.parse({ question }),
      });
    },

    updateSectionAsync(caseId, deliverableId, sectionId, update) {
      return requestAsync(
        `${casePath(caseId)}/deliverables/${segment(deliverableId)}/sections/${segment(sectionId)}`,
        deliverableSectionSchema,
        { method: "PATCH", json: sectionUpdateRequestSchema.parse(update) },
      );
    },

    resolveOpenQuestionAsync(caseId, questionId, note) {
      return requestAsync(
        `${casePath(caseId)}/open-questions/${segment(questionId)}/resolve`,
        openQuestionSchema,
        { method: "POST", json: reviewNoteRequestSchema.parse({ note }) },
      );
    },

    dismissOpenQuestionAsync(caseId, questionId, note) {
      return requestAsync(
        `${casePath(caseId)}/open-questions/${segment(questionId)}/dismiss`,
        openQuestionSchema,
        { method: "POST", json: reviewNoteRequestSchema.parse({ note }) },
      );
    },

    approveCaseAsync(caseId, note) {
      return requestAsync(`${casePath(caseId)}/approve`, caseSchema, {
        method: "POST",
        json: reviewNoteRequestSchema.parse({ note }),
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
