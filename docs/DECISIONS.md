# Architecture Decision Records

## ADR-001 — Generic gateway
**Status:** Accepted  
Universal MCP Gateway is a generic MCP control plane, not a FigCraft-specific bridge. Backend-specific behavior belongs in adapters.

## ADR-002 — Empty initial production registry
**Status:** Accepted  
Production registry starts with zero backends. Test fixtures are temporary and isolated.

## ADR-003 — Node.js + TypeScript ESM
**Status:** Accepted  
Use Node.js and TypeScript ESM with strict mode and NodeNext resolution.

## ADR-004 — pnpm
**Status:** Accepted  
Keep pnpm. Do not switch to npm.

## ADR-005 — Official MCP SDK
**Status:** Accepted  
Use official MCP TypeScript SDK packages for server/client/transport. Verify APIs against installed versions.

## ADR-006 — Hono
**Status:** Accepted  
Use Hono and `@hono/node-server` for HTTP application layer.

## ADR-007 — Local-first binding
**Status:** Accepted  
Default to `127.0.0.1:8787`, MCP `/mcp`, health `/health`. No remote exposure by default.

## ADR-008 — SQLite
**Status:** Accepted  
Use SQLite through `better-sqlite3` for local metadata/registry, with migrations and repository boundaries.

## ADR-009 — Dashboard is full-product scope
**Status:** Accepted  
A complete administration dashboard is required, including overview, backends, tools, agents, policies, sessions, activity, monitoring, audit, and settings.

## ADR-010 — Astryx is the direct UI library
**Status:** Accepted  
Use Astryx directly from `https://astryx.atmeta.com/` as the frontend component library and design system. Use its documented components, tokens, themes, and patterns.

## ADR-011 — No shadcn/ui
**Status:** Accepted  
Do not install, generate, or use shadcn/ui. This is not an Astryx-inspired shadcn implementation.

## ADR-012 — No Radix UI fallback library
**Status:** Accepted  
Do not introduce Radix UI as a substitute component library. If Astryx lacks a required component, create a focused custom component or propose an alternative for approval.

## ADR-013 — Next.js dashboard
**Status:** Accepted  
Use Next.js + React + TypeScript for the dashboard. Verify Astryx's current compatibility and setup requirements before implementation.

## ADR-014 — No dashboard before API/core stability
**Status:** Accepted with sequencing clarification  
Dashboard is part of the full product, but implementation begins after core APIs and domain contracts are stable.

## ADR-015 — Do not alter agent configuration yet
**Status:** Accepted  
Existing Claude Code, Codex CLI, OpenCode, and DeepSeek configurations remain untouched until the user explicitly approves connection work.

## ADR-016 — Session isolation and concurrency protection
**Status:** Accepted as product requirements  
Implement isolated sessions and per-backend/resource concurrency controls. Exact transport and locking design must be validated.

## ADR-017 — Windows + WSL2 boundary
**Status:** Accepted  
Gateway runs in WSL2; some desktop applications run on Windows. Do not assume shared paths/network behavior without testing.

## ADR-018 — Dynamic backend lifecycle
**Status:** Accepted  
Adding, updating, enabling, disabling, and removing a backend must not require rebuilding the gateway.

## ADR-019 — Local-first security
**Status:** Accepted  
Default deny for unknown identities, separate dashboard/MCP authentication, secret redaction, and explicit security review before remote exposure.

## ADR-020 — SDK v2 `createMcpHandler` as the MCP serving entry
**Status:** Accepted  
The installed SDK is MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0), which ships `createMcpHandler`: one entry serving both the 2025 `initialize` handshake and the 2026-07-28 `server/discover` era. We use it instead of hand-wiring a `WebStandardStreamableHTTPServerTransport` per request. Consequences:
- Serving is **stateless per HTTP exchange**; `McpServer` instances are constructed per exchange by a factory and never shared. There is no server-side session store yet, so a client-supplied `mcp-session-id` carries no authority and is ignored.
- On that stateless legacy leg the SDK answers `GET`/`DELETE` with `405`, so MCP session resumption and server→client notifications are not available until Phase 7 introduces session tracking.
- `HOST` is restricted to loopback values so the binding cannot drift from the DNS-rebinding allowlist.

## ADR-021 — Rejecting the Hono JSON body middleware
**Status:** Accepted  
`createMcpHonoApp` pre-parses JSON bodies and answers malformed input with a plain-text `400 Invalid JSON`. The MCP endpoint instead hands the raw `Request` to the handler so malformed bodies produce a JSON-RPC `-32700` parse error and oversize bodies a `413` — the behavior an MCP client can actually interpret. Host/Origin middleware is still applied explicitly, per SDK guidance that transport-level DNS-rebinding protection is deprecated in favour of middleware.

