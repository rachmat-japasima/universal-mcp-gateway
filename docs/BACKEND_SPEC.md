# Backend and API Specification

## 1. Scope

Defines the management API, registry domain, MCP adapters, routing, and lifecycle. Everything described here is implemented through Phase 8; `docs/API_REFERENCE.md` is the endpoint-by-endpoint inventory and `docs/ROADMAP.md` lists what is still unbuilt.

Every route in this document is also described, machine-readably, by `GET /api/v1/openapi.json`. `tests/openapi.test.ts` holds the two in sync.

## 2. API conventions (implemented)

- JSON over HTTP; every request body must declare `application/json`.
- Versioned under `/api/v1`. There is no unversioned alias.
- Success envelope: `{ "data": ... }`, plus `"pagination"` on lists.
- Error envelope:

```json
{
  "error": {
    "code": "RESOURCE_CONFLICT",
    "message": "The backend was modified by another request. Reload and retry.",
    "requestId": "0be82930-c2e4-4e3f-be5a-b965811b951b"
  }
}
```

- Codes come from the fixed `ErrorCode` set in `src/shared/errors.ts`. `UNAUTHENTICATED`, `FORBIDDEN`, `BACKEND_NOT_FOUND`, `TOOL_NOT_FOUND` from earlier drafts are **not** used; the implemented set is `VALIDATION_ERROR`, `RESOURCE_NOT_FOUND`, `RESOURCE_CONFLICT`, `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `MCP_PROTOCOL_ERROR`, `BACKEND_CONNECTION_ERROR`, `BACKEND_TIMEOUT`, `BACKEND_UNAVAILABLE`, `DATABASE_ERROR`, `CONFIGURATION_ERROR`, `INTERNAL_ERROR`.
- `X-Request-Id` is echoed on every response. A well-formed inbound value is kept for log correlation; anything else is replaced. Phase 11 adds `X-Correlation-Id`: same treatment, but validated against `^[A-Za-z0-9._-]{1,64}$` and never trusted beyond that — it groups log lines and activity rows, and nothing else. Both ids are carried through AsyncLocalStorage, not a global.
- Every input is validated with Zod: body, query, and route parameters. Unknown **body** keys are rejected (`.strict()`). Unknown **query** *names* are ignored, because browsers and proxies add them freely (`utm_*`, cache busters); an unknown query *value* — a status outside its enum, a malformed UUID or date, `limit` above the cap — is still a `400`.
- Internal exception text is never serialized. Non-`AppError` failures become a generic `INTERNAL_ERROR`.
- Validation messages name the failing path and the rule, never a received value. A path segment is echoed only if it is a field the gateway defines; otherwise it is `(redacted)`. Zod's `unrecognized_keys` message is rewritten without the caller-supplied key names, because a pasted secret can arrive as a *name* rather than a value.
- Env keys must be POSIX names and header keys must be RFC 7230 tokens. See `docs/SECURITY.md` for the one accepted limit: a header *name* is config text and is displayed, not redacted.
- Secrets never appear in responses. Backend `env`/`headers` accept only secret *references*, so no secret value exists in a payload to leak.

## 3. Management endpoints (implemented)

### System
| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/system` | Service name/version, environment, endpoint paths, backend count, explicit capability flags (`backendConnections: true`, `toolRouting: true`, `authentication: true`), and a live `authentication` field (`required` or `unavailable`). |
| `GET` | `/api/v1/system/health` | Management-plane liveness. Distinct from `/health`, which stays dependency-free for the process probe. |

