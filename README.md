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

Phases 1–8 are complete. Phase 9 (dashboard foundation) is **complete in its
adjusted scope**: the foundation is implemented and verified. Phase 10.0
(dashboard operator identity and authentication) is **implemented** — the gateway
now requires an operator session on every `/api/v1` route and the dashboard has a
real login. The remaining Phase 10 modules are not built. Phase 11 (monitoring
and observability foundation) is **implemented**: structured correlated logging
and a metrics registry, exported at `GET /metrics` (operator-authenticated) and
`GET /api/v1/monitoring/metrics`. Phase 12 (integration-ready architecture) is
**implemented**: two tool source types — MCP backends and managed integrations —
share one catalog, one authorization model, and one audit trail. Phase 13
(First real provider integration — GitHub) is **implemented**: a code-registered,
read-only, fine-grained-PAT GitHub connector, the operator write API
(`test` answers as data; `enable` is the only path to `connected`), and three
dashboard routes; no test dials GitHub. Phase 15 (integration-platform
hardening) is **implemented**, audit-first (ADR-054): `enable` refreshes a live
connection in place, a failed refresh withdraws its stale tools, a racing
delete/disconnect/disable wins over an in-flight connect, the GitHub client
refuses redirects outright, and tool-call metrics split by a closed
`source_type` enum — the platform guide for the second provider is
`docs/INTEGRATION_PLATFORM.md`.
- Typecheck, build, and tests pass (`pnpm typecheck`, `pnpm build`, `pnpm test`,
  741 gateway tests; `pnpm test:dashboard`, 471 tests).
- Streamable HTTP `/mcp` verified against the official MCP Client SDK for both
  protocol eras (2025 `initialize` handshake and 2026 `server/discover`).
- `tools/list` serves the live catalog, filtered per agent; no backend is
  registered and none is connected in the production registry, so it is empty
  there by default.
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
- Phase 5: generic tool discovery, deterministic namespacing, a fail-closed
  collision policy, lossless JSON Schema forwarding, `tools/list` + `tools/call`
  over a low-level SDK `Server`, per-call timeout and cancellation, lifecycle
  synchronization, and a catalog management API. 47 new tests.
- Phase 6: agent profiles, per-agent bearer credentials, a default-deny policy
  engine enforced on both `tools/list` and `tools/call`, per-request
  authentication on `/mcp`, and `auth.*` / `access.denied` audit events. 69 new
  tests.
- Phase 7: persistent session isolation — one protocol session bound to one agent
  and one credential, immutable at the database level; idle and hard-cap expiry
  enforced per request; invalidation on revocation/rotation/disable/delete;
  terminate, cleanup, and inspect endpoints; and `session.*` audit events. 65
  new tests → 437 total. Session serving is single-process by construction
  (`docs/ARCHITECTURE.md` §10).
- Phase 8: management API completion — overview, monitoring (+ four
  sub-resources), `/ready`, diagnostics, read-only settings, filterable and
  paginated activity and audit, and an OpenAPI 3.1 document checked against the
  live route table. One snapshot reader feeds every ops endpoint so counts
  cannot disagree; an unavailable store reports `null`, never `0`. 49 new tests
  → 486 total.
- `/health` reports `backendCount: 0`; production backend registry is empty.

**Phase 10.0 — dashboard operator identity and authentication.** ADR-045; the
gateway now requires an operator session on every `/api/v1` route, and the
dashboard has a real login.

- One local operator in `admin_users` (migration `0006`, additive). scrypt hashes
  from `node:crypto` with the parameters encoded in the stored string.
- Opaque server-side sessions in `operator_sessions` — only an HMAC digest is
  stored — with idle (30 min) and absolute (12 h) lifetimes derived on read,
  rotation at login, immediate revocation, and lockout after five failures.
- Default-deny boundary in the gateway (`operatorAuth`) with a closed exemption
  list, plus `X-CSRF-Token` on every non-safe method. `/health` and `/ready` stay
  unauthenticated; `/mcp` is untouched and still uses per-agent bearer tokens.
