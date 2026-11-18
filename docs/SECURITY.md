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

These controls prevent *remote and cross-origin* misuse. They do **not** provide identity, and they do not stop another local process or another local user. Treat the API as a local operator tool, equivalent in trust to a CLI on the same machine. This is a documented limitation, not an oversight; dashboard authentication is Phase 8.

Phase 6 authenticates the **MCP** surface only. The management API still has no operator identity: it can now mint, rotate, and revoke the credentials that MCP callers use, so a local caller who can reach it can issue themselves an agent credential. That is why it stays loopback-only and why it is not a lower bar to clear than it was in Phase 4.

`GET /api/v1/system` reports `capabilities.authentication: true` and a live `authentication` field (`required` or `unavailable`) so a client can tell whether the MCP surface can currently verify anything.

**What changed in Phase 4.** Before this phase the API could only mutate rows. It can now cause process spawns and outbound sockets, which widens the blast radius of a local caller from "edit configuration" to "run a command as the gateway user". The mitigations are structural (no shell, argument arrays, destination policy, no auto-connect) but they are **not** a substitute for authentication. Do not expose this API — including via a tunnel or reverse proxy — until the dashboard has an operator identity (Phase 8).

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
- Dashboard: secure local owner login/session (Phase 8).
- MCP: unique credential per agent/client (Phase 6, implemented).
- Backend: separate secret references for backend credentials.

Do not use a client-supplied `agentName` or arbitrary metadata as proof of identity.

### 4.1 Implemented in Phase 6 (MCP surface)

Every HTTP request to `/mcp` is authenticated independently. There is no session, cookie, or connection state that can carry identity forward: the bearer token presented *on this request* is the only proof accepted. `mcp-session-id`, `X-Agent-*` headers, agent names, ids, and query parameters are all just input, and none of them is read as identity.

**Credential format:** `umg_live_<43 base64url chars>` — 32 random bytes from `crypto.randomBytes`. The prefix exists so a caller can recognise what it is holding and so a leaked token is greppable; it is not a secret.

**Storage.** `agent_credentials` holds:

| Column | Content |
| --- | --- |
| `credential_hash` | HMAC-SHA-256 of the full token, lowercase hex (`CHECK length = 64`, `UNIQUE`) |
| `token_prefix` | first 12 characters, for operator recognition only |
| `hash_key_id` | which key produced the digest (`v1` today) |

The token is never written to the database, an API response after issuance, a log line, or an audit row. Verification is: shape check → HMAC over the presented token → **single indexed lookup by digest** → timing-safe re-compare → key id known to this process → status (`revoked`/`expired`) → owning agent exists and is enabled → touch usage.

**Hashing secret.** `CREDENTIAL_HASH_SECRET` (minimum 32 characters) is read in `src/index.ts` and `src/auth/credential-key.ts`, never through `Config`. It therefore cannot appear in `redactConfig`, any API response, or a config dump. `CREDENTIAL_HASH_KEY_ID` defaults to `v1` and exists for rotation.

- Production: a missing or too-short secret **fails startup**. Starting with authentication permanently unavailable would answer 401 to every MCP client while `/health` stayed green — a silently dead gateway.
- Development: startup succeeds and every MCP request fails closed with 401, so health checks and the management API remain usable while the secret is provisioned. An ephemeral secret is deliberately **not** generated: it would verify tokens only until the next restart.

A credential issued under the same secret keeps verifying across restarts, because the digest has no process-local state. Rotating the *secret* means a new key id; a credential whose key id this process does not hold is refused (`unknown_key`) rather than trusted on the digest alone.

**Failure is uniform.** Missing header, malformed header, malformed token, unknown token, wrong secret, revoked credential, expired credential, disabled agent, and missing server secret all answer the same 401 with the same body and the same `WWW-Authenticate: Bearer` challenge. The distinction exists only in the audit trail and the log.

### 4.2 Credential lifecycle

