# SIMWARS production image — single container with three processes.
#
#   Caddy (:8080)  → reverse proxy. App Runner exposes this to the world.
#     ├ /api/*, /ws/*    → Bun on :8787 (sim-engine API + spawned workers)
#     └ /*               → Node on :3000 (Next.js production server)
#
# Build for AWS App Runner (linux/amd64) with:
#   docker buildx build --platform linux/amd64 -t simwars:latest .

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — builder: install deps + build the Next frontend
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-debian AS builder

# Node 20 for `next build` and `next start`. Bun runs Next dev fine but
# production mode is rock-solid on Node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Frontend
COPY frontend/package.json frontend/bun.lock frontend/tsconfig.json frontend/next.config.ts frontend/components.json frontend/eslint.config.mjs frontend/postcss.config.mjs frontend/next-env.d.ts ./frontend/
COPY frontend/public ./frontend/public
WORKDIR /build/frontend
RUN bun install --frozen-lockfile

COPY frontend/app ./app
COPY frontend/components ./components
COPY frontend/hooks ./hooks
COPY frontend/lib ./lib

# Build with the API_BASE empty so client bundles use relative URLs (same-origin).
ENV NEXT_PUBLIC_SIM_API=""
RUN bun run build

# Sim-engine — Bun runs TS directly so no build step.
WORKDIR /build
COPY sim-engine/package.json ./sim-engine/
WORKDIR /build/sim-engine
RUN bun install

COPY sim-engine/src ./src
COPY sim-engine/scenarios ./scenarios
COPY sim-engine/runs-demo ./runs-demo
COPY sim-engine/tsconfig.json ./tsconfig.json

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-debian AS runtime

# Node 20 (frontend) + Caddy (reverse proxy)
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
 && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs caddy tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Frontend artifacts
COPY --from=builder /build/frontend/.next ./frontend/.next
COPY --from=builder /build/frontend/public ./frontend/public
COPY --from=builder /build/frontend/node_modules ./frontend/node_modules
COPY --from=builder /build/frontend/package.json ./frontend/package.json
COPY --from=builder /build/frontend/next.config.ts ./frontend/next.config.ts

# Sim-engine
COPY --from=builder /build/sim-engine/src ./sim-engine/src
COPY --from=builder /build/sim-engine/scenarios ./sim-engine/scenarios
COPY --from=builder /build/sim-engine/runs-demo ./sim-engine/runs-demo
COPY --from=builder /build/sim-engine/package.json ./sim-engine/package.json
COPY --from=builder /build/sim-engine/tsconfig.json ./sim-engine/tsconfig.json
COPY --from=builder /build/sim-engine/node_modules ./sim-engine/node_modules

# Caddy + entrypoint
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY infra/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Production env defaults — override via App Runner config.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    SIM_REQUIRE_BYOK=1 \
    SIM_DISABLE_ONCHAIN=1 \
    SIM_API_PORT=8787 \
    NEXT_PORT=3000 \
    PUBLIC_PORT=8080 \
    NEXT_PUBLIC_SIM_API="" \
    SIM_RUNS_DIR=/app/runs \
    SIM_DEMO_RUNS_DIR=/app/sim-engine/runs-demo

# Writable runs dir (App Runner has no persistent volume — restarts wipe it).
RUN mkdir -p /app/runs

EXPOSE 8080

# tini reaps zombies and forwards SIGTERM to children.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
