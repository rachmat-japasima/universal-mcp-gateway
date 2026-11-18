# Backend and API Specification

## 1. Scope

Defines the target management API, registry domain, MCP adapters, routing, and lifecycle. Exact route schemas may evolve during implementation but must remain typed and documented.

## 2. API conventions

- JSON over HTTP for dashboard management APIs.
- Version management under `/api/v1`.
- Consistent error envelope with stable error code, human-readable message, and request ID.
- Validate input using Zod.
- Never return secrets.
- Apply authentication and authorization server-side.
- Use pagination for potentially large lists.
- Use idempotency where retrying mutations could create duplicate effects.

Example error:
```json
{
  "error": {
    "code": "BACKEND_NOT_FOUND",
    "message": "The requested backend does not exist.",
    "requestId": "..."
  }
}
```

## 3. Proposed management endpoints

### System
- `GET /api/v1/system`
- `GET /api/v1/system/health`
- `GET /api/v1/system/diagnostics`
- `GET /api/v1/system/metrics`

### Backends
- `GET /api/v1/backends`
- `POST /api/v1/backends`
- `GET /api/v1/backends/:backendId`
- `PATCH /api/v1/backends/:backendId`
- `DELETE /api/v1/backends/:backendId`
- `POST /api/v1/backends/:backendId/validate`
- `POST /api/v1/backends/:backendId/connect`
- `POST /api/v1/backends/:backendId/disconnect`
- `POST /api/v1/backends/:backendId/reconnect`
- `GET /api/v1/backends/:backendId/health`
- `GET /api/v1/backends/:backendId/tools`

### Tools
- `GET /api/v1/tools`
- `GET /api/v1/tools/:toolId`
- `POST /api/v1/tools/:toolId/test` (admin-only, explicit confirmation and safe policy)

### Agents
- `GET /api/v1/agents`
- `POST /api/v1/agents`
- `GET /api/v1/agents/:agentId`
- `PATCH /api/v1/agents/:agentId`
- `DELETE /api/v1/agents/:agentId`
- `POST /api/v1/agents/:agentId/credentials`
- `POST /api/v1/agents/:agentId/credentials/rotate`
- `POST /api/v1/agents/:agentId/credentials/revoke`
- `GET /api/v1/agents/:agentId/activity`

### Policies
- `GET /api/v1/policies`
- `POST /api/v1/policies`
- `GET /api/v1/policies/:policyId`
- `PATCH /api/v1/policies/:policyId`
- `DELETE /api/v1/policies/:policyId`
- `GET /api/v1/agents/:agentId/effective-access`

### Sessions and activity
- `GET /api/v1/sessions`
- `GET /api/v1/sessions/:sessionId`
- `POST /api/v1/sessions/:sessionId/revoke`
- `GET /api/v1/activity`
- `GET /api/v1/audit`

### Settings
- `GET /api/v1/settings`
- `PATCH /api/v1/settings`
- `POST /api/v1/settings/backup`
- `POST /api/v1/settings/restore` (owner-only, guarded workflow)

These are proposed contracts, not a mandate to implement every endpoint in one milestone.

## 4. Backend domain model

### BackendDefinition
- `id`: stable ID.
- `name`: unique display name or documented uniqueness rule.
- `description`.
- `transport`: discriminated union.
- `connectionConfig`: transport-specific validated object.
- `enabled`.
- `timeoutMs`.
- `concurrencyPolicy`.
- `createdAt`, `updatedAt`.

### BackendRuntime
- `status`: disabled, disconnected, connecting, connected, degraded, error.
- `lastConnectedAt`.
- `lastHealthCheckAt`.
- `lastErrorCode`.
- `lastErrorAt`.
- `reconnectAttempt`.
- `discoveredToolCount`.

Separate persisted definition from in-memory runtime state where possible.

## 5. Adapter interface

Conceptual interface:
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

## 6. Transport configuration

### stdio
- executable path/command as a separate field.
- argument array.
- explicit environment allowlist/references.
- working directory constrained by policy.
- timeout and shutdown behavior.
- never interpolate untrusted values into shell command strings.

### Streamable HTTP
- URL.
- authentication secret reference.
- allowed host/origin policy.
- request timeout.
- reconnect behavior.
- TLS verification enabled by default.

## 7. Tool routing

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

Suggested stable codes:
- `VALIDATION_ERROR`
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `BACKEND_NOT_FOUND`
- `BACKEND_DISABLED`
- `BACKEND_UNAVAILABLE`
- `BACKEND_TIMEOUT`
- `TOOL_NOT_FOUND`
- `TOOL_NAME_COLLISION`
- `TOOL_CALL_FAILED`
- `CONCURRENCY_TIMEOUT`
- `SESSION_NOT_FOUND`
- `INTERNAL_ERROR`

## 9. API security

- Authenticate all protected management routes.
- Authorize every mutation.
- Rate-limit login and credential operations.
- Validate Origin/Host and CSRF where relevant.
- Redact secrets in errors and logs.
- Require owner confirmation for restore, credential revocation, and network exposure changes.
