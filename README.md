# Evianta

## Requirements

- Node 22 LTS
- pnpm 9 (`corepack enable`)

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

## Workspace layout

```
apps/
  api/   HTTP service for Cloud Run (Express + Genkit)
  web/   Next.js workspace UI with the Evidence Atlas design system
packages/
  config/  shared TypeScript config
  env/     environment variables as typed constants
  core/    domain model and Zod schemas
  ai/      model tiers, structured runs, grounding, cost accounting, and a mock provider
  agents/  coordinator, specialist, and verification agents
  store/   Firestore repositories and Cloud Storage document store
  ingest/  spreadsheet parsing, PDF text extraction, and per-page OCR
```

## Common commands

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm test`
- Scope to one package: `pnpm --filter @evianta/core test`
- `pnpm test:emulators` runs the `*.emulator.test.ts` suites against the Firestore and Storage emulators (needs Java 21; uses the `demo-evianta` project, so no cloud resources are touched)
- Run the web app locally: `pnpm --filter @evianta/web dev`, then open `/design` for the component gallery

## Configuration

Copy `.env.example` to `.env` and set values. `EVIANTA_AI_PROVIDER` selects `googleai` (Gemini Developer API, local dev), `vertexai` (production on Cloud Run), or `mock` (scripted outputs, no network or keys). Tests always use the mock provider.

AI token prices live in [pricing.ts](packages/ai/src/pricing.ts). Costs are calculated per attempt, including failed attempts, then summed across retries. High-tier attempts with more than 200,000 input tokens use $2.50 per million input tokens and $15 per million output tokens, including thinking tokens. `estimateCost` accepts usage for a single attempt, not combined retry usage. Grounding request fees are not included.

Orchestration holds a store-backed per-case lease, renewed every 20 seconds and expiring after 60 seconds if the worker stops. Planning and task-attempt charges are journaled before their work is marked complete. Runs reconcile unapplied charges into case totals atomically and idempotently, including on resume. `retryFailedAsync` can finish accounting for completed work without calling the agents again.

The store reads `GCS_BUCKET` for uploaded file bytes. `EVIANTA_USAGE_VIEW_PATH` enables the unlisted usage view when set. `FIRESTORE_EMULATOR_HOST` and `STORAGE_EMULATOR_HOST` point the Firestore and Storage clients at local emulators.

## Document ingestion

`@evianta/ingest` accepts CSV, TSV, XLSX, XLS, PDF, PNG, JPEG, and WEBP. Convert TIFF and GIF before uploading, preserving multi-page documents as PDFs. Workbooks and delimited text are each limited to 1,000,000 expanded cell slots (workbooks across all sheets, including gaps between populated cells); larger inputs fail with a `DocumentExtractionError`.

If every OCR page that was sent to the model fails, `OcrExtractionError` exposes aggregate `usage`, `cost`, and `pageUsage`. Pages skipped by `maxOcrPages` do not count as extracted. Its `errors` array and `AggregateError` cause retain the original page failures, including their AI error types and retry classification. Partial OCR failures remain in the returned outcome and are not cached.

If OCR reports that the model is not configured or access was denied, no further pages are scheduled. In-flight pages finish, then `OcrConfigurationError` (a subclass of `OcrExtractionError`) is thrown with their combined accounting; its `cause` is the original AI error.

## API

`apps/api` is an Express service. `createApp(deps)` in [app.ts](apps/api/src/app.ts) builds the app from a store, document store, AI client, orchestrator, and config, so tests run it against the in-memory store and the mock provider. `src/index.ts` wires Firestore, Cloud Storage (`GCS_BUCKET`), and the provider from `EVIANTA_AI_PROVIDER`, seeds the agent directory, and listens on `PORT`. Set `FIRESTORE_EMULATOR_HOST`, `STORAGE_EMULATOR_HOST`, and `GOOGLE_CLOUD_PROJECT` to run it against local emulators. `EVIANTA_WEB_ORIGIN` lists the origins allowed by CORS.

There is no auth and no rate limit. The web app sends an anonymous visitor id in `X-Evianta-Visitor`; it scopes `GET /cases` and stamps new cases and copies, but a request that names a case id works for anyone.

| Method and path                                                             | Purpose                                                                                                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                              | Liveness                                                                                                         |
| `GET /agents?enabled=true`                                                  | Agent directory: `{ roles, agents }`                                                                             |
| `GET /agents/:role`                                                         | One agent profile                                                                                                |
| `POST /cases`                                                               | Create `{ title, description?, useCase }` for the visitor (201)                                                  |
| `GET /cases`                                                                | The visitor's cases, newest first                                                                                |
| `GET /samples`                                                              | Read-only sample cases                                                                                           |
| `POST /cases/:id/copy`                                                      | Copy a sample for the visitor (201)                                                                              |
| `GET /cases/:id`                                                            | Case, tasks, active findings, cited evidence, deliverables, documents with extraction state, cost, and run state |
| `POST /cases/:id/documents`                                                 | Multipart upload in the `files` field (201); extraction starts in the background                                 |
| `GET /cases/:id/documents/:documentId`                                      | Document state and its full extraction                                                                           |
| `GET /cases/:id/documents/:documentId/file`                                 | The uploaded bytes                                                                                               |
| `POST /cases/:id/run`                                                       | Start a run (202 `{ caseId, runId, mode, streamUrl }`, 409 when one is active)                                   |
| `POST /cases/:id/retry`                                                     | Re-run failed and blocked tasks only (202, 409 `nothing-to-retry`)                                               |
| `GET /cases/:id/stream`                                                     | Server-sent run events                                                                                           |
| `GET /cases/:id/deliverables/:deliverableId`                                | One deliverable                                                                                                  |
| `GET /cases/:id/deliverables/:deliverableId/export?format=docx\|xlsx\|json` | Export with reviewer edits and an evidence appendix                                                              |
| `PATCH /cases/:id/deliverables/:deliverableId/sections/:sectionId`          | `{ editedContent?, reviewStatus?, reviewComment? }`; `null` clears an edit or comment                            |
| `POST /cases/:id/open-questions/:questionId/resolve` and `/dismiss`         | `{ note? }`                                                                                                      |
| `POST /cases/:id/approve`                                                   | `{ note? }`; records the approval with the still-open question ids                                               |
| `POST /cases/:id/ask`                                                       | `{ question }`; streamed grounded answer                                                                         |

Uploads accept CSV, TSV, XLSX, XLS, PDF, PNG, JPEG, and WEBP up to 25 MB each and 10 per request; the content is checked, not just the declared type. Uploads are rejected with 409 while a run is active and once the case has been planned, because later runs reuse completed tasks and would ignore new documents. Documents report `status` (`pending`, `processing`, `ready`, `partial`, or `failed`), a client-safe `error` with an `errorCode` (`unsupported-type`, `ocr-unavailable`, `ocr-failed`, `ocr-partial`, `extraction-failed`, or `read-failed`; provider and parser details are only logged) and, once read, the extraction method, confidence, warnings, and pages needing review. Documents without a stored extraction are extracted again when a run starts. If one still cannot be read for a reason a later attempt may fix (for example OCR being unavailable), the run ends with `run-failed` before it starts; a file that cannot be read at all does not block runs. OCR and Ask usage is added to the case totals.

Errors are JSON `{ error, message }` with a stable `error` code: `invalid-request` (400, with `issues`), `invalid-json`, `visitor-required`, `not-found` (404), `run-in-progress`, `nothing-to-retry`, `upload-in-progress`, `approval-in-progress`, and `case-already-planned` (409), `use-case-missing` and `not-a-sample` (422), `unsupported-media-type` (415), `file-too-large` (413), and `internal-error` (500, never with details). Mutating a sample case returns 409 `{ error: "sample-read-only", reason: "sample-read-only", copyUrl }`.

### Run stream

`GET /cases/:id/stream` sends each `RunEvent` as an SSE frame with `id:` set to the event's per-case `seq`, `event:` set to its `type` (`run-started`, `task-started`, `task-completed`, `task-failed`, `finding-added`, `cost-updated`, `run-completed`, `run-failed`), and `data:` holding the event JSON. It replays persisted events after the cursor, then tails live ones without gaps or duplicates. The cursor is the larger of the `Last-Event-ID` header (sent by `EventSource` on reconnect) and `?after=<seq>`; `GET /cases/:id` returns `run.lastEventSeq` for a fresh subscription, plus `run.lastRunMode` and, after a failure, `run.lastRunError`. Comment frames keep the connection alive every 15 seconds. The server closes the stream after a terminal event (`run-completed` or `run-failed`) once no run is active, so clients should close their `EventSource` on a terminal event to stop automatic reconnects. Every accepted run ends with a terminal event, including runs that fail before they start.

### Ask stream

`POST /cases/:id/ask` answers with `text/event-stream`: one or more `answer-delta` frames with `{ text }` chunks, then one `answer` frame with the full `AskCaseResult` from `@evianta/agents` (`status` `answered` with `answer`, `evidenceIds`, `findingIds`, and `evidence`, or `not-supported` with `message` and `canFlagForReview`). A failure sends a single `error` frame `{ error: "ask-failed", message }`. Validation and not-found errors are returned as JSON before the stream starts.

### Usage view

When `EVIANTA_USAGE_VIEW_PATH` is set, `GET /<path>/cases?limit=&cursor=` lists every case (newest first) with metadata, document and run counts, tokens, and cost, and `GET /<path>/summary` returns totals overall and per use case. Responses carry `X-Robots-Tag: noindex` and contain no document contents or links. The path is obscurity, not authentication; when it is unset or wrong, the response is a plain 404.

### Cloud Run

Build from the repository root: `docker build -f apps/api/Dockerfile -t evianta-api .`. A run keeps going after `POST /run` returns and the stream shares in-process state with it, so deploy with a long request timeout, CPU outside requests, and a single instance:

```bash
gcloud run deploy evianta-api --image <image> --timeout=3600 --no-cpu-throttling \
  --min-instances=1 --max-instances=1 \
  --set-env-vars=EVIANTA_AI_PROVIDER=vertexai,GOOGLE_CLOUD_PROJECT=<project>,GCS_BUCKET=<bucket>,EVIANTA_WEB_ORIGIN=<web origin> \
  --set-secrets=GEMINI_API_KEY=gemini-api-key:latest,EVIANTA_USAGE_VIEW_PATH=usage-view-path:latest
```

`GEMINI_API_KEY` is only needed with `googleai`; Vertex AI uses the service account. Because events are persisted, a client that reconnects after a restart still replays the whole run.
