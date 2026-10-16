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

  it("turns a 409 sample-read-only response into a typed error with an absolute copy URL", async () => {
    const { client } = createClient(
      jsonResponse({ reason: "sample-read-only", copyUrl: "/cases/sample-a/copy" }, 409),
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
      jsonResponse({ reason: "run-in-progress", message: "Busy" }, 409),
    );

    const error = await client.startRunAsync("case-1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SampleReadOnlyError);
    expect((error as ApiError).reason).toBe("run-in-progress");
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
      gcsPath: "cases/case-1/doc-1",
      uploadedAt: now,
      processing: { status: "queued" },
    };
    const { client, fetchMock } = createClient(jsonResponse(document, 201));

    const result = await client.uploadDocumentAsync("case-1", new File(["data"], "ledger.xlsx"));

    const request = requestOf(fetchMock);
    expect(request.url).toBe("https://api.example.test/cases/case-1/documents");
    expect(request.init.body).toBeInstanceOf(FormData);
    expect((request.init.body as FormData).get("file")).toBeInstanceOf(File);
    expect(request.headers.get("Content-Type")).toBeNull();
    expect(result.processing?.status).toBe("queued");
  });

  it("builds endpoint paths for review actions and exports", async () => {
    const question = { id: "q 1", text: "Confirm", severity: "high", status: "resolved" };
    const { client, fetchMock } = createClient(jsonResponse(question));

    await client.resolveOpenQuestionAsync("case-1", "q 1", "Checked");

    const request = requestOf(fetchMock);
    expect(request.url).toBe("https://api.example.test/cases/case-1/open-questions/q%201/resolve");
    expect(JSON.parse(String(request.init.body))).toEqual({ note: "Checked" });
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
});
