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
- Typecheck, build, and tests pass (`pnpm typecheck`, `pnpm build`, `pnpm test`, 190 tests).
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
- `/health` reports `backendCount: 0`; production backend registry is empty.

**No backend is connected in Phase 3.** Registration, validation, enable, and
disable are configuration operations only: nothing is spawned, dialled, or
resolved. Adapters, tool discovery, and routing are Phase 4+.

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

# Register a backend (configuration only)
curl -s -X POST http://127.0.0.1:8787/api/v1/backends \
  -H 'content-type: application/json' \
  -d '{"name":"fs","connection":{"type":"stdio","command":"node","args":["server.js"],"env":{"KEY":"env:FS_KEY"}}}'

# Inspect, filter, and page
curl -s 'http://127.0.0.1:8787/api/v1/backends?transport=stdio&enabled=true&page=1&limit=20&sort=name'
```

| Method | Path |
| --- | --- |
| `GET` | `/api/v1/system` |
| `GET` | `/api/v1/system/health` |
| `GET` | `/api/v1/backends` |
| `POST` | `/api/v1/backends` |
| `GET` | `/api/v1/backends/:backendId` |
| `PATCH` | `/api/v1/backends/:backendId` |
| `DELETE` | `/api/v1/backends/:backendId` |
| `POST` | `/api/v1/backends/:backendId/enable` |
| `POST` | `/api/v1/backends/:backendId/disable` |
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

Phase 4 — adapter framework: stdio and Streamable HTTP adapters over the official
MCP Client SDK, with process lifecycle, timeouts, reconnect, and cleanup, plus
the `connect`/`disconnect`/`reconnect` endpoints deferred from Phase 3. Do not add
real backends or modify agent configurations without approval.
