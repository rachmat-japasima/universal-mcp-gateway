# System Architecture — Universal MCP Gateway

## 1. Principles

- Generic MCP gateway; no backend-specific core.
- Official MCP SDK for protocol implementation.
- Empty production registry by default.
- Dynamic backend configuration.
- Least-privilege authorization.
- Isolated sessions and scoped concurrency.
- Local-only network binding by default.
- Dashboard consumes documented backend APIs; it does not contain business logic.

## 2. Logical architecture

```mermaid
flowchart TB
  subgraph Clients
    A[Claude Code]
    B[Codex CLI]
    C[OpenCode]
    D[Other MCP clients]
  end

  subgraph Platform
    G[Next.js Admin Dashboard]
    API[Management API]
    MCP[Streamable HTTP MCP Endpoint]
    AUTH[Identity / Authentication]
    POLICY[Authorization Policy Engine]
    ROUTER[Tool Catalog and Router]
    REG[Backend Registry]
    OBS[Logs / Metrics / Audit]
    DB[(SQLite)]
  end

  subgraph Adapters
    STDIO[stdio MCP Adapter]
    HTTP[Streamable HTTP Adapter]
  end

  subgraph Backends
    X[External MCP Server A]
    Y[External MCP Server B]
    Z[Future MCP Server]
  end

  A --> MCP
  B --> MCP
  C --> MCP
  D --> MCP
  G --> API
  API --> AUTH
  MCP --> AUTH
  AUTH --> POLICY
  POLICY --> ROUTER
  ROUTER --> STDIO
  ROUTER --> HTTP
  STDIO --> X
  HTTP --> Y
  HTTP --> Z
  API --> REG
  REG --> DB
  POLICY --> DB
  OBS --> DB
  MCP --> OBS
  API --> OBS
```

## 3. Deployment topology

Initial local deployment:
- Gateway/API process in WSL2.
- Dashboard served locally by Next.js, either same origin through a reverse proxy or a documented separate local port.
- SQLite database in project/runtime data directory, excluded from source control.
- Backend child processes launched by the gateway process when stdio adapters are enabled.
- Bind to loopback only.

Do not assume Windows and WSL share identical localhost routing or filesystem paths. Validate cross-environment access before connecting Windows desktop applications.

## 4. Application modules

Suggested source boundaries:

```text
src/
  adapters/
    mcp/
      stdio/
      streamable-http/
    process/
  api/
    routes/
    middleware/
  config/
  core/
    lifecycle/
    gateway/
  registry/
    domain/
    repositories/
    migrations/
  routing/
    catalog/
    dispatcher/
    namespacing/
  security/
    authentication/
    authorization/
    secrets/
    redaction/
  sessions/
  concurrency/
  monitoring/
    logging/
    metrics/
    health/
    audit/
  shared/
    errors/
    schemas/
    types/

apps/
  dashboard/
    app/
    components/
    features/
    lib/
```

This is a target structure, not a requirement to move existing files immediately. Preserve the current working bootstrap and refactor incrementally.

### 4.1 Implemented module layout (Phase 3)

```text
src/
  domain/          # contracts, no infrastructure imports
    primitives.ts        ids, timestamps, secret references
    backend.ts           definition + create/update schemas
    backend-runtime.ts   runtime state + status enum
    agent.ts
    agent-credential.ts  verifier hash, derived status
    policy.ts            rules, effects, deterministic ordering
    session.ts
    activity-event.ts    operational history
    audit-event.ts       administrative/security history
    repositories.ts      persistence interfaces (SQL/persistence-free)
  shared/
    errors.ts        AppError, ErrorCode, toAppError, log view
  config/
    config.ts        pure parseConfig/loadConfig/redactConfig
  api/
    index.ts             management API assembly + middleware order
    http.ts              request id, envelopes, JSON parsing, error boundary
    middleware/
      guards.ts          loopbackOnly, requireJsonBody
    schemas/
      queries.ts         pagination/filter/param contracts
    routes/
      system.routes.ts
      backends.routes.ts
  registry/
    backend-service.ts   business rules, transactions, audit, sanitization
  core/
    gateway.ts       Hono app + MCP handler + health + API mount
  infrastructure/
    database/
      connection.ts        pragmas, one handle per process
      migration-runner.ts  transactional, checksummed migrations
      migrations/0001_initial_schema.sql
      migrations/0002_backend_version.sql
      repositories/        SQLite implementations
  monitoring/
    logger.ts        Pino + redaction paths
  index.ts           process lifecycle
```

Dependency direction is one-way: `index` → `core` → `api` → `registry` → `infrastructure`/`config` → `shared`/`domain`. `domain` imports only Zod and its own primitives, so it can move into a workspace package without changes (ADR-022). `registry` is the only layer that combines several repositories in one transaction.

Boundaries that matter:

