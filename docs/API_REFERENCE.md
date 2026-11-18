# API Reference — Universal MCP Gateway

Complete inventory of the implemented HTTP surface, the contract every endpoint
follows, and the two trust boundaries it sits across. This document describes
what the code does today; `docs/BACKEND_SPEC.md` holds the design rationale and
`docs/ROADMAP.md` says what is not built yet.

The machine-readable contract is served by the gateway itself at
`GET /api/v1/openapi.json` (OpenAPI 3.1). `tests/openapi.test.ts` compares that
document against the live Hono route table in both directions, so a documented
path that does not exist — or a live path that is undocumented — fails the build.

## 1. Two surfaces

| Surface | Prefix | Authentication |
| --- | --- | --- |
| Management API | `/api/v1` | none — loopback only |
| Infrastructure probes | `/health`, `/ready` | none — loopback only |
| MCP protocol | `/mcp` | per-request agent bearer token |

The management API is **unauthenticated**. Its boundary is the loopback socket:
`loopbackOnly` checks the socket's local address, the configured `HOST`, the
`Host` header, and the `Origin` header on every request. Any local process can
call it, including minting a credential. Do not expose it beyond `127.0.0.1`
(`docs/SECURITY.md` §3.1).

`/mcp` is the only authenticated surface and is documented separately in
`docs/BACKEND_SPEC.md` §7. No REST route invokes a tool; there is exactly one
path from an agent to a backend.

## 2. Contract

### 2.1 Success

```json
{ "data": { } }
```

Lists add `pagination`:

```json
{
  "data": [],
  "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 }
}
```

### 2.2 Failure

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The 'limit' query parameter is invalid.",
    "requestId": "0be82930-c2e4-4e3f-be5a-b965811b951b"
  }
}
```

`code` is from the fixed `ErrorCode` set (`src/shared/errors.ts`); no route
invents one. `message` is safe to show a user: never a stack trace, SQL text,
driver message, or the received value.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Malformed path, query, or body |
| `AUTHENTICATION_ERROR` | 401 | `/mcp` bearer missing or invalid |
| `AUTHORIZATION_ERROR` | 403 | Policy refusal outside the MCP surface |
| `RESOURCE_NOT_FOUND` | 404 | Unknown id, or a route that does not exist |
| `RESOURCE_CONFLICT` | 409 | Name collision, stale `expectedVersion`, disabled backend |
| `MCP_PROTOCOL_ERROR` | 400 | Malformed JSON-RPC |
| `TOOL_NOT_FOUND` | 404 | Unknown public tool name |
| `TOOL_UNAVAILABLE` | 503 | Tool exists but cannot be reached |
| `TOOL_CANCELLED` | 408 | Call cancelled by the client |
| `BACKEND_CONNECTION_ERROR` | 502 | Backend refused or failed the connection |
| `BACKEND_TIMEOUT` | 504 | Backend exceeded its timeout |
| `BACKEND_UNAVAILABLE` | 503 | Backend disconnected or otherwise unusable |
| `DATABASE_ERROR` | 500 | Storage failed |
| `CONFIGURATION_ERROR` | 500 | Deployment misconfigured |
| `INTERNAL_ERROR` | 500 | Anything else, deliberately opaque |

`X-Request-Id` is echoed on every response. A well-formed inbound value
(`[A-Za-z0-9._-]{1,64}`) is kept for log correlation; anything else is replaced.

### 2.3 Validation

Path, query, and body are all validated with Zod. The rule that matters for
clients:

- An unknown **value** (a status outside the enum, a malformed UUID, `limit`
  above the cap, a malformed date) is a `400`.
- An unknown **parameter name** is ignored, because browsers, editors, and
  proxies add query keys freely (`utm_*`, cache busters). Query schemas are
  therefore not `.strict()`; body schemas are.

Bodies must declare `application/json` when they declare a content type at all;
that blocks cross-site form posts, which cannot set that header without a
preflight the API never grants.

### 2.4 Pagination

Every list uses the same contract:

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer ≥ 1 | `1` | 1-based |
| `limit` | integer 1–100 | `20` | 100 is the hard cap (`MAX_PAGE_SIZE`) |

- `total` is a separate `COUNT(*)` over the **same filtered set**, before
  `LIMIT`. A filter is never applied after slicing, so `total` and the page
  cannot disagree.
- Ordering always tie-breaks on `id`, so equal names or timestamps cannot
  produce a page that repeats or drops a row.
- Sort/filter field names are allowlisted enums. Only the sort column and
  direction are interpolated into SQL, and only from a fixed whitelist; every
  value is a bound parameter.
- Date bounds (`after`/`before`, `createdAfter`/`createdBefore`) are inclusive
  and compared as stored ISO-8601 strings (UTC).

## 3. Endpoint inventory

Every route below is implemented and covered by `tests/openapi.test.ts`.

### 3.1 Infrastructure

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness only. Answers while the process can serve; never fails because a backend is down or authentication is unconfigured. |
| `GET` | `/ready` | Readiness. Checks that the database answers and the migration ledger is readable. `503` with `status: "not_ready"` when either fails. Optional backends are **not** consulted. Mounted outside `/api/v1`, and only when a store exists. |

```json
{ "status": "ready", "checks": { "database": "ok", "migrations": "ok" }, "migrationVersion": "0005", "timestamp": "2026-11-19T10:00:00.000Z" }
```

### 3.2 System and operations

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/system` | Service identity, environment, endpoint paths, backend count, capability flags. |
| `GET` | `/api/v1/system/health` | Management-plane liveness. |
| `GET` | `/api/v1/overview` | Dashboard landing payload: every aggregate in one read. |
| `GET` | `/api/v1/monitoring` | Summary: runtime, storage, backends, sessions, tools, activity. |
| `GET` | `/api/v1/monitoring/health` | Storage and backend health summary. |
| `GET` | `/api/v1/monitoring/backends` | Backend counts, all runtime states, discovery reports, conflicts. |
| `GET` | `/api/v1/monitoring/sessions` | Session distribution by effective status. |
| `GET` | `/api/v1/monitoring/runtime` | Service version, Node version, platform, uptime. |
| `GET` | `/api/v1/diagnostics` | Safe facts for a bug report. Read-only. |
| `GET` | `/api/v1/settings` | Effective, non-secret configuration. Read-only; write verbs answer `404`. |
| `GET` | `/api/v1/openapi.json` | This contract, as OpenAPI 3.1. |