- Dashboard `/login`, `/api/login`, `/api/logout`, a session probe, and an account
  menu. The dashboard never verifies a password and never mints a session.
- 42 new gateway tests (28 auth boundary + 14 identity), 13 new dashboard tests
  → 528 gateway / 38 dashboard.
- **Not built:** multiple operators, RBAC beyond `owner`, password-change and
  session-listing UIs, TLS, per-IP login rate limits, dashboard CSP. Loopback
  only; see `docs/SECURITY.md` §8.2.

**Phase 10.1 — backend management.** The first module page is real: the dashboard
now manages the backend registry end to end.

- `/dashboard/backends` (list, server-side search/transport/enabled filters,
  pagination, counts from `GET /api/v1/monitoring/backends`), `/backends/new`,
  `/backends/[backendId]`, and `/backends/[backendId]/edit`.
- Enable/disable, connect/disconnect/reconnect, and delete — with availability
  derived from the gateway's own rules and `expectedVersion` sent for the
  compare-and-set operations.
- Writes go through the dashboard's own allowlisted same-origin proxy
  (`/api/backends/[...path]`), which forwards the operator cookie and the CSRF
  token from one session probe. The browser never reaches the gateway and holds
  no token.
- `env`/`headers` values are `secret:<path>`/`env:<VAR>` references only. The
  form refuses a literal value; no response can carry a secret because none is
  stored.
- 110 new dashboard tests → 528 gateway / 148 dashboard. **Not built:** the other
  module pages (tools, agents, policies, sessions, activity, monitoring, audit,
  settings) remain honest placeholders; runtime-status filtering needs an API
  parameter that does not exist. No backend was registered or connected, and the
  running gateway was not restarted. See `docs/DASHBOARD.md` Part IV.

**Phase 11 — monitoring and observability foundation.** ADR-046, ADR-047; the
gateway now keeps structured, correlated logs and aggregate telemetry — with no
new runtime dependency.

- Correlation first on the outer app: `X-Request-Id` generated/echoed on every
  response; `X-Correlation-Id` accepted only when it matches
  `^[A-Za-z0-9._-]{1,64}$` — validated, never trusted. Both travel via
  AsyncLocalStorage, so no global mutable context exists and concurrent requests
  stay isolated. Migration `0007` persists the join on activity rows; audit
  keeps the gateway's own request id.
- Structured logging with serializer-level redaction (`authorization`, cookies,
  credential/token/secret field families); tool arguments and upstream responses
  are never logged.
- A hand-rolled in-memory registry (`src/monitoring/metrics.ts`): counters,
  gauges, bucketed histograms, `umg_`-prefixed, **closed-enum labels only** —
  never a tool name, agent id, or caller input; violations drop into
  `umg_metrics_dropped_total`. In memory only: resets on restart, current facts
  not history.
- Instrumented at every layer that owns an outcome: HTTP surfaces, MCP methods,
  tool calls, lifecycle (connect/reconnect/disconnect), auth, credentials,
  backends, sessions.
- Two exports, one boundary: `GET /metrics` (Prometheus text 0.0.4) behind the
  same operator cookie and loopback check as `/api/v1`, mounted only when an
  operator exists; JSON twin `GET /api/v1/monitoring/metrics` for the dashboard.
- The dashboard's monitoring page gains a fifth card (Telemetry) reading the
  registry by exact metric and label — no rates, no percentages, no charts — and
  `/settings` reports `features.metrics: true`.
- 50 new gateway tests (correlation, redaction, registry + access control,
  instrumentation) → 582; 5 new dashboard tests → 432.
- **Not verified:** a real Prometheus scrape of a long-running instance, and a
  browser view of the telemetry card against a live gateway.

**Phase 12 — integration-ready architecture.** ADR-048–052; the gateway can now
host two kinds of tool sources without forking any pipeline. Architecture only:
**zero production providers are registered**, and no connection can exist in a
production deployment.

