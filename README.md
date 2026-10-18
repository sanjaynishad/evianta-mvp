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
  connectors/  demo data-source connectors (Tally, Busy, Zoho Books, Shopify, Gmail, Outlook, Google Drive)
```

## Common commands

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm test`
- Scope to one package: `pnpm --filter @evianta/core test`
- `pnpm test:emulators` runs the `*.emulator.test.ts` suites against the Firestore and Storage emulators (needs Java 21; uses the `demo-evianta` project, so no cloud resources are touched)
- Run the web app locally: `pnpm --filter @evianta/web dev`, then open `/design` for the component gallery
- Build the web image from the repo root: `docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_EVIANTA_API_URL=<api url> -t evianta-web .`

## Configuration

Copy `.env.example` to `.env` and set values. `EVIANTA_AI_PROVIDER` selects `googleai` (Gemini Developer API, local dev), `vertexai` (production on Cloud Run), or `mock` (scripted outputs, no network or keys). Tests always use the mock provider.

AI token prices live in [pricing.ts](packages/ai/src/pricing.ts). Costs are calculated per attempt, including failed attempts, then summed across retries. High-tier attempts with more than 200,000 input tokens use $2.50 per million input tokens and $15 per million output tokens, including thinking tokens. `estimateCost` accepts usage for a single attempt, not combined retry usage. Grounding request fees are not included.

Orchestration holds a store-backed per-case lease, renewed every 20 seconds and expiring after 60 seconds if the worker stops. Planning and task-attempt charges are journaled before their work is marked complete. Runs reconcile unapplied charges into case totals atomically and idempotently, including on resume. `retryFailedAsync` can finish accounting for completed work without calling the agents again.

The store reads `GCS_BUCKET` for uploaded file bytes and `FIRESTORE_DATABASE_ID` for the database ID (defaults to `(default)`; a database named `default` is different). `EVIANTA_USAGE_VIEW_PATH` enables the unlisted usage view when set. `FIRESTORE_EMULATOR_HOST` and `STORAGE_EMULATOR_HOST` point the Firestore and Storage clients at local emulators.

The web app talks to `apps/api` at `NEXT_PUBLIC_EVIANTA_API_URL`. When it is unset, the web app runs on built-in fixtures (labeled in the UI) so every page works without the API. The web server also reads `EVIANTA_USAGE_VIEW_PATH` at request time and serves the usage view at `/<path>` (noindex, 404 for any other path).

## Document ingestion

`@evianta/ingest` accepts CSV, TSV, XLSX, XLS, JSON, JSON Lines (`.jsonl`, `.ndjson`), plain text (`.txt`), Markdown (`.md`, `.markdown`), Word (`.docx`), PDF, PNG, JPEG, and WEBP. Convert TIFF and GIF before uploading, preserving multi-page documents as PDFs, and save Word 97-2003 `.doc` files as `.docx` or PDF. Workbooks, delimited text, JSON, and Markdown or Word tables are each limited to 1,000,000 expanded cell slots (workbooks across all sheets, including gaps between populated cells); larger inputs fail with a `DocumentExtractionError`.

JSON is read without a model call. A top-level array becomes one table named after the file, and an array of arrays is read like a sheet with a header row. In a top-level object, each array of records becomes its own table named by its path (for example `data.invoices`), and the remaining scalar fields go into a `<file> fields` table. Nested objects are flattened into dotted columns (`customer.name`) up to five levels; nested arrays and deeper values are kept as compact JSON text. JSON Lines files become one table with one row per line, and invalid lines are skipped with a warning. JSON with no arrays of records is stored as pretty-printed text. Row numbers in evidence count the header as row 1, so the first record is row 2.

Plain text and Markdown are also read without a model call. Their text is split into pages of about 4,000 characters, breaking at a blank line, then a line break, then a space; a form feed always starts a new page. Page text is kept as written apart from line endings, so evidence quotes match it. Markdown is kept as source text, and its pipe tables (outside fenced code) are also read as tables named after the nearest heading above them, with the page they start on. Files that are not valid UTF-8 are decoded as Windows-1252 with a warning.

Word documents are read without a model call or third-party parser: only the main document part is inflated, capped at 64 MB, and its XML is read without entity expansion or DOCTYPE support. Each parsed XML part, including package relationships, is limited to 100,000 elements; larger inputs are rejected before allocating another element. Paragraphs, tabs, line breaks, inserted tracked changes, field results, and text boxes are kept; deleted text and field codes are dropped. Explicit page breaks, "page break before" paragraphs, and the page breaks Word recorded when it last laid out the file start new pages, so page numbers roughly match Word's; long pages are then split like plain text. Tables with at least two rows are also read as tables named after the nearest heading above them, with merged cells left empty, and their rows stay in the page text as tab-separated lines. Headers, footers, footnotes, comments, and list numbering are not read.

