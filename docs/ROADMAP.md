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

## Phase 5 — Tool catalog and routing (completed)
- [x] Discovery from connected backends over `tools/list`, coalesced per backend, with a hard deadline (`TOOL_DISCOVERY_TIMEOUT_MS`).
- [x] Deterministic namespacing `<backend_id>__<tool>`, total character normalization, 128-char bound with an identity-derived suffix.
- [x] Collision detection that withholds **every** claimant and surfaces them on `GET /api/v1/tools/conflicts`; no ordering-based routing.
- [x] In-memory authoritative catalog; nothing persisted, rebuilt by rediscovery on restart.
- [x] Lossless JSON Schema forwarding: `$defs`, `$ref`, `enum`, `additionalProperties`, and vendor extensions survive untouched.
- [x] Argument validation against the backend's own schema (AJV, no coercion); uncompilable schemas forwarded unvalidated with the reason logged.
- [x] `tools/call` routing with per-call timeout `min(TOOL_CALL_TIMEOUT_MS, backend.timeoutMs)` and cancellation mapped to JSON-RPC `-32800`.
- [x] `tools/list` on the low-level SDK `Server`, serving both protocol eras with one stateless instance per exchange.
- [x] Lifecycle synchronization: connect discovers, disconnect/disable removes; stale entries are refused at call time regardless.
- [x] Error normalization: `TOOL_NOT_FOUND` (404/`-32602`), `TOOL_UNAVAILABLE` (503/`-32603`), `TOOL_CANCELLED` (408/`-32800`).
- [x] Catalog API: list/detail/discovery/conflicts/refresh, per-backend tools, per-backend refresh. No invocation endpoint.
- [x] `tools.list` / `tools.call` activity events with no arguments or results.
- [x] 47 new tests (`routing` 26, `tools-api` 12, `mcp-tools` 9) → 303 total, using local fixtures only.
- [x] `pnpm typecheck`, `pnpm test`, `pnpm build` pass.
- [x] No real backend connected; no agent configuration touched; no non-loopback exposure.

**Deferred by design:** health probing (an `unhealthy` state still has no setter), catalog persistence (ADR-038), and `tools/list` pagination (full list is protocol-legal and bounded).

## Phase 6 — Identity, authentication, and policies (completed)
- [x] Agent profiles with `enabled`, metadata, and a tombstone delete that revokes credentials and drops assignments in one transaction.
- [x] Per-agent credentials: `umg_live_<base64url>` tokens, returned once, stored as HMAC-SHA-256 with `token_prefix` and `hash_key_id`.
- [x] Timing-safe verification: shape → digest → indexed lookup → re-compare → key id → status → agent enabled.
- [x] Per-request MCP authentication on `/mcp` with one uniform 401 for every failure; no session binding, no trust in client-supplied identity.
- [x] `CREDENTIAL_HASH_SECRET` read outside `Config`: production fails startup when absent, development fails closed per request, never an ephemeral secret.
- [x] Credential rotation as one transaction with a single `credential.rotated` audit row and no overlap window.
- [x] Policy engine with explicit precedence: system restrictions → priority → deny over allow → policy id → rule index → default deny.
- [x] Default-deny authorization enforced independently in `tools/list` (filtered view) and `tools/call` (checked before resolution).
- [x] A denied call is byte-identical to an unknown tool: `-32602`, `Unknown tool`, no backend/policy/schema disclosure.
- [x] `access.denied`, `auth.succeeded`, and `auth.failed` audit rows with agent, backend/tool, credential, correlation id, reason, and outcome; windowed dedup with `suppressed` counts.
- [x] Agent, credential, and policy endpoints, plus a read-only access preview.
- [x] `GET /api/v1/system` and `/health` report the live authentication posture.
- [x] Migration `0004_agent_authentication.sql`: additive, nullable, no backfill, no index, `sessions` untouched.
- [x] 69 new tests (`credentials` 19, `authentication` 18, `authorization` 23, `mcp-auth` 8) → 372 total.
- [x] `pnpm typecheck`, `pnpm test`, `pnpm build` pass; migration 0004 verified against a real pre-0004 database.
- [x] No real backend connected; backend registry empty; bind still `127.0.0.1`.

**Not in this phase (by decision):** dashboard owner authentication, session-to-agent binding, and OAuth. *At the time of Phase 6* the management API remained unauthenticated and loopback-only, and it can now mint a credential — that is why it must not be exposed. Workstream 10.0 later added operator authentication (ADR-045). Session tracking is Phase 7, which must not turn a session binding into an authorization shortcut.

