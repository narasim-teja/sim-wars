# sim-engine — Bun runtime image for the API/WS server and sim worker.
# Dev image first; switch to --target=runtime for slim production.

FROM oven/bun:1.3-alpine AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS runtime
COPY src ./src
COPY scenarios ./scenarios
COPY scripts ./scripts
COPY tsconfig.json ./

# .local/runs is where per-sim artifacts land; mount a volume at this path
# in prod so they survive container restarts.
RUN mkdir -p .local/runs
VOLUME ["/app/.local/runs"]

ENV NODE_ENV=production
EXPOSE 8787
CMD ["bun", "run", "src/api/server.ts"]