If every OCR page that was sent to the model fails, `OcrExtractionError` exposes aggregate `usage`, `cost`, and `pageUsage`. Pages skipped by `maxOcrPages` do not count as extracted. Its `errors` array and `AggregateError` cause retain the original page failures, including their AI error types and retry classification. Partial OCR failures remain in the returned outcome and are not cached.

If OCR reports that the model is not configured or access was denied, no further pages are scheduled. In-flight pages finish, then `OcrConfigurationError` (a subclass of `OcrExtractionError`) is thrown with their combined accounting; its `cause` is the original AI error.

## API

`apps/api` is an Express service. `createApp(deps)` in [app.ts](apps/api/src/app.ts) builds the app from a store, document store, AI client, orchestrator, and config, so tests run it against the in-memory store and the mock provider. `src/index.ts` wires Firestore, Cloud Storage (`GCS_BUCKET`), and the provider from `EVIANTA_AI_PROVIDER`, seeds the agent directory, and listens on `PORT`. Set `FIRESTORE_EMULATOR_HOST`, `STORAGE_EMULATOR_HOST`, and `GOOGLE_CLOUD_PROJECT` to run it against local emulators. `EVIANTA_WEB_ORIGIN` lists the origins allowed by CORS.

There is no auth and no rate limit. The web app sends an anonymous visitor id in `X-Evianta-Visitor`; it scopes `GET /cases` and stamps new cases and copies, but a request that names a case id works for anyone.

| Method and path                                                             | Purpose                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                              | Liveness                                                                                                                        |
| `GET /agents?enabled=true`                                                  | Agent directory: `{ roles, agents }`                                                                                            |
| `GET /agents/:role`                                                         | One agent profile                                                                                                               |
| `POST /cases`                                                               | Create `{ title, description?, useCase?, intakeMode? }` for the visitor (201); `intakeMode` is `chat` or `form`                 |
| `PATCH /cases/:id`                                                          | `{ title?, description?, useCase? }` while the case is not yet planned                                                          |
| `PATCH /cases/:id/intake`                                                   | One intake change: entry mode, enabled data sources, a skipped checklist item, a document assignment, or a clarification answer |
| `GET /cases/:id/messages`                                                   | Chat transcript, oldest first                                                                                                   |
| `POST /cases/:id/messages`                                                  | `{ text, documentIds? }`; streamed assistant reply                                                                              |
| `GET /sources/catalog`                                                      | Data-source connectors and what each can provide                                                                                |
| `GET /sources/connections`, `POST /sources/connections`                     | The visitor's connections; connect a demo account (idempotent per connector)                                                    |
| `DELETE /sources/connections/:connectionId`                                 | Disconnect                                                                                                                      |
| `GET /sources/connections/:connectionId/items`                              | Items a connection can import                                                                                                   |
| `POST /cases/:id/sources/proposals`                                         | `{ action: attach \| dismiss, proposalIds }`; attached items become case documents                                              |
| `POST /cases/:id/sources/import`                                            | Import a browsed item as a case document                                                                                        |
| `GET /cases`                                                                | The visitor's cases, newest first                                                                                               |
| `GET /samples`                                                              | Read-only sample cases                                                                                                          |
| `POST /cases/:id/copy`                                                      | Copy a sample for the visitor (201)                                                                                             |
| `GET /cases/:id`                                                            | Case, tasks, active findings, cited evidence, deliverables, documents with extraction state, cost, and run state                |
| `POST /cases/:id/documents`                                                 | Multipart upload in the `files` field (201); extraction starts in the background                                                |
| `GET /cases/:id/documents/:documentId`                                      | Document state and its full extraction                                                                                          |
| `GET /cases/:id/documents/:documentId/file`                                 | The uploaded bytes                                                                                                              |
| `POST /cases/:id/run`                                                       | Start a run (202 `{ caseId, runId, mode, streamUrl }`, 409 when one is active)                                                  |
| `POST /cases/:id/retry`                                                     | Re-run failed and blocked tasks only (202, 409 `nothing-to-retry`)                                                              |
| `GET /cases/:id/stream`                                                     | Server-sent run events                                                                                                          |
| `GET /cases/:id/deliverables/:deliverableId`                                | One deliverable                                                                                                                 |
| `GET /cases/:id/deliverables/:deliverableId/export?format=docx\|xlsx\|json` | Export with reviewer edits and an evidence appendix                                                                             |
| `PATCH /cases/:id/deliverables/:deliverableId/sections/:sectionId`          | `{ editedContent?, reviewStatus?, reviewComment? }`; `null` clears an edit or comment                                           |
| `POST /cases/:id/open-questions/:questionId/resolve` and `/dismiss`         | `{ note? }`                                                                                                                     |
| `POST /cases/:id/approve`                                                   | `{ note? }`; records the approval with the still-open question ids                                                              |
| `POST /cases/:id/ask`                                                       | `{ question }`; streamed grounded answer                                                                                        |

