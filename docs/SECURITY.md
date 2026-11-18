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

### 3.1 Management API boundary (Phase 4) — read this before exposing anything

**The management API is unauthenticated.** It has no login, no API token, and no per-caller authorization. Any process or user that can reach the loopback socket can create, modify, enable, disable, or delete backend definitions — and, since Phase 4, **make the gateway spawn a process or open an outbound connection**.

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
| Outbound destination | SSRF policy below, applied before every HTTP request |
| Process execution | no shell; single executable token plus an argument array |

These controls prevent *remote and cross-origin* misuse. They do **not** provide identity, and they do not stop another local process or another local user. Treat the API as a local operator tool, equivalent in trust to a CLI on the same machine. This is a documented limitation, not an oversight; dashboard authentication is Phase 6.

`GET /api/v1/system` reports `capabilities.authentication: false` so a client cannot mistake the current posture for an authenticated one.

**What changed in Phase 4.** Before this phase the API could only mutate rows. It can now cause process spawns and outbound sockets, which widens the blast radius of a local caller from "edit configuration" to "run a command as the gateway user". The mitigations are structural (no shell, argument arrays, destination policy, no auto-connect) but they are **not** a substitute for authentication. Do not expose this API — including via a tunnel or reverse proxy — until Phase 6.

## 3.2 Outbound destination policy (SSRF)

Implemented in `src/security/network-policy.ts`. A gateway that dials operator-supplied URLs is an SSRF primitive unless destinations are constrained; `http://169.254.169.254/` or `http://10.0.0.5:6379/` in a backend definition would otherwise turn the local API into a network scanner.

Rules, applied to every Streamable HTTP request:

1. Scheme must be `http` or `https`. No `file:`, `gopher:`, `javascript:`, etc.
2. Embedded credentials (`user:pass@`) are refused — they are logged by proxies and would leak through a redirect.
3. The hostname is **resolved**, and every returned address is classified. A string check is not enough: `http://metadata.google.internal` looks public.
4. Refused classes: loopback, private (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), link-local (`169.254/16`, `fe80::/10`), unspecified (`0.0.0.0`, `::`), multicast, reserved, and IPv4-mapped forms of all of the above.
5. `ALLOW_PRIVATE_NETWORK=true` opens **only** loopback/private/CGNAT for local fixtures. Link-local, metadata, unspecified, multicast, and reserved stay refused, so the opt-in is not a general bypass. Default is `false`.
6. The check runs inside the `fetch` the transport uses, so it applies to **every** request rather than once per connect.
7. Redirects stay on the SDK default `redirectPolicy: 'same-origin'`. A cross-origin redirect fails instead of being followed to a destination that was never checked.

**Accepted limit, documented:** this is check-then-connect. If DNS re-resolves between our lookup and the socket (rebinding), pinning is not complete. Closing that fully needs a custom dialing agent that connects to the resolved IP; Phase 4 does not add one. The remaining window requires a hostile DNS server for a hostname the operator configured themselves.

TLS verification is never disabled: no `rejectUnauthorized: false`, no `NODE_TLS_REJECT_UNAUTHORIZED`, no custom agent anywhere in the codebase.

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
- A `POST /backends/validate` call performs **no** DNS lookup, socket open, or process spawn. A remote URL in a definition cannot be used to probe an internal network; the egress policy is applied by the adapter at connect time.
- A stdio `command` must be a single executable token. Whitespace and shell metacharacters (`;`, `&`, `|`, `<`, `>`, backtick, `$`, parentheses) are rejected, so `node x && rm -rf /` is unrepresentable rather than split or executed.
- Validation errors report the failing path and rule, never a received value. Path segments are emitted only when they are field names the gateway defines (`KNOWN_FIELDS`); anything else becomes `(redacted)`, and Zod's `unrecognized_keys` message is rewritten without the supplied key names. A pattern-based "looks safe" check is not enough — `sk-live-ABCDEFGHIJKLMNOP` matches one.
- Env keys must be POSIX names (`^[A-Za-z_][A-Za-z0-9_]{0,127}$`) and header keys must be RFC 7230 tokens, so a name is validated for what a child process or a request can actually use.
- **Known limit:** a header *name* is caller-supplied config text, like `name` or `description`. `X-Api-Key` is indistinguishable from a pasted secret, so header names are stored and displayed rather than redacted. A secret typed into a header name by mistake is therefore visible to any local API caller — the same exposure class as a secret typed into `description`. Only header/env *values* are constrained to references, and they are the fields that would carry a credential.
- Creating, updating, enabling, or disabling a backend cannot connect, spawn, or emit network traffic. The only runtime states the registry may write are `disconnected` and `disabled`; a `connected` state is never fabricated from configuration.

