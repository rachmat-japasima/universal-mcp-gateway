# Backend and API Specification

## 1. Scope

Defines the management API, registry domain, MCP adapters, routing, and lifecycle. Sections 2–4 and 7 describe **what Phase 3 implements**. Sections 5, 8, and 9 describe the target for later phases and say so explicitly.

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
- `X-Request-Id` is echoed on every response. A well-formed inbound value is kept for log correlation; anything else is replaced.
- Every input is validated with Zod: body, query, and route parameters. Unknown body/query keys are rejected (`.strict()`).
- Internal exception text is never serialized. Non-`AppError` failures become a generic `INTERNAL_ERROR`.
- Validation messages name the failing path and the rule, never a received value. A path segment is echoed only if it is a field the gateway defines; otherwise it is `(redacted)`. Zod's `unrecognized_keys` message is rewritten without the caller-supplied key names, because a pasted secret can arrive as a *name* rather than a value.
- Env keys must be POSIX names and header keys must be RFC 7230 tokens. See `docs/SECURITY.md` for the one accepted limit: a header *name* is config text and is displayed, not redacted.
- Secrets never appear in responses. Backend `env`/`headers` accept only secret *references*, so no secret value exists in a payload to leak.

## 3. Management endpoints (implemented)

### System
| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/system` | Service name/version, environment, endpoint paths, backend count, and explicit capability flags (`backendConnections: false`, `toolRouting: false`, `authentication: false`). |
| `GET` | `/api/v1/system/health` | Management-plane liveness. Distinct from `/health`, which stays dependency-free for the process probe. |

### Backends
| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/backends` | Paginated, filterable, searchable list. |
| `POST` | `/api/v1/backends` | Create. `201` with the sanitized backend. |
| `GET` | `/api/v1/backends/:backendId` | Detail, `404` if absent or tombstoned. |
| `PATCH` | `/api/v1/backends/:backendId` | Partial update. Optional `?expectedVersion=`. |
| `DELETE` | `/api/v1/backends/:backendId` | Tombstone. `200` with the pre-deletion representation. |
| `POST` | `/api/v1/backends/:backendId/enable` | Idempotent configuration enable. |
| `POST` | `/api/v1/backends/:backendId/disable` | Idempotent configuration disable. |
| `POST` | `/api/v1/backends/validate` | Validate a *proposed* config; nothing persisted. |

**Documented deviation.** Earlier drafts put validation at `POST /api/v1/backends/:backendId/validate`. Validating a proposed configuration has no persisted entity to address, so it lives at `/backends/validate` (declared before `/:backendId` so the literal is never parsed as an id). ADR-027.

**Not implemented (later phases):** `connect`, `disconnect`, `reconnect`, `:backendId/health`, `:backendId/tools`, and all `tools`/`agents`/`policies`/`sessions`/`settings` routes.

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

- `enable`/`disable` are **configuration-state** operations. No process is started or stopped; lifecycle coordination is Phase 4.
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
- **No outbound request.** Validating `http://10.255.255.1:9/mcp` returns immediately; no DNS lookup or socket is opened. A stored definition cannot cause traffic, so a remote URL in a definition grants no network access.
- TLS verification, redirect policy, and egress allowlists belong to the Phase 4+ adapter, not to the registry.

`POST /backends/validate` answers `200` with `{ valid: boolean, transport?, normalized?, errors? }` — a validation *result*, not a request failure. Each error names a path and a message, never the received value.

## 5. Adapter interface (target — Phase 4, not implemented)

```typescript
interface McpBackendAdapter {
  validate(config: unknown): Promise<ValidationResult>;
  connect(): Promise<void>;
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: unknown, options?: CallOptions): Promise<McpToolResult>;
  getHealth(): Promise<BackendHealth>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
}
```

Adapt exact types to the installed official SDK. Do not copy this illustrative interface blindly if SDK types offer a better contract.

## 6. Transport configuration (implemented portions)

### stdio
- Executable and argument array as separate fields — implemented.
- Secret-reference-only environment — implemented.
- Working directory — implemented as stored configuration; it is **not** yet constrained by policy.
- Timeout, shutdown behavior, environment inheritance — the fields exist; enforcement is Phase 4.
- No shell interpolation — structurally unrepresentable, not merely checked.

### Streamable HTTP
- URL and secret-reference headers — implemented.
- Authentication resolution, allowed host/origin policy for outbound calls, request timeout enforcement, reconnect behavior, TLS verification defaults — Phase 4.

## 7. Tool routing (Phase 4+)

1. Resolve public tool name.
2. Resolve backend and original tool name.
3. Authenticate agent.
4. Evaluate effective policy.
5. Validate arguments.
6. Acquire scoped concurrency control.
7. Invoke backend with timeout/cancellation.
8. Release lock/queue slot in `finally`.
9. Normalize result/error.
10. Record safe activity metadata.

## 8. Error codes

Implemented: see section 2. The following remain **proposals** for later phases and must be added to `ErrorCode` before use — inventing them at a call site would break the contract:

- `TOOL_NOT_FOUND`, `TOOL_NAME_COLLISION`, `TOOL_CALL_FAILED`, `CONCURRENCY_TIMEOUT`, `SESSION_NOT_FOUND`, `BACKEND_NOT_FOUND` (today covered by `RESOURCE_NOT_FOUND`), `UNAUTHENTICATED`/`FORBIDDEN` (today `AUTHENTICATION_ERROR`/`AUTHORIZATION_ERROR`).

## 9. API security

Implemented in Phase 3:

- Loopback-only enforcement per request: socket local address, configured `HOST`, `Host` header, and `Origin` header.
- JSON content-type requirement on any request that declares a content type, which blocks cross-site form posts (HTML forms cannot send `application/json` without a preflight the API never grants).
- Request-size limit before parsing; query-string length cap.
- Zod validation of body, query, and parameters; unknown keys rejected.
- Parameterized SQL everywhere; identifier quoting only from a whitelist.
- No internal exception text, stack traces, or driver messages in responses.
- Secrets are structurally absent from stored config (references only).

**Not implemented, and the API must not be described as production-secure:** authentication, authorization, per-caller rate limiting, and CSRF tokens. Any caller that can reach loopback — any local process or user — can call this API. See `docs/SECURITY.md`.

Deferred: dashboard authentication and agent authorization (Phase 6), owner confirmation flows for destructive or exposure-changing operations.