## ADR-022 — No workspace split yet; module layout as the seam
**Status:** Accepted  
The target architecture is a pnpm workspace (`apps/gateway`, `packages/shared`, `packages/config`). Phase 2 keeps a single package with an intentional module layout instead: `src/domain` (schemas, entities, repository interfaces), `src/shared` (error taxonomy), `src/config`, `src/core`, `src/infrastructure`. Reasons:
- `packages/shared` would have exactly one consumer until the dashboard exists (Phase 9). A package with one importer buys a build step and a version to keep in sync, not isolation.
- Moving `src/` requires a workspace reinstall, which re-resolves the native `better-sqlite3` build. That risk is not worth taking to relocate files that have no second consumer.
- The directory boundaries are already the package boundaries. Lifting `src/domain` + `src/shared` into `packages/shared` later is a move plus an import rewrite, with no redesign.
Revisit when the dashboard needs the domain contracts, or when a second runnable app exists.

## ADR-023 — Error taxonomy with one boundary-crossing error type
**Status:** Accepted  
`AppError` is the only error type permitted across a trust boundary. It carries a stable `ErrorCode` (never renamed; the dashboard and clients may branch on it), a client-safe message, log-only `details`/`cause`, and an optional `requestId`. Each code has a fixed category, HTTP status, and JSON-RPC code, so mapping is a table lookup rather than per-handler judgement.
- `toAppError()` collapses everything else into `INTERNAL_ERROR` with a generic message, preserving the original as `cause`. This is what stops SQLite text, filesystem paths, and stack traces from reaching a client.
- `describeErrorForLog()` is the log-only view: cause chain and stack, never serialized outward.
- Code strings are chosen to match the documented API envelope (`docs/BACKEND_SPEC.md`).

## ADR-024 — Tombstones for backends and agents, hard delete for policies
**Status:** Accepted  
Backends and agents are soft-deleted (`deleted_at`). Activity and audit history reference them, so a hard delete would either orphan or require `SET NULL` — losing "which backend was this?" forever. A tombstone keeps history resolvable and makes "was this ever configured?" answerable. A partial unique index (`WHERE deleted_at IS NULL`) still allows the name to be reused.
- Policies are hard-deleted, with assignments cascading. Nothing historic references a policy id: audit rows store `target_id` as a plain string plus a metadata snapshot, so the trail stays readable.
- Credentials and sessions are never deleted at all. Revocation is a timestamp, and the first revocation wins so the trail cannot silently move.
- Trade-off: tombstoned rows accumulate. A bounded, observable purge is a later operational concern, not a silent cascade.

## ADR-025 — Derived status instead of stored status columns
**Status:** Accepted  
`agent_credentials` and `sessions` have no `status` column. Status is computed from `revoked_at` / `expires_at` against the current time, with revocation winning over expiry. A stored status column can disagree with the timestamps after any partial update or clock-driven transition, and the disagreement is invisible. Deriving it makes that class of bug unrepresentable.
- `backend_runtime.status` *is* stored: it reflects an observed connection state that no timestamp can reconstruct, and it is written by the adapter that owns the connection.

## ADR-026 — Env-only configuration, no YAML in Phase 2
**Status:** Accepted  
Configuration comes from environment variables with documented defaults; YAML is not read. Nothing in this phase needs a nested shape, and a second source adds a precedence rule to implement, document, and test without buying anything. Precedence is strict and one-directional: explicit overrides → environment → defaults.
- `parseConfig()` is pure: it never exits, logs, or throws. `loadConfig()` throws `ConfigError`; only the process entry decides to exit. This is what makes configuration unit-testable.
- `HOST` is restricted to loopback values. Network exposure is a security decision requiring approval and review, not a config toggle.
- Secret *references* require an explicit `secret:` or `env:` scheme. No regex can distinguish a pasted secret (`sk-live-...`) from a variable name (`api-key`), so the scheme makes intent explicit and rejects literals by construction.

## ADR-027 — Validate a proposed config at `POST /backends/validate`, not `:backendId/validate`
**Status:** Accepted  
`docs/BACKEND_SPEC.md` originally listed `POST /api/v1/backends/:backendId/validate`. Validation is useful *before* creation — the dashboard validates a form before saving — and a proposed configuration has no persisted entity, so a path segment addressing one does not exist yet. Requiring a saved backend first would force operators to persist configuration they are still editing.
- The route is declared before `/:backendId`, so the literal `validate` is never parsed as a UUID.
- The response is a validation result with `200` (`{ valid, transport?, normalized?, errors? }`), not a `400`: the request was well-formed and the answer is "this configuration is invalid".
- Trade-off: an id-suffixed form would let an operator re-validate *stored* configuration. That arrives with the Phase 4 adapter, where real connection metadata exists to validate.