### Backends
| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/backends` | Paginated, filterable, searchable list. |
| `POST` | `/api/v1/backends` | Create. `201` with the sanitized backend. |
| `GET` | `/api/v1/backends/:backendId` | Detail, `404` if absent or tombstoned. |
| `PATCH` | `/api/v1/backends/:backendId` | Partial update. Optional `?expectedVersion=`. |
| `DELETE` | `/api/v1/backends/:backendId` | Tombstone. `200` with the pre-deletion representation. |
| `POST` | `/api/v1/backends/:backendId/enable` | Idempotent configuration enable. Does not connect. |
| `POST` | `/api/v1/backends/:backendId/disable` | Idempotent configuration disable. Disconnects. |
| `POST` | `/api/v1/backends/:backendId/connect` | Explicit connect. `409` if disabled. |
| `POST` | `/api/v1/backends/:backendId/disconnect` | Idempotent. Cancels retries. |
| `POST` | `/api/v1/backends/:backendId/reconnect` | Explicit retry; resets the attempt counter. |
| `GET` | `/api/v1/backends/:backendId/runtime` | Runtime state, no pids or connection details. |
| `GET` | `/api/v1/backends/runtime` | Runtime state for every backend. Literal route. |
| `POST` | `/api/v1/backends/validate` | Validate a *proposed* config; nothing persisted. |

**Documented deviation.** Earlier drafts put validation at `POST /api/v1/backends/:backendId/validate`. Validating a proposed configuration has no persisted entity to address, so it lives at `/backends/validate` (declared before `/:backendId` so the literal is never parsed as an id). ADR-027. The same ordering rule protects `/backends/runtime`.

**Not implemented (later phases):** `:backendId/health`. A health probe of a live backend still does not exist; `unhealthy` is in the state machine but nothing sets it.

### 3.1 List query parameters

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer ≥ 1 | `1` | |
| `limit` | integer 1–100 | `20` | 100 is the enforced maximum. |
| `search` | string, 1–200 chars | — | Case-insensitive substring over `name` and `description`. |
| `transport` | `stdio` \| `streamable-http` | — | |
| `enabled` | `true` \| `false` | — | |
| `sort` | `name` \| `createdAt` \| `updatedAt` | `name` | |
| `order` | `asc` \| `desc` | `asc` | |

Response:

```json
{
  "data": [],
  "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 }
}
```

- `total` counts all matches before `LIMIT`, so paging is safe while records are added.
- Ordering always tie-breaks on `id`, so equal names or timestamps cannot produce unstable pages.
- `search` uses `instr(lower(...))`, not `LIKE`: a user-supplied `%` or `_` is a literal character, not a wildcard.
- The sort column is interpolated from a fixed whitelist because SQLite cannot parameterize identifiers; every value is bound.

### 3.2 Create and update bodies

`POST /backends` requires only `name` and `connection`; defaults fill `enabled`, `timeoutMs`, and `concurrencyMode`.

```json
{
  "name": "filesystem",
  "description": "Local filesystem tools",
  "connection": {
    "type": "stdio",
    "command": "node",
    "args": ["/srv/mcp-fs/server.js"],
    "cwd": "/srv/mcp-fs",
    "env": { "API_KEY": "env:FS_API_KEY" }
  },
  "enabled": true,
  "timeoutMs": 30000,
  "concurrencyMode": "serialized"
}
```

`PATCH` accepts any subset of `name`, `description`, `connection`, `enabled`, `timeoutMs`, `concurrencyMode`, `concurrencyLimit`. Rules:

- `undefined` (field omitted) leaves the stored value untouched; `description: null` clears it.
- Immutable fields are rejected, not ignored: sending `id`, `version`, `createdAt`, or `updatedAt` is a `400`.
- Renaming onto another active backend's name is a `409`, not an opaque database error.
- Changing `transport` is allowed only by supplying a complete `connection` of the new type; the discriminated union prevents mixing transports.
- `updatedAt` is refreshed and `version` is incremented on every persisted change.
- **Concurrency:** `?expectedVersion=N` makes the write a compare-and-set in a single `UPDATE ... WHERE id = ? AND version = ?`. A stale value yields `409 RESOURCE_CONFLICT` and the first writer's data is kept. Omitting the parameter is last-write-wins, documented for scripts.

### 3.3 Enable, disable, and delete

- `enable`/`disable` change configuration **and** runtime: disable cancels a
  pending retry and tears the connection down; enable makes the backend eligible
  but never connects it. Lifecycle coordination happens after the transaction
  commits (`lifecycle.reconcile`), so the service itself stays synchronous and pure.
- They are idempotent: re-enabling an enabled backend returns `200` unchanged, writes no audit row, and does not bump `version`. A stale `?expectedVersion=` is still refused.
- Only two runtime transitions happen: disable → `disabled`; enable from `disabled` → `disconnected`. A `connected` state is never fabricated, and an `error` state is left alone.
- `DELETE` returns `200` with the representation the backend had immediately before deletion, so the caller sees what it removed. Deleting twice yields `404`.
- Deletion is a **tombstone**: the row keeps its id so `activity_events`/`audit_events` references stay valid; the runtime row cascades away; audit history is never cascade-deleted (ADR-024). The name becomes reusable.

## 4. Backend domain model (implemented)

### BackendDefinition (`src/domain/backend.ts`)
- `id` — UUIDv4.
- `name` — 1–120 chars, unique among active backends.
- `description` — ≤ 2000 chars, optional/nullable.
- `connection` — discriminated union on `type`.
- `enabled`, `timeoutMs` (100–600000), `concurrencyMode` (`parallel` | `serialized` | `limited`), `concurrencyLimit` (1–64, iff `limited`).
- `version` — integer ≥ 1.
- `createdAt`, `updatedAt` — UTC ISO-8601.

### BackendRuntime (`src/domain/backend-runtime.ts`)
- `status`, `lastConnectedAt`, `lastHealthCheckAt`, `lastErrorCode`, `lastErrorAt`, `lastErrorMessage`, `reconnectAttempts`, `updatedAt`.

Live clients, process handles, or transport instances are never persisted.

### 4.1 Validation rules

**stdio**
- `command` — required, trimmed, ≤ 1024 chars, and a **single executable token**. Whitespace, `;`, `&`, `|`, `<`, `>`, backticks, `$`, and parentheses are rejected, so a shell string cannot be smuggled in. `node server.js` must be `command: "node", args: ["server.js"]`.
- `args` — array of strings (≤ 64 entries, each ≤ 4096 chars), default `[]`.
- `cwd` — optional, trimmed, ≤ 1024 chars.
- `env` — record of ≤ 128-char keys to secret references matching `^(?:secret|env):[A-Za-z0-9._:/-]+$`. A literal value such as `sk-live-...` is rejected.
- **Never executed.** Validation is schema work only: no `spawn`, no `exec`, no shell.

**streamable-http**
- `url` — required, parsed as a URL, scheme restricted to `http`/`https`. `file:`, `javascript:`, and other schemes are rejected.
- `headers` — record of ≤ 128-char names to secret references, default `{}`.
- **Registry validation makes no outbound request.** `POST /backends/validate` performs no DNS lookup and opens no socket. The destination policy runs later, at connect time.
- Scheme, embedded credentials, resolved-address class, and redirects are enforced by the adapter's destination policy — see section 6.

`POST /backends/validate` answers `200` with `{ valid: boolean, transport?, normalized?, errors? }` — a validation *result*, not a request failure. Each error names a path and a message, never the received value.

## 5. Adapter framework (implemented in Phase 4)

Two files per transport plus one shared client wrapper. The interface is smaller
than the original target because lifecycle, retry, and health are owned by the
manager, not by adapters:

```typescript
interface BackendAdapter {
  readonly transport: 'stdio' | 'streamable-http';
  readonly target: string;             // loggable; never a secret
  readonly closedByPeer: boolean;
  readonly pid: number | undefined;    // stdio only, never exposed by the API
  connect(): Promise<McpBackendClient>;
  close(): Promise<void>;              // idempotent, safe after a failed connect
}
```

- `createAdapter()` switches on `connection.type`; adding a transport is one new
  file plus one case, with no change to the manager.
- `McpBackendClient` (`src/adapters/mcp-client.ts`) wraps the SDK `Client`. It
  exists to normalize SDK/transport/OS failures onto the gateway's `AppError`
  taxonomy, apply the per-call timeout, and own `close()`. It walks the error's
  cause chain so a wrapped `ECONNREFUSED` is still recognized as transient.
- Tool aggregation, namespacing, and routing are **not** implemented; the client
  exposes the read verbs because a health check and operator inspection need
  them. See section 7.

## 6. Transport configuration (implemented)

### stdio (`src/adapters/stdio-adapter.ts`)
- `command` is a single executable token and `args` is an array; the SDK spawns
  with `shell: false`, so there is no shell and nothing to interpolate.
- The child receives `getDefaultEnvironment()` (`HOME`, `PATH`, `USER`, `SHELL`,
  `TERM`, `LOGNAME`) plus explicitly referenced variables — never the gateway's
  whole environment.
- `cwd` resolves against the gateway's working directory.
- stderr is piped with a 2048-byte tail, redacted of credential-shaped tokens,
  and never logged verbatim. A failed handshake reports the last line.
- Teardown is the SDK's `close()`: stdin end → SIGTERM → grace → SIGKILL. Not
  reimplemented.
- A failed handshake closes the child before throwing, so no process leaks.

### Streamable HTTP (`src/adapters/http-adapter.ts`)
- Destination is resolved and classified before any socket opens
  (`src/security/network-policy.ts`). `fetch` is replaced by a guarded one, so
  every request is re-checked, which is also how redirects are covered.
- `redirectPolicy: 'same-origin'`: a cross-origin redirect fails instead of being
  followed to a new destination.
- TLS verification is never disabled anywhere in the codebase.
- Headers come from secret references and are never logged or persisted.
- SDK-internal reconnection is disabled (`maxRetries: 0`); retry policy belongs
  to the lifecycle manager.
- `terminateSession()` is attempted before close; a server answering 405 is not
  treated as a failure.

## 6.1 Runtime lifecycle (implemented)

`src/adapters/lifecycle.ts` is the only owner of live connections. Live objects
never enter the database; the database holds a truthful status row.

| Method | Behaviour |
| --- | --- |
| `recover()` | Startup. A persisted `connected`/`connecting`/`unhealthy`/`disconnecting` is rewritten to `disconnected` (or `disabled`). Never reconnects. A persisted `error` is kept. |
| `connect(id)` | Explicit. Idempotent under concurrency (one promise chain per backend). Refuses a disabled backend with `409`. |
| `disconnect(id)` | Idempotent. Cancels a pending retry, tears down, ends at `disconnected`. |
| `reconnect(id)` | Explicit retry. Cancels retries, tears down, resets the attempt counter, opens again. |
| `reconcile(id)` | Called by the registry after a mutation commits. Compares a connection fingerprint (`connection`, `timeoutMs`, `enabled`). Tears down a live connection whose fingerprint changed, honours disable/delete, and **never connects**. |
| `getRuntimeState` / `getAllRuntimeStates` | Read paths; fall back to the stored row, then to the initial state. |
| `shutdown()` | Stops all connections, cancels every timer, refuses new connects. Runs before the store closes. |

**State machine** (`src/domain/backend-runtime.ts`): `BACKEND_TRANSITIONS` declares
every legal edge and `canTransition()` enforces it. `persist()` throws
`INTERNAL_ERROR` on an illegal edge — a silently stored impossible status would
be worse than a crash. `disconnecting` exists because teardown is not
instantaneous and showing `connected` while a process is being killed is a lie.

**Recovery** uses exponential backoff with ± jitter
(`initialDelayMs * 2^(n-1)`, capped, then jittered). Only transient failures are
retried — `BACKEND_TIMEOUT` and `BACKEND_UNAVAILABLE`. A bad executable, a policy
refusal, or a rejected credential is permanent: retrying cannot change the answer.
Retries are off by default (`RECONNECT_ENABLED=false`).

**Secrets.** `env:` references are resolved from `process.env`. `secret:`
references fail loudly as `CONFIGURATION_ERROR` — there is still no secret store —
rather than being sent literally, which would look like an auth failure and hide
the real problem.

## 7. Tool routing (implemented in Phase 6)

Implemented in `src/routing/`, served on `/mcp`. Every step exists except 6 and 8,
which are Phase 7 concurrency control.

1. **Authenticate the caller** (Phase 6, before anything else runs). `mcpAuthenticate`
   verifies the bearer credential and establishes the agent for this exchange only.
2. **Evaluate effective policy** for that agent (Phase 6): system restrictions →
   priority → deny → default deny. A denial answers `-32602 "Unknown tool"` and
   stops — no backend read, no reachability check, no schema compile, no
   invocation. (The decision reads the in-memory catalog to learn a tool's
   backend for `backend`-scoped rules; that read behaves identically for a real
   and an invented name.)
3. Resolve public tool name against the in-memory catalog.
4. Resolve backend and original tool name; re-check the backend is enabled and
   connected at call time, so a stale mapping is refused rather than dialled.
5. Validate arguments against the backend's own JSON Schema. A schema that
   cannot be compiled is forwarded **unvalidated** with the reason logged, never
   replaced by a permissive stub (ADR-037).
6. Acquire scoped concurrency control — **Phase 7**. Today a call is forwarded
   immediately; there is no gateway-side lock.
7. Invoke backend with timeout/cancellation. Bound is
   `min(TOOL_CALL_TIMEOUT_MS, backend.timeoutMs)`.
8. Release lock/queue slot in `finally` — n/a until Phase 7.
9. Normalize result/error: a backend `isError` result is passed through as a
   result; a routing failure becomes a JSON-RPC error.
10. Record `tools.call` activity: backend, public name, outcome, error code,
    duration, and the bounded JSON-RPC id. Never arguments or results.

`tools/list` applies the same policy: it publishes only the tools this agent may
call, through the same `AuthorizationService`, so the view and the boundary cannot
drift.

### 7.1 Catalog endpoints (implemented)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/tools` | Catalog page; filters `backendId`, `availability`, `search` |
| `GET` | `/api/v1/tools/:publicName` | One tool, or `RESOURCE_NOT_FOUND` |
| `GET` | `/api/v1/tools/discovery` | Last discovery report per backend |
| `GET` | `/api/v1/tools/conflicts` | Public names withheld, with every claimant |
| `POST` | `/api/v1/tools/refresh` | Rediscover every connected backend; per-backend result |
| `GET` | `/api/v1/backends/:id/tools` | One backend's tools plus its report (`404` for an unknown backend) |
| `POST` | `/api/v1/backends/:id/tools/refresh` | Rediscover one backend; `503` on failure |

