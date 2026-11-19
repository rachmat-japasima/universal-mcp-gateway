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
- What does not exist: identity, per-caller authorization, rate limiting, CSRF tokens. Any local process can call the API.
- Audit rows record `{ type: "admin", id: "local-operator" }` rather than an anonymous actor, so Phase 3 history does not later read as system-generated.
- Revisit in Phase 6 (ADR planned then): dashboard auth, agent credentials, and default-deny authorization. Until then no non-loopback exposure, per `docs/SECURITY.md` release gate.
- **Updated in Phase 6:** agent credentials and default-deny authorization exist, but **for the MCP surface only**. This ADR still describes the management API exactly as it is — unauthenticated and loopback-only — and that API can now mint an agent credential, which makes the boundary more consequential, not less. `GET /api/v1/system` now reports `capabilities.authentication: true` (the MCP surface can verify) plus a live `authentication: required | unavailable` field. See ADR-039.

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

## ADR-036 — Namespacing is total, deterministic, and identity-derived
**Status:** Accepted  
`publicToolName(backendId, originalName)` = two normalized segments joined by `__`.
- Normalization replaces **every** character outside `[A-Za-z0-9._-]` with `_`. Total rather than permissive, so a name that survives is always safe to put in a JSON-RPC message, a log line, and a URL path segment, and so two originals that differ only in punctuation (`search items`, `search_items`) become the *same* public name and are therefore caught by collision detection instead of quietly aliasing.
- Names over 128 characters are cut and suffixed with `__<8 hex of SHA-256(backendId, NUL, originalName)>`. The suffix comes from identity, not randomness: the same tool keeps the same public name across restarts and rediscoveries, so a persisted agent config or a client's cached tool list stays valid.
- Rejected alternative: appending a counter or UUID to every name. It would make collisions impossible to *detect*, which hides the real problem — two backends claiming one name — and it breaks the "same name every time" property above.
- Rejected alternative: permissive normalization that preserves the original characters. It would push escaping into every consumer and still allow collisions to differ only by a character no downstream system can represent.
- **Accepted limit:** normalization is lossy, so two genuinely different tools can collapse onto one public name. That is reported, not hidden: the catalog withholds both claimants.

## ADR-037 — Forward the backend's JSON Schema; validate with AJV; never rebuild it in Zod
**Status:** Accepted  
A backend's `inputSchema` is carried as an opaque `Record<string, unknown>` from `tools/list` to the wire, and compiled for argument checking with `fromJsonSchema`.
- Rebuilding each remote schema in Zod would lose `$defs`, `$ref` chains, formats, `additionalProperties`, and vendor extensions — and a gateway that loses schema detail silently weakens the backend's contract. Zod reconstructs the gateway's own contracts; it is the wrong tool for forwarding someone else's.
- `compileInputSchema` caches by schema object identity (WeakMap), so a schema is compiled once per discovery, not once per call.
- A schema that fails to compile (unresolvable `$ref`, unknown `$schema`) is forwarded **unvalidated**, with `unvalidatedReason` logged. The alternative — substituting `{type: 'object'}` — makes "we could not check" indistinguishable from "there are no constraints", and would also silently discard the schema the client was shown.
- Validation does not coerce. `{limit: "2"}` where the backend declared an integer is a client bug, and quietly fixing it produces a call the backend never expected.
- The advertised `outputSchema`, when present, is passed to `projectCallToolResult` so the SDK projects the result for the correct protocol era.
- **Accepted limit:** an uncompilable schema means no local validation for that tool. The backend is still the authority and will reject bad arguments; the gateway's rejection just arrives later.

## ADR-038 — The catalog is in-memory only
**Status:** Accepted  
`ToolCatalog` is derived state. There is no table, no migration, and no cache file.
- A persisted catalog outlives the connection it describes. It would either be served — lying about reachability — or distrusted on every read, which is the same as not storing it, plus a migration. Recovery already rewrites live connection state for exactly this reason (ADR-034); persisting the tools would recreate the problem one level up.
- A restart starts empty and rediscovery refills it. Discovery is idempotent, so "rebuild by asking again" is not just safe, it is the only description guaranteed to be current.
- The catalog is authoritative **within** its lifetime: routing reads it, but re-checks `isConnected` at call time rather than trusting the entry. A hint plus a fact beats two sources of truth.
- Conflict counts are computed at read time from the whole index rather than stored on each snapshot, because a conflict is a property of the catalog, not of one backend's discovery — and a stored count would go stale the moment a *different* backend connected or disconnected.
- **Accepted limit:** a process restart costs one `tools/list` per connected backend before their tools are callable. Acceptable for a local gateway with a handful of backends; a persisted snapshot with a validity check would be the upgrade path if that stops being true.

