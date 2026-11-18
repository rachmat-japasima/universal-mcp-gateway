# Security Requirements

## 1. Security posture

Local-first, deny-by-default MCP control plane. Security must be enforced in backend APIs and MCP request handling, not only in dashboard presentation.

## 2. Trust boundaries

- Dashboard browser.
- Dashboard user session.
- MCP client/agent.
- Gateway process.
- Backend MCP process/service.
- Local filesystem and environment.
- Windows ↔ WSL2 boundary.

Treat backend tool descriptions, tool outputs, and configuration strings as untrusted data. Never interpret returned text as privileged instructions.

## 3. Network

- Default bind `127.0.0.1`.
- No `0.0.0.0` default. A non-loopback `HOST` is rejected at config load, so the process cannot be misconfigured into listening publicly.
- Host/Origin validation according to MCP SDK guidance, on both the MCP and management surfaces.
- Do not expose through tunnel, reverse proxy, LAN, or WAN without authentication and explicit review.
- If remote access is added, require TLS and strong authentication.

### 3.1 Management API boundary (Phase 3) — read this before exposing anything

**The management API is unauthenticated.** It has no login, no API token, and no per-caller authorization. Any process or user that can reach the loopback socket can create, modify, enable, disable, or delete backend definitions.

What is actually enforced, per request:

| Control | Mechanism |
| --- | --- |
| Loopback socket | `incoming.socket.localAddress` must be a loopback address when the Node adaptor supplies it |
| Configured bind | `HOST` must be loopback, checked again per request |
| DNS rebinding | `Host` must resolve to `localhost`/`127.0.0.1`/`[::1]` (SDK `validateHostHeader`) |
| Cross-site browser calls | `Origin`, when present, must be loopback (SDK `validateOriginHeader`) |
| Cross-site form posts | any declared content type must be `application/json`; HTML forms cannot send it without a preflight this API never grants |
| Payload size | `requestBodyLimitBytes` before parsing; query string capped at 2048 chars |
| Injection | Zod validation of body/query/params; parameterized SQL; sort identifiers from a whitelist |
| Information disclosure | error envelope carries only `code`/`message`/`requestId`; no stacks, SQLite text, or paths |

These controls prevent *remote and cross-origin* misuse. They do **not** provide identity, and they do not stop another local process or another local user. Treat the API as a local operator tool, equivalent in trust to a CLI on the same machine. This is a documented Phase 3 limitation, not an oversight; dashboard authentication is Phase 6.

`GET /api/v1/system` reports `capabilities.authentication: false` so a client cannot mistake the current posture for an authenticated one.

## 4. Authentication

Separate dashboard and MCP authentication:
- Dashboard: secure local owner login/session.
- MCP: unique credential per agent/client.
- Backend: separate secret references for backend credentials.

Do not use a client-supplied `agentName` or arbitrary metadata as proof of identity.

## 5. Authorization

- Default deny for unknown agents.
- Newly created agents have no tool access by default.
- Enforce policy on both `tools/list` and `tools/call`.
- Dashboard role checks enforced server-side.
- Re-evaluate access on every call, not only at session initialization.
- Define and test allow/deny precedence.

## 6. Credentials and secrets

- Show generated agent token only once.
- Store verifier/hash where compatible with authentication design.
- Rotate and revoke credentials.
- Mask secrets in dashboard.
- Never log authorization headers, tokens, passwords, or secret environment variables.
- Do not store plaintext secrets in ordinary SQLite fields.
- If encrypted secret storage is introduced, document key derivation, key location, rotation, backup, and recovery.
- `.env` and local secret files must be gitignored.

### 6.1 Implemented in Phase 2

- `agent_credentials` stores a lowercase hex SHA-256 verifier only (`CHECK length = 64`, unique index). The `Agent` entity has no credential field, so listing agents cannot serialize one.
- Backend `env` and HTTP `headers` accept **secret references only**: `secret:<path>` or `env:<VAR>`. Any other string is rejected at validation time. A scheme is required because no pattern can tell a pasted secret (`sk-live-...`) from a variable name (`api-key`).
- SQLite never receives raw secrets; `config_json` holds references and non-secret connection detail.
- Verifier integrity is enforced at three layers: Zod (`^[a-f0-9]{64}$`), a `CHECK` constraint, and a unique index.
- Credential/session status is derived from `revoked_at`/`expires_at`, so a "revoked" row cannot be reported as active.

### 6.2 Implemented in Phase 3

- Backend configuration still stores secret *references* only; the registry cannot hold a value.
- API responses are built by an explicit `toPublicBackend()` projection rather than serializing a database row, so a future secret-valued field has to be added deliberately to leak.
- A `POST /backends/validate` call performs **no** DNS lookup, socket open, or process spawn. A remote URL in a definition cannot be used to probe an internal network; egress policy belongs to the Phase 4+ adapter.
- A stdio `command` must be a single executable token. Whitespace and shell metacharacters (`;`, `&`, `|`, `<`, `>`, backtick, `$`, parentheses) are rejected, so `node x && rm -rf /` is unrepresentable rather than split or executed.
- Validation errors report the failing path and rule, never a received value. Path segments are emitted only when they are field names the gateway defines (`KNOWN_FIELDS`); anything else becomes `(redacted)`, and Zod's `unrecognized_keys` message is rewritten without the supplied key names. A pattern-based "looks safe" check is not enough — `sk-live-ABCDEFGHIJKLMNOP` matches one.
- Env keys must be POSIX names (`^[A-Za-z_][A-Za-z0-9_]{0,127}$`) and header keys must be RFC 7230 tokens, so a name is validated for what a child process or a request can actually use.
- **Known limit:** a header *name* is caller-supplied config text, like `name` or `description`. `X-Api-Key` is indistinguishable from a pasted secret, so header names are stored and displayed rather than redacted. A secret typed into a header name by mistake is therefore visible to any local API caller — the same exposure class as a secret typed into `description`. Only header/env *values* are constrained to references, and they are the fields that would carry a credential.
- Creating, updating, enabling, or disabling a backend cannot connect, spawn, or emit network traffic. The only runtime states the registry may write are `disconnected` and `disabled`; a `connected` state is never fabricated from configuration.