There is deliberately **no** HTTP tool-invocation endpoint. Invocation stays on
`/mcp`, so there is exactly one place where an agent can reach a backend and one
place where authorization is enforced.

## 7.2 Agent, credential, and policy endpoints (Phase 6)

All of these are on the loopback-only management API, which requires an operator session (Phase 10.0) and an `X-CSRF-Token` header on every non-safe method.

### Agents
| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/agents` | Paginated, filterable (`status`, `search`), sortable list. |
| `POST` | `/api/v1/agents` | Create. `201`. New agents have no credential and no policy. |
| `GET` | `/api/v1/agents/:agentId` | Detail, `404` if absent or tombstoned. |
| `PATCH` | `/api/v1/agents/:agentId` | Update name/description/clientType/metadata. |
| `DELETE` | `/api/v1/agents/:agentId` | Tombstone, revoke every credential, drop every assignment — one transaction. |
| `POST` | `/api/v1/agents/:agentId/enable` | Enable. No-op when already enabled (writes no audit row). |
| `POST` | `/api/v1/agents/:agentId/disable` | Disable. Effective immediately: authentication refuses the agent's credentials. |
| `GET` | `/api/v1/agents/:agentId/access` | Read-only preview: assigned policies and, for every tool in the current catalog, allowed/denied plus the reason. |

### Credentials
| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/agents/:agentId/credentials` | List. Never includes a token or verifier. |
| `POST` | `/api/v1/agents/:agentId/credentials` | Issue. `201` with the token **once** in the response; `409`/`500` if no hashing key. |
| `POST` | `/api/v1/agents/:agentId/credentials/:credentialId/rotate` | Create new + revoke old in one transaction; token returned once; one `credential.rotated` audit row with `previousCredentialId`. |
| `POST` | `/api/v1/agents/:agentId/credentials/:credentialId/revoke` | Idempotent; keeps the original `revokedAt`. |