- `POST /api/v1/agents/:agentId/credentials` returns the token **once**. Listing never re-exposes it.
- Rotation creates the new credential and revokes the old one **in one transaction**, writing a single `credential.rotated` audit row carrying `previousCredentialId`. There is no overlap window: the old token stops working the moment the new one exists.
- Revocation is idempotent and keeps the original timestamp.
- Deleting an agent tombstones it, revokes every credential, and drops every policy assignment in the same transaction.
- Issuing requires a hashing key. With none configured the API returns a configuration error rather than creating a credential that could never authenticate.

## 5. Authorization

- Default deny for unknown agents.
- Newly created agents have no tool access by default.
- Enforce policy on both `tools/list` and `tools/call`.
- Dashboard role checks enforced server-side.
- Re-evaluate access on every call, not only at session initialization.
- Define and test allow/deny precedence.

### 5.1 Implemented in Phase 6 — precedence, in this order

1. **System restrictions** — a disabled agent, a disabled backend, or an unusable credential denies before any policy is read. No rule can re-enable them.
2. **Highest policy `priority` wins.** The operator's explicit ordering is authoritative, so a deny at `priority: 10` beats an allow at `0` — and vice versa.
3. **At equal priority, `deny` beats `allow`.**
4. Remaining ties break by policy id, then rule index, so the outcome never depends on row order.
5. **No matching rule → deny.**

A rule matches a `tool` resource by public tool name (`<backendId>__<tool>`) or a `backend` resource by backend id; `*` matches any target at that level. Policy targets naming an unknown backend are rejected at write time. Tool targets are checked for *shape* only, because the catalog is transient (ADR-038) and a policy must be authorable while its backend is disconnected.

Both enforcement points call the same `AuthorizationService`, so the view and the boundary cannot drift:

- `tools/list` returns only the tools this agent may call.
- `tools/call` rejects before resolution.

### 5.2 A denied call is indistinguishable from a nonexistent one

An unauthorized `tools/call` answers `-32602` with the message `Unknown tool` — the same code and the same bytes as a name that was never published. No backend name, backend id, policy id, or reason is disclosed, and no input schema is returned. Resolving first would have allowed a caller to distinguish "exists but not yours" from "does not exist" by error or by timing, so authorization runs *before* routing: a denied call performs no backend lookup, no reachability check, no schema compile, no invocation, and writes no `tools.call` activity. One catalog read does happen — it is how a `backend`-scoped rule learns the tool's backend, and it is used only to decide and to enrich the audit row.

The real reason (`default_deny`, `explicit_deny`, `agent_disabled`, `backend_disabled`) is written to `access.denied` in `audit_events` with the agent id, the resolved backend/tool id where safely determinable, the credential id, the correlation id, and the decision timestamp.

### 5.3 Persistent session binding (Phase 7)

A protocol session is now bound to exactly one agent and one credential, but the binding is **an additional check, never a substitute for authentication**. The order per request is:

1. Verify the bearer credential (Phase 6, unchanged).
2. Resolve `mcp-session-id` to a stored session, if the request carries one.
3. Require the session to exist, be `active`, and belong to *this* agent.
4. Require the credential to be the one that opened it, and still unrevoked and unexpired.
5. Require the owning agent to exist and be enabled.
6. Record activity, then serve.

Every step re-reads the database. A session id alone authenticates nothing: a request carrying a valid session id and no token is a 401 from step 1, and the socket tests assert exactly that.

**Which era has a session at all.** Against the installed SDK (server/client `2.4.0`), the 2026 era is per-request by design and issues no `mcp-session-id`; identity is re-established on every exchange, so there is nothing to bind and nothing to hijack. The 2025 era does issue one, and is served through `WebStandardStreamableHTTPServerTransport` with `sessionIdGenerator`. Only an `initialize` or a request that already presents a session id takes that path; everything else keeps the stateless leg, which is why a one-shot `tools/list` still works exactly as it did in Phase 6.

**Refusals do not disclose ownership.** A session belonging to another agent, a session id that was never issued, a terminated session, an expired session, and a session whose transport is gone all answer the same `404` with `{"code":-32001,"message":"Session not found"}`. `tests/mcp-sessions.test.ts` asserts the cross-agent body is byte-identical to the never-issued body. The real reason (`session_owner_mismatch`, `session_unknown`, `session_expired`, `credential_revoked`, `agent_disabled`, …) exists only in the `session.access.denied` audit row and the log.