- Every catalog tool carries a stable `{ sourceType, sourceId }`:
  `mcp_backend` (unchanged; `backendId` survives, equal to `sourceId`) or
  `managed_integration` (connection id; no fabricated `backendId`). One catalog,
  composite snapshot keys, deterministic namespacing reused — no existing MCP
  public tool name changed.
- A code-registered provider registry (`src/integrations/`): zod-validated
  registrations, duplicate ids refused, declared capabilities cross-checked
  against the connector. No dynamic loading, no marketplace, no plugins.
- Connectors are bounded guests: the execution context is exactly
  `{ connectionId, metadata, resolveCredential, signal, timeoutMs }` — no store
  handle, no eager credential value. Errors normalize onto the existing
  `BACKEND_*` codes; the connector's own message stays in `details`.
- One dispatch seam in the router, **after** authorization: a denied caller of
  a managed tool gets the uniform unknown-tool answer and the connector never
  runs. A `reauthorization_required` answer flips the connection status,
  withdraws its tools, and fails closed until an operator acts.
- Credentials are sealed in an AES-256-GCM envelope vault (per-record DEK,
  versioned envelope, master key from `INTEGRATION_MASTER_KEY` only, lazy
  fail-closed — no key means no credential can be stored, ever). The database
  holds a reference; no endpoint returns a value; a test scans every database
  file for the plaintext and finds none.
- Connection lifecycle is data: seven statuses, every non-terminal status can
  reach `disabled`, `disabled` is the only terminal, and `error` /
  `reauthorization_required` exit only through an explicit operator connect.
- Migration `0008` is additive only and is tested against a genuine Phase 11
  database: every row survives, the new tables arrive empty. Read-only operator
  endpoints `GET /api/v1/integrations/{providers,connections}` answer honestly
  (`[]` in production); managed calls reuse `tools.call` activity rows and
  `umg_tool_calls_total`.
- 76 new gateway tests across five suites (domain/registry/catalog, execution,
  vault, database migration, security regression) → 658; dashboard unchanged at
  432. **Not built:** the operator write API, any dashboard page, and any real
  provider — none exists to point them at.

**Phase 13 — first real provider integration (GitHub).** ADR-053. The registry's
first code entry: GitHub, **read-only**, fine-grained PAT.

- The provider-owned HTTP client (`src/integrations/github/`): fixed origin
  `https://api.github.com` (HTTPS only, nothing caller-suppliable can redirect
  it), closed header set (`Bearer`, `X-GitHub-Api-Version: 2026-03-10`,
  `Accept: application/vnd.github+json`, UA `universal-mcp-gateway`), one retry
  only on `Retry-After ≤ 5s`, and a closed failure vocabulary — GitHub prose
  never crosses the connector boundary.
- Six read-only tools (`list_repositories`, `get_repository`, `list_issues`,
  `get_issue`, `list_pull_requests`, `get_pull_request`): strict zod inputs,
  bounded pagination, timeouts with cancellation, normalizers that refuse
  malformed provider shapes rather than padding them.
- The operator write API on the same `IntegrationService`: create is `pending`;
  `credential` is write-only (a replacement deletes the previous envelope
  in-transaction); `test` is data either way and moves nothing; `enable` is the
  only path to `connected`, the only exit from `disabled`, the only reconnect —
  it stamps `validatedAt` (migration `0009`, nullable until first proof) and
  publishes the tools. Every write sits behind session + CSRF + origin and
  audits through the Phase 12 closed enum; the OpenAPI document keeps path
  parity by test.
- Three dashboard routes — `/dashboard/integrations` (list), `/new` (create,
  the step that takes no secret), `/[connectionId]` (credential panel,
  lifecycle actions, published tools). The PAT lives in one
  `type="password"`/`autoComplete="off"` field, is cleared when the request
  answers success or failure, and is never rendered back or persisted.
- 39 new gateway tests; the dashboard grows to 470 across 45 files. **Zero calls
  to `api.github.com` from the repository** — the client's injectable `fetch`
  carries every suite; the first live call is an operator's `test` or `enable`.

