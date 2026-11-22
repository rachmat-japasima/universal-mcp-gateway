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
- [x] OpenAPI 3.1 at `GET /api/v1/openapi.json`, hand-written (`apps/gateway/src/api/openapi.ts`) with query parameters derived from the same Zod schemas the handlers parse. `apps/gateway/tests/openapi.test.ts` checks the document against the live Hono route table **in both directions**, resolves every `$ref`, and asserts the pagination and error-envelope shapes. No new dependency — `z.toJSONSchema` ships with Zod 4.
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

**Workstream 10.1 — Backend management: implemented.**

Scope: the registry only — list, create, detail, edit, enable/disable,
connect/disconnect/reconnect, and delete. Deliberately excluded, and still
placeholders: tools, agents, credentials, policies, sessions, activity, audit,
monitoring, settings, OAuth, vault, semantic routing, managed integrations.

What shipped, against the verified gateway contract (`apps/gateway/src/api/routes/backends.routes.ts`):

- `/dashboard/backends` — the registry table (`search`, `transport`, `enabled`,
  pagination, all server-side). Summary tiles read
  `GET /api/v1/monitoring/backends`, so a filtered page does not report its own
  row count as the registry total. A failed list read is an error state; a failed
  counts read degrades only the tiles.
- `/dashboard/backends/new` — one structured form, transport-adaptive (STDIO vs
  Streamable HTTP), with local rules mirroring the domain schema and an explicit
  **Validate** call to `POST /api/v1/backends/validate` that persists and dials
  nothing. Creating never connects.
- `/dashboard/backends/[backendId]` and `…/edit` — configuration from the item
  read, runtime from `…/runtime`, and a compare-and-set save that always sends
  the rendered `version` as `expectedVersion` (a query parameter, not a body
  field). A failed runtime read reports itself rather than passing off the
  reduced list status as live state.
- Writes go through the dashboard's own same-origin proxy
  (`/api/backends/[...path]`), which forwards the operator cookie and the CSRF
  token derived from the same session. The browser never reaches the gateway and
  never holds either. The proxy forwards backend write paths only, with UUID- and
  `$`-anchored patterns.
- Secret handling is structural, not cosmetic: `env` and `headers` values are
  `secret:<path>` / `env:<VAR>` references only. The form refuses a literal value,
  and no response can carry a secret because none is stored.

**Documented contract corrections and limitations:**

- `BackendRuntimeView` in the dashboard said `attempts`; the wire field is
  `reconnectAttempts` (`toView()` in `apps/gateway/src/adapters/lifecycle.ts`). Fixed.
- Filtering the registry by **runtime status** is not supported: the list route
  accepts `search`, `transport` and `enabled` only. The UI says so instead of
  offering a control that would filter nothing. Deferred until the API grows the
  parameter.
- Backend **tools** and per-backend **health/call history** do not appear on the
  detail page; those need the tool and activity APIs, which are out of scope here.

**Verification:** dashboard typecheck clean; 148 dashboard tests (was 38) across
13 files, including the client contract against a stubbed `fetch`, the write
proxy's allowlist and its refusals, the form's local rules, and the detail page's
degraded-runtime path; production dashboard build lists the four backend routes
and the proxy handler. Gateway suite unchanged at 528 tests; gateway build clean.
**Not verified:** a real browser click-path and a real connect — no backend was
registered or connected, and the running gateway was not restarted.

**Workstream 10.2 — Tool Explorer: implemented.**

Scope: the catalog only — list, filter, detail, discovery state, name conflicts,
and the two refresh routes. No invocation and no per-agent access matrix, both by
design (see below).

What shipped, against the verified gateway contract (`apps/gateway/src/api/routes/tools.routes.ts`):

- `/dashboard/tools` — the catalog table with the gateway's own `search`,
  `backendId` and `availability` filters and pagination. Counts read
  `GET /api/v1/monitoring`, the same payload `/overview` uses, so a filtered page
  cannot understate the catalog. Discovery reports and name conflicts are read
  separately and degrade on their own when they fail.
- `/dashboard/tools/[toolId]` — one tool addressed by **public name**
  (`<backend_id>__<original>`), which is what `GET /api/v1/tools/:publicName`
  keys on. Shows identity, availability, the owning backend, and the input,
  output and annotation schemas.