A credential addressed under the wrong agent is a `404`, never a cross-agent
operation.

### Policies
| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/policies` | Paginated; filters `effect`, `agentId`, `backendId`, `search`. Every filter runs in the query, so `total` describes the filtered set. |
| `POST` | `/api/v1/policies` | Create. |
| `GET` | `/api/v1/policies/:policyId` | Detail. |
| `PATCH` | `/api/v1/policies/:policyId` | Update name/description/priority/rules. |
| `DELETE` | `/api/v1/policies/:policyId` | Hard delete; every assignment is dropped (`ON DELETE CASCADE`). |
| `POST` | `/api/v1/policies/:policyId/assignments` | Assign to an agent (idempotent). |
| `DELETE` | `/api/v1/policies/:policyId/assignments/:agentId` | Remove an assignment; `404` if not assigned. |

Rule targets are validated at write time: a `backend` target must exist in the
registry (or be `*`); a `tool` target must be a well-formed public name and is
**not** required to exist in the catalog, because the catalog is transient
(ADR-038).

## 7.3 Session management endpoints (Phase 7)

Read-and-terminate surface over the persistent session binding. Same loopback-only
operator boundary as everything else in §3 — an operator session plus CSRF on the
write — and this one can end a client's session, so it inherits §9's exposure rule
in full.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/sessions` | Paginated, filterable list. Never includes a token, verifier, or transport state. |
| `GET` | `/api/v1/sessions/:sessionId` | Detail by **internal** id. `404` if absent. |
| `POST` | `/api/v1/sessions/:sessionId/terminate` | Terminate. Idempotent. Body optional. |
| `POST` | `/api/v1/sessions/cleanup` | Expire idle/lapsed sessions now and report what changed. |

