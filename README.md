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
  web/   frontend placeholder (scaffold pending design)
packages/
  config/  shared TypeScript config
  env/     environment variables as typed constants
  core/    domain model and Zod schemas
  ai/      model tiers, structured runs, grounding, cost accounting, and a mock provider
  agents/  coordinator, specialist, and verification agents
  store/   Firestore repositories and Cloud Storage document store
```

## Common commands

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm test`
- Scope to one package: `pnpm --filter @evianta/core test`
- `pnpm test:emulators` runs the `*.emulator.test.ts` suites against the Firestore and Storage emulators (needs Java 21; uses the `demo-evianta` project, so no cloud resources are touched)

## Configuration

Copy `.env.example` to `.env` and set values. `EVIANTA_AI_PROVIDER` selects `googleai` (Gemini Developer API, local dev), `vertexai` (production on Cloud Run), or `mock` (scripted outputs, no network or keys). Tests always use the mock provider.

The store reads `GCS_BUCKET` for uploaded file bytes. `EVIANTA_USAGE_VIEW_PATH` enables the unlisted usage view when set. `FIRESTORE_EMULATOR_HOST` and `STORAGE_EMULATOR_HOST` point the Firestore and Storage clients at local emulators.