### 3.3 Backends

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/backends` | Paginated list. Filters `search`, `transport`, `enabled`; sort `name`/`createdAt`/`updatedAt`. |
| `POST` | `/api/v1/backends` | Create. `201`. Creates a resting runtime row; never connects. |
| `POST` | `/api/v1/backends/validate` | Validate a proposed config. Returns a result object in a `200`; persists nothing, dials nothing. |
| `GET` | `/api/v1/backends/runtime` | Runtime state for every backend. Literal route, declared before `/:backendId`. |
| `GET` | `/api/v1/backends/:backendId` | Detail. `404` if absent or tombstoned. |
| `PATCH` | `/api/v1/backends/:backendId` | Partial update. Optional `?expectedVersion=` makes it a compare-and-set. |
| `DELETE` | `/api/v1/backends/:backendId` | Tombstone; returns the pre-deletion representation. |
| `POST` | `/api/v1/backends/:backendId/enable` | Makes it eligible. Does not dial. |
| `POST` | `/api/v1/backends/:backendId/disable` | Tears down any connection and refuses new ones. |
| `POST` | `/api/v1/backends/:backendId/connect` | Explicit connect. `409` when disabled. |
| `POST` | `/api/v1/backends/:backendId/disconnect` | Idempotent. Cancels pending retries. |
| `POST` | `/api/v1/backends/:backendId/reconnect` | Explicit retry; resets the attempt counter. |
| `GET` | `/api/v1/backends/:backendId/runtime` | One runtime state. |
| `GET` | `/api/v1/backends/:backendId/tools` | One backend's tools plus its discovery report. |
| `POST` | `/api/v1/backends/:backendId/tools/refresh` | Rediscover one backend. `503` on failure. |

### 3.4 Tools

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/tools` | Catalog page. Filters `search`, `backendId`, `availability`; sort `publicName`/`backendId`/`discoveredAt`. |
| `GET` | `/api/v1/tools/discovery` | Last discovery report per backend. |
| `GET` | `/api/v1/tools/conflicts` | Public names withheld, with every claimant. |
| `POST` | `/api/v1/tools/refresh` | Rediscover every connected backend; per-backend results, not a thrown error. |
| `GET` | `/api/v1/tools/:publicName` | One tool, or `404`. |

Listing a tool here means it exists in the catalog. It does **not** mean an
agent may call it — policy decides that, per agent, on `/mcp`.