- Schemas are inert: Astryx `CodeBlock` from `JSON.stringify`, with copy. No
  HTML injection, no evaluation — an `inputSchema` is attacker-influenced data
  from a remote backend.
- Refresh uses the two real routes (`POST /tools/refresh`,
  `POST /backends/:id/tools/refresh`). Global refresh answers `200` with
  per-backend failures, so the summary reports refreshed *and* failed counts
  instead of assuming success from the status code. One run at a time.

**Documented contract corrections and limitations:**

- `DiscoveryReport` in the dashboard said `status: success|failed|pending` with
  `errorCode`/`errorMessage`; the wire shape is `never|ok|failed` with
  `toolCount`, `conflictCount`, `rejectedCount`, `lastError`
  (`discoveryReportSchema`). Fixed.
- `conflictCount` in a discovery report is a baseline `0` by design — the catalog
  computes the live number at read time. The UI reads `/tools/conflicts` for the
  real conflict list rather than printing a reassuring zero.
- **Admin test invocation is not implemented.** There is no REST invocation
  route, deliberately: a call goes through `/mcp` under an agent's credential and
  policy. The detail page states this rather than rendering a button with nothing
  behind it.
- **No availability-by-agent filter.** Agent access is a policy question
  answered per agent (10.4), not a property of a catalog row.

**Verification:** 187 dashboard tests (was 148) across 17 files, adding the tool
client contract, list states, detail (inert schema, conflict/disabled wording,
404), refresh (pending guard, partial failure), and the extended write allowlist.
Dashboard typecheck and production build green; gateway suite unchanged at 528;
gateway typecheck and build clean. **Not verified:** a real browser click-path
and a real discovery run against a connected backend.

**Workstream 10.3 — Agents and credentials: implemented.**

Scope: agent CRUD, enable/disable, credential issue/rotate/revoke, and a
read-only effective-access preview. Sessions, usage and activity on the detail
page are deferred to their own phases.

- `/dashboard/agents` — the registry table with the gateway's `search`, `status`
  and `clientType` filters. Counts read `GET /api/v1/overview`, because
  `/monitoring` does not report agents; the list is filtered and paginated, so
  counting its rows would understate the registry.
- `/dashboard/agents/[agentId]` — identity, credentials, effective access. The
  three reads are independent: a failed access evaluation does not hide the
  revoke controls.
- `/dashboard/agents/new` and `/edit` — one form. No `version` field exists on an
  agent, so there is no compare-and-set to promise; the form re-reads after
  saving. `null` clears a nullable field rather than storing an empty string.
- Credential panel: the raw token is rendered once, in memory, with explicit
  copy, and discarded on close. It is never written to browser storage, the URL,
  a log, or audit metadata, and the gateway stores only an HMAC digest, so it
  cannot be shown again.
- Rotation copy states the real semantics: replace, **no grace period**, previous
  credential revoked in the same transaction, sessions bound to it invalidated.
  A revoked credential is not offered Rotate (the gateway answers `409`).
- Disabling states that live sessions end, not just new ones. Delete states that
  credentials are revoked and assignments dropped, and that the record is
  tombstoned rather than erased.

**Deliberately not in 10.3:** creating a credential as part of "create agent"
(a token needs a panel built to show it once), a `metadata` editor (the map is
replaced wholesale; a JSON textarea would be a worse editor than none),
per-client connection instructions (no endpoint derives them), and sessions /
usage / activity sections (their own phases).

**Verification:** 253 dashboard tests (was 187) across 23 files. Dashboard
typecheck and production build green (four agent routes emitted); gateway suite
unchanged at 528; gateway typecheck clean. **Not verified:** a real browser
click-path and a real credential handshake against a live client.

**Workstream 10.4 — Access policies: implemented.**

Scope: policy CRUD, the rule editor, agent assignment, and an effective-access
preview that is the gateway's evaluator rendered verbatim.

- `/dashboard/policies` — the registry with the gateway's `search` and `effect`
  filters. The API exposes no registry-wide policy counts, so the tiles are
  computed from the visible page and labelled "on this page of N".
- `/dashboard/policies/[policyId]` — rules (ALLOW/DENY as words, not colour), the
  agents holding the policy, and a preview of one agent's access.