**Phase 9 — Astryx dashboard foundation.** A Next.js 16 / React 19 dashboard
lives in `apps/dashboard` (pnpm workspace) and uses Astryx directly as its design
system. The gateway did **not** move: it is still the root package, so there is no
`apps/gateway/package.json` and `dev:gateway` aliases the root `dev` script.

- `/dashboard` reads real data from `GET /api/v1/overview`; `/dashboard/backends`
  manages the registry (Phase 10.1). The remaining module routes (`/tools`,
  `/agents`, `/policies`, `/sessions`, `/activity`, `/monitoring`, `/audit`,
  `/settings`) exist as honest placeholders — no sample data, no fake counters.
- The gateway binds `127.0.0.1` and grants no CORS, so the browser never calls it.
  Server components use `GATEWAY_ORIGIN`; client refreshes go through the
  same-origin allowlisted proxy `/api/proxy/[...path]`.
- The header probe distinguishes *unreachable* (proxy `503` + error envelope)
  from *not ready* (gateway `503` + a valid readiness document) by payload shape,
  because both arrive as `503`.
- Astryx only: no shadcn/ui, no Radix UI.
- **Operator login is Phase 10.0 (implemented).** `pnpm operator:create` creates
  the single local operator; `/login` signs in; the gateway — not the dashboard —
  verifies the password and enforces the session on every `/api/v1` request. See
  "Operator sign-in" below and `docs/SECURITY.md` §4.3.
- **Not verified:** real-browser click-path behaviour (no browser automation was
  installed). Component behaviour is covered by jsdom tests; layout by SSR
  inspection and the production build. This applies to the login form too.
  See `docs/DASHBOARD.md` Part III.

**Nothing connects by itself.** Registration, validation, and enable/disable are
configuration operations: no process is spawned and no socket is dialled. A
connection happens only on an explicit `POST /backends/:id/connect`, and a
restart rewrites every persisted live state to `disconnected` without
reconnecting. Connecting discovers tools; disconnecting removes them.

**Tools are namespaced `<backend_id>__<tool_name>`.** Two backends claiming the
same public name have **both** tools withheld — never routed by discovery order.
Schemas are forwarded verbatim, validated with AJV where they compile, and
forwarded unvalidated (with the reason logged) where they do not. There is no
HTTP tool-invocation endpoint: calls go through `/mcp` only.

**Backends can now run processes and make outbound connections.** The outbound
policy (scheme, credentials, DNS-resolved destinations, redirects) is in
`src/security/network-policy.ts`; `ALLOW_PRIVATE_NETWORK` opens only
loopback/private/CGNAT and never metadata or link-local. TLS verification is
never disabled.

**`/mcp` requires a per-agent credential.** Every request presents
`Authorization: Bearer umg_live_…`, verified independently on that request.
Authorization is default deny: an agent sees only the tools its policies allow,
and a denied call answers `-32602 "Unknown tool"`, identical to a name that does
not exist. New agents have no credential and no access until an operator issues
one and assigns a policy.

**A protocol session is bound to the agent that opened it.** In the 2025 era the
SDK issues an `mcp-session-id`; the gateway stores it against the authenticating
agent and credential, and every later request must present both a valid bearer
*and* a session that is active, unexpired, and owned by that agent. A session id
is a routing handle, never proof: presenting one without a token is a 401.
Unknown, terminated, expired, revoked, and other-agent sessions all answer the
same `404 Session not found`. The 2026 era is per-request by protocol design and
has no session to bind. A sessionless one-shot `tools/list` still works exactly as
before.

**The management API requires an operator session** (Phase 10.0), is
loopback-only, and — since Phase 6 — can mint a credential. It is no longer
reachable by an anonymous local process, but a local user who holds the operator
password can still grant themselves MCP access. Treat it as a local operator CLI,
not a service. Do not expose this beyond loopback. See `docs/SECURITY.md` §3.1,
§4.1, §4.3, §5.