## Phase 7 — Session isolation and concurrency

- [x] Transport/session model finalized against the installed SDK (`2.4.0`, not assumed): the 2026 era is per-request and issues no session id; the 2025 era issues one and is served through `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator`. Recorded as ADR-043.
- [x] Two-shape routing: a 2025 `initialize` or a request already carrying `mcp-session-id` takes the sessionful leg; everything else keeps the stateless leg, so a one-shot `tools/list` still answers `200` with no session (Phase 1–6 compatibility preserved).
- [x] Session tracking: `sessions` rows carry `mcp_session_id` (unique), `credential_id`, `status`, `terminated_at`, `termination_reason`; internal id and protocol id are distinct and never interchangeable.
- [x] Binding: one protocol session ↔ one agent ↔ one credential, enforced by a partial unique index plus immutability and no-reactivation triggers, so a second process cannot violate it either.
- [x] Expiration: idle timeout (`SESSION_IDLE_TIMEOUT_MS`, default 30 min) and hard cap (`SESSION_MAX_LIFETIME_MS`, default 12 h), both enforced **per request** rather than only by the sweep.
- [x] Invalidation on revocation, rotation, agent disable, and agent delete, in the same transaction as the change; termination is one-way and idempotent; shutdown terminates everything as `gateway_shutdown` before transports close.
- [x] Session management API: list (paginated, filterable by agent/status/created/activity), detail, terminate, cleanup — loopback-only, no credential or transport state in any payload.
- [x] Audit: `session.created`, `session.authenticated`, `session.access.denied`, `session.expired`, `session.terminated`, `session.invalidated`, `session.cleanup.completed`; windowed so a busy session cannot grow the table linearly.
- [x] Migration `0005_session_isolation.sql`: additive, five nullable columns plus a defaulted `status`, one back-fill of `revoked_at`, four indexes, four triggers; verified against a real 0004 database.
- [x] 65 new tests (`mcp-sessions` 14 socket, `sessions` 32 service, `sessions-api` 17 API) → 437 total; Phase 1–6 tests unmodified.
- [x] `pnpm typecheck`, `pnpm test`, `pnpm build` pass; no real backend connected; bind still `127.0.0.1`.
- [ ] **Deferred from Phase 7, still open after Phase 8:** per-backend tool-call queueing for `concurrency_mode = 'limited'`. Connection state is still serialized per backend, so two concurrent connects open one connection; tool calls are not queue-gated. The columns exist, so no migration will be needed.

**Not in this phase (by decision):** dashboard session views, operator identity on the management API, Redis or any cross-process session registry, OAuth. Session serving is single-process by construction; what is cross-process is the row and its constraints. See `docs/ARCHITECTURE.md` §10–§11 and ADR-043.

## Phase 8 — Management API completion (completed)