**Identity is immutable.** The owning agent, credential, protocol id, internal id, and creation time cannot change after insert: migration `0005` installs a `BEFORE UPDATE` trigger that aborts the statement, so even a bug — or another gateway process — cannot reassign a session. A finished session cannot be returned to `active` either (`sessions_no_reactivation`), so an operator's termination is one-way.

**Lifecycle takes effect immediately.** Revoking a credential, rotating it, disabling an agent, deleting an agent, and an explicit terminate all end the affected sessions in the *same transaction* as the change, and each is re-checked per request anyway. Expiry is enforced per request from `lastActivityAt` + idle timeout and from `expiresAt`; the cleanup sweep only writes back what a request would already refuse, so a missed sweep cannot extend access.

**Multi-process limit, stated plainly.** The transport registry is in-process. A session created by one gateway process cannot be served by another, and this is not claimed otherwise: there is no Redis, no shared lock, no cross-process registry. What *is* cross-process is the database: the unique index on `mcp_session_id` and the immutability trigger hold for every writer, so two processes cannot bind one protocol session to two agents or move an existing one.

### 5.4 Audit volume control

Authentication success and failure rows are collapsed per agent (success) or per reason (failure) within a fixed 60-second window. Suppressed repeats are counted and folded into the next written row as `suppressed`, so the trail never understates an attempt while a caller cannot grow the table linearly by looping.

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
  - Phase 6 correction: only `env:` is actually resolvable. There is no secret store yet, so a `secret:` reference fails loudly as `CONFIGURATION_ERROR` at connect time and is never sent literally. It is accepted by the schema because the reference format exists to keep the value out of `config_json`, not because resolution is implemented.
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

### 6.3 Implemented in Phase 6

- **The MCP credential is an HMAC-SHA-256 digest of the whole token, keyed by `CREDENTIAL_HASH_SECRET`.** A plain SHA-256 would let anyone who obtained a copy of the database verify guesses offline; keying the digest means a database leak alone is not enough to mount a dictionary attack on tokens that follow the `umg_live_` format.
- **The secret never enters `Config`.** It is read by `src/auth/credential-key.ts` and `src/index.ts` only. `redactConfig`, the config validator, the management API, `/health`, and `/api/v1/system` have no field that could carry it, so it cannot be leaked by a serialization change.
- **Comparison is timing-safe.** The indexed lookup is by digest, so a hit already implies equality; `crypto.timingSafeEqual` re-checks it anyway so a future query change cannot silently turn a prefix match into an authentication.
- **Key ids make rotation possible without a flag day.** `hash_key_id` records which key produced a digest. A credential whose key id this process does not hold is refused (`unknown_key`) rather than verified on the digest alone.
- **Tokens are returned exactly once**, at issue or rotate. There is no "show token" endpoint and no field in any projection that carries one. `toPublicCredential()` omits `credentialHash` and `token` by construction, not by a delete call.
- **No secret is ever written to audit or logs.** `auth.succeeded`/`auth.failed`/`access.denied` carry ids, reason, and outcome only. The pino redaction list already covers `authorization` and `*.token|credential|credentialHash|password|secret|apiKey`.
- **`umg_live_` tokens are not password-equivalent.** They are machine credentials with no user, no scope beyond the owning agent's policies, and no ability to reach the management API.
- **Known limit:** the hashing secret is a symmetric secret in the process environment. Anyone who can read `/proc/<pid>/environ`, the shell history that set it, or a backup of the deployment's env file can mint credentials offline. Rotate it by adding a new key id, revoking, and reissuing; there is no automatic rehash-on-verify yet.
- **Known limit, unchanged:** the management API remains unauthenticated on loopback, and it can issue credentials. A local attacker with API access does not need to steal one.

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

### 9.1.2 Tool arguments and results (Phase 5)

The tool surface is a new trust boundary in both directions: a caller supplies arguments, and a backend supplies results. Neither is logged.

