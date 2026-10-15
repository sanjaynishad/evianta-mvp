# Evianta Coding Agent Preferences

## Coding preferences

- Do not use em dashes.
- Avoid unnecessary code comments and docstrings. Add them only when they are essential to explain non-obvious behavior or a required constraint.
- Use clear, descriptive names so comments are not needed to explain what a variable or function represents.
- Do not add SEO-focused copy or metadata intended to improve this repository's discoverability.
- Follow the user's established coding patterns and the conventions already present in the relevant files. Prefer the smallest focused change.
- In JavaScript and TypeScript, use braces for all `if`, `else`, `for`, and `while` blocks, including single-statement blocks.
- In JavaScript and TypeScript, leave a blank line after a completed block before the next statement, unless the next line closes an enclosing block or ends the file.
- Preserve existing behavior and public APIs unless the task requires changing them. Do not alter unrelated work.
- Validate changes with the narrowest relevant test, lint, or type-check command available, and report checks that could not be run.

## Tech stack

- Monorepo: pnpm workspaces + Turborepo. Language: TypeScript (strict, ESM). Runtime: Node 22 LTS.
- Quality: ESLint 9 (flat config) + typescript-eslint, Prettier 3, Vitest, Husky + lint-staged, commitlint (conventional commits).
- AI: Google Genkit with Gemini models. Provider is chosen at runtime by `EVIANTA_AI_PROVIDER`: `googleai` (Gemini Developer API, local dev) or `vertexai` (Vertex AI, production). Gemma is used where a smaller or open model fits.
- Data: Firestore via `firebase-admin`.
- Deployment: container images on Google Cloud Run. `apps/api` has a Dockerfile; build with the repo root as context.

## Project structure

- `apps/api` - HTTP service deployed to Cloud Run (Express + Genkit entry point).
- `apps/web` - frontend placeholder; full framework scaffold is deferred until design is ready.
- `packages/config` - shared `tsconfig.base.json` extended by every package.
- `packages/core` - domain model and Zod schemas (`Case`, `Task`, `Finding`, `Evidence`, `Deliverable`, `AgentRole`). No runtime side effects.
- `packages/ai` - Genkit initialization and Gemini/Gemma provider selection.
- `packages/agents` - coordinator, specialist, and verification agent definitions.
- `packages/store` - Firestore and document-storage data access.

Where new code goes:

- Shared types and schemas belong in `packages/core`; depend on it instead of redefining shapes.
- Agent and orchestration logic belongs in `packages/agents`; model access goes through `packages/ai`.
- Persistence belongs in `packages/store`; do not call Firestore directly from apps.
- Workspace packages are named `@evianta/<name>` and reference each other with `workspace:*`.

## Commands

- `pnpm install` - install the workspace.
- `pnpm lint` / `pnpm lint:fix` - ESLint across the repo.
- `pnpm format` / `pnpm format:check` - Prettier.
- `pnpm typecheck` - type-check every package (Turborepo).
- `pnpm build` - build every package (Turborepo).
- `pnpm test` - run Vitest across packages.
- Scope to one package with a filter, for example `pnpm --filter @evianta/core test`.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