## 7. stdio process security

- Use executable + argument array.
- Avoid `shell: true` and shell interpolation.
- Validate executable and working directory.
- Control inherited environment variables.
- Set process timeouts and termination escalation.
- Do not allow arbitrary user-supplied command strings from unauthenticated sources.
- Document that configured MCP servers execute with the gateway user's OS permissions.

## 8. Dashboard/web security

- Secure, HttpOnly, SameSite cookies.
- CSRF defense for cookie-authenticated state changes.
- CSP and security headers.
- Rate limits for login and sensitive mutations.
- Output encoding for backend/tool metadata.
- Avoid unsafe HTML rendering.
- Validate uploads if a future feature supports them.

## 9. Logging and audit

- Redact credentials and sensitive headers.
- Do not log tool arguments/results by default.
- Audit administrative changes and security decisions.
- Limit access to logs.
- Define retention and export policy.
- Audit records should not be editable through ordinary dashboard functions.

### 9.1 Implemented in Phase 3

Administrative backend operations write `audit_events` rows: `backend.created`, `backend.updated`, `backend.enabled`, `backend.disabled`, `backend.deleted`, and `backend.validation_failed`.

- Metadata is a whitelist of primitives — `{ transport, enabled }`, `{ changed: "timeoutMs" }`, `{ name }`, or `{ operation: "validate", reason, fields }`. A connection config is never copied into audit, so environment references, URLs, and headers do not accumulate there.
- The actor is recorded as `{ type: "admin", id: "local-operator" }` because there is no authenticated identity yet. Recording it explicitly means Phase 3 rows will not later read as anonymous or system-generated.
- A no-op (re-enabling an enabled backend) writes no audit row, so the log reflects changes rather than requests.
- Deleting a backend tombstones the row instead of cascading, so audit and activity references stay valid and history is not silently destroyed.
- `backend.validation_failed` is its own action rather than a reused `backend.updated`, so repeated invalid configurations — a plausible probe of the API — are visible as such.

### 9.2 Implemented in Phase 2

- Pino redaction paths cover `authorization`/`cookie` request headers, `set-cookie` responses, and `*.token`, `*.credential`, `*.credentialHash`, `*.password`, `*.secret`, `*.apiKey`.
- `AppError.toEnvelope()` exposes only `code`, `message`, and optional `requestId`. `details`, `cause`, and stack exist solely for `describeErrorForLog()`.
- `toAppError()` collapses unexpected errors into `INTERNAL_ERROR` with a generic message, so SQLite text and filesystem paths cannot reach a client.
- Activity and audit are separate tables with separate repository interfaces. Audit is append-only: `AuditRepository` has no update or delete.
- Activity events deliberately have no arguments/results column — the schema makes storing tool payloads unrepresentable.
- Audit `metadata` is a flat map of primitives, capped at 20 entries, so it cannot become an unbounded JSON dump.
- Runtime `last_error_message` is bounded to 500 characters and is expected to be sanitized by the writer: connection URLs, commands, and environment values are logged, never persisted for display.

## 10. Threat scenarios to test

- Unauthenticated client invokes tool.
- Agent invokes tool not present in its allowlist.
- Hidden tool called directly by name.
- Credential revoked while session is active.
- Malicious backend returns hostile text/metadata.
- Backend config attempts shell injection.
- Invalid Origin/Host request.
- Dashboard CSRF attempt.
- Excessive tool calls / queue exhaustion.
- Backend process hangs or spawns child processes.
- Secret accidentally appears in logs or API error.
- SQLite backup contains sensitive data.
- Literal secret pasted into backend `env`/`headers` config (rejected by schema).
- Raw database error surfaced through an API response (collapsed to `INTERNAL_ERROR`).
- Management API reached from a non-loopback socket, a spoofed `Host`, or a foreign `Origin` (all rejected with `403`).
- Cross-site form post to a management endpoint without a JSON content type (rejected with `400`).
- SQL metacharacters or `%`/`_` supplied as a search term (bound as literals; no wildcard expansion).
- Shell string supplied as a stdio `command` (rejected by the schema, never executed).
- Server-side request forgery via the validate endpoint (no outbound request is made).
- Secret value pasted into `env`/`headers` (rejected) or echoed in a validation error (never included).

## 11. Release gate

No non-loopback exposure until:
- Authentication and authorization are implemented (Phase 6). The management API is currently unauthenticated and loopback-only; see 3.1.
- TLS/reverse-proxy assumptions are documented.
- Host/Origin and CSRF defenses are tested.
- Secrets are protected.
- Threat review and operational rollback plan are complete.