### Two identifiers

| | Internal `id` | `mcpSessionId` |
| --- | --- | --- |
| Path parameter | yes | no — a protocol id is never accepted as an internal id |
| Issued by | gateway | SDK transport, echoed by the client in `mcp-session-id` |
| Authenticates | nothing | nothing |

A path segment that is not a UUID is a `400`, not a `404`, so a client cannot use the
error to probe which protocol ids the gateway has seen.

### `GET /api/v1/sessions` query parameters

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer ≥ 1 | `1` | 1-based |
| `limit` | integer 1–100 | `20` | `MAX_PAGE_SIZE` |
| `agentId` | uuid | — | Exact owner |
| `status` | `active` \| `expired` \| `terminated` \| `invalidated` | — | **Effective** status: a lapsed but unswept session filters as `expired` |
| `createdAfter` | ISO datetime | — | Inclusive lower bound |
| `createdBefore` | ISO datetime | — | Inclusive upper bound |
| `lastActivityAfter` | ISO datetime | — | Inclusive lower bound |
| `sort` | `createdAt` \| `lastActivityAt` | `createdAt` | |
| `order` | `asc` \| `desc` | `desc` | |

An unknown *value* (a status outside the enum, a malformed UUID, `limit` over the cap) is a
`400 VALIDATION_ERROR`. Unknown *parameter names* are ignored, as everywhere else in the API —
proxies and editors add them freely. Both date bounds are inclusive and compared as stored
ISO strings.