## 7. stdio process security

Requirements (Phase 4 implements them; see §7.1):
- Use executable + argument array.
- Avoid `shell: true` and shell interpolation.
- Validate executable and working directory.
- Control inherited environment variables.
- Set process timeouts and termination escalation.
- Do not allow arbitrary user-supplied command strings from unauthenticated sources.
- Document that configured MCP servers execute with the gateway user's OS permissions.

### 7.1 Implemented in Phase 4

- `command` must be a single executable token; whitespace and shell metacharacters are rejected by the schema itself, and arguments are a separate array. There is no shell, so nothing can be interpolated.
- The SDK transport spawns with `shell: false` and `windowsHide: true`; the gateway never builds a command string.
- The child inherits only `getDefaultEnvironment()` (`HOME`, `PATH`, `USER`, `SHELL`, `TERM`, `LOGNAME`) plus explicitly referenced variables. The gateway's own environment — where its tokens would live — is not inherited wholesale.
- Secret values are resolved in memory and passed to the transport; they are never logged, persisted, or attached to an error.
- Per-call timeout comes from the backend definition; a hung handshake is bounded rather than waiting for process exit.
- Teardown is the SDK's escalating close: stdin end → `SIGTERM` → grace → `SIGKILL`. A failed handshake closes the child before throwing, so no process leaks.
- stderr is piped with a bounded 2048-byte tail, credential-shaped tokens are redacted, and only the last line is surfaced on a failed connect.
- **Known limit, unchanged:** a configured MCP server runs with the gateway user's OS permissions. It can do anything that user can do — read their files, use their SSH keys, reach their network. Registering a backend is therefore equivalent to letting that binary run as you. There is no sandbox, container, seccomp profile, or UID split in this phase.
- **Known limit:** `cwd` is resolved against the gateway's working directory and is not confined to a root. It is stored configuration with the same trust as `command`.

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

### 9.1.1 Runtime logging (Phase 4)

Connect, disconnect, failure, retry scheduling, retry exhaustion, and shutdown each emit one structured log line.

- Fields are `{ backendId, transport, requestId, state, durationMs }` plus `{ code }` on failure and `{ attempts, delayMs }` on a scheduled retry. Never `connection`, headers, env values, URLs with query strings, or command lines.
- The transport target is stored on the adapter for logs only and strips credentials and the query string (some servers put a token there).
- Child stderr is bounded and credential-redacted; only the last line reaches an error message, which is itself truncated to the 500-character column limit.
- An SDK or transport error is normalized to a generic message before storage: SDK errors can carry response bodies, URLs, or a command line.
- Runtime state (`backendRuntime`) holds no connection detail at all — no pid, no command, no URL. The `RuntimeView` returned by the API is an explicit projection.
- **Not audited:** connect/disconnect/reconnect are logged but produce no `audit_events` row. `AUDIT_ACTIONS` has no lifecycle actions yet, and inventing one at a call site would break the contract. Add `backend.connected`/`backend.disconnected` when Phase 5 introduces a per-caller actor worth recording against.

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
- SSRF at connect time: literal loopback, private, link-local, metadata, IPv6 unique-local, and IPv4-mapped forms (all refused before a socket opens).
- SSRF via a hostname that resolves to a restricted address (resolved and classified, not string-matched).
- SSRF via `ALLOW_PRIVATE_NETWORK=true` reaching cloud metadata (still refused; the flag opens private/loopback only).
- Cross-origin redirect to a restricted destination (refused; `redirectPolicy: 'same-origin'`).
- Secret reference that cannot be resolved (fails loudly as `CONFIGURATION_ERROR`, never sent literally).
- Resolved secret value appearing in an API response, the stored config, the runtime row, or the audit log.
- Gateway restart while a backend claims `connected` (recovered to `disconnected`; nothing is re-dialled).
- Disable, delete, or config change while a child process is live (process is torn down, pending retries cancelled).

## 11. Release gate

No non-loopback exposure until:
- Authentication and authorization are implemented (Phase 6). The management API is currently unauthenticated and loopback-only; see 3.1.
- TLS/reverse-proxy assumptions are documented.
- Host/Origin and CSRF defenses are tested.
- Secrets are protected.
- Threat review and operational rollback plan are complete.