**Set `CREDENTIAL_HASH_SECRET` before connecting any agent.** In production a
missing or too-short secret refuses startup; in development the gateway starts
but every `/mcp` request answers 401 until it is set. There is deliberately no
auto-generated ephemeral secret, and no default value.

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
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | 30 min. A session unused this long is refused per request and swept by cleanup |
| `SESSION_MAX_LIFETIME_MS` | `43200000` | 12 h hard cap from creation, regardless of activity |
| `RECONNECT_ENABLED` | `false` | Auto-reconnect after a transient loss |
| `RECONNECT_INITIAL_DELAY_MS` | `1000` | First backoff step |
| `RECONNECT_MAX_DELAY_MS` | `60000` | Backoff ceiling |
| `RECONNECT_MAX_ATTEMPTS` | `5` | Attempts before giving up (1–100) |
| `RECONNECT_JITTER_RATIO` | `0.2` | ± fraction of each delay (0–1) |
| `ALLOW_PRIVATE_NETWORK` | `false` | Permit loopback/private HTTP backends (fixtures only) |
| `TOOL_DISCOVERY_TIMEOUT_MS` | `15000` | Bound on one backend's `tools/list` |
| `TOOL_CALL_TIMEOUT_MS` | `60000` | Ceiling on one `tools/call` (backend `timeoutMs` still wins if lower) |
| `CREDENTIAL_HASH_SECRET` | *(none)* | **Required for `/mcp`.** ≥32 chars. Read outside `Config`; production refuses startup without it |
| `CREDENTIAL_HASH_KEY_ID` | `v1` | Key id stored with each digest, for rotation |

Precedence: explicit overrides → environment → defaults. Invalid configuration
fails fast at startup with a message naming the setting. No YAML is read; no
secret is ever logged.

`.env.example` lists the common variables. There is no built-in `.env` loader —
export the variables or let your process manager inject them. `CREDENTIAL_HASH_SECRET`
is the only one with no default, and it is deliberately not part of `Config`.

## Development commands

Gateway (the root package):
```bash
pnpm install
pnpm dev            # tsx watch src/index.ts on 127.0.0.1:8787
pnpm typecheck
pnpm build
pnpm test
```

Dashboard (`apps/dashboard`, port 3000):
```bash
pnpm dev:dashboard       # next dev --port 3000
pnpm typecheck:dashboard
pnpm test:dashboard      # 38 jsdom component/validator tests
pnpm build:dashboard
```

Explicit aliases and the combined gate (identical behaviour to the commands
above, kept so a script name states its target):
```bash
pnpm dev:gateway         # same as pnpm dev
pnpm build:gateway       # same as pnpm build
pnpm verify              # both typechecks + both test suites
```

Run the gateway and the dashboard in two terminals. The dashboard shows
"Gateway unreachable" until the gateway is up; that is a real state, not an
error to work around. The dashboard talks to `GATEWAY_ORIGIN` (default
`http://127.0.0.1:8787`), which is server-only — never a `NEXT_PUBLIC_*`
variable, because the browser must not learn the gateway address.

## Operator sign-in (Phase 10.0)

The management API requires an operator session. Create the operator **once, on
the gateway host**:

```bash
pnpm operator:create
```

- The password is read from a TTY/stdin prompt, **never from argv** — an
  argument would land in shell history and process listings.
- The command refuses to run when an operator already exists. There is no default
  or generated password.
- An unconfigured instance answers login with *"No operator is configured. Run
  `pnpm operator:create` on the gateway host."* and nothing more.

Then open `http://localhost:3000`, which redirects to `/login`. Sign-in posts to
the dashboard's own `/api/login` route, which forwards the credentials to the
gateway over loopback; the gateway verifies the password, mints the session, and
the dashboard re-issues the cookie on its own origin. **The dashboard never
verifies a password** — it cannot, and that is the point.