```json
{
  "data": [
    {
      "id": "9f1c…",
      "mcpSessionId": "a4d1e0…",
      "agentId": "3b7e…",
      "credentialId": "c02f…",
      "status": "active",
      "createdAt": "2026-11-19T10:00:00.000Z",
      "lastActivityAt": "2026-11-19T10:04:12.000Z",
      "expiresAt": "2026-11-19T22:00:00.000Z",
      "metadata": { "clientType": "claude-code", "protocolVersion": "2025-11-25" }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`terminatedAt` and `terminationReason` appear only once a session has ended. Something
that has never been exposed is absent rather than `null`.

### `POST /api/v1/sessions/:sessionId/terminate`

Empty body is the documented call and defaults the reason to `operator_terminated`. A
supplied body must be `{"reason": "<closed enum>"}`; anything else is a `400`. The enum is
`operator_terminated`, `client_deleted`, `idle_timeout`, `max_lifetime`, `agent_disabled`,
`agent_deleted`, `credential_revoked`, `credential_rotated`, `gateway_shutdown`,
`transport_lost`, `cleanup`.

```bash
curl -s -X POST http://127.0.0.1:8787/api/v1/sessions/<id>/terminate
curl -s -X POST http://127.0.0.1:8787/api/v1/sessions/<id>/terminate \
  -H 'content-type: application/json' -d '{"reason":"transport_lost"}'
```

Idempotent: a repeat returns the same record with the same `terminatedAt`, and writes no
second audit row. A finished session cannot be returned to `active` — the database
refuses it. An unknown internal id is `404 RESOURCE_NOT_FOUND`.

### `POST /api/v1/sessions/cleanup`

Expires every session whose idle deadline or hard cap has passed. Row-retaining, and each
statement is conditional on `status = 'active'`, so it is safe to repeat and safe to run
concurrently with a request or a terminate.

```json
{ "data": { "expired": 1, "sessions": [ { "id": "9f1c…", "terminationReason": "idle_timeout" } ] } }
```

Cleanup is housekeeping, not the control: expiry is enforced on the request path, so an
unswept session is already refused. Running it twice changes nothing.

### What a client sees instead

An MCP request carrying a session id that is unknown, terminated, expired, belongs to
another agent, or whose credential was revoked answers **one** shape:

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32001, "message": "Session not found" } }
```

That refusal is identical for every cause on purpose (`docs/SECURITY.md` §5.3). The real
reason is in the `session.access.denied` audit row, not on the wire. Session ids are not
credentials: a session-bearing request with no valid bearer is a `401` before any session
lookup happens.

## 7.4 Activity and audit endpoints (Phase 8)