- **Domain vs persistence.** Repository interfaces live in `src/domain/repositories.ts` and speak in entities; SQL and `better-sqlite3` types never appear there. An in-memory fake satisfies the same contract.
- **Route vs service vs repository.** A route parses HTTP and formats the response; `BackendService` owns uniqueness, transactions, audit, and sanitization; repositories own SQL. No handler contains a statement or a business rule.
- **Definition vs runtime.** `backends` holds configuration; `backend_runtime` holds observed connection state. A persisted backend never implies a live connection.
- **Activity vs audit.** Separate entities, tables, and interfaces. Operational volume must not dilute administrative history, and audit is append-only.
- **Contracts vs secrets.** Agent tokens are not part of the `Agent` entity; only a verifier hash is stored. Backend `env`/`headers` accept secret *references* only.

### 4.2 Management API middleware order (Phase 3)

Declared once in `createManagementApi()`, applied to every `/api/v1` route:

1. `requestId` — assigns or accepts a well-formed `X-Request-Id` so later log lines and error envelopes correlate.
2. `loopbackOnly` — rejects a non-loopback socket, a non-loopback configured `HOST`, a foreign `Host`, and a foreign `Origin`.
3. `jsonBodyLimit` — bounds the body before any parse allocates it.
4. `requireJsonBody` — rejects a declared non-JSON content type, which blocks cross-site form posts.

Order is load-bearing: the local-only check runs before a body is read, so a non-local caller cannot make the gateway buffer a payload. Host/Origin checks reuse the SDK's own `validateHostHeader`/`validateOriginHeader`; only the response envelope differs from `/mcp` (ADR-029).

The MCP surface keeps the SDK's `hostHeaderValidation`/`originValidation` middleware because a JSON-RPC client expects a JSON-RPC error. Both middlewares are scoped away from `/api/v1` so neither surface answers in the other's shape.

The API is not mounted at all when no store is configured, rather than mounted against a missing database.

## 5. Inbound MCP lifecycle

1. Client connects to `/mcp`.
2. Transport validates HTTP request and host/origin according to SDK guidance.
3. Client identity is authenticated.
4. MCP initialize lifecycle is handled by official SDK.
5. The server establishes the selected stateless/sessionful behavior.
6. `tools/list` obtains the catalog filtered by the authenticated agent's policy.
7. `tools/call` checks identity, permission, schema, timeout, and concurrency.
8. Router dispatches to the correct backend adapter.
9. Adapter returns MCP-compatible result/error.
10. Observability records safe metadata and correlation ID.
11. Session/transport resources are cleaned up according to SDK lifecycle.

## 6. Outbound adapter lifecycle

Adapter interface should cover:
- validate configuration
- connect/start
- initialize MCP client
- list tools
- call tool
- health/status
- reconnect
- close/stop
- expose sanitized diagnostics

Use official MCP Client SDK. Keep process launch and transport details inside adapters. A backend failure must not crash the whole gateway.

## 7. Registry model

Implemented in Phase 3 (`src/domain/backend.ts`, `src/registry/backend-service.ts`, `docs/BACKEND_SPEC.md`).

Backend definition fields:
- `id` — application-generated UUIDv4.
- `name` — unique among active backends (`RESOURCE_CONFLICT` on clash).
- `description` — optional, nullable.
- `connection` — discriminated union on `type`: `stdio` or `streamable-http`.
- `enabled` — configuration flag only; not a connection.
- `timeoutMs` — per-call timeout applied later by an adapter.
- `concurrencyMode` / `concurrencyLimit` — `parallel` | `serialized` | `limited`.
- `version` — optimistic-concurrency counter, incremented on every persisted change.
- `createdAt`, `updatedAt`.

Runtime state is a separate row and never part of a definition:
- `status` — `disconnected` | `connecting` | `connected` | `unhealthy` | `error` | `disabled`.
- `lastConnectedAt`, `lastHealthCheckAt`, `lastErrorCode`, `lastErrorAt`, `reconnectAttempts`.

Rules enforced by the registry service:

- Creating, updating, enabling, or disabling **cannot** connect, spawn, or resolve anything. Only two configuration-visible runtime transitions exist: disable → `disabled`, enable from `disabled` → `disconnected`. A `connected` state is never fabricated.
- A definition's `env`/`headers` may hold secret *references* (`secret:...`, `env:VAR`) only. A literal secret is rejected by the schema, so an API response cannot leak one by construction.
- A stdio `command` is a single executable token. Arguments, flags, and pipes belong in `args`; a shell-looking command is rejected rather than split.
- Deletion is a tombstone: the backend leaves the registry, runtime state cascades, and audit rows keep referencing the id.

Do not store plaintext secrets in ordinary registry JSON/YAML or database columns. Use secret references and a separately designed secure store.

## 8. Tool catalog and naming

Proposed public tool name: `<backend_id>__<original_tool_name>`. Validate compatibility and length constraints before final adoption.

Catalog record:
- public tool name
- original tool name
- backend ID
- description
- input schema
- discovered timestamp
- enabled/visibility status

Collision must be explicit and fail closed. Never route a duplicate name based on ordering.

## 9. Authentication and authorization

Separate:
- Dashboard user identity.
- MCP client/agent identity.
- Backend credentials.

Use separate credential scopes. Dashboard login must not implicitly grant MCP tool access. MCP client metadata must not be trusted as identity.