- `tools.call` activity holds only `backendId`, the public tool name, outcome, `errorCode`, `durationMs`, and the bounded JSON-RPC id. `activity_events` has **no** column for arguments or results — omission is structural, not a filter someone can forget.
- Discovery logs counts, names, and codes. A remote schema body is never logged: it can embed descriptions and defaults the operator did not write.
- A tool that normalizes to an unusable name is reported by count only, because a malformed tool can carry arbitrary strings in its `name` field — logging it would hand a hostile backend a log-injection primitive.
- **Arguments are validated against the backend's own JSON Schema** before dispatch, with AJV and no coercion. This is a correctness control first: forwarding `{limit: "2"}` where the backend declared an integer is how a tool silently does the wrong thing. It is not an authorization control — a schema describes shape, not entitlement.
- If a backend's schema cannot be compiled, the call is forwarded **unvalidated** and the reason is logged at `warn`. The alternative — substituting an empty permissive schema — would erase the distinction between "no constraints" and "constraints we could not check", and would hide the bug (ADR-037).
- Only tools from a connected, enabled backend are listed or callable, and that is re-checked at call time. A catalog entry is a hint; `isConnected` is the fact.
- There is **no HTTP tool-invocation endpoint**. Invocation exists only on `/mcp`, so there is one place to authenticate and one place to redact. A REST "test call" would need its own authorization model and its own result contract, and Phase 5 has neither.
- Cancellation is derived from the transport's abort signal, not from an error's shape, so a backend cannot fabricate a "cancelled" outcome by throwing a lookalike error.
- Child stderr is bounded and credential-redacted; only the last line reaches an error message, which is itself truncated to the 500-character column limit.
- An SDK or transport error is normalized to a generic message before storage: SDK errors can carry response bodies, URLs, or a command line.
- Runtime state (`backendRuntime`) holds no connection detail at all — no pid, no command, no URL. The `RuntimeView` returned by the API is an explicit projection.
- **Not audited:** connect/disconnect/reconnect are logged but produce no `audit_events` row. `AUDIT_ACTIONS` still has no lifecycle actions; Phase 6 added agent/credential/auth actions only. Add `backend.connected`/`backend.disconnected` when there is a reason to correlate them with a per-caller actor.

### 9.1.3 Authentication and authorization audit (Phase 6)

Three new audit actions, all with flat primitive metadata:

| Action | Actor | Metadata |
| --- | --- | --- |
| `auth.succeeded` | `agent` | `credentialId`, `hashKeyId` |
| `auth.failed` | `system` | `reason` (fixed enum), `credentialId` and `agentId` only when the credential row was located |
| `access.denied` | `agent` | `reason`, `backendId`/`toolId` where resolvable, `credentialId`, `matchedPolicyId`, `suppressed` |

Phase 7 session actions (`docs/MONITORING.md` §6.4 has the full table): `session.created`, `session.authenticated`, `session.access.denied`, `session.expired`, `session.terminated`, `session.invalidated`, `session.cleanup.completed`. Metadata is ids, reasons from a closed enum, and counts — never a token, an `Authorization` header, an HMAC key, request content, or transport state. `session.authenticated` is windowed (once per session per 60 s) and `session.access.denied` once per reason per 60 s, with the suppressed count folded into the next row, so a busy or hostile client cannot grow the table linearly.

- The failure *reason* is internal. On the wire every failure is the same 401; only the audit row and the `warn` log carry `malformed_token`, `revoked_credential`, `agent_disabled`, and so on.
- `access.denied` names the resolved backend and tool id when the decision could be made about them, and the bare public name otherwise. A name that resolves to nothing is audited by name only, so probing for tools leaves a trail without confirming that anything exists.
- Repeated failures are collapsed per reason within a 60-second window, with the suppressed count folded into the next row, so a loop cannot grow the table linearly.
- Audit is best-effort by design: `safeAudit` swallows a write failure after logging it, because a request that was already refused for security reasons must not turn into a 500.
- Tokens, headers, agent-supplied names, and authorization reasons never appear in metadata. `tests/mcp-auth.test.ts` and `tests/authentication.test.ts` assert both the presence of the ids and the absence of the token.

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

Phase 6 additions (all covered by `tests/credentials.test.ts`, `tests/authentication.test.ts`, `tests/authorization.test.ts`, `tests/mcp-auth.test.ts`):