Two read-only surfaces over two deliberately separate logs. Neither has a write
verb: `ActivityRepository`/`AuditRepository` expose no update or delete method, so
append-only is a property of the interface rather than a permission check a future
route could bypass.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/activity` | Operational history. |
| `GET` | `/api/v1/activity/:eventId` | One event. `404` when absent. |
| `GET` | `/api/v1/audit` | Administrative history. `metadata` omitted. |
| `GET` | `/api/v1/audit/:eventId` | One event, `metadata` included. |

### Activity query parameters

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` / `limit` | integers | `1` / `20` | `limit ≤ 100` |
| `type` | closed enum | — | `mcp.initialize`, `tools.list`, `tools.call`, `backend.connected`, `backend.disconnected`, `backend.error`, `request.failed` |
| `outcome` | `success` \| `failure` \| `denied` | — | |
| `agentId`, `backendId` | uuid | — | Exact match |
| `toolName` | string 1–200 | — | Exact public tool name |
| `search` | string 1–200 | — | Substring over `tool_name` and `request_id` |
| `after`, `before` | ISO datetime | — | Inclusive bounds on `created_at` |
| `order` | `asc` \| `desc` | `desc` | Tie-broken by `id` |

### Audit query parameters

`action` (from `AUDIT_ACTIONS`), `actorType` (`admin`/`agent`/`system`),
`actorId`, `targetType` (`backend`/`agent`/`credential`/`policy`/`session`/
`settings`), `targetId`, `result` (`success`/`failure`/`denied`), `search`
(substring over `target_id` and `request_id`), `after`, `before`, `order`, plus
`page`/`limit`.

**Metadata is the disclosure boundary.** `GET /audit` renders the bounded columns
only; `GET /audit/:eventId` renders `metadata`. Reading one record is an explicit
operator act, and a list endpoint that forwarded free-form context would become
the leak path the day a caller put something in it.

## 7.5 Operational endpoints (Phase 8)

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/overview` | Dashboard landing payload: one snapshot of every aggregate. |
| `GET` | `/api/v1/monitoring` | Summary: runtime, storage, backends, sessions, tools, activity. |
| `GET` | `/api/v1/monitoring/health` | Storage and backend health summary. |
| `GET` | `/api/v1/monitoring/backends` | Counts, every runtime state, discovery reports, conflicts. |
| `GET` | `/api/v1/monitoring/sessions` | Effective session distribution, or `available: false`. |
| `GET` | `/api/v1/monitoring/runtime` | Version, Node, platform, uptime. |
| `GET` | `/api/v1/diagnostics` | Safe incident facts. Read-only. |
| `GET` | `/api/v1/settings` | Effective, non-secret configuration. Read-only. |
| `GET` | `/api/v1/openapi.json` | The OpenAPI 3.1 document. |

### Three rules the payloads keep

1. **Every number is real.** All counts come from a repository, the lifecycle
   manager, or the in-memory catalog. An empty registry reports zeros; nothing is
   sampled, estimated, or seeded with demo data.
2. **Unavailable is `null`, never `0`.** When a storage read fails, the
   storage-backed fields become `null` and `status` becomes `degraded`. The
   in-memory catalog is still reported, because it survives the outage.
3. **One snapshot.** `/overview`, `/monitoring*`, and `/diagnostics` all read
   through `opsSnapshot()` (`src/api/ops.ts`), so two endpoints cannot report
   different backend counts for the same instant.

`/ready` is outside `/api/v1` (infrastructure probes should not follow an API
version) and asks a different question from `/health`: liveness is "is this
process alive", readiness is "can it serve". It checks the database and the
migration ledger, and deliberately **not** optional backends — a gateway with
every backend disconnected is still ready to accept work. It is mounted only when
a store exists, because without one the gateway has no evidence to report.

`/settings` and `/diagnostics` are the two most tempting places to dump
`process.env`. Neither does: the key list is explicit, availability is reported as
booleans rather than values, and the credential HMAC secret is not part of
`Config` at all — which is what makes "no secret is reachable here" structural
rather than a promise in a comment.

## 7.6 Phase 8 contract changes

Two behaviour changes, both documented rather than silent:

| Route | Before | After | Why |
| --- | --- | --- | --- |
| `GET /api/v1/backends/:id/tools` | `200` + `[]` for an unknown backend | `404 RESOURCE_NOT_FOUND` | An unknown backend is not a backend with no tools. `GET /tools?backendId=` still answers an empty page, because that is a filter over a collection. |
| `GET /api/v1/policies?backendId=&limit=&page=` | `total` described the *unfiltered* page | `total` describes the filtered set | The filter ran after slicing, so a page could be short and its total wrong. It now runs in SQL (`EXISTS ... json_each`), like every other filter. |

A `backendId` or `agentId` policy filter that names nothing is a `404`, not an
empty page: a typo must not look like "no policies".

## 7.7 Integrations endpoints (Phases 12–13)

Operator-session-gated like every `/api/v1` route, with session + CSRF + origin
on every write (ADR-052/053; payload detail in `docs/API_REFERENCE.md` §3.10).

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/integrations/providers` | Registered providers. GitHub ships registered and read-only (ADR-053); the registry is code and cannot be widened at runtime. |
| `GET` | `/api/v1/integrations/connections` | Connections, newest first; `providerName` present iff the provider is still registered. |
| `POST` | `/api/v1/integrations/connections` | Create; the row answers `201` at `pending`. |
| `GET`/`DELETE` | `/api/v1/integrations/connections/{connectionId}` | Read one; hard delete answering with the removed row. |
| `POST` | `…/credential` | Write-only token seal (ADR-051); replacement deletes the previous envelope in-transaction. The only credential route, POST-only. |
| `POST` | `…/test` | Non-mutating handshake; **data either way**, no row change, no audit, no publication. |
| `POST` | `…/enable` | Connect: the only path to `connected`, the only exit from `disabled`, the only reconnect; stamps `validatedAt`, publishes tools, answers `{ connection, tools }`. |
| `POST` | `…/disable` / `…/disconnect` | Explicit rest states; tools withdrawn in the same instant. |
| `GET` | `…/tools` | The connection's published tools; a stranger id is `404`, not `[]`. |