- `/dashboard/policies/new` and `/edit` — one form. Rules are a field of the
  policy, replaced wholesale, so the form always sends the full array; a partial
  send would keep rules that were just deleted.
- **Widening is confirmed, and enumerated:** a new ALLOW, a DENY flipped to ALLOW,
  a removed DENY (which restores access under deny-overrides-allow), and any `*`
  allow. A narrowing edit saves without a prompt. Nothing rewrites an effect on
  the operator's behalf.
- **Effective access is not recomputed in the browser.** The preview calls
  `GET /agents/:agentId/access` for an assigned agent selected by a plain GET form,
  so the URL reproduces it. A second rule engine would be a second answer.
- Assignment removal and policy deletion both state their real consequence
  (immediate withdrawal, cascade) before they happen.

**One gateway addition:** `GET /api/v1/policies/:policyId/assignments`. The
assignments sub-resource had `POST` and `DELETE` but no read, so the detail page
could say what a policy grants and not who receives it. It is the reverse of the
existing `listPoliciesForAgent`, backed by `listAgentsForPolicy` and the existing
`idx_assignments_policy` index, excludes tombstoned agents, returns the same
`Agent` shape as the agent list, and is covered by four new gateway tests.
Documented in `docs/API_REFERENCE.md` §3.6.

**Verification:** 339 dashboard tests (was 253) across 30 files; gateway 532 (was
528) across 27 files; both typechecks clean; dashboard production build emits all
four policy routes plus `/api/policies/[...path]`. **Not verified:** a real browser
click-path and a live agent handshake.

**Workstream 10.5 — Sessions: implemented.**

Scope: the MCP session registry, one session's binding and timing, and
termination.

- `/dashboard/sessions` — list with the gateway's own `agentId`, `status`
  (effective), `sort`, `order` and pagination. There is no `search` parameter in
  the contract, so there is no search box: an id lookup redirects to the real
  detail read, and a malformed id explains itself without asking the gateway.
- `/dashboard/sessions/[sessionId]` — identity, immutable agent/credential
  binding, both lifetimes, client metadata, and the terminate control.
- Counts come from `/api/v1/overview`, not from the visible page.
- **These are MCP agent sessions, not dashboard sign-ins.** `operator_sessions`
  is a different table with its own endpoints and is never read here (ADR-045).
- **Termination is a server operation.** `POST /sessions/:id/terminate` writes
  the row, releases the transport, writes one audit record, and refuses later
  requests with that protocol id. The dialog states the client impact and what is
  unaffected; the button is disabled in flight and the gateway's idempotency
  covers a double click.
- **No cleanup sweep and no `invalidate` UI.** Neither is in the write allowlist,
  so the browser cannot reach them even by hand.
- No token, hash, cookie, or transport state appears anywhere; `mcpSessionId` is
  displayed as the routing handle it is.

**One pre-existing test fixture bug fixed:** `apps/gateway/tests/sessions.test.ts` pinned its
clock to a date that has now passed while the repository derives a lapsed
lifetime from the real `Date.now()`, so thirteen tests began failing
independently of this batch. Both files matched `HEAD`; the fixture now starts at
real now.

**Verification:** 366 dashboard tests (was 339) across 34 files; gateway 532
across 27 files; both typechecks clean; dashboard production build emits
`/dashboard/sessions`, `/dashboard/sessions/[sessionId]` and
`/api/sessions/[...path]`. **Not verified:** a real browser click-path and a live
MCP client termination.

**Workstream 10.6 — Activity and Audit Trail: implemented.**

Scope: two separate views over two separate gateway tables, with CSV export of the
audit trail.

- `/dashboard/activity` — operational history: what the gateway *did*, with the
  gateway's own `type`, `outcome`, `agentId`, `backendId`, `search` (tool or
  request id) and `order`.
  Tiles come from `/overview.activity` and report the recorded totals only — no
  rate, no average, no graph, because none are collected.
- `/dashboard/activity/[eventId]` — one event. Tool arguments and results are
  never stored, so there is nothing to reveal or redact.
- `/dashboard/audit` — administrative history ("who changed what") with `action`,
  `actorType`, `actorId`, `targetType`, `targetId`, `result`, `search`, `order`.
