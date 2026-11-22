# Universal MCP Gateway — container image (Phase 18, Stage C).
#
# NOT VERIFIED: this image has not been built or run in this environment. It
# is written against the repository's real surface: `pnpm build` produces
# `apps/gateway/dist/index.js`, which was verified locally to boot, serve, and drain
# cleanly on SIGTERM. Expect to adjust details on first build.
#
# The gateway is loopback-only by design: configuration refuses any
# non-loopback HOST at startup, and the management API re-checks the socket
# address per request. That has two consequences for containers:
#   * bridge networking with published ports CANNOT serve it — the server
#     binds 127.0.0.1 inside the container's network namespace and published
#     traffic arrives via the container IP. This is the security posture
#     working as intended, not a defect.
#   * run it with host networking: `--network host` (docker run) or
#     `network_mode: host` (compose). See deployment/docker/docker-compose.yml.

FROM node:26-slim

# better-sqlite3 ships prebuilt binaries for common platforms; these tools are
# the node-gyp fallback so the build cannot dead-end on an unusual platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

corepack enable
WORKDIR /app

# Manifests first so the dependency layer caches independently of source.
# Both workspace members' manifests must be present for the frozen install to
# resolve; only the gateway's code is ever built or shipped by this image.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN pnpm install --frozen-lockfile

COPY apps/gateway/tsconfig.json apps/gateway/tsconfig.json
COPY apps/gateway/src ./apps/gateway/src
RUN pnpm --filter @universal-mcp-gateway/gateway build

# SQLite lives under <repo>/data by default; mount a volume here (compose does).
# The gateway resolves its default database against the repository root inside
# the image (/app), so this volume is the same file a bare-metal run uses.
VOLUME /app/data

CMD ["node", "apps/gateway/dist/index.js"]
