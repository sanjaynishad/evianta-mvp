# Build and run from the monorepo root as the Docker context:
#   docker build -f apps/api/Dockerfile -t evianta-api .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @evianta/api build
RUN pnpm --filter @evianta/api deploy --prod /app/out

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/out /app
EXPOSE 8080
CMD ["node", "dist/index.js"]
