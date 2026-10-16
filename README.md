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