- `/dashboard/audit/[eventId]` — one audit record, including `metadata`.
- `GET /api/audit-export` — CSV of the filtered trail, capped at 1000 rows across
  at most 10 pages, quoted unconditionally, with a leading `=`, `+`, `-`, `@`, tab
  or CR neutralised. Failure returns `AUDIT_EXPORT_FAILED`, never an empty file.
- **The two are never one table.** Different types, filters, tables, detail pages
  and status vocabularies; the two near-identical table modules are the deliberate
  cost of keeping activity from diluting the security record.
- **`metadata` is disclosed only by the detail read.** `toAuditListItem` omits it,
  so neither the list nor the CSV (built from the list shape) can contain it.
- **Audit immutability is structural.** No update or delete route exists, and the
  repository has no method for either; there is therefore no mutation control.
- `lib/events/query.ts` is the single URL→filter allowlist shared by the page,
  pagination links and the export. Values outside a closed enum are dropped rather
  than forwarded as a `400`. The `targetType` filter omits `operator`, which the
  event schema allows but the list schema does not.

**Verification:** 406 dashboard tests (was 366) across 38 files; gateway 532
across 27 files; both typechecks clean; dashboard production build emits
`/dashboard/activity`, `/dashboard/activity/[eventId]`, `/dashboard/audit`,
`/dashboard/audit/[eventId]` and `/api/audit-export`. **Not verified:** a real
browser click-path and opening a downloaded CSV in a real spreadsheet.

**Workstream 10.7 — Monitoring and diagnostics: implemented.**

Scope: runtime and dependency health, plus the safe facts a bug report needs.

- `/dashboard/monitoring` — four sections that are deliberately not one status:
  **liveness** (`/health`, never consults storage), **readiness** (`/ready`,
  storage plus the migration ledger, optional backends excluded), **dependency
  health** (`/monitoring/health`), and **backend runtime**
  (`/monitoring/backends`, per-connection state).
- `/ready` answers `503` with a real document, so the page trusts the validated
  body rather than `response.ok`; a proxy `503` error envelope is rejected instead
  of being mistaken for "not ready". `/health` is raw and validated by
  `isGatewayHealth`.
- Seven reads run concurrently and settle independently, so one failing endpoint
  degrades one card. A failed count renders `Unavailable`, never `0`.
- **No invented metric.** No uptime percentage, request rate, latency percentile,
  CPU or memory figure, and no chart: `/settings` reports `features.metrics:
  false` and the gateway keeps no history. Historical metrics are **deferred**,
  not faked.
- Diagnostics renders only the documented safe payload — identity, storage and
  migration state, environment, log level, counts, two limits. No env values,
  secrets, hashes, headers, paths, or stack traces; the page never falls back to
  its own process configuration.
- Manual refresh only, with a pending state and duplicate-transition protection.
  No polling, WebSocket, or Redis.

**Verification:** 421 dashboard tests (was 406) across 40 files; both typechecks
clean; the production build emits `/dashboard/monitoring`. **Not verified:** a
real browser click-path against a gateway in each of the four states.

**Workstream 10.8 — Settings and final regression: implemented.**

Scope: the last placeholder becomes a real screen, the placeholder mechanism is
deleted, and every route gets a final review.

- `/dashboard/settings` — the effective configuration, read-only. `/settings`
  answers `readOnly: true` and `features.settingsMutation: false`, and there is
  no write route, so the page shows values and says where they come from instead
  of drawing dead inputs. A test asserts no `form`, `input`, `select`, or submit
  control is rendered at all.
- Values are separated by governance: where the gateway listens; limits and
  sessions; backend connections (with `allowPrivateNetwork` flagged as
  security-relevant); capabilities as availability flags; logging.
- **No generic environment editor.** One would need write access the gateway does
  not expose and would make `settings.updated` a lie. Changes are made in the
  gateway's environment, followed by a restart.
- **Operator account deferred with a procedure, not a fake form:** no
  password-change API exists, so the page documents the real recovery (stop the
  gateway, delete the operator row, `pnpm operator:create`, restart).
- `features/placeholder/` deleted; `NavItem` lost its dead `implemented` and
  `summary` fields. The navigation table was diffed against the route tree:
  ten module roots in each, no orphans either direction.
