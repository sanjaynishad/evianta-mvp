import { describe, expect, it, vi } from "vitest";
import { sampleCaseStates } from "@/fixtures";
import { createApiClient } from "./client";
import {
  ApiError,
  ApiNetworkError,
  ApiResponseValidationError,
  SampleReadOnlyError,
  isSampleReadOnlyError,
} from "./errors";

const visitorId = "0b7c6a8e-3f1d-4c2a-9e5b-7d8f9a0b1c2d";
const now = "2026-10-01T10:00:00.000Z";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createClient(response: Response | (() => Promise<Response>)) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    typeof response === "function" ? response() : response.clone(),
  );
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: fetchMock,
    getVisitorId: () => visitorId,
  });
  return { client, fetchMock };
}

function requestOf(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] ?? [];
  return { url: String(url), init: init ?? {}, headers: new Headers(init?.headers) };
}

describe("createApiClient", () => {
  it("sends the visitor header and validates the case list", async () => {
    const sample = sampleCaseStates[0]!.case;
    const { client, fetchMock } = createClient(jsonResponse({ cases: [sample] }));

    const cases = await client.listCasesAsync();

    const request = requestOf(fetchMock);
    expect(request.url).toBe("https://api.example.test/cases");
    expect(request.headers.get("X-Evianta-Visitor")).toBe(visitorId);
    expect(request.headers.get("Accept")).toBe("application/json");
    expect(cases).toEqual([sample]);
  });

  it("posts a validated case body and parses the created case", async () => {
    const created = {
      id: "case-1",
      title: "Sales",
      useCase: "data-analysis",
      createdAt: now,
      updatedAt: now,
    };
    const { client, fetchMock } = createClient(jsonResponse(created, 201));

    const result = await client.createCaseAsync({ title: "  Sales  ", useCase: "data-analysis" });

    const request = requestOf(fetchMock);
    expect(request.init.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(request.init.body))).toEqual({
      title: "Sales",
      useCase: "data-analysis",
    });
    expect(result.status).toBe("draft");
  });

  it("parses a full case state with schema defaults", async () => {
    const { client } = createClient(jsonResponse({ case: sampleCaseStates[1]!.case }));

    const state = await client.getCaseStateAsync("sample-tax-notice");

    expect(state.tasks).toEqual([]);
    expect(state.documents).toEqual([]);
  });

  it("rejects responses that do not match the schema", async () => {
    const { client } = createClient(jsonResponse({ cases: [{ id: 1 }] }));

    await expect(client.listSamplesAsync()).rejects.toBeInstanceOf(ApiResponseValidationError);
  });

  it("reads a document with its extraction and builds the file URL", async () => {
    const document = sampleCaseStates[1]!.documents[0]!;
    const { client, fetchMock } = createClient(
      jsonResponse({
        document,
        extraction: {
          documentId: document.id,
          kind: "text",
          method: "pdf-text",
          confidence: 0.98,
          pages: [{ index: 2, text: "Difference 12,400", method: "pdf-text", confidence: 0.98 }],
        },
      }),
    );

    const detail = await client.getDocumentAsync("sample tax", document.id);

    expect(requestOf(fetchMock).url).toBe(
      `https://api.example.test/cases/sample%20tax/documents/${document.id}`,
    );
    expect(detail.extraction?.pages[0]?.index).toBe(2);
    expect(client.getDocumentFileUrl("sample tax", "doc/1")).toBe(
      "https://api.example.test/cases/sample%20tax/documents/doc%2F1/file",
    );
  });

  it("turns a 409 sample-read-only response into a typed error with an absolute copy URL", async () => {
    const { client } = createClient(
      jsonResponse(
        {
          error: "sample-read-only",
          message: "Sample cases are read-only. Copy the case to work on it.",
          reason: "sample-read-only",
          copyUrl: "/cases/sample-a/copy",
        },
        409,
      ),
    );

    const error = await client.startRunAsync("sample-a").catch((caught: unknown) => caught);

    expect(isSampleReadOnlyError(error)).toBe(true);
    expect((error as SampleReadOnlyError).status).toBe(409);
    expect((error as SampleReadOnlyError).copyUrl).toBe(
      "https://api.example.test/cases/sample-a/copy",
    );
  });

  it("keeps other 409 responses as plain API errors", async () => {
    const { client } = createClient(
      jsonResponse({ error: "run-in-progress", message: "Busy" }, 409),
    );

    const error = await client.startRunAsync("case-1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SampleReadOnlyError);
    expect((error as ApiError).code).toBe("run-in-progress");
    expect((error as ApiError).message).toBe("Busy");
  });

  it("reports network failures", async () => {
    const { client } = createClient(() => Promise.reject(new TypeError("fetch failed")));

    await expect(client.listCasesAsync()).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it("uploads documents as multipart form data", async () => {
    const document = {
      id: "doc-1",
      caseId: "case-1",
      name: "ledger.xlsx",
      mimeType: "application/vnd.ms-excel",
      size: 4,
      uploadedAt: now,
      status: "pending",
    };
    const { client, fetchMock } = createClient(jsonResponse({ documents: [document] }, 201));

    const result = await client.uploadDocumentAsync("case-1", new File(["data"], "ledger.xlsx"));

    const request = requestOf(fetchMock);
    expect(request.url).toBe("https://api.example.test/cases/case-1/documents");
    expect(request.init.body).toBeInstanceOf(FormData);
    expect((request.init.body as FormData).get("files")).toBeInstanceOf(File);
    expect(request.headers.get("Content-Type")).toBeNull();
    expect(result.status).toBe("pending");
  });

  it("builds endpoint paths for review actions and exports", async () => {
    const finding = sampleCaseStates[1]!.findings[0]!;
    const { client, fetchMock } = createClient(jsonResponse({ finding }));

    const result = await client.resolveOpenQuestionAsync("case-1", "q 1", "Checked");

    const request = requestOf(fetchMock);
    expect(request.url).toBe("https://api.example.test/cases/case-1/open-questions/q%201/resolve");
    expect(JSON.parse(String(request.init.body))).toEqual({ note: "Checked" });
    expect(result.id).toBe(finding.id);
    expect(client.getExportUrl("case-1", "d-1", "docx")).toBe(
      "https://api.example.test/cases/case-1/deliverables/d-1/export?format=docx",
    );
  });

  it("reads the usage view under the configured path", async () => {
    const { client, fetchMock } = createClient(jsonResponse({ cases: [], nextCursor: "abc" }));

    const result = await client.listUsageCasesAsync("/secret-path/", { cursor: "xyz" });

    expect(requestOf(fetchMock).url).toBe("https://api.example.test/secret-path/cases?cursor=xyz");
    expect(result.nextCursor).toBe("abc");
  });

  it("parses the 202 run start response", async () => {
    const { client, fetchMock } = createClient(
      jsonResponse(
        { caseId: "case-1", runId: "run-7", mode: "run", streamUrl: "/cases/case-1/stream" },
        202,
      ),
    );

    const started = await client.startRunAsync("case-1");

    expect(requestOf(fetchMock).url).toBe("https://api.example.test/cases/case-1/run");
    expect(started.runId).toBe("run-7");
  });

  it("returns the approved case with the questions left open", async () => {
    const approved = { ...sampleCaseStates[0]!.case, status: "completed" };
    const { client, fetchMock } = createClient(
      jsonResponse({ case: approved, unresolvedQuestions: [] }),
    );

    const result = await client.approveCaseAsync("case-1", "  ");

    expect(result.case.status).toBe("completed");
    expect(result.unresolvedQuestions).toEqual([]);
    expect(JSON.parse(String(requestOf(fetchMock).init?.body))).toEqual({});
  });

  it("sends an explicit incomplete-review acknowledgement with approval", async () => {
    const approved = {
      ...sampleCaseStates[0]!.case,
      status: "completed",
      approval: {
        approvedAt: "2026-10-18T00:00:00.000Z",
        unresolvedQuestionIds: [],
        reviewFailureAcknowledged: true,
      },
    };
    const { client, fetchMock } = createClient(
      jsonResponse({ case: approved, unresolvedQuestions: [] }),
    );

    const result = await client.approveCaseAsync("case-1", undefined, true);

    expect(result.case.approval?.reviewFailureAcknowledged).toBe(true);
    expect(JSON.parse(String(requestOf(fetchMock).init?.body))).toEqual({
      acknowledgeIncompleteReview: true,
    });
  });

  it("streams an answer from the ask endpoint", async () => {
    const frames = [
      ": connected\n\n",
      'event: answer-delta\ndata: {"text":"The gap "}\n\n',
      'event: answer-delta\ndata: {"text":"is TDS."}\n\n',
      `event: answer\ndata: ${JSON.stringify({
        status: "answered",
        answer: "The gap is TDS.",
        evidenceIds: ["ev-1"],
        findingIds: ["f-1"],
        evidence: [],
      })}\n\n`,
    ].join("");
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-frame to exercise chunk reassembly.
        controller.enqueue(encoder.encode(frames.slice(0, 40)));
        controller.enqueue(encoder.encode(frames.slice(40)));
        controller.close();
      },
    });
    const { client, fetchMock } = createClient(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    );
    const deltas: string[] = [];

    const result = await client.askAsync("case-1", "Why the gap?", {
      onDelta: (text) => deltas.push(text),
    });

    const request = requestOf(fetchMock);
    expect(request.headers.get("Accept")).toBe("text/event-stream");
    expect(JSON.parse(String(request.init.body))).toEqual({ question: "Why the gap?" });
    expect(deltas.join("")).toBe("The gap is TDS.");
    expect(result.status === "answered" && result.findingIds).toEqual(["f-1"]);
  });

  it("raises the ask stream's error frame", async () => {
    const { client } = createClient(
      new Response('event: error\ndata: {"error":"ask-failed","message":"Try again later."}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const error = await client.askAsync("case-1", "Why?").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ask-failed");
    expect((error as ApiError).message).toBe("Try again later.");
  });
});
