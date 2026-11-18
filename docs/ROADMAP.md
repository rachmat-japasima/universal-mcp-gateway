# Full Project Implementation Roadmap

The full product scope is approved in this document. Implement sequentially; do not attempt the entire product in one change.

## Phase 0 — Bootstrap (completed)
- [x] pnpm project initialized.
- [x] TypeScript ESM / NodeNext configured.
- [x] Agreed base dependencies installed.
- [x] Hono server and MCP endpoint skeleton created.
- [x] Pino logger and environment config created.
- [x] `/health` endpoint works.
- [x] `pnpm typecheck` passes.
- [x] `pnpm build` passes.
- [x] User verified dev server and health endpoint.
- [x] Production backend registry remains empty.

## Phase 1 — MCP protocol correctness (completed)
- [x] Audited installed SDK versions (v2.4.0 server/client, v2.0.2 hono).
- [x] Serving entry replaced with SDK `createMcpHandler` (2025 + 2026 eras).
- [x] Host and Origin validation wired explicitly (loopback allowlists).
- [x] `tools/list` returns an empty array on both eras.
- [x] Per-exchange server instances: no mutable state shared between clients.
- [x] Malformed JSON, unknown method, empty batch, bad protocol version,
      wrong content type, and oversize body produce protocol errors.
- [x] Shutdown closes the MCP handler; `/mcp` answers 503 afterwards.
- [x] 19 integration tests using the official MCP Client SDK.
- [x] `pnpm typecheck`, `pnpm build`, `pnpm test` pass.

## Phase 2 — Core domain and configuration (completed)
- [x] Domain models + Zod 4 schemas: backend, backend runtime, agent,
      credentials, policies, sessions, activity events, audit events.
- [x] Create vs update schemas; update schemas carry no defaults.
- [x] Error taxonomy (`AppError`, 12 stable codes) mapped to HTTP and JSON-RPC.
- [x] Centralized configuration: pure parser, env → defaults, loopback-only host,
      fail-fast with actionable messages, no `process.exit` inside the module.
- [x] SQLite foundation: connection pragmas, transactional versioned migrations
      with checksums, `0001_initial_schema.sql` (11 tables).
- [x] Repository interfaces (domain terms) + SQLite implementations.
- [x] Bootstrap wiring: config → logger → store → HTTP, migrations before serving,
      shutdown releases handler then database.
- [x] 121 tests; `/health` reports `backendCount: 0`; registry remains empty.
- [x] `pnpm typecheck`, `pnpm build`, `pnpm test` pass.

## Phase 3 — Backend registry and management API (completed)
- [x] Backend CRUD and validation at `/api/v1/backends`.
- [x] Enable/disable as idempotent configuration operations.
- [x] Definitions persisted in SQLite; runtime status kept in a separate row.
- [x] Pagination, filtering (transport, enabled), search, stable ordering, totals.
- [x] Optimistic concurrency via `backends.version` and `?expectedVersion=`.
- [x] Audit events for create/update/enable/disable/delete and validation failure.
- [x] api / registry / infrastructure layering; no SQL or rules in handlers.
- [x] Loopback-only, Host/Origin, JSON content-type, and body-size guards.
- [x] 190 tests; `pnpm typecheck`, `pnpm test`, `pnpm build` pass.
- [x] Registry remains empty until the user adds a backend. No backend connected.