- [x] `GET /api/v1/overview` — one snapshot of every aggregate a dashboard home screen needs; a single `opsSnapshot()` reader feeds it, `/monitoring*`, and `/diagnostics`, so their counts cannot disagree.
- [x] `GET /api/v1/monitoring` + `/health`, `/backends`, `/sessions`, `/runtime`.
- [x] `GET /ready` — readiness over the database and the migration ledger, mounted outside `/api/v1`; `503` when either is unreadable. Optional backends excluded by design; `/health` stays liveness-only.
- [x] `GET /api/v1/diagnostics` — version, runtime, uptime, migration version, counts, limits. Read-only, non-secret.
- [x] `GET /api/v1/settings` — effective, non-secret configuration; write verbs answer `404` because no mutation path exists.
- [x] `GET /api/v1/activity` + `/:eventId` — filters `type`, `outcome`, `agentId`, `backendId`, `toolName`, `search`, `after`, `before`, `order`; closed enums, so an unknown value is a `400`.
- [x] `GET /api/v1/audit` + `/:eventId` — filters `action`, `actorType`, `actorId`, `targetType`, `targetId`, `result`, `search`, date range. Audit stays immutable: no repository update/delete and no REST write verb. `metadata` is omitted from the list and rendered only by the detail read.
- [x] Canonical pagination everywhere: `page`/`limit` (max 100), allowlisted sort/filter fields, deterministic `id` tie-break, `total` measured over the filtered set.
- [x] Fixed a real pagination bug: policy `backendId` filtering moved from post-slice route code into SQL (`EXISTS … json_each`), so `total` describes the filtered set. A `backendId`/`agentId` filter that names nothing is now `404`.
- [x] Documented one tightening: `GET /api/v1/backends/:id/tools` answers `404` for an unknown backend (was `200` + `[]`); `GET /tools?backendId=` still answers an empty page.
- [x] OpenAPI 3.1 at `GET /api/v1/openapi.json`, hand-written (`src/api/openapi.ts`) with query parameters derived from the same Zod schemas the handlers parse. `tests/openapi.test.ts` checks the document against the live Hono route table **in both directions**, resolves every `$ref`, and asserts the pagination and error-envelope shapes. No new dependency — `z.toJSONSchema` ships with Zod 4.
- [x] `null` vs `0`: when a storage read fails, storage-backed fields are `null` and `status` is `degraded`; the in-memory catalog is still reported. An empty registry reports legitimate zeros.
- [x] Single-statement aggregate queries: enabled/disabled splits, runtime distribution, session effective-status counts, activity/audit groupings — no N+1.
- [x] No migration needed: the existing `created_at` and composite event indexes cover the new range/filter shapes. Production `data/gateway.db` untouched (migrations `0001–0005`, 0 backends, 0 agents).
- [x] 49 new tests (`ops-api` 31, `openapi` 8, `policies-api` 10) → 486 total; Phase 1–7 tests kept, one updated with a comment for the documented `404`.
- [x] `pnpm typecheck`, `pnpm test`, `pnpm build` pass; no real backend connected; bind still `127.0.0.1`.
- [x] New `docs/API_REFERENCE.md`; `ARCHITECTURE`, `BACKEND_SPEC`, `SECURITY`, `DATABASE`, `MONITORING`, `ROADMAP`, and `README` updated.
- [ ] **Still deferred:** per-backend tool-call queueing for `concurrency_mode = 'limited'`. The columns exist, so no migration will be needed.
- [ ] **Still deferred:** backup/restore APIs. Phase 8 was scoped to the read/management surface the dashboard consumes.
- [x] **Dashboard owner authentication — delivered in workstream 10.0** (ADR-045), not in Phase 8.

**Not in this phase (by decision):** any frontend code, any real backend integration, any new dependency, Redis or any cache, a metrics/time-series store, audit retention, and OAuth. *At Phase 8 close* the management API remained unauthenticated and loopback-only; workstream 10.0 has since added operator authentication (ADR-045), without changing the loopback-only rule.

## Phase 9 — Astryx dashboard foundation (complete in adjusted scope — see ADR-044)

- [x] Read current official Astryx docs (`astryx.atmeta.com`) and inspected the
      reference app `meta/astryx` → `apps/example-nextjs-tailwind`.