## ADR-039 — MCP authentication is per request; the hashing secret lives outside `Config`
**Status:** Accepted  
Phase 6 authenticates `/mcp` and authorizes nothing else. Three decisions make that safe to state.
- **Per request, no session binding.** Every exchange presents a bearer credential and is verified independently. `sessions` is untouched and no binding table was added. Cost: one indexed SQLite read per request. Benefit: revocation, a disabled agent, and a policy edit take effect on the next call instead of the next handshake, and no client-supplied id can become proof.
- **Credentials are HMAC-SHA-256, not SHA-256.** A plain digest would let anyone with a database copy verify guesses offline. The key (`CREDENTIAL_HASH_SECRET`) is a symmetric secret; `hash_key_id` records which key produced a digest so rotation needs no flag day.
- **The secret is read outside `Config`.** `src/auth/credential-key.ts` and `src/index.ts` read the environment directly. Putting it in `Config` would put it one serializer away from `redactConfig`, a config dump, and an API response. Production fails startup when it is missing; development starts with keys that issue nothing, so `/health` and the management API keep working while every `/mcp` request fails closed with the same 401. No ephemeral secret is generated — it would verify tokens only until the next restart.
- **Accepted limit:** anyone who can read the process environment can mint credentials. There is no automatic rehash-on-verify, so key rotation means adding a key id, revoking, and reissuing.

## ADR-040 — A denied tool call is byte-identical to a nonexistent tool
**Status:** Accepted  
Authorization runs **before** routing in `ToolRouter.call`, and both outcomes produce `-32602` with the message `Unknown tool`.
- Resolving first — backend lookup, reachability check, schema compile — would let a caller distinguish "exists but not yours" from "does not exist" by error code, error text, or timing. That turns the tool surface into a discovery oracle for the catalog it was denied.
- One catalog read does precede the decision: `resolveTarget` maps the public name to its backend because a `backend`-scoped rule cannot be evaluated without it. It is a lookup in the gateway's own in-memory index, performs no DNS, no socket, and no backend call, and yields the same result for a real and an invented name.
- No backend name, backend id, policy id, reason, or input schema is disclosed. `toProtocolError` special-cases `TOOL_NOT_FOUND` with a fixed string rather than echoing `AppError.message`, so a future message change cannot reintroduce the leak.
- The real reason is not lost: `access.denied` records it with the agent, credential, correlation id, and resolved ids. Internal truth, public uniformity.
- **Accepted limit:** because a denial for an existing name and one for an invented name take the same path, the gateway cannot avoid the catalog read; it only avoids disclosing anything that distinguishes the two responses.

## ADR-041 — Policy precedence is priority-first, then deny
**Status:** Accepted  
`evaluateAccess` sorts candidates by policy `priority` desc, then `deny` over `allow`, then policy id, then rule index, and denies when nothing matched.
- The spec's "explicit deny overrides all allow" is reconciled as: an operator's explicit priority ordering is authoritative, so a deny at a higher priority beats an allow; at *equal* priority the deny wins. Encoding deny-first globally would make priority decorative and let a catch-all deny in a low-priority policy silently disable a specific allow.
- The remaining tie-breaks exist so the outcome never depends on row order. Without them, two policies with the same priority and conflicting effects would resolve differently after a vacuum or a re-insert.
- System restrictions (agent disabled, backend disabled) are applied by `AuthorizationService` *before* the comparator and cannot be re-enabled by any rule, so "never" does not depend on an operator remembering to write a deny.
- **Accepted limit:** an operator can accidentally let an allow outrank a deny by giving it a higher priority. `GET /agents/:id/access` shows the winning policy and reason for every tool, which is the intended place to notice it.

