# Universal MCP Gateway

A self-hosted, local-first MCP gateway and control plane for multiple coding agents and independently managed MCP backends.

## Full product scope

- MCP Streamable HTTP gateway.
- Dynamic backend registry and adapters.
- Tool discovery, namespacing, and routing.
- Agent profiles and per-agent credentials.
- Authorization policies.
- Session isolation and concurrency controls.
- Complete administration dashboard.
- Monitoring, structured logs, diagnostics, and audit trail.
- Backup, recovery, and operational runbooks.

## Technology

### Backend
Node.js, TypeScript ESM, pnpm, Hono, official MCP TypeScript SDK, Zod, Pino, YAML, SQLite (`better-sqlite3`), Vitest.

### Dashboard
Next.js, React, TypeScript, and **Astryx directly** as the UI component library/design system.

**Do not use shadcn/ui or Radix UI as a fallback component library.** Follow current official Astryx documentation: https://astryx.atmeta.com/

## Current status

Phases 1–3 are complete.
- Typecheck, build, and tests pass (`pnpm typecheck`, `pnpm build`, `pnpm test`, 256 tests).
- Streamable HTTP `/mcp` verified against the official MCP Client SDK for both
  protocol eras (2025 `initialize` handshake and 2026 `server/discover`).
- `tools/list` returns an empty catalog; no backend is registered and none is connected.
- Phase 1: 19 integration tests cover handshake, malformed input, Host/Origin
  validation, per-exchange server isolation, and shutdown.
- Phase 2: domain + Zod 4 contracts, error taxonomy, centralized configuration,
  SQLite foundation (versioned transactional migrations, 11 tables), repository
  interfaces, and bootstrap wiring.
- Phase 3: backend registry and management API at `/api/v1` — CRUD, validation,
  enable/disable, pagination/filtering/search, optimistic concurrency, and audit
  events. 69 new tests (service + API + real-socket).
- Phase 4: MCP transport adapters (stdio + Streamable HTTP) over the official
  MCP Client SDK, a serialized lifecycle manager, a persisted state machine with
  a `disconnecting` state, bounded exponential-backoff reconnect, startup
  recovery, an SSRF destination policy, and `connect`/`disconnect`/`reconnect`/
  `runtime` endpoints. 61 new tests, including real child processes and a
  loopback HTTP fixture.
- `/health` reports `backendCount: 0`; production backend registry is empty.

**Nothing connects by itself.** Registration, validation, and enable/disable are
configuration operations: no process is spawned and no socket is dialled. A
connection happens only on an explicit `POST /backends/:id/connect`, and a
restart rewrites every persisted live state to `disconnected` without
reconnecting. Tool discovery aggregation and routing remain Phase 5+.

**Backends can now run processes and make outbound connections.** The outbound
policy (scheme, credentials, DNS-resolved destinations, redirects) is in
`src/security/network-policy.ts`; `ALLOW_PRIVATE_NETWORK` opens only
loopback/private/CGNAT and never metadata or link-local. TLS verification is
never disabled.

**The management API is unauthenticated.** It is loopback-only and applies
Host/Origin, JSON content-type, and size guards — but any local process can call
it. Do not expose it beyond loopback. See `docs/SECURITY.md` §3.1.

## Configuration

Environment variables, with defaults:

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Loopback only (`127.0.0.1`, `localhost`, `::1`) |
| `PORT` | `8787` | 1–65535 |
| `DATABASE_PATH` | `./data/gateway.db` | Created with parents if missing |
| `LOG_LEVEL` | `info` | `fatal`…`trace`, `silent` |
| `ENVIRONMENT` | `development` | `development`, `test`, `production` |
| `REQUEST_BODY_LIMIT_BYTES` | `4194304` | Max MCP request body |
| `REQUEST_TIMEOUT_MS` | `30000` | Per-exchange bound |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | Used from Phase 7 |
| `SESSION_MAX_LIFETIME_MS` | `43200000` | Used from Phase 7 |
| `RECONNECT_ENABLED` | `false` | Auto-reconnect after a transient loss |
| `RECONNECT_INITIAL_DELAY_MS` | `1000` | First backoff step |
| `RECONNECT_MAX_DELAY_MS` | `60000` | Backoff ceiling |
| `RECONNECT_MAX_ATTEMPTS` | `5` | Attempts before giving up (1–100) |
| `RECONNECT_JITTER_RATIO` | `0.2` | ± fraction of each delay (0–1) |
| `ALLOW_PRIVATE_NETWORK` | `false` | Permit loopback/private HTTP backends (fixtures only) |