## ADR-028 — Optimistic concurrency on backend updates via a `version` column
**Status:** Accepted  
Two admins, or one double-clicked Save, read the same backend and write conflicting edits. Last-write-wins silently discards the other change, which is indistinguishable from success.
- `backends.version` (migration `0002`) is incremented by every persisted update. Update/enable/disable accept an optional `?expectedVersion=`, which turns the write into a single `UPDATE ... WHERE id = ? AND version = ?`. The check and the write are one statement, so no writer can interleave.
- A stale version yields `409 RESOURCE_CONFLICT`; the first writer's data is untouched.
- Omitting `expectedVersion` keeps last-write-wins, which is the sane default for scripts and single-operator use. Requiring it would break every simple `curl`.
- Trade-off: a client must round-trip the version it read. The list and detail responses include it, so this costs nothing beyond not discarding it.

## ADR-029 — Split REST and MCP Host/Origin guards; share the validators
**Status:** Accepted  
`hostHeaderValidation`/`originValidation` from `@modelcontextprotocol/hono` answer `403` with a JSON-RPC envelope. That is correct for `/mcp`: an MCP client parses JSON-RPC and would choke on a REST error body. It is wrong for `/api/v1`: a REST client parses `{ error: { code, message, requestId } }` and would see an unparseable 403.
- The SDK middlewares are scoped to non-API paths. The management API applies `validateHostHeader`/`validateOriginHeader` — the same allowlist logic, imported directly from `@modelcontextprotocol/server` — and formats the result in its own envelope.
- Security logic is therefore not duplicated: one implementation of the loopback allowlist, two response shapes.
- Trade-off: the app has two guard chains, so a future change to the allowlist must be applied via the SDK, not by editing one middleware. Keyword handlers (`app.use` with a path test) keep the split in one file (`src/core/gateway.ts`) rather than scattering it.

## ADR-030 — The management API is unauthenticated and loopback-only in Phase 3
**Status:** Accepted (interim)  
The API can create, modify, and delete backend definitions but has no authentication. Pretending otherwise would be worse than documenting it.
- What exists: loopback socket check, configured-`HOST` check, `Host` and `Origin` validation, JSON content-type requirement, size limits, strict Zod validation, parameterized SQL, and a non-leaking error envelope. These stop remote and cross-origin misuse.
- What does not exist: identity, per-caller authorization, rate limiting, CSRF tokens. Any local process can call the API. `GET /api/v1/system` reports `capabilities.authentication: false` so a client cannot mistake the posture.
- Audit rows record `{ type: "admin", id: "local-operator" }` rather than an anonymous actor, so Phase 3 history does not later read as system-generated.
- Revisit in Phase 6 (ADR planned then): dashboard auth, agent credentials, and default-deny authorization. Until then no non-loopback exposure, per `docs/SECURITY.md` release gate.

## ADR-031 — Validation messages echo only field names the gateway defines
**Status:** Accepted  
Error messages must help a caller fix a request without ever repeating what they sent. The naive version — "path and message, not the value" — is insufficient, because Zod puts caller-controlled *keys* into the path and into `unrecognized_keys` messages. A secret pasted into an env-var name (`{"env": {"sk-live-...": "x"}}`) or an unknown top-level field therefore reached the response and the audit log in testing.
- `safeIssuePath()` emits a segment only when it is in `KNOWN_FIELDS`, a literal set of the gateway's own field names. Everything else becomes `(redacted)`.
- `safeIssueMessage()` rewrites `unrecognized_keys` to a count, dropping the names entirely.
- A "looks like an identifier" regex was tried and rejected: `sk-live-ABCDEFGHIJKLMNOP` matches it, so the check cannot distinguish a secret from an env-var name.
- Two name positions are additionally constrained at the schema, which settles most of this by construction: env keys must be POSIX variables (`^[A-Za-z_][A-Za-z0-9_]{0,127}$`, so no hyphens) and header keys must be RFC 7230 tokens.
- Accepted limit: a header *name* that looks like a secret is a legal header name, and header names must be displayed for the config to be legible. It is treated as caller-supplied text (same class as `description`), not as a credential. Attempting to redact it would hide legitimate names like `X-Api-Key`.
- Trade-off: adding a schema field without adding it to `KNOWN_FIELDS` makes its name appear as `(redacted)` in error text. That is cosmetic and fails safe. Both `tests/api.test.ts` and `tests/backend-service.test.ts` assert a pasted-key secret never appears in a response or in `audit_events`.