- One `dashboard/loading.tsx` now streams a skeleton for all 23 routes.
- **Read proxy narrowed.** The browser-side allowlist previously forwarded six
  read paths that only server components use; it now forwards `/ready` alone, the
  one client-side gateway read. Unused proxy surface is removed, not retained.

**Verification:** 427 dashboard tests (was 421) across 41 files; gateway 532
across 27 files; both typechecks clean; both production builds clean. **Not
verified:** a real browser pass over all routes.

**Status: workstreams 10.0–10.8 are complete. Phase 10 is complete: every
dashboard route renders real API data, and no placeholder remains.**

## Phase 11 — Observability and operations

**Implemented.** Scope as specified: structured request logs, metrics
aggregation, health/diagnostics. Reconnect/backoff, audit, and runbooks were
already in place from Phases 4–8; this phase added the telemetry layer they
never had.

**Correlation and structured logging.** One `requestCorrelation` middleware
runs first on the outer app: it generates/echoes `X-Request-Id`, and accepts
`X-Correlation-Id` **validated, never trusted** (`^[A-Za-z0-9._-]{1,64}$`, else
replaced — an attacker-supplied string must not reach the log stream). Both ids
travel via AsyncLocalStorage, so deep call sites log them without a threaded
parameter and no global mutable context exists. Pino redaction covers
`authorization`, `cookie`, and credential/secret field families; tool arguments
and upstream responses are never logged. Migration `0007` persists
`activity_events.correlation_id`; audit keeps `requestId` only. Instrumented
sites: router, lifecycle, auth services, MCP handlers, session manager,
gateway modern leg.

**Metrics aggregation.** A hand-rolled in-memory registry
(`apps/gateway/src/monitoring/metrics.ts`) — no Prometheus/OTel/Redis dependency. Counter/
gauge/histogram primitives; **closed-enum labels only** (route class, MCP
method, outcome, transport, stable error code, HTTP status — never tool names,
agent ids, or user input); violations dropped and counted in
`umg_metrics_dropped_total`; per-metric series caps; the API never throws into
a request path. Every family is `umg_`-prefixed. `initialize` counts at
session creation — the one outcome the gateway owns, since the SDK answers the
request itself. Client-category errors feed a counter only; internal and
unhandled errors also enter a 20-entry ring of `{code, component, at,
requestId}` (never messages), surfaced by diagnostics.

**Export and access.** Root `GET /metrics` (Prometheus text 0.0.4) behind the
same operator session cookie and loopback check as `/api/v1`, mounted only when
an operator row exists — the same restart-after-`operator:create` semantics as
every configured feature. JSON twin `GET /api/v1/monitoring/metrics` inside the
versioned API. Registry is in memory: resets on restart, current facts not
history. DB op durations deliberately uninstrumented (synchronous better-sqlite3).

**Health vs readiness vs diagnostics** stay three distinct answers
(`/health` liveness, `/ready` storage+migrations, `/diagnostics` safe facts
including registry state and `recentErrors`). With a closed store, diagnostics
reports `database: unavailable` while metrics stay real — tested.

**Dashboard.** Monitoring page gains a Telemetry card — the eighth concurrent
read — rendering counters by exact metric and label, with "not read" for a
failed read and a true 0 for an unincremented family. Settings reports
`features.metrics: true` with the reset caveat. No proxy entry: the card is a
server-component read.

**Verification:** gateway 582 tests (was 532) across 31 files — 20 registry/
access tests, 11 instrumentation tests, correlation and redaction suites
included; dashboard 432 (was 427); both typechecks; both production builds;
OpenAPI route-table parity both directions; API_REFERENCE §1/§3.2/§4.4
document the two exports. **Not verified:** a real Prometheus scrape of a
long-running instance, and a browser view of the telemetry card against a live
gateway.

## Phase 12 — Integration-ready architecture

**Implemented** (executed ahead of the previously planned agent-compatibility
phase, which was in turn leapfrogged: Phase 13 became the first real provider —
GitHub — and agent compatibility renumbers to Phase 14). ADR-048–052. The goal
was the shape, not a provider: two tool source
types — MCP backends and managed integrations — sharing catalog, authorization,
execution, observability, and audit, with **zero production providers**.