Precedence: explicit overrides → environment → defaults. Invalid configuration
fails fast at startup with a message naming the setting. No YAML is read; no
secret is ever logged.

## Development commands

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm build
pnpm test
```

Health:
```bash
curl -i http://127.0.0.1:8787/health
```

MCP endpoint:
```text
http://127.0.0.1:8787/mcp
```

Management API (unauthenticated, loopback only):
```bash
# Empty registry
curl -s http://127.0.0.1:8787/api/v1/backends
# {"data":[],"pagination":{"page":1,"limit":20,"total":0,"totalPages":0}}

# Validate a proposed configuration (persists nothing, connects nothing)
curl -s -X POST http://127.0.0.1:8787/api/v1/backends/validate \
  -H 'content-type: application/json' \
  -d '{"name":"fs","connection":{"type":"stdio","command":"node","args":["server.js"]}}'

# Register a backend (configuration only — nothing is spawned or dialled)
curl -s -X POST http://127.0.0.1:8787/api/v1/backends \
  -H 'content-type: application/json' \
  -d '{"name":"fs","connection":{"type":"stdio","command":"node","args":["server.js"],"env":{"KEY":"env:FS_KEY"}}}'

# Inspect, filter, and page
curl -s 'http://127.0.0.1:8787/api/v1/backends?transport=stdio&enabled=true&page=1&limit=20&sort=name'

# Connect explicitly, then inspect runtime state (Phase 4)
curl -s -X POST http://127.0.0.1:8787/api/v1/backends/<id>/connect
curl -s http://127.0.0.1:8787/api/v1/backends/<id>/runtime
curl -s http://127.0.0.1:8787/api/v1/backends/runtime
curl -s -X POST http://127.0.0.1:8787/api/v1/backends/<id>/disconnect
```

| Method | Path |
| --- | --- |
| `GET` | `/api/v1/system` |
| `GET` | `/api/v1/system/health` |
| `GET` | `/api/v1/backends` |
| `POST` | `/api/v1/backends` |
| `GET` | `/api/v1/backends/runtime` |
| `GET` | `/api/v1/backends/:backendId` |
| `PATCH` | `/api/v1/backends/:backendId` |
| `DELETE` | `/api/v1/backends/:backendId` |
| `POST` | `/api/v1/backends/:backendId/enable` |
| `POST` | `/api/v1/backends/:backendId/disable` |
| `POST` | `/api/v1/backends/:backendId/connect` |
| `POST` | `/api/v1/backends/:backendId/disconnect` |
| `POST` | `/api/v1/backends/:backendId/reconnect` |
| `GET` | `/api/v1/backends/:backendId/runtime` |
| `POST` | `/api/v1/backends/validate` |

Every request body must be `application/json`. Errors use one envelope:
`{ "error": { "code", "message", "requestId" } }`. Contracts and validation
rules are in `docs/BACKEND_SPEC.md`.

## Documentation

- `PRD.md` — full product requirements.
- `ARCHITECTURE.md` — system architecture.
- `DASHBOARD.md` — complete dashboard and Astryx requirements.
- `BACKEND_SPEC.md` — management API and backend domain.
- `SECURITY.md` — security requirements.
- `DATABASE.md` — database model and persistence.
- `MONITORING.md` — logs, metrics, audit, operations.
- `ROADMAP.md` — implementation phases.
- `DECISIONS.md` — accepted decisions.
- `AGENT_GUIDE.md` — instructions for local coding agents.

## Next task

Phase 5 — tool discovery, namespacing, and routing across connected backends.
Do not add real backends or modify agent configurations without approval.