- [x] Installed Astryx directly as a package set: `@astryxdesign/core` 0.7.16,
      `@astryxdesign/theme-neutral` 0.7.16, `@stylexjs/stylex` (core's peer).
      `@astryxdesign/cli` is a dev dependency, used to generate theme wiring.
- [x] No shadcn/ui, no Radix UI, no parallel design system.
- [x] App shell: Astryx `AppShell` + `SideNav` + `TopNav` with a responsive
      mobile drawer, skip link, and a single `<main>` owned by `AppShell`.
- [x] Navigation, breadcrumbs, page titles, and placeholder copy derived from one
      source (`apps/dashboard/src/lib/navigation.ts`).
- [x] Theme infrastructure: light/dark/system via Astryx `<Theme mode>`; no local
      `color-scheme` rule, so `reset.css` stays the only owner of that mapping.
- [x] Tokens: Tailwind v4 bridged to Astryx with the official
      `tailwind-theme.css` export; cascade layers declared once in `globals.css`.
- [x] Typed API client (`apps/dashboard/src/lib/api/`): envelope unwrap, request
      timeout, `ApiError` normalisation that never surfaces a stack trace, SQL
      text, or a URL.
- [x] **Auth guard — implemented in Phase 10.0.** Phase 9 correctly declined to
      back-fill a placeholder guard (ADR-044); 10.0 then built the identity model
      it needed. The gateway enforces the operator session on every `/api/v1`
      route, and the `(dashboard)` layout probes it before rendering. See below.
- [x] Same-origin read proxy `/api/proxy/[...path]` — allowlisted GET only, not a
      passthrough. Necessary because the gateway grants no CORS and the browser
      cannot reach `127.0.0.1:8787` directly.
- [x] Reusable compositions: `components/feedback/*` (loading, empty, error,
      unavailable), `components/layout/*`, `components/ui/*`.
- [x] `GatewayStatus` header probe reads `/ready` and distinguishes
      *unreachable* (proxy `503` + error envelope) from *not ready* (gateway
      `503` + a valid readiness document) by **payload shape**, since both arrive
      as `503`.
- [x] One real page: `/dashboard` overview reads `GET /api/v1/overview`. Every
      other module route is an honest placeholder with no sample data and no
      fake counters.
- [x] 25 dashboard component/validator tests at Phase 9 close; 38 after Phase
      10.0 added login-form and auth-helper tests. Root `vitest.config.ts` is
      pinned to `tests/**/*.test.ts` so one workspace's suite cannot run inside
      the other's environment.
- [x] `pnpm typecheck`, `pnpm test` (486 at Phase 9 close; 528 after Phase 10.0),
      `pnpm build`, dashboard typecheck / test / build (17 routes) all pass; no
      real backend connected; bind still `127.0.0.1`.
- [x] Root scripts: `dev:gateway`, `dev:dashboard`, `build:gateway`,
      `build:dashboard`, `typecheck:dashboard`, `test:dashboard`, `verify`.
      Every pre-existing script is unchanged. The gateway remains the root
      package, so there is no `apps/gateway/package.json`.
- [x] **Operator authentication for the dashboard — implemented in Phase 10.0**
      (ADR-045). The dashboard must still not be exposed beyond loopback: there is
      no TLS, and the session cookie crosses plain HTTP within the host.
- [ ] **Still deferred:** real-browser click-path verification. No browser
      automation was installed; layout is verified by SSR HTML inspection, the
      production build, and jsdom component tests.
- [ ] **Known limitation:** JSDOM 27.4 cannot parse CSS anchor positioning
      (`@position-try`, `position-area`), which Astryx injects at runtime for
      overlay components. Test output only; the built CSS is unaffected.

**Scope decision (ADR-044).** Dashboard Operator Authentication was a Phase 10
deliverable, not a Phase 9 gap to be filled retroactively. Phase 9 is complete
**within its adjusted scope**: foundation implemented and verified, operator
authentication intentionally excluded rather than back-filled with a placeholder.
It is not "complete" in the original roadmap sense, and the docs say so rather
than papering over it. Workstream 10.0 subsequently built that identity model
(ADR-045).

**Not in this phase (by decision):** any Phase 10 page beyond the overview, any
mutation UI, any new backend integration, any remote exposure, and any change to
agent MCP configuration.

## Phase 10 — Dashboard feature pages

**Workstream 10.0 — Dashboard operator identity and authentication: implemented.**
ADR-045 records the decisions; `docs/SECURITY.md` §4.3 and §8.1 are the
reference, and `docs/DASHBOARD.md` Part III is the UI record.

What shipped:

- One local operator (`admin_users`, extended by migration `0006`). scrypt
  password hashes with parameters encoded in the stored string.
- Opaque server-side sessions in `operator_sessions` (digest-only storage), with
  idle and absolute lifetimes derived on read, rotation at login, immediate
  revocation, and lockout after five failures.
- `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/session`.
- **Gateway-enforced boundary on every `/api/v1` route**, default-deny with a
  closed exemption list, plus CSRF via `X-CSRF-Token` on non-safe methods. The
  dashboard is not the guard, because a local `curl` does not load a page.
- Dashboard login/logout, a session probe, and an account menu showing the
  identity the gateway confirmed.
- Audit actions for login success/failure, logout, revocation, expiry,
  creation, disable, and password change.
- `pnpm operator:create` bootstrap, refusing to run when an operator exists and
  never accepting a password on the command line.

**Deliberately not in 10.0:** multiple operators, RBAC beyond `owner`, password
change UI, session listing UI, external identity provider, TLS, per-IP login
rate limiting, dashboard CSP, and any non-loopback exposure. Each is a real
limitation, recorded in `docs/SECURITY.md` §8.2 rather than implied to exist.

**Verification honesty:** 42 gateway tests cover the boundary end to end, and 38
dashboard tests cover the form and cookie helpers, but **no real browser was
driven** through sign-in — no browser automation is installed here.

**Module workstreams (after 10.0):**

Implement:
1. ~~Overview~~ — shipped in Phase 9; Phase 10 only extends it if new aggregates appear.
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

**Status: workstream 10.0 is complete; module pages are not started.** Every
module route except `/dashboard` is a placeholder that says so. Phase 9 built the
shell, theme, client, proxy, and compositions these pages will use; 10.0 added
the identity and the boundary they will rely on. It did not build the pages.

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