## ADR-032 — Outbound destination policy before the socket, enforced per request
**Status:** Accepted  
Phase 4 makes the gateway dial operator-supplied URLs, which is an SSRF primitive unless destinations are constrained. A definition containing `http://169.254.169.254/` would otherwise turn the loopback-only API into a network scanner.
- Order: scheme (`http`/`https` only) → embedded credentials refused → hostname **resolved** → every returned address classified. String matching is insufficient: `metadata.google.internal` looks public.
- Checked inside the `fetch` the transport uses, not once at connect, so every request and every redirect hop is covered. `redirectPolicy: 'same-origin'` keeps a redirect from reaching a destination that was never checked.
- `ALLOW_PRIVATE_NETWORK=true` opens **only** loopback, RFC 1918, and CGNAT. Link-local (`169.254/16`, `fe80::/10`), unspecified, multicast, and reserved stay refused. This was tightened after a live test showed the original single-list implementation let `169.254.169.254` through when the flag was set — the opt-in exists for local fixtures, not as a general bypass.
- Rejected alternative: a per-backend egress allowlist. Premature — there is no policy engine until Phase 6, and an allowlist with one operator would encode the same host every time.
- **Accepted limit:** check-then-connect leaves a DNS-rebinding window between our lookup and the socket. Closing it needs a custom dialing agent that connects to the resolved IP; the remaining exposure requires a hostile DNS server for a hostname the operator chose themselves.
- TLS verification is never disabled anywhere: no `rejectUnauthorized: false`, no `NODE_TLS_REJECT_UNAUTHORIZED`, no custom agent.

## ADR-033 — One lifecycle manager per process, explicit connect only
**Status:** Accepted  
`src/adapters/lifecycle.ts` is constructed once in `createGateway()` and shared by the connect routes, the runtime reads, startup recovery, and shutdown. Duplicating it per request would give two views of "is this backend connected", and the second one would be wrong.
- The service layer stays synchronous and connection-free; the manager is the sole owner of processes and HTTP clients. Live objects never enter SQLite.
- **Nothing connects implicitly.** Create, update, and `enable` reconcile runtime state but never dial. A connection needs an explicit `POST /backends/:id/connect`. Before this phase the worst a local caller could do was edit rows; now it can spawn a process, so implicit dialling would widen the blast radius for no benefit.
- One promise chain per backend serializes concurrent connects, so a double-click cannot spawn two children.
- Retry: bounded exponential backoff with ± jitter, transient-only (`BACKEND_TIMEOUT`, `BACKEND_UNAVAILABLE`), off by default. A bad executable, a policy refusal, or rejected credentials is permanent — retrying cannot change the answer.
- Shutdown is sequenced inside `Gateway.close()`: MCP handler → lifecycle → store. A store closed under a running teardown could not persist a truthful row.
- **Accepted limit:** no health probing yet, so `unhealthy` is a legal state nothing sets in Phase 4. Adding a probe without tool discovery would be a timer that only proves the process is alive.

## ADR-034 — Startup recovery rewrites live state; `reconcile` after commit
**Status:** Accepted  
Two related choices about who decides what a change means for a live connection.
- **Recovery distrusts the database.** A persisted `connected` is a claim by a process that no longer exists. `recover()` rewrites `connected`/`connecting`/`unhealthy`/`disconnecting` to `disconnected` (or `disabled` when the config says so), resets `reconnectAttempts`, preserves `lastConnectedAt` as history, and **does not reconnect**. Trusting the row would either lie to the operator or auto-dial on boot — both unacceptable. A persisted `error` is preserved: it is still true.
- **One `reconcile()` per mutation, after the transaction commits.** Each mutating route calls `lifecycle.reconcile(id)` once; the manager re-reads the committed row, compares a connection fingerprint (`connection`, `timeoutMs`, `enabled`), and tears down a live connection whose fingerprint changed. The alternative — five change detectors, one per field — duplicates knowledge of the domain in the route layer and drifts. The manager is the only place that knows what a connection depends on.
- Fingerprint comparison, not a dirty flag: a `PATCH` that changes only `description` leaves the connection alone, which a flag would get wrong.
- Rejected alternative: an event bus between the service and the manager. One process, one caller, no fan-out — an emitter would add ordering questions with nothing to answer them.

## ADR-035 — A `disconnecting` state, added by a table rebuild
**Status:** Accepted  
Teardown is not instantaneous: a child gets stdin end → SIGTERM → grace → SIGKILL. Reporting `connected` while a process is being killed is a lie, and reporting `disconnected` before it exits is worse — the next connect could race the old child.
- `backend_runtime.status` gains `disconnecting` (migration `0003`). SQLite cannot alter a `CHECK`, so the migration rebuilds the table and copies every row inside the runner's transaction.
- The transition set is declared as data (`BACKEND_TRANSITIONS`) and enforced in `persist()`; an illegal edge throws `INTERNAL_ERROR` rather than storing an impossible status. This catches manager bugs at the write instead of at a later read.
- `disconnecting` is transient and never survives a restart: recovery treats it as dead-process state like `connected`.
- **Accepted limit:** the status is only as truthful as the last write. A `SIGKILL` of the gateway itself leaves whatever was last persisted; recovery exists precisely because that cannot be avoided.