Uploads accept CSV, TSV, XLSX, XLS, JSON, JSON Lines, TXT, Markdown, DOCX, PDF, PNG, JPEG, and WEBP up to 25 MB each and 10 per request; the content is checked, not just the declared type. Uploads are rejected with 409 while a run is active and once the case has been planned, because later runs reuse completed tasks and would ignore new documents. Documents report `status` (`pending`, `processing`, `ready`, `partial`, or `failed`), a client-safe `error` with an `errorCode` (`unsupported-type`, `ocr-unavailable`, `ocr-failed`, `ocr-partial`, `extraction-failed`, or `read-failed`; provider and parser details are only logged) and, once read, the extraction method, confidence, warnings, and pages needing review. Documents without a stored extraction are extracted again when a run starts. If one still cannot be read for a reason a later attempt may fix (for example OCR being unavailable), the run ends with `run-failed` before it starts; a file that cannot be read at all does not block runs. OCR and Ask usage is added to the case totals.

Errors are JSON `{ error, message }` with a stable `error` code: `invalid-request` (400, with `issues`), `invalid-json`, `visitor-required`, `not-found` (404), `run-in-progress`, `nothing-to-retry`, `upload-in-progress`, `approval-in-progress`, and `case-already-planned` (409), `use-case-missing` and `not-a-sample` (422), `unsupported-media-type` (415), `file-too-large` (413), and `internal-error` (500, never with details). Mutating a sample case returns 409 `{ error: "sample-read-only", reason: "sample-read-only", copyUrl }`.

### Run stream

`GET /cases/:id/stream` sends each `RunEvent` as an SSE frame with `id:` set to the event's per-case `seq`, `event:` set to its `type` (`run-started`, `task-started`, `task-completed`, `task-failed`, `finding-added`, `cost-updated`, `run-completed`, `run-failed`), and `data:` holding the event JSON. It replays persisted events after the cursor, then tails live ones without gaps or duplicates. The cursor is the larger of the `Last-Event-ID` header (sent by `EventSource` on reconnect) and `?after=<seq>`; `GET /cases/:id` returns `run.lastEventSeq` for a fresh subscription, plus `run.lastRunMode` and, after a failure, `run.lastRunError`. Comment frames keep the connection alive every 15 seconds. The server closes the stream after a terminal event (`run-completed` or `run-failed`) once no run is active, so clients should close their `EventSource` on a terminal event to stop automatic reconnects. Every accepted run ends with a terminal event, including runs that fail before they start.

Section content edits, including restoring the original content, clear case approval in the same store operation. Approval requests, section edits, and export snapshot reads share a per-case guard, so an export cannot combine replacement content with an earlier approval. XLSX amounts with more than 15 significant digits across the integer and fractional parts remain text. Text longer than Excel's 32,767-character cell limit continues in subsequent rows in the same column, without truncation; blank cells in other columns indicate continuation.

### Ask stream

`POST /cases/:id/ask` answers with `text/event-stream`: one or more `answer-delta` frames with `{ text }` chunks, then one `answer` frame with the full `AskCaseResult` from `@evianta/agents` (`status` `answered` with `answer`, `evidenceIds`, `findingIds`, and `evidence`, or `not-supported` with `message` and `canFlagForReview`). A failure sends a single `error` frame `{ error: "ask-failed", message }`. Validation and not-found errors are returned as JSON before the stream starts.

Run cost updates and terminal events read reconciled case totals, including Ask charges recorded during the run. Run-only usage and cost remain separate. Unexpected run preflight failures use a generic message in SSE and `run.lastRunError`; internal diagnostics are logged, while document-unavailable errors retain their retry guidance.

### Chat stream