**Tool sources and catalog.** Every catalog tool carries a stable
`{ sourceType, sourceId }` from the moment it enters the catalog: `mcp_backend`
(unchanged — `backendId` survives and equals `sourceId`) or
`managed_integration` (a gateway-generated connection id; no fabricated
`backendId`). One catalog with composite `"<sourceType>:<sourceId>"` snapshot
keys, so the same id in both types never collides; deterministic namespacing
(`<sourceId>__<tool>`) is reused, not forked, and **no existing MCP public
tool name changed**. Cross-source name collisions withhold both claimants and
report each source honestly.

**Registry and connectors.** Providers are registered in code — a module
constant that ships **empty**; no dynamic loading, marketplace, or plugins.
Registration is zod-validated, duplicate ids fail closed (`RESOURCE_CONFLICT`),
and declared capabilities are cross-checked against the connector's methods at
registration time. The connector contract separates discovery from execution,
mandates a timeout and an `AbortSignal` (enforced by the gateway's
`withCancellation` wrapper, not requested of the connector), and normalizes
errors to a closed kind set. The execution context is a whitelist — exactly
`{ connectionId, metadata, resolveCredential, signal, timeoutMs }` — no store
handle, no eager credential value, no agent or operator identity.

**Execution seam and policy.** One branch in `ToolRouter.call()` after
authorization; MCP-only helpers are narrowed to the MCP tool variant so the
compiler enforces the seam. Denied callers of managed tools get the uniform
unknown-tool answer and the connector records zero executions. The existing
policy evaluator is untouched: `sourceId` rides the existing `backendId` query
field (identical value for MCP), a `backend`-scoped rule naming a connection
id is **rejected at policy creation**, and managed tools are granted via
tool-scoped rules and wildcards exactly like MCP tools. Connector failures map
onto the existing public codes (`BACKEND_TIMEOUT`, `BACKEND_UNAVAILABLE`,
`VALIDATION_ERROR`, `BACKEND_CONNECTION_ERROR`, `TOOL_UNAVAILABLE`); the
connector's own message stays in `details`. `reauthorization_required` flips
the connection status, withdraws its tools, and fails closed until an operator
acts — the router never drives a connection out of trouble.

**Credentials.** An AES-256-GCM envelope vault (`apps/gateway/src/integrations/vault.ts`):
per-record random DEK with per-record nonces, a versioned envelope
`{v, keyId, wrappedDek, wrapNonce, wrapTag, nonce, ct, tag}`, master key from
`INTEGRATION_MASTER_KEY` only (optional `INTEGRATION_MASTER_KEY_PREVIOUS` for
rotation), lazy fail-closed — a missing key never blocks startup but no
credential can ever be stored without one. The database holds a reference id;
audit rows record `integration.credential.sealed` / `.resolved` with the
reference, never the value; no endpoint returns a value. The security suite
scans every database file byte-for-byte for the plaintext after a round trip.

**Connection lifecycle.** Seven statuses with legal edges declared as data;
every non-terminal status can reach `disabled` (an operator can always turn a
connection off, including mid-connect), `disabled` is the only terminal, and
`error` / `reauthorization_required` exit only through an explicit operator
connect. Withdrawal is synchronous with the state change; removal cascades the
credential rows structurally.

**Database and API.** Migration `0008` is additive-only: two new tables plus
nullable `activity_events.connection_id`, tested against a genuine Phase 11
database built with Phase 11-shaped SQL — every row survives, the new tables
arrive empty, reopening is idempotent, hand-edited rows fail at the read
boundary. The operator API gains two read-only endpoints,
`GET /api/v1/integrations/{providers,connections}`, behind the same operator
session as every `/api/v1` route, answering honest empty states in production
(`[]` — the registry ships empty). OpenAPI parity holds in both directions.
No write endpoint and no dashboard page exist: with zero providers, both would
be surfaces over nothing.

**Verification:** 76 new gateway tests across five suites — vault (14),
domain/registry/catalog (22), execution through the real router seam (22),
database/migration (8), security regression (10) — → 658 gateway across 36
files; dashboard 432 unchanged; both typechecks; both production builds.
**Not built:** any real provider, any OAuth flow, the operator write API, any
dashboard integrations page. **Not verified:** nothing claims provider behavior
beyond fixture connectors, because no provider exists.