| Setting | Default | Meaning |
| --- | --- | --- |
| `OPERATOR_SESSION_IDLE_TIMEOUT_MS` | `1800000` (30 min) | Session ends after this much inactivity |
| `OPERATOR_SESSION_MAX_LIFETIME_MS` | `43200000` (12 h) | Absolute ceiling, regardless of use |
| `OPERATOR_COOKIE_SECURE` | `false` | Set `true` only when serving over HTTPS. A `Secure` cookie on plain-HTTP loopback is silently dropped, so login would appear to do nothing |

Lifetime rules, locking, and CSRF are described in `docs/SECURITY.md` §4.3.
Calling the API directly (e.g. `curl`) needs the cookie and, for any write, the
`X-CSRF-Token` from login — see `docs/API_REFERENCE.md` §3.1.1.

**Loopback only.** The operator password and session cookie cross plaintext HTTP
inside the host. There is no TLS, no RBAC beyond a single `owner`, and no per-IP
login rate limit (per-account lockout: 5 failures → 15 minutes). Do not put this
behind a tunnel, reverse proxy, or non-loopback bind.

MCP agent authentication is unchanged and separate: `/mcp` still requires its own
per-agent bearer credential, an operator cookie is refused there, and an agent
bearer is refused on `/api/v1`.

Health:
```bash
curl -i http://127.0.0.1:8787/health
```

MCP endpoint:
```text
http://127.0.0.1:8787/mcp
```