`POST /cases/:id/messages` answers with `text/event-stream`: a `user-message` frame with the stored user message, `reply-delta` frames with `{ text }` chunks, then one `reply` frame with `{ message, case }`. A failure sends a single `error` frame. While the case is gathering inputs, a cheap-tier intake agent identifies the kind of work and asks for the checklist items, details, and data-source items it still needs; a rules layer owns the checklist and replies when the model is unavailable. During a run the reply is a short status note, and after delivery questions go to grounded Ask. An off-topic request gets a polite decline and the supported kinds of work. `POST /cases/:id/run` returns 422 `use-case-missing` until the kind of work is set, then records the submit in the transcript.

### Data sources

Connectors live in `@evianta/connectors` and all run in demo mode: connecting simulates consent, and imports return deterministic synthetic files. Connections are scoped by visitor. When a case turns sources on, the intake proposes items whose datasets satisfy missing checklist items; attaching or importing stores them through the same path as uploads, with `provenance` on the document. Responses call these files evidence; the origin appears only as an `Imported from` detail.

### Usage view

When `EVIANTA_USAGE_VIEW_PATH` is set, `GET /<path>/cases?limit=&cursor=` lists every case (newest first) with metadata, document and run counts, tokens, and cost, and `GET /<path>/summary` returns totals overall, per use case, and per entry mode (chat or guided setup). Responses carry `X-Robots-Tag: noindex` and contain no document contents or links. The path is obscurity, not authentication; when it is unset or wrong, the response is a plain 404.

### Cloud Run

The [deployment workflow](.github/workflows/deploy-cloud-run.yml) builds and deploys both the API and web app. Pushes to `main` deploy to development. For a manual deployment, select a branch and choose `development` or `production` in the environment dropdown (default: `production`). The selected GitHub environment supplies deployment variables, secrets, and protection rules. Development defaults to the `evianta-api-dev` and `evianta-web-dev` services and the `evianta-dev` Firestore database; production defaults to `evianta-api`, `evianta-web`, and `(default)`. Environment variables can override these defaults. Branches targeting the same environment share services and data, and deployments to that environment are serialized. Check CI before starting a deployment; the workflow does not wait for it.

Deployments update stable service names without rotating URLs or deleting services. For a one-time URL rotation, manually choose new service names, set `CLOUD_RUN_SERVICE` and `CLOUD_RUN_WEB_SERVICE` in the target GitHub environment, deploy, and retire the old services separately. The workflow masks service URLs and image references in action logs and omits them from the job summary; retrieve the current endpoints from Cloud Run when needed. The web image uses Next.js standalone output, with static assets copied into `apps/web/.next/static` alongside the traced server. Static export is not used because case routes and the usage view require a server. The workflow builds the web app with the deployed API URL and configures API CORS with the deployed web origin.

Store additional allowed web origins in the `EVIANTA_WEB_ORIGIN` GitHub environment secret, not a variable, so they are masked before steps start. The deployed web origin is discovered automatically.

Both services are private by default. Direct browser access requires `CLOUD_RUN_ALLOW_UNAUTHENTICATED=true`; the frontend does not send Cloud Run identity tokens. Public access requires an explicit opt-in because the API has no authentication or rate limiting. The workflow uses Vertex AI and keyless Workload Identity Federation; no service account JSON key or Gemini API key is required.

A run keeps going after `POST /cases/:id/run` returns and the stream shares in-process state with it, so the workflow uses a one-hour request timeout, CPU outside requests, and one minimum and maximum instance. This incurs idle compute charges. Instances can still restart, and revisions can overlap during deployment. Deploy only when no runs or extractions are active. Persisted events can be replayed after a restart, but in-flight work is not automatically recovered.

## Data analysis (use case A)

The `business-data-analyst` task analyzes the case's spreadsheet in plain TypeScript before any model call: it infers column roles, runs data-quality checks (duplicates, missing values, type mismatches, negative and out-of-range values, mixed date formats), computes totals, averages, monthly changes, a Theil-Sen trend, and segment shares, and flags months whose robust z-score against the trend exceeds 3.5. One mid-tier call receives only these aggregates and five sample rows, and writes the narrative with `{{metric-id}}` placeholders that are replaced with the computed values; any other figure it states is flagged as an open question. The task produces a report deliverable and a dashboard deliverable whose chart sections hold `ChartSpec` JSON from `@evianta/core`. Every finding cites the cell ranges it was computed from.

Mixed date formats are only detectable when ingestion keeps the column as text; columns that ingestion normalizes to ISO dates are treated as consistent.

Column display names are limited to 64 characters in prompts and reports, with distinct suffixes for truncated names. Original headers remain available for role inference, currency detection, and source mapping. Narrative amounts with leading or trailing currency markers must match the data's denomination.