## Phase 13 — First real provider integration (GitHub)
**Implemented.** ADR-053. The Phase 12 machinery got its first live occupant:
GitHub, code-registered, fine-grained PAT, **read-only**.

- **Provider and connector.** `githubRegistration` is the registry's first
  entry (still code — ADR-050 holds). `createGitHubConnector({ fetchImpl?,
  sleep? })` owns its HTTP client: fixed origin `https://api.github.com`,
  HTTPS only, closed header set (`Authorization: Bearer`,
  `X-GitHub-Api-Version: 2026-03-10`, `Accept: application/vnd.github+json`,
  `User-Agent: universal-mcp-gateway`), one bounded retry only on
  `Retry-After ≤ 5s`, and a closed failure vocabulary — GitHub prose never
  crosses the connector boundary.
- **Six read-only tools.** `list_repositories`, `get_repository`,
  `list_issues`, `get_issue`, `list_pull_requests`, `get_pull_request`:
  strict zod inputs, bounded pagination, timeouts with cancellation, and
  normalizers that refuse (never pad) malformed provider shapes.
- **Operator write API.** Create (`pending`), write-only credential seal,
  `test` (data either way, moves nothing), `enable` (the only door to
  `connected`; stamps `validatedAt`, migration `0009`; publishes tools),
  `disable`/`disconnect`/`DELETE`, every write behind session + CSRF +
  origin and audited through the Phase 12 closed enum.
- **Dashboard.** Three routes — list, create (the step that takes no secret),
  detail — with the PAT living in one password field that is cleared when the
  request answers, never rendered back, never persisted; destructive steps
  confirm with their real consequence stated.
- **Testing discipline.** Zero calls to `api.github.com` from the repository:
  the client's injectable `fetch` carries every suite. Gateway 697 tests
  across 38 files; dashboard 470 across 45; both typechecks; both
  production builds. **Not built:** OAuth, GitHub Apps, webhooks, enterprise
  hosts, write tools, any second provider. **Not verified:** a live GitHub
  round trip with a real PAT — deliberately; the first one happens when an
  operator runs `test` or `enable` with their own token.

## Phase 14 — Agent compatibility
**Implemented.** Audit first, then an SDK-driven harness, then real clients
where an isolated probe was possible. `docs/AGENT_COMPATIBILITY.md` is the
deliverable; nothing in it outruns its evidence.

- **Stack pinned, not assumed.** Server and client SDK 2.4.0 (LATEST
  `2025-11-25`, supported back to `2024-10-07`), hono adapter 2.0.2; both
  protocol eras served through the SDK's own `isLegacyRequest`.
- **Harness.** `apps/gateway/tests/compatibility/` — six files, 34 tests, scenarios A–F
  (basic protocol, authentication, authorization, session isolation, tool
  interoperability, failure/resilience), every one driven by the official
  client SDK over a real loopback socket against real stdio fixture
  subprocesses; a new `shapes` fixture mode covers nested/enum/unicode/
  structured/large payloads. Closes the explicit-notification, DELETE, and
  stale-cursor gaps the audit found.
- **Real clients.** Claude Code 2.1.330 **VERIFIED** (isolated
  `--mcp-config` + `--allowedTools`, full tool round trip, unicode intact);
  OpenCode 2.3.2 **VERIFIED** (`mcp add`/`mcp list` health check, then a full
  `opencode run` round trip — all in a temp project); Codex CLI 0.171.0
  **PARTIAL** (registration, URL, and bearer-token plumbing verified; no
  end-to-end turn possible locally — the machine's Codex model key is
  rejected by the provider); DeepSeek Desktop **NOT VERIFIED** (not
  installed; installing a client needs approval that was not asked for).
  Every probe ran against a scratch gateway with test fixtures; every temp
  file holding a token was deleted afterwards; no existing client config
  was read for writing or modified.
- **Honest absences, kept.** No MCP-surface rate limiter exists by design, so
  no 429 scenario was faked; STDIO serving stays unsupported; no per-client
  code entered the gateway (the matrix is protocol-level, which is the
  point).