## ADR-042 — `tools/list` and `tools/call` share one decision function
**Status:** Accepted  
`tools/list` filtering and `tools/call` enforcement both call `AuthorizationService` — the former through `visibleTools`, the latter through `authorize` in the router.
- Two implementations would drift: a tool could be hidden but callable, or visible and then rejected. The view and the boundary are one function read two ways.
- The `ToolCatalog` is still authoritative for *what exists*; `AuthorizationService` only answers *may this agent use it*. Keeping those separate is why the catalog needed no change to support filtering, and why a policy does not have to be re-validated when the catalog changes.
- Both are re-evaluated per request, so there is no cached decision to invalidate when a policy is edited.
- **Accepted limit:** every listed tool costs one evaluation per policy rule; fine for operator-sized policy sets, and it would need indexing before thousands of rules per agent.

## ADR-043 — Session binding is a stored, immutable row; serving is per era
**Status:** Accepted
Phase 7 binds a protocol session to an agent, but the binding is an additional check, never a substitute for authentication.
- **Two eras, verified not assumed.** Against the installed SDK (`2.4.0`), the 2026 era (`2026-07-28`) is per-request and issues no `mcp-session-id`, so there is nothing to bind. The 2025 era does issue one and is served through `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator` + `onsessioninitialized`/`onsessionclosed`. Serving both from a design that assumes one shape would have been a fiction.
- **Two request shapes take the sessionful leg:** a 2025 `initialize` (where a session is created) or a request already carrying `mcp-session-id`. Everything else stays on the SDK's stateless leg. The obvious alternative — routing *all* legacy traffic through the sessionful transport — was tried and rejected: it turned every sessionless one-shot `tools/list` into `400 Server not initialized`, breaking Phase 1–6 behaviour for clients that never wanted a session.
- **Status is stored; lifetimes are derived.** `status` is written explicitly because a terminal state (`terminated`, `invalidated`) is a decision, not a clock reading, and an operator's terminate must survive a restart. A lapsed `expires_at` or idle deadline is still derived in `sessionStatus()` and enforced **on the request path**, so a missed cleanup sweep cannot extend access. Cleanup only writes back what a request would already refuse.
- **Invariants live in the database.** A partial `UNIQUE` on `mcp_session_id`, a `BEFORE UPDATE` trigger freezing `id`/`agent_id`/`credential_id`/`mcp_session_id`/`created_at`, `sessions_no_reactivation`, and `sessions_terminal_is_complete` hold for every writer — including a second gateway process — which no in-memory lock could promise. Triggers rather than `CHECK` because SQLite cannot add a table-level constraint with `ALTER TABLE`.
- **The transport registry is process-local, and says so.** `McpSessionManager` is a `Map` of protocol id to transport. A session created by one process cannot be served by another; this is documented rather than papered over, and no Redis or shared lock was added for a single-process local gateway. Removing it would require a shared registry, not a bigger mutex.
- **Concurrency needs no mutex.** `better-sqlite3` is synchronous on one handle, and every session write carries its precondition in the `WHERE` (`status = 'active'`, `last_activity_at <= ?`), so decide-and-write is one statement. There is no window to lock and no lock to leak. `endWhere` uses `RETURNING` to release exactly the transports it ended.
- **Release is one-way through a callback.** `SessionService` takes `onEnded(sessions)`; `registry/` never imports `sessions/`. Every ending path — API terminate, revocation, rotation, disable, delete, cleanup, shutdown — funnels through it, so a dead session cannot leave an open server in memory.
- **Accepted limit:** a session id is useless without a bearer token, but the session refusals are deliberately uniform, so a client cannot tell *why* it was refused. That diagnosis lives in the `session.access.denied` audit row and the log, not on the wire (ADR-040's reasoning, applied to sessions).

## ADR-044 — Dashboard operator authentication is Phase 10, not a Phase 9 retrofit
**Status:** Accepted
Phase 9 delivers the dashboard foundation without an auth guard. Operator authentication is deferred to Phase 10.0 and must be built against a real identity model, not as a placeholder.

- **No identity exists to guard with.** The management API has never had an operator identity: it is unauthenticated and its boundary is loopback + Host/Origin + JSON content-type. A "guard" added now would have nothing to check a session against, so it could only be a flag that returns `true`. That is worse than no guard, because the UI would then label open operations as protected and teach an operator to trust a boundary that does not exist.
- **Placeholder auth is explicitly forbidden.** The project rules ban fake metrics, dummy records, and invented data; a dummy operator account or a hard-coded credential is the same class of problem, applied to security. It would also create a password-shaped artifact that must later be migrated or deleted.
- **Phase 9's own scope is the reason the deferral is safe.** Every module route except `/dashboard` is a placeholder with no mutation control, so there is no state-changing surface being left unguarded. The one exposed capability is a read of data that Phase 8 already serves to any loopback caller. Deferring does not widen access; it declines to *pretend* access is narrowed.
- **Two boundaries, not one ladder.** MCP agent credentials (Phase 6) and dashboard operator sessions answer different questions and must not share a table, a token format, or a verification function. An operator session must never authenticate an agent, and an agent bearer must never open the dashboard. Treating "we already did auth in Phase 6" as coverage for the dashboard would blur exactly the distinction that makes the agent boundary defensible.
- **The deferral is bounded and recorded, not open-ended.** Phase 10.0 is a prerequisite workstream with a required investigation list (single- vs multi-operator, identity model, mechanism, session lifecycle, cookies, login/logout, password vs external IdP, CSRF, authorization for sensitive operations, secret handling, local-only assumptions, recovery/bootstrap). No provider is chosen before that investigation; the choice gets its own ADR.
- **What still holds in the meantime.** Bind stays loopback. The browser still cannot reach the API directly — reads are server-side and client refresh goes through the same-origin allowlisted proxy. No tunnel, reverse proxy, or non-loopback bind. No "sign in", "account", or lock affordance appears in the UI while there is nothing behind it.
- **Accepted limit:** a local process or local user can do anything the API allows, exactly as before this phase. That is unchanged and documented in `SECURITY.md` §3.1 and §8.3 — the dashboard neither improves nor degrades it.

## ADR-045 — Phase 10.0: single local operator, opaque server-side session, gateway-enforced
**Status:** Accepted
Implements the boundary ADR-044 deferred. Scope is local-first: one operator account per gateway instance, session-based login, enforced in the gateway rather than in the Next.js app.

- **Identity model: one operator, no roles engine.** `admin_users` (already in 0001) holds `username`, `password_hash`, `enabled`, plus a `role` column that stays `owner`. Multi-operator, invitations, and role management are *not* built: they need an approval model, an audit story for privilege changes, and a UI that Phase 10 modules will need anyway. A single operator is the honest description of a local-first control plane, and the schema does not block adding peers later — `role` and the per-row timestamps already exist. Providing a role column is not the same as providing RBAC; nothing reads it.
- **Password hashing: scrypt from `node:crypto`.** No new dependency. Parameters are encoded *in the stored string* (`scrypt$N$r$p$salt$hash`) so a future cost bump verifies old hashes instead of locking the operator out. Verification uses `timingSafeEqual`. scrypt is memory-hard, which is the property that matters against GPU cracking of a human-chosen password; Argon2id would be marginally better but is not in the standard library, and adding a native module for a single-operator local tool is not a trade worth making.
- **No third-party identity provider.** An OIDC provider would mean a network dependency, an external account, and a redirect flow — for a gateway that must work offline on loopback. Passwords are the correct mechanism here. This decision is revisitable only if the product becomes multi-user and remote, which is explicitly out of scope.
- **Sessions are opaque, server-side, and stored in SQLite.** The cookie carries 256 bits of randomness; the server stores only an HMAC-SHA-256 digest (`operator_sessions.token_hash`) keyed by the same `CREDENTIAL_HASH_SECRET` already used for agent credentials, with its own key-id encoding. JWT was rejected: a stateless token cannot be revoked before expiry without a revocation list, and "logout must actually end access" is a requirement. Opaque + row lookup gives immediate revocation, single-session logout, and "disable the operator, end all their sessions" for free.
- **Session lifecycle mirrors the MCP session rules that already exist.** Idle timeout (default 30 min) and absolute lifetime (default 12 h), both enforced on read from the two stored instants, so a missed sweep cannot extend access. Rotation happens at login: a new session id is minted on every successful authentication, and the pre-login session (if any) is revoked, which is what makes session fixation impossible. Expired rows are kept with a reason for audit.
- **Cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` conditional.** The dashboard is served over plain HTTP on loopback, so `Secure` would make the cookie unreachable and produce a login that silently never works. Therefore `Secure` is set when the request arrived over HTTPS (forwarded proto is *not* trusted; the decision uses the explicit `OPERATOR_COOKIE_SECURE` setting, default off, documented as "turn on only behind TLS"). `SameSite=Strict` is the CSRF primary defence; a double-submit token is the second.
- **CSRF: same-site cookie + explicit token, not Origin alone.** `SameSite=Strict` stops cross-site sends, but same-site ≠ same-origin on loopback (another port is same-site), and a compromised sibling origin would pass. Every state-changing request therefore requires an `X-CSRF-Token` header matching a value bound to the session. The token is *derived*, not stored separately: `HMAC-SHA-256(key = the cookie value, message = "operator-csrf-v1")` (`csrfFor` in `src/registry/operator-service.ts`), so it cannot drift from the session, needs no extra column, and cannot be computed without the cookie — which is exactly what a cross-site request lacks. Comparison is `timingSafeEqual`. This is a second lock, not a defence against XSS: nothing cookie-derived is.
- **Enforcement lives in the gateway, not in Next.js.** This is the decision that matters most. The management API is reachable directly on `127.0.0.1:8787`; a Next.js middleware guard would be cosmetic, because any local process could still call the API. The gateway therefore verifies the operator session itself on every `/api/v1` request. A BFF-only design was rejected for exactly this reason — it protects the browser path and leaves the documented API path open.
- **The browser obtains a session by talking to the dashboard, which talks to the gateway.** Next.js route handlers own the login form POST, forward credentials to the gateway over loopback, and re-issue the gateway's `Set-Cookie` on the dashboard origin. The gateway is the only place a password is verified and the only place a session is minted. The browser never holds a gateway credential, and no internals are proxied: the allowlist still governs which reads exist.
- **Health and readiness stay unauthenticated.** `/health` and `/ready` are operational probes whose purpose dies if they require a session; neither returns sensitive data (counts and check states only). Everything under `/api/v1` requires an operator session except the auth endpoints themselves.
- **Bootstrap is a CLI command, not a default account.** `pnpm operator:create` reads the password from stdin or a TTY prompt with confirmation, never from an argument (which lands in shell history and `ps`). It refuses to run when an operator already exists, so it cannot silently reset a password. There is no default password, no generated password in the logs, and an unconfigured instance answers login with a clear "no operator is configured" rather than a crash loop.
- **Login failure is uniform.** Unknown operator, disabled operator, locked operator, and wrong password all produce one message and take comparable time (a dummy scrypt verify runs when no row matches, so response timing cannot enumerate usernames). Lockout is 5 failures → 15 minutes, stored on the row as `locked_until` so it survives a restart, and it is deliberately not permanent: a local operator with no recovery UI must not be able to lock themselves out forever.
- **Audit events are new enum values, not free-form strings.** `operator.login.succeeded`, `operator.login.failed`, `operator.logout`, `operator.session.revoked`, `operator.session.expired`, `operator.created`, `operator.disabled`, `operator.password_changed`. Actor type `admin`, actor id = the operator id for successes and `undefined` for failures (naming a username in an audit row would record an attempted identity). No password, no cookie value, and no token digest is ever written.
- **MCP authentication is untouched.** Different table, different digest key-id namespace, different verifier, different middleware, different cookie/header. An operator session is never accepted on `/mcp`, and an agent bearer is never accepted on `/api/v1`. ADR-039 and ADR-043 remain in force verbatim.
- **Accepted limits, stated plainly.** Loopback-only means any *local user* who can reach the socket can attempt a login; this raises the bar from "no authentication" to "must guess a password", not to "remote-hardened". `SameSite=Strict` means a deep link from an external site lands on the login page rather than the target. There is no rate limit per IP beyond per-account lockout, so a distributed guess against many usernames is not slowed — with one operator account, "many usernames" is not a practical surface. No TLS is terminated here, so cookies can be read by anything that can read loopback traffic; that is the documented cost of local HTTP.
