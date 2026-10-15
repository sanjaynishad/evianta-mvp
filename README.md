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
  core/    domain model and Zod schemas
  ai/      Genkit setup and Gemini/Gemma provider selection
  agents/  coordinator, specialist, and verification agents
  store/   Firestore data access
```

## Common commands

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`, `pnpm test`
- Scope to one package: `pnpm --filter @evianta/core test`

## Configuration

Copy `.env.example` to `.env` and set values. `EVIANTA_AI_PROVIDER` selects `googleai` (Gemini Developer API, local dev) or `vertexai` (production on Cloud Run).