### 3.5 Agents and credentials

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/agents` | Paginated. Filters `search`, `enabled`, `status`, `clientType`. |
| `POST` | `/api/v1/agents` | Create. `201`. No credential, no policy. |
| `GET` | `/api/v1/agents/:agentId` | Detail. |
| `PATCH` | `/api/v1/agents/:agentId` | Update name/description/clientType/metadata. |
| `DELETE` | `/api/v1/agents/:agentId` | Tombstone, revoke every credential, drop every assignment, invalidate sessions — one transaction. |
| `POST` | `/api/v1/agents/:agentId/enable` | Enable. No-op when already enabled (no audit row, no version bump). |
| `POST` | `/api/v1/agents/:agentId/disable` | Disable. Refuses the agent's credentials and invalidates its active sessions. |
| `GET` | `/api/v1/agents/:agentId/access` | Read-only preview: assigned policies, and allowed/denied plus reason for every tool in the current catalog. |
| `GET` | `/api/v1/agents/:agentId/credentials` | List. Never a token or verifier. |
| `POST` | `/api/v1/agents/:agentId/credentials` | Issue. `201`. The raw token appears **once**, in this response only. |
| `POST` | `/api/v1/agents/:agentId/credentials/:credentialId/rotate` | Replace in one transaction; new token returned once; sessions bound to the old credential are invalidated. |
| `POST` | `/api/v1/agents/:agentId/credentials/:credentialId/revoke` | Idempotent; keeps the original `revokedAt`. Invalidates sessions it authenticated. |

A credential addressed under the wrong agent is a `404`, never a cross-agent
operation.

### 3.6 Policies

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/policies` | Paginated. Filters `search`, `effect`, `agentId`, `backendId`; sort `name`/`createdAt`/`updatedAt`/`priority`. |
| `POST` | `/api/v1/policies` | Create. |
| `GET` | `/api/v1/policies/:policyId` | Detail. |
| `PATCH` | `/api/v1/policies/:policyId` | Update name/description/priority/rules. |
| `DELETE` | `/api/v1/policies/:policyId` | Hard delete; assignments cascade. |
| `POST` | `/api/v1/policies/:policyId/assignments` | Assign to an agent (idempotent). |
| `DELETE` | `/api/v1/policies/:policyId/assignments/:agentId` | Remove an assignment; `404` if not assigned. |

`backendId` matches a policy with a `backend` rule targeting that id **or** `*`.
`agentId` and `backendId` that name nothing are `404`, not an empty page — a typo
must not look like "no policies".

### 3.7 Sessions

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/sessions` | Paginated. Filters `agentId`, `status` (effective), `createdAfter`, `createdBefore`, `lastActivityAfter`; sort `createdAt`/`lastActivityAt`. |
| `GET` | `/api/v1/sessions/:sessionId` | Detail by **internal** id. `404` if absent. |
| `POST` | `/api/v1/sessions/:sessionId/terminate` | Terminate. Idempotent. Body optional. |
| `POST` | `/api/v1/sessions/cleanup` | Expire idle/lapsed sessions now and report what changed. |

`status` filters on the *effective* status, so `expired` includes sessions whose
lifetime lapsed but which the sweep has not written back. A non-UUID path
segment is a `400`, not a `404`, so the error cannot be used to probe which
protocol ids exist.

### 3.8 Activity

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/activity` | Operational history, newest first. |
| `GET` | `/api/v1/activity/:eventId` | One event. |

Filters: `type`, `outcome`, `agentId`, `backendId`, `toolName`, `search` (tool
name or request id), `after`, `before`, `order` (`asc`/`desc`). `type` and
`outcome` are closed enums — an unknown value is a `400`, never a silently empty
page.

Activity records `mcp.initialize`, `tools.list`, `tools.call`, backend
connect/disconnect/error, and `request.failed`. It never contains tool arguments
or results, only names, counts, outcome, error code, and duration.