## Phase 4 — Adapter framework (completed)
- [x] stdio adapter: executable + argument array, `shell: false`, inherited env limited to the SDK default set plus explicit references, bounded credential-redacted stderr tail, SDK escalating teardown.
- [x] Streamable HTTP adapter: guarded `fetch` re-checked per request, same-origin redirects, TLS verification never disabled, SDK reconnection disabled.
- [x] Official MCP Client SDK for both transports, wrapped so failures map onto the gateway's error taxonomy.
- [x] Process lifecycle: serialized per backend, one promise chain, idempotent connect/disconnect.
- [x] Persisted state machine with a `disconnecting` state (migration `0003`), enforced at the write.
- [x] Bounded exponential-backoff reconnect with jitter, transient-only, off by default.
- [x] Startup recovery: persisted live state rewritten to a resting state, never reconnected.
- [x] `connect`, `disconnect`, `reconnect`, and `runtime` endpoints; `enable` does not connect, `disable` tears down.
- [x] SSRF destination policy: scheme, credentials, DNS-resolved address classes, per-request re-check. `ALLOW_PRIVATE_NETWORK` opens only loopback/private/CGNAT.
- [x] 256 tests (`network-policy` 16, `lifecycle` 25, `lifecycle-api` 14, plus config/domain additions), using isolated fixtures and a loopback HTTP fixture only.
- [x] Live-verified on `127.0.0.1` with a temp database: spawn/teardown, disable/enable, metadata URL refused, SIGTERM cleanup, restart recovery with zero children spawned.
- [x] `pnpm typecheck`, `pnpm test`, `pnpm build` pass.
- [x] Production registry remains empty; no real backend connected; no agent configuration touched.

## Phase 5 — Tool catalog and routing
- Discover tools from connected backends.
- Namespacing and collision detection.
- Tool call routing.
- Timeout/cancellation.
- Error normalization.
- Tool catalog cache/invalidation.
- Health probing of live backends (sets `unhealthy`).
- Integration tests with isolated fixtures.

## Phase 6 — Identity, authentication, and policies
- Agent profiles.
- Per-agent credentials.
- Dashboard owner authentication.
- Policy engine.
- Default-deny authorization.
- Filter tools/list and enforce tools/call.
- Secret redaction and audit events.

## Phase 7 — Session isolation and concurrency
- Finalize transport/session model.
- Session tracking and expiration.
- Per-backend concurrency modes.
- Resource-scoped queue/locks.
- Cancellation and stale-lock recovery.
- Concurrent client tests.

## Phase 8 — Management API completion
- Agents, policies, sessions, activity, settings APIs.
- Validation, pagination, filtering.
- API contracts and integration tests.
- Secure backup/restore APIs.

## Phase 9 — Astryx dashboard foundation
- Read current official Astryx docs.
- Install and configure Astryx directly.
- Do not install shadcn/ui or Radix UI as fallback.
- Build app shell, navigation, theme, tokens, responsive behavior.
- Establish typed API client and auth guard.
- Implement reusable product compositions using Astryx.

## Phase 10 — Dashboard feature pages
Implement:
1. Overview.
2. Backend list/create/detail.
3. Tool Explorer.
4. Agents and credential lifecycle.
5. Access Policies.
6. Sessions.
7. Activity.
8. Monitoring.
9. Audit Trail.
10. Settings and diagnostics.

Every page must use real API data and complete loading/empty/error/success states.

## Phase 11 — Observability and operations
- Structured request logs.
- Metrics aggregation.
- Health/diagnostics.
- Reconnect/backoff.
- Audit retention.
- Backup/restore and runbooks.

## Phase 12 — Agent compatibility
- Verify Claude Code, Codex CLI, OpenCode, and DeepSeek client compatibility.
- Connect one client at a time.
- Direct HTTP where supported.
- Local stdio bridge only where necessary.
- Do not alter agent configs without user approval.

## Phase 13 — First real backend integration
- Select one pilot backend with user approval.
- Start with read-only/safe tools.
- Validate permissions and concurrency.
- Add further backends only after pilot is stable.
- FigCraft is a candidate, not a required first integration.

## Phase 14 — Hardening and release
- Security review.
- Performance and soak tests.
- Failure/recovery tests.
- Backup/restore verification.
- Documentation and versioning.
- Local deployment and process supervision.
- Explicit security gate before non-loopback exposure.

## Phase 15 — Optional enhancements
- Import/export configuration.
- Advanced alerting.
- More transports.
- Multi-user administration.
- Remote access with strong security.
- Additional dashboards/analytics.

## Rules
- One phase at a time.
- No real backend integration before adapter/routing/security foundation.
- No dashboard before stable API contracts.
- No fake production backends or metrics.
- Do not modify agent configuration without explicit approval.
- Report exact files, tests, results, and remaining risks at each phase.