Policy evaluation:
1. Authenticate caller.
2. Resolve active agent profile.
3. Load effective policy.
4. Filter tools/list.
5. Re-check permission on every tools/call.
6. Audit allow/deny outcome without recording secrets or sensitive payloads.

Default deny for unknown identities and unassigned tools.

## 10. Session isolation

Document and test selected Streamable HTTP session behavior against the installed SDK version. Keep session-bound data isolated. Define expiration, cleanup, and revocation. Avoid sharing mutable server/transport state between clients unless explicitly supported by the SDK lifecycle.

**Current (Phase 1):** serving is stateless per HTTP exchange. `createMcpHandler` builds a fresh `McpServer` from a factory for every exchange, so no mutable state exists to share; `tools/list` and `tools/call` see only that exchange's instance. Session ids are not issued and a client-supplied `mcp-session-id` is ignored. `GET`/`DELETE` answer `405` on the stateless legacy leg.

**Deferred to Phase 7:** server-side session registry, expiry/revocation, resumable streams, and per-session concurrency accounting. Until then a session cannot be revoked mid-flight because none is tracked — credential revocation (Phase 6) is enforced per request instead.

## 11. Concurrency

Per-backend/resource modes:
- `parallel`
- `serialized`
- `limited`

Use scoped queues/locks for stateful resources. Include timeout, cancellation, cleanup, and stale lock handling. Do not globally serialize all tool calls.

## 12. Data persistence

SQLite stores registry metadata, agent profiles, policy records, audit events, and any bounded operational metadata. Access goes through the repository interfaces in `src/domain/repositories.ts`; SQL is confined to `src/infrastructure/database/`. Runtime MCP client/transport/process objects stay in memory.

Implemented in Phase 2 (details in `docs/DATABASE.md`):

- One connection per process, WAL + `synchronous=FULL` + `foreign_keys=ON`.
- Transactional, checksummed, additive migrations; applied files are immutable.
- Soft delete (tombstone) for backends and agents; hard delete with cascade for policies; revocation timestamps for credentials and sessions.
- Status for credentials and sessions is derived from timestamps, not stored.

Retention and backup policy are still to be defined. Do not store sensitive tool arguments/results by default.

## 13. Dashboard architecture

- Next.js application.
- Astryx as the direct UI component library and design system.
- Typed API client generated or maintained from backend API contracts.
- Feature-oriented page modules.
- Server-side authorization for protected dashboard routes and APIs.
- Loading, empty, error, and confirmation states.
- No business rules implemented only in the browser.

**Explicit exclusion:** no shadcn/ui, no Radix UI fallback component library, and no parallel design system. Follow the current Astryx official installation/API documentation. Do not guess package names or CLI commands.

## 14. Security boundaries

- Loopback binding by default; a non-loopback `HOST` is refused at config load.
- The management API is **unauthenticated** in Phase 3. Its boundary is local-only access (socket address, `HOST`, `Host`, `Origin`) plus a JSON content-type requirement — not identity. Dashboard authentication is Phase 6.
- Origin/Host validation on both surfaces, each answering in its own protocol's error shape.
- Redacted logs; secrets exist only as references, so there is nothing to redact in a payload.
- Safe stdio process launch with executable and argument arrays; no shell interpolation.
- Controlled environment inheritance.
- No public exposure before security review.

## 15. Error taxonomy

Implemented in `src/shared/errors.ts` as `AppError` with stable `ErrorCode` values. Each code has a fixed category, HTTP status, and JSON-RPC code (`errorDefinition()`), so mapping is a table lookup rather than per-call judgement.

| Code | Category | HTTP | JSON-RPC |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | client | 400 | -32602 |
| `RESOURCE_NOT_FOUND` | client | 404 | -32602 |
| `RESOURCE_CONFLICT` | client | 409 | -32602 |
| `MCP_PROTOCOL_ERROR` | client | 400 | -32600 |
| `AUTHENTICATION_ERROR` | denied | 401 | -32001 |
| `AUTHORIZATION_ERROR` | denied | 403 | -32002 |
| `BACKEND_CONNECTION_ERROR` | unavailable | 502 | -32603 |
| `BACKEND_UNAVAILABLE` | unavailable | 503 | -32603 |
| `BACKEND_TIMEOUT` | unavailable | 504 | -32603 |
| `CONFIGURATION_ERROR` | internal | 500 | -32603 |
| `DATABASE_ERROR` | internal | 500 | -32603 |
| `INTERNAL_ERROR` | internal | 500 | -32603 |

Rules:

- `message` is client-safe; `details` and `cause` are log-only and never serialized outward (`toEnvelope()`).
- `toAppError()` collapses any non-`AppError` into `INTERNAL_ERROR` with a generic message, preserving the original as `cause`, so raw SQLite/OS text cannot reach a client. The one exception is a `ZodError`: it is always malformed caller input, so it maps to `VALIDATION_ERROR` naming only the failing paths and messages — never the received values.
- `describeErrorForLog()` is the only view that includes stacks and causes.
- `isClientFault()` separates caller mistakes from gateway faults so invalid input is not logged as an outage.

Return protocol-appropriate errors without leaking stack traces, secrets, process environment, or filesystem details.
