# Build and run from the monorepo root as the Docker context:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_EVIANTA_API_URL=https://api.example.com -t evianta-web .
# Without NEXT_PUBLIC_EVIANTA_API_URL the app runs on built-in fixtures.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS build
ARG NEXT_PUBLIC_EVIANTA_API_URL=""
ENV NEXT_PUBLIC_EVIANTA_API_URL=$NEXT_PUBLIC_EVIANTA_API_URL
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@evianta/web..." build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