Management API (operator session required, loopback only):
```bash
# Sign in first; keep the cookie and the CSRF token (Phase 10.0).
COOKIE=$(curl -s -D - -o /dev/null http://127.0.0.1:8787/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"username":"owner","password":"…"}' \
  | grep -i '^set-cookie:' | sed 's/.*umg_operator=\([^;]*\).*/umg_operator=\1/')
CSRF=$(curl -s http://127.0.0.1:8787/api/v1/auth/session -H "cookie: $COOKIE" | jq -r .data.csrfToken)

# Empty registry
curl -s http://127.0.0.1:8787/api/v1/backends -H "cookie: $COOKIE"
# {"data":[],"pagination":{"page":1,"limit":20,"total":0,"totalPages":0}}

# Validate a proposed configuration (persists nothing, connects nothing)
curl -s -X POST http://127.0.0.1:8787/api/v1/backends/validate \
  -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"name":"fs","connection":{"type":"stdio","command":"node","args":["server.js"]}}'

# Register a backend (configuration only — nothing is spawned or dialled)
curl -s -X POST http://127.0.0.1:8787/api/v1/backends \
  -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"name":"fs","connection":{"type":"stdio","command":"node","args":["server.js"],"env":{"KEY":"env:FS_KEY"}}}'

# Inspect, filter, and page (reads need the cookie, not the CSRF header)
curl -s 'http://127.0.0.1:8787/api/v1/backends?transport=stdio&enabled=true&page=1&limit=20&sort=name' \
  -H "cookie: $COOKIE"

# Connect explicitly, then inspect runtime state (Phase 4)
curl -s -X POST http://127.0.0.1:8787/api/v1/backends/<id>/connect -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF"
curl -s http://127.0.0.1:8787/api/v1/backends/<id>/runtime -H "cookie: $COOKIE"
curl -s http://127.0.0.1:8787/api/v1/backends/runtime -H "cookie: $COOKIE"
curl -s -X POST http://127.0.0.1:8787/api/v1/backends/<id>/disconnect -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF"

# Agents, credentials, policies (Phase 6). Writes carry the CSRF header.
curl -s -X POST http://127.0.0.1:8787/api/v1/agents \
  -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' -d '{"name":"coding-agent"}'
# Token is returned ONCE here; it is never readable again.
curl -s -X POST http://127.0.0.1:8787/api/v1/agents/<agentId>/credentials \
  -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' -d '{"name":"laptop"}'
curl -s -X POST http://127.0.0.1:8787/api/v1/policies \
  -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"name":"read-only","rules":[{"resource":"tool","target":"<backendId>__get_status","effect":"allow"}]}'
curl -s -X POST http://127.0.0.1:8787/api/v1/policies/<policyId>/assignments \
  -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF" \
  -H 'content-type: application/json' -d '{"agentId":"<agentId>"}'
# Read-only preview of what that agent may call, and why
curl -s http://127.0.0.1:8787/api/v1/agents/<agentId>/access -H "cookie: $COOKIE"

# Sessions (Phase 7). Internal ids only; a protocol session id is not accepted here.
curl -s 'http://127.0.0.1:8787/api/v1/sessions?status=active&limit=20' -H "cookie: $COOKIE"
curl -s http://127.0.0.1:8787/api/v1/sessions/<sessionId> -H "cookie: $COOKIE"
# Body is optional; the default reason is operator_terminated.
curl -s -X POST http://127.0.0.1:8787/api/v1/sessions/<sessionId>/terminate -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF"
# Expire idle/lapsed sessions now (row-retaining, safe to repeat)
curl -s -X POST http://127.0.0.1:8787/api/v1/sessions/cleanup -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF"

# Operations (Phase 8). Read-only.
curl -s http://127.0.0.1:8787/api/v1/overview -H "cookie: $COOKIE"
curl -s http://127.0.0.1:8787/api/v1/monitoring/backends -H "cookie: $COOKIE"
curl -s http://127.0.0.1:8787/api/v1/settings -H "cookie: $COOKIE"
curl -s http://127.0.0.1:8787/api/v1/diagnostics -H "cookie: $COOKIE"
# History: filters are closed enums; unknown values are 400, not empty pages.
curl -s 'http://127.0.0.1:8787/api/v1/activity?type=tools.call&order=desc&limit=50' -H "cookie: $COOKIE"
curl -s 'http://127.0.0.1:8787/api/v1/audit?result=failure&actorType=agent&limit=50' -H "cookie: $COOKIE"

# End the session (revokes the row, not just the cookie)
curl -s -X POST http://127.0.0.1:8787/api/v1/auth/logout -H "cookie: $COOKIE"

# Readiness (distinct from /health): 503 when storage or the ledger is unreadable.
curl -i http://127.0.0.1:8787/ready

# Then call /mcp as that agent
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'authorization: Bearer umg_live_…' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
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
| `GET` | `/api/v1/agents` |
| `POST` | `/api/v1/agents` |
| `GET` | `/api/v1/agents/:agentId` |
| `PATCH` | `/api/v1/agents/:agentId` |
| `DELETE` | `/api/v1/agents/:agentId` |
| `POST` | `/api/v1/agents/:agentId/enable` |
| `POST` | `/api/v1/agents/:agentId/disable` |
| `GET` | `/api/v1/agents/:agentId/access` |
| `GET` | `/api/v1/agents/:agentId/credentials` |
| `POST` | `/api/v1/agents/:agentId/credentials` |
| `POST` | `/api/v1/agents/:agentId/credentials/:credentialId/rotate` |
| `POST` | `/api/v1/agents/:agentId/credentials/:credentialId/revoke` |
| `GET` | `/api/v1/policies` |
| `POST` | `/api/v1/policies` |
| `GET` | `/api/v1/policies/:policyId` |
| `PATCH` | `/api/v1/policies/:policyId` |
| `DELETE` | `/api/v1/policies/:policyId` |
| `POST` | `/api/v1/policies/:policyId/assignments` |
| `DELETE` | `/api/v1/policies/:policyId/assignments/:agentId` |
| `GET` | `/api/v1/sessions` |
| `GET` | `/api/v1/sessions/:sessionId` |
| `POST` | `/api/v1/sessions/:sessionId/terminate` |
| `POST` | `/api/v1/sessions/cleanup` |
| `GET` | `/api/v1/activity` |
| `GET` | `/api/v1/activity/:eventId` |
| `GET` | `/api/v1/audit` |
| `GET` | `/api/v1/audit/:eventId` |
| `GET` | `/api/v1/overview` |
| `GET` | `/api/v1/monitoring` |
| `GET` | `/api/v1/monitoring/health` |
| `GET` | `/api/v1/monitoring/backends` |
| `GET` | `/api/v1/monitoring/sessions` |
| `GET` | `/api/v1/monitoring/runtime` |
| `GET` | `/api/v1/monitoring/metrics` |
| `GET` | `/api/v1/diagnostics` |
| `GET` | `/api/v1/settings` |
| `GET` | `/api/v1/openapi.json` |
| `GET` | `/api/v1/backends/:backendId/tools` |
| `POST` | `/api/v1/backends/:backendId/tools/refresh` |
| `GET` | `/api/v1/tools` |
| `GET` | `/api/v1/tools/discovery` |
| `GET` | `/api/v1/tools/conflicts` |
| `POST` | `/api/v1/tools/refresh` |
| `GET` | `/api/v1/tools/:publicName` |

Outside the version prefix: `GET /health` (liveness) and `GET /ready`
(readiness), `GET /metrics` (Prometheus text export; operator session required,
mounted only when an operator exists), plus `ALL /mcp` for the authenticated MCP
surface.

`GET /api/v1/openapi.json` is the authoritative contract (OpenAPI 3.1). It is
generated from a literal table and checked against the live route table by
`tests/openapi.test.ts`, so it cannot describe a route that does not exist.

Every request body must be `application/json`. Errors use one envelope:
`{ "error": { "code", "message", "requestId" } }`. The endpoint-by-endpoint
contract — pagination, filters, envelopes, operational payloads, and the two
Phase 8 behaviour changes — is `docs/API_REFERENCE.md`.

## Documentation

- `PRD.md` — full product requirements.
- `ARCHITECTURE.md` — system architecture (dashboard in §13).
- `DASHBOARD.md` — Part I: dashboard/Astryx product specification. Part II: what Phase 9 actually implemented.
- `BACKEND_SPEC.md` — management API and backend domain.
- `API_REFERENCE.md` — endpoint inventory, envelopes, filters, OpenAPI.
- `SECURITY.md` — security requirements.
- `DATABASE.md` — database model and persistence.
- `MONITORING.md` — logs, metrics, audit, operations.
- `AGENT_COMPATIBILITY.md` — which MCP clients work, with evidence.
- `ROADMAP.md` — implementation phases.
- `DECISIONS.md` — accepted decisions.
- `AGENT_GUIDE.md` — instructions for local coding agents.

## Next task

Phase 14 (agent compatibility) is **implemented** — see
`docs/AGENT_COMPATIBILITY.md` for the client matrix and its evidence: Claude
Code and OpenCode VERIFIED end-to-end, Codex CLI PARTIAL (no working local
login to drive a turn), DeepSeek Desktop NOT VERIFIED (not installed), and
the SDK harness (`tests/compatibility/`, scenarios A–F) carrying the
protocol-level proof for every standards-compliant client.

The integration-platform half of Phase 15 is **implemented** (ADR-054): an
audit-first hardening pass over the managed-integration platform — refresh in
place, honest failed-refresh state, concurrency ownership at the lifecycle
seam, redirect refusal in the GitHub client, and a source-typed tool-call
counter — with `docs/INTEGRATION_PLATFORM.md` written for whoever adds the
second provider.

Next: **the release half of Phase 15** (see `docs/ROADMAP.md`): security
review, soak and failure/recovery tests, backup/restore verification, docs
and versioning, local process supervision. Nothing non-loopback without the
explicit security gate.

**Start with a decision, not code:** each step needs user approval before
anything is registered or connected. Not to be added without approval: real
backends, agent client config changes, OAuth or any third-party auth flow,
non-loopback exposure. Still deferred from Phase 7–15: real-browser
click-path verification, per-backend `limited` queueing
(`docs/ARCHITECTURE.md` §11.2), backup/restore APIs, audit retention, session
cleanup sweep UI, operator password-change API.