- **Verification:** 34 compatibility tests (gateway total 731 across 44
  files); both typechecks; both production builds; full root + dashboard
  regression. **Not built:** nothing — the phase required no gateway code
  change; the only source-adjacent edits are test fixtures. **Not
  verified:** DeepSeek Desktop (absent), Codex end-to-end (bad local login).

Further providers (FigCraft is a candidate, not a requirement) follow the
Phase 13 pattern: read-only first, code-registered, through the same seam;
add each only after the pilot is stable.

## Phase 15 — Hardening and release
*Integration-platform hardening (ADR-054) is **implemented** — see
`docs/INTEGRATION_PLATFORM.md`.* Audit-first, no widening: `enable` on a live
connection is the in-place refresh (`connected → connecting`), a failed refresh
withdraws stale tools and audits the failure, a connect continuation re-reads
the row so a racing delete/disconnect/disable wins (404/409, nothing
published), the GitHub client refuses redirects outright, and
`umg_tool_calls_total` gained a closed `source_type` label. Concurrency,
refresh, and credential-isolation regressions pin all of it; the six GitHub
tools and every prior suite stay green.

Still open under this phase (the release half):
- Security review.
- Performance and soak tests.
- Failure/recovery tests.
- Backup/restore verification.
- Documentation and versioning.
- Local deployment and process supervision.
- Explicit security gate before non-loopback exposure.

## Phase 16 — Second provider integration (Notion)

*Notion as the second code-registered provider (ADR-055) is **implemented** —
see `docs/providers/NOTION.md`.* Audit-first again: the platform-generalization
claim is now proven by a structurally different provider — internal connection
token (no OAuth), opaque cursor pagination, a block-tree content model, the
post-`2025-09-03` database/data-source split. Six read-only tools (`search`,
`get_page`, `get_block`, `list_block_children`, `get_database`,
`query_data_source`); fixed origin `https://api.notion.com`, pinned
`Notion-Version: 2026-03-11`, redirects refused, one bounded `Retry-After ≤ 5s`
retry; unknown and future block types recorded, never dropped. Zero
provider-specific logic outside `apps/gateway/src/integrations/notion/`: the registry entry
is the only core change, and the vault, lifecycle, catalog, authorization,
execution, audit, and metrics paths are reused unchanged — proven by a
router-level suite with two Notion connections, two agents, and a GitHub
connection publishing alongside (18 tools, zero collisions, each call carrying
its own connection's sealed token). No test dials `api.notion.com`; **live
account validation: NOT PERFORMED — requires separate user approval.**

## Phase 17 — Third provider integration (Slack)

*Slack as the third code-registered provider (ADR-056) is **implemented** —
see `docs/providers/SLACK.md`.* Audit-first a third time; the new proof is a
failure model GitHub and Notion do not share: **application failures arrive
as HTTP 200 with `{ok: false, error: "<code>"}`**, so the client reads both
envelope halves on every answer — a 200 is not a success until the body says
so, and the stable error code is the only failure-body text that crosses the
connector boundary. Credential: manually supplied **bot user OAuth token**
(`xoxb-`) — no OAuth flow, no refresh infrastructure; nine read scopes
(`channels/groups/im/mpim` `:read` + `:history`, `users:read`), and the
connector refuses non-bot tokens before any request leaves. Five read-only
tools (`list_conversations`, `get_conversation_info`,
`get_conversation_history`, `get_thread_replies`, `get_user_info`); fixed
origin `https://slack.com/api`, redirects refused, one bounded
`Retry-After ≤ 5s` retry; `ts` values are string ids
(`epoch.microseconds`), carried exactly, never float-parsed; unknown message
subtypes recorded, never dropped; cursors opaque, `limit` a deliberate ≤ 200
bound. **`search.messages` is excluded on the audit's research finding** —
user-token-only — documented, not approximated. Zero provider-specific logic
outside `apps/gateway/src/integrations/slack/`: the registry entry is the only core
change, and the vault, lifecycle, catalog, authorization, execution, audit,
and metrics paths are reused unchanged — proven by a router-level suite with
two Slack connections, two agents, and Notion and GitHub connections
publishing alongside (22 tools, zero collisions, each call carrying its own
connection's sealed token; workspaces never become identity). No test dials
`slack.com`; **live Slack workspace validation: NOT PERFORMED — requires
separate user approval.**

## Not scheduled (candidate future phases)
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