- `/mcp` called with no credential, a malformed header, a malformed token, an unknown token, a revoked credential, an expired credential, or a disabled agent's credential (all one identical 401).
- The same bearer token replayed against a *different* request after revocation (401: verification is per request, not per session).
- A previously issued `mcp-session-id` replayed without a token (401; session ids are not credentials).
- A client declaring another agent's id or name in a header (`X-Agent-Id`, `X-Agent-Name`) while holding its own token (authenticated as itself; claims ignored).
- A live credential used with a different `CREDENTIAL_HASH_SECRET` (401: digest mismatch, no oracle).
- A credential whose `hash_key_id` this process does not hold (`unknown_key`, refused).
- A no-op re-hash: two processes with the same secret verify the same stored digest across restarts.
- `tools/call` for a tool that exists but is not granted (byte-identical to a nonexistent tool: `-32602`, `Unknown tool`; no backend id, policy id, reason, or schema disclosed).
- `tools/call` for a guessed name (`ghost__tool`) by an agent that may use other tools (same answer).
- `tools/list` for an agent with no policy, a tool-only policy, and a wildcard policy (empty, one tool, all tools).
- A denied call producing **no** backend invocation and **no** `tools.call` activity row.
- Two agents seeing different catalog views at the same moment.
- Policy precedence: priority beats effect, equal priority denies, ties are order-independent, system restrictions beat every rule.
- Rotating a credential (`previousCredentialId` audited, old token dead immediately) and deleting an agent (all credentials revoked, all assignments dropped).
- Inspecting `/health`, `/api/v1/system`, and the agent/credential/policy endpoints for the hashing secret or a stored token (never present).

Phase 7 additions (covered by `tests/mcp-sessions.test.ts`, `tests/sessions.test.ts`, `tests/sessions-api.test.ts`):

- Agent A initializing a session, then agent B presenting A's `mcp-session-id`: `404`, byte-identical to a never-issued id, A's session still `active` and still owned by A.
- The same test in reverse (B→A), so the result cannot depend on creation order.
- A valid session id with **no** credential (401) and with a **different** agent's credential (404).
- `X-Agent-Id` / `X-Agent-Name` spoofing on a session-bearing request: served as the bearer's identity, headers ignored, stored owner unchanged.
- Guessing a session id (`never-issued`, `guess`): the same refusal as another agent's real id, with no timing or body difference an operator can branch on.
- Revocation, rotation, agent disable, and agent delete while a session is live: the next request fails, and the row is `invalidated` with the matching reason.
- Credential expiry with the session row still `active`: refused at authentication, before any session lookup succeeds.
- Idle timeout and max lifetime reached with no sweep: refused at request time; the stored row is unchanged, proving enforcement does not depend on the sweep.
- Terminate through the API, then a session-bearing `tools/call`: `404`. Repeating terminate returns the same timestamp and does not resurrect the session.
- Raw `UPDATE sessions SET agent_id = ...` and `UPDATE ... SET status = 'active'` on a finished row: both abort (trigger), asserted at the repository level in `tests/repositories.test.ts` and against an upgraded database by `verify-0005.ts`.
- Graceful shutdown: every active session becomes `terminated` / `gateway_shutdown`, and transports are released before the store closes.
- `/api/v1/sessions`, its detail, terminate, and cleanup endpoints read for credential hashes, tokens, and transport state (never present).

## 11. Release gate

No non-loopback exposure until:
- Authentication and authorization are implemented. **MCP is done (Phase 6); the management API still has no operator identity (Phase 8).** The API is loopback-only; see 3.1.
- TLS/reverse-proxy assumptions are documented.
- Host/Origin and CSRF defenses are tested.
- Secrets are protected — `CREDENTIAL_HASH_SECRET` is required in production and never enters `Config`, but it is still a symmetric secret in the environment with the limits in 6.3.
- Threat review and operational rollback plan are complete.

**Explicitly not satisfied by Phase 6 or Phase 7:** dashboard login, dashboard sessions/CSRF, TLS, per-operator identity on the management API (Phase 8), and any form of non-loopback exposure. Do not put this behind a tunnel yet. The session management API is an operator surface on the *unauthenticated* loopback boundary — it can terminate a client's session, so it inherits §3.1 in full: loopback only, no proxy, no tunnel.