The writes audit through the Phase 12 closed enum (`integration.connection.*`):
create, delete, and every lifecycle transition — enable, disable, disconnect —
write `integration.connection.updated`/`.created`/`.deleted` with a status
detail. `test` writes nothing, because it decides nothing. Every mutation is
attributed to the requesting operator (`{ type: 'admin', id: … }`).

This section also records the domain distinction the endpoints sit on
(ADR-048): a **backend** is an MCP peer configured by an operator; a
**provider** is a code registration; a **connection** is an operator's instance
of a provider. The tables are separate, the ids are disjoint, and a
`backend`-scoped policy rule naming a connection id is rejected at creation.
Managed tools are granted through tool-scoped rules exactly like MCP tools.

## 8. Error codes

Implemented: see section 2, plus the Phase 5 additions:

- `TOOL_NOT_FOUND` → HTTP 404 / JSON-RPC `-32602`
- `TOOL_UNAVAILABLE` → HTTP 503 / JSON-RPC `-32603`
- `TOOL_CANCELLED` → HTTP 408 / JSON-RPC `-32800`

The following remain **proposals** and must be added to `ErrorCode` before use — inventing them at a call site would break the contract:

- `CONCURRENCY_TIMEOUT`, `SESSION_NOT_FOUND`, `BACKEND_NOT_FOUND` (today covered by `RESOURCE_NOT_FOUND`), `UNAUTHENTICATED`/`FORBIDDEN` (today `AUTHENTICATION_ERROR`/`AUTHORIZATION_ERROR`).

## 9. API security

Implemented in Phase 3:

- Loopback-only enforcement per request: socket local address, configured `HOST`, `Host` header, and `Origin` header.
- JSON content-type requirement on any request that declares a content type, which blocks cross-site form posts (HTML forms cannot send `application/json` without a preflight the API never grants).
- Request-size limit before parsing; query-string length cap.
- Zod validation of body, query, and parameters; unknown keys rejected.
- Parameterized SQL everywhere; identifier quoting only from a whitelist.
- No internal exception text, stack traces, or driver messages in responses.
- Secrets are structurally absent from stored config (references only).

Phases 5–6 add:

- The MCP surface (`/mcp`) requires a per-agent bearer credential, verified on every request. It answers one uniform 401 for every failure.
- MCP authorization is default-deny, enforced on both `tools/list` and `tools/call`; a denial is byte-identical to an unknown tool.
- Credential tokens are returned exactly once and stored only as an HMAC-SHA-256 digest with a key id.
- `CREDENTIAL_HASH_SECRET` is read outside `Config`, so no API response or log line has a field that could carry it. Production refuses to start without it.

**Implemented in Phase 10.0:** management-API operator authentication (session cookie + CSRF token). **Still not implemented, and the API must not be described as production-secure:** TLS, per-IP rate limiting, per-operator RBAC (one `owner` role), and any form of non-loopback exposure. Any local user who can reach loopback *and* holds the operator password can call this API, including minting an agent credential. See `docs/SECURITY.md`.

Deferred: multiple operators and role management, owner confirmation flows for destructive or exposure-changing operations, password-change and session-listing UIs.