### 3.9 Audit

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/audit` | Administrative history, newest first. Metadata omitted. |
| `GET` | `/api/v1/audit/:eventId` | One event, metadata included. |

Filters: `action`, `actorType`, `actorId`, `targetType`, `targetId`, `result`,
`search` (target id or request id), `after`, `before`, `order`.

**Audit is immutable through the API.** No write verb exists on either path; the
repository interface has no update or delete method, so no future route can gain
one by accident. The list omits `metadata` — the detail read is the deliberate
disclosure boundary.

Activity and audit are distinct on purpose: operational volume must not dilute
the security record.

## 4. Operations payloads

### 4.1 `/api/v1/overview`

The dashboard's landing read. Every number comes from a repository, the
lifecycle manager, or the in-memory catalog — nothing is estimated.

```json
{
  "data": {
    "service": { "name": "universal-mcp-gateway", "version": "1.0.0" },
    "environment": "production",
    "uptimeMs": 120000,
    "status": "operational",
    "database": "ok",
    "backends": {
      "total": 0, "enabled": 0, "disabled": 0,
      "runtime": { "disconnected": 0, "connecting": 0, "connected": 0, "unhealthy": 0, "disconnecting": 0, "error": 0, "disabled": 0 }
    },
    "tools": { "total": 0, "available": 0, "unavailable": 0, "conflict": 0, "backendsWithCatalog": 0, "discoveryFailures": 0 },
    "agents": { "total": 0, "enabled": 0, "disabled": 0 },
    "sessions": { "active": 0, "expired": 0, "terminated": 0, "invalidated": 0 },
    "activity": { "total": 0, "byType": {}, "byOutcome": {} },
    "authentication": "required"
  }
}
```

Three rules the payload is built to keep:

1. **Empty is zero.** An empty registry yields real zeros, not missing fields.
2. **Unavailable is `null`.** When the database read fails, every
   storage-backed field (`backends`, `agents`, `sessions`, `activity`) is `null`
   and `status` is `degraded`. `0` would be a false claim.
3. **The catalog survives.** `tools` is in-memory, so it is still reported
   during a storage outage.

`/overview`, `/monitoring*`, and `/diagnostics` all read through one function
(`opsSnapshot()` in `src/api/ops.ts`), so their counts cannot disagree.

### 4.2 `/api/v1/monitoring/sessions`

```json
{ "data": { "available": true, "counts": { "active": 2, "expired": 1, "terminated": 0, "invalidated": 0 }, "total": 3 } }
```

Effective status in one statement, using the same lifetime rules as the sessions
list. When session tracking is not wired it answers `available: false` and
`counts: null` — not a fabricated zero.

### 4.3 `/api/v1/settings`

```json
{
  "data": {
    "environment": "production",
    "host": "127.0.0.1",
    "port": 8787,
    "endpoints": { "mcp": "/mcp", "health": "/health", "api": "/api/v1" },
    "logging": { "level": "info" },
    "limits": { "requestBodyLimitBytes": 1048576, "requestTimeoutMs": 30000, "toolDiscoveryTimeoutMs": 15000, "toolCallTimeoutMs": 60000 },
    "sessions": { "idleTimeoutMs": 1800000, "maxLifetimeMs": 43200000 },
    "backendConnections": { "reconnect": { "enabled": false, "initialDelayMs": 1000, "maxDelayMs": 30000, "maxAttempts": 5, "jitterRatio": 0.2 }, "allowPrivateNetwork": false },
    "features": { "authentication": true, "sessions": true, "toolRouting": true, "backendLifecycle": true, "auditTrail": true, "settingsMutation": false, "metrics": false },
    "readOnly": true
  }
}
```

Read-only, and structurally so: the credential HMAC secret is not part of
`Config` at all, so there is no field that could carry it. No token, header
value, environment dump, or private path appears here. Write verbs answer `404`
because no mutation path exists.

## 5. The `backends/:id/tools` change

Phase 8 tightened one route:

| Before | After |
| --- | --- |
| `GET /api/v1/backends/<unknown>/tools` → `200` with `[]` | → `404 RESOURCE_NOT_FOUND` |

An unknown backend is not a backend with no tools, and a dashboard typo must not
read as the latter. `GET /api/v1/tools?backendId=<unknown>` still answers an
empty page: that is a filter over a collection, where "nothing matched" is a real
answer.

## 6. Consuming the API from a dashboard

- Call `/overview` once per home-screen render; it is one snapshot, so widgets
  cannot show counts from different instants.
- Branch on `null`, never on `0`, to distinguish "unavailable" from "none".
- Read `/api/v1/openapi.json` at build time if you want generated types; the
  document is checked against the routes, so it will not drift silently.
- Every list is bounded (`limit ≤ 100`) and tie-broken, so paging is safe while
  rows are being written.
- No endpoint returns a credential token except credential issue/rotate, and
  neither can be replayed to retrieve it.
