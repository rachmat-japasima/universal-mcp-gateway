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

### 3.1 Management API boundary (Phase 4, extended in Phase 10.0) — read this before exposing anything

**The management API requires an operator session** (Phase 10.0, §4.3). Before that it had no login at all, so any process or user that could reach the loopback socket could create, modify, enable, disable, or delete backend definitions — and, since Phase 4, **make the gateway spawn a process or open an outbound connection**. That is now behind a password login, but the API is still loopback-only and **not remote-ready**: there is no TLS, and a local user who can read the operator's password or attach a debugger to the process is not stopped.

What is actually enforced, per request:

| Control | Mechanism |
| --- | --- |
| Operator session | **Phase 10.0.** Every `/api/v1` route requires a live operator cookie; the only exemptions are `POST /auth/login` and `POST /auth/logout` (§4.3) |
| CSRF | **Phase 10.0.** `SameSite=Strict` plus a required `X-CSRF-Token` on every non-safe method |
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

These controls prevent *remote and cross-origin* misuse. Since Phase 10.0 they are joined by an operator session on the management API (§4.3), so "another local process" can no longer read or mutate it without signing in. What remains true: the API is loopback-only, it is not protected against a *local user who holds the operator password*, and there is no TLS. Treat it as a local operator tool, not as a multi-tenant service.

Phase 6 authenticates the **MCP** surface with per-agent credentials; Phase 10.0 authenticates the **management** surface with an operator session. Those are separate boundaries and neither substitutes for the other (§4).

`GET /api/v1/system` reports `capabilities.authentication: true` and a live `authentication` field (`required` or `unavailable`) so a client can tell whether the MCP surface can currently verify anything.

**What changed in Phase 4.** Before this phase the API could only mutate rows. It can now cause process spawns and outbound sockets, which widens the blast radius of a local caller from "edit configuration" to "run a command as the gateway user". The mitigations are structural (no shell, argument arrays, destination policy, no auto-connect) and, since Phase 10.0, require an operator session — but they are still **not** a substitute for TLS or for exposure review. Do not expose this API — including via a tunnel or reverse proxy — on the strength of a password login over plain HTTP.

**What changed in Phase 8.** The API gained read surfaces over everything it already held: `/overview`, `/monitoring*`, `/diagnostics`, `/settings`, `/activity`, `/audit`, and the OpenAPI document. Read-only is not the same as harmless — a log endpoint is a disclosure surface — so each was designed around what it must *not* return:

| Endpoint | Deliberately never returns |
| --- | --- |
| `/settings` | Any secret, token, or credential value. The key list is explicit; the HMAC secret is not on `Config` at all, so there is no field that could carry it. Availability is reported as booleans, not as reasons that would require inspecting the secret. |
| `/diagnostics` | `process.env`, environment values, database paths, secret presence. Node version, platform, uptime, migration version, and counts only. |
| `/activity` | Tool arguments, tool results, or remote schema bodies — the table never stores them. |
| `/audit` (list) | `metadata`. Only `GET /audit/:eventId` renders it, so reading free-form context is one explicit act rather than a collection response. |
| `/audit` and `/activity` (any verb) | Any write. The repository interfaces declare no update or delete, so append-only cannot be bypassed by a route. |

Neither `settings` nor `diagnostics` mutates state, and `settings` answers `404` to every write verb because no mutation path exists.

One tightening landed with these: `GET /api/v1/backends/:id/tools` now answers `404` for an unknown backend instead of `200` with an empty list. That is an information-quality fix, not a security one — an unknown backend and an empty backend were indistinguishable to an operator.

**What changed in Phase 11.** Two new disclosure surfaces arrived, and both were
designed against what they must not become:

- `GET /metrics` (root, Prometheus text) is aggregate operational data — a
  metrics port is the classic leak, so it sits behind the **same operator
  session and loopback checks as `/api/v1`** and is mounted only when an
  operator row exists. There is no unauthenticated scrape path, and its JSON
  twin `/api/v1/monitoring/metrics` lives inside the versioned API's existing
  boundary. Neither ever carries a tool name, agent id, username, or anything
  a caller chose: **labels are closed enums**, so the export cannot disclose
  topology or identity by construction. The error ring keeps
  `{code, component, at, requestId}` — codes and components, never messages,
  stacks, or paths.
- An inbound `X-Correlation-Id` is **validated, never trusted**: it must match
  `^[A-Za-z0-9._-]{1,64}$` or it is replaced, because a header the operator
  cannot control must not become a log-injection vector. It flows to log
  fields and one nullable activity column; audit rows keep the gateway's own
  `requestId` only.

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

**Managed-provider connectors (Phases 13/16) are a different outbound class.** The GitHub and Notion clients dial no operator-supplied URL at all — their origins are constants (`https://api.github.com`, `https://api.notion.com`) in connector code, and no field on any route or form can change them. Since Phase 15 both clients refuse redirects outright (`redirect: 'error'`): a hop anywhere else — even one undici would have stripped the `Authorization` header from — is a network failure, so the no-cross-host boundary is enforced by the request itself, not by platform courtesy. The SSRF policy exists to constrain *chosen* destinations; a constant destination needs no constraint, only the TLS-verification rule below, which the clients inherit by using plain `fetch` with no custom agent.

TLS verification is never disabled: no `rejectUnauthorized: false`, no `NODE_TLS_REJECT_UNAUTHORIZED`, no custom agent anywhere in the codebase.

## 4. Authentication

Separate dashboard and MCP authentication:
- Dashboard: local owner login and server-side session — **implemented in Phase
  10.0** (§4.3).
- MCP: unique credential per agent/client (Phase 6, implemented, §4.1).
- Backend: separate secret references for backend credentials.

These are **separate security boundaries**. An operator session is never accepted
as an agent credential, and an agent credential never grants dashboard access.
Do not use a client-supplied `agentName` or arbitrary metadata as proof of
identity. `tests/operator-auth.test.ts` asserts both directions: an operator
cookie at `/mcp` gets `401` with a `Bearer` challenge, and an agent bearer at
`/api/v1` gets `401`.

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

### 4.3 Implemented in Phase 10.0 (management surface)

The management API — every route under `/api/v1` — now requires an operator
session. `/health` and `/ready` stay unauthenticated because a probe that needs a
session stops probing, and they carry no sensitive data.

**Enforcement is in the gateway, not in Next.js.** The REST surface is directly
reachable on `127.0.0.1:8787` by any local process, so a guard that lived in the
browser app would be cosmetic: `curl` does not load a page. The middleware is
`src/api/middleware/operator-auth.ts`.

**Default deny with a closed exemption list.** A request is allowed only if it
carries a live operator cookie, with exactly two exemptions — `POST
/api/v1/auth/login` and `POST /api/v1/auth/logout`, the endpoints whose job is to
create and end a session. The direction matters: a route added later is protected
because it did not opt out. `tests/operator-auth.test.ts` asserts a `401` on one
route per router (15 paths) so a router mounted without the middleware fails a test
rather than shipping an open surface.

| Control | Implementation |
| --- | --- |
| Password storage | `scrypt` from `node:crypto`; parameters (`N`, `r`, `p`) encoded in the stored string, so a future cost increase does not invalidate existing hashes |
| Session storage | opaque 256-bit token; only an HMAC-SHA-256 digest (`token_hash`) is stored, keyed by `CREDENTIAL_HASH_SECRET` with its own key id |
| Session lifetime | idle timeout (30 min) and absolute lifetime (12 h) both derived on read, so neither can be extended by using the session |
| Rotation | a login carrying an existing session ends that session before minting the new one, so a pre-login session id cannot survive login |
| Lockout | 5 consecutive failures → 15 minutes, persisted as `locked_until`; the correct password is refused while the lock stands |
| Enumeration defence | unknown user, wrong password, disabled account, and lockout all answer the same `401` with the same message; a dummy scrypt verification burns comparable time on unknown users |
| Cookie | `HttpOnly`, `SameSite=Strict`, `Path=/`; `Secure` only when explicitly configured (`OPERATOR_COOKIE_SECURE`), because a `Secure` cookie on plain-HTTP loopback is silently dropped and login appears to do nothing |
| CSRF | `SameSite=Strict` plus an `X-CSRF-Token` header derived as `HMAC(session token, "operator-csrf-v1")`, verified on every non-safe method. No extra column, no stored token, and a token from another session is rejected |
| Dead cookie | every rejection path clears the cookie, so an expired session redirects once instead of looping |

**Bootstrap.** `pnpm operator:create` reads the password from stdin/a TTY prompt —
never from argv, where it would land in shell history and process listings — and
refuses to run when an operator already exists. There is no default or generated
password. An unconfigured instance answers login with *"No operator is configured.
Run `pnpm operator:create` on the gateway host."* and nothing more.

**Identity separation.** Operators live in `admin_users` and `operator_sessions`,
not in `agents`/`sessions`. Sharing a table would make "this credential can call
tools" and "this session can mint credentials" the same row. An operator row is
never returned with its hash: every public shape strips it (`tests/operator-identity.test.ts`).

**Audit.** Emitted on the wire today: `operator.login.succeeded`,
`operator.login.failed`, `operator.logout`, `operator.session.expired` (written
when a lapsed session is refused), and `operator.created` (written by
`pnpm operator:create`). Three further actions are declared in
`src/domain/audit-event.ts` with **no caller**: `operator.session.revoked`
(`OperatorService.revokeSession` is only reachable from code, not from a route),
`operator.disabled`, and `operator.password_changed` — there is no disable route
and no password-change route (§8.2). Listing an action in the vocabulary is not
the same as observing it. A failed login deliberately does **not** record the
attempted username — the trail would otherwise become a list of guesses at
identities that may not exist — and no row ever contains a password or a session
token.

**Limits, stated plainly.** This is a single local owner (`role: owner`, no RBAC
engine — ADR-045). It is not TLS: the password and cookie cross loopback in
plaintext, which is acceptable only because loopback never leaves the host. It is
not protection against another local user who can read the operator's password or
attach a debugger to the gateway process. It does not make non-loopback exposure
safe. See §11.

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
- **Known limit:** `umg_live_` tokens still reach nothing but `/mcp`. The management API now requires an operator session, so an agent credential cannot mint another credential — but a local user who holds the operator password can, and there is no second factor.

### 6.4 Implemented in Phase 12 — the integration credential vault

This is the "encrypted secret storage" §6 requires documentation for, so this subsection states key derivation, key location, rotation, backup, and recovery explicitly (ADR-051).

- **What is stored:** `integration_credentials.envelope` — an AES-256-GCM envelope `{v, keyId, wrappedDek, wrapNonce, wrapTag, nonce, ct, tag}`. Per seal: a fresh random 32-byte DEK seals the payload; the master key wraps the DEK; both GCM operations bind the key id as AAD and use fresh 12-byte nonces. No column anywhere in the schema can hold plaintext, and the security suite scans every database file (WAL siblings included) after a round trip to prove the value never lands on disk.
- **Key derivation:** none — the key *is* the secret. `INTEGRATION_MASTER_KEY` is 32 bytes, base64, read by `src/integrations/vault.ts` only; it never enters `Config`, is never logged, and is not echoed by `/health`, `/diagnostics`, or `/api/v1/system`. The envelope's `keyId` is digest-derived (never the key bytes), which is what makes a mismatch diagnosable without disclosing material.
- **Key location:** the process environment only. No config file, no database row, no default. A key that can decrypt the database must not live in the database; a default key would be a lock painted on.
- **Rotation:** set `INTEGRATION_MASTER_KEY` to the new value and `INTEGRATION_MASTER_KEY_PREVIOUS` to the old. Sealing always uses the active key; unsealing tries active then previous and reports both key ids on mismatch. Re-encrypting old records is an explicit operator re-store per credential — no background re-encryption exists, because a queue for it would be unwritten code whose only effect is moving ciphertext around without an operator decision.
- **Backup and recovery:** back up the key the way any environment secret is backed up (the deployment's env file); a database backup without the key is inert ciphertext by design. Losing the key loses the credentials — they must be re-stored at the provider. That is the honest failure mode of envelope encryption and it is preferred to a recoverable plaintext.
- **Fail-closed, not degraded:** a missing key never blocks startup (MCP serving, listings, and the operator API stay up) but the first seal or unseal refuses with `CONFIGURATION_ERROR`, the connection row keeps `credential_id: NULL`, and no weaker fallback exists. A test drives this through the real gateway wiring.
- **The value crosses exactly one boundary:** the connector context's `resolveCredential(credentialId)` (ADR-049). It is backend-only, every resolution is audited as `integration.credential.resolved` with the reference id and never the value, and no endpoint returns a value. Phase 13 added the one credential route the operator flow needs — `POST /api/v1/integrations/connections/{id}/credential` — and it is **write-only**: the security suite pins that path's OpenAPI methods to exactly `['post']`, so no read surface for the secret can appear by drift. References are validated as UUIDs, so a pasted `sk-live-...` string in `credentialId` is a validation error, not a stored secret.
- **Known limit:** the DEK lives in memory only during a seal/unseal, but there is no mlock or key vault — a memory-scraping local attacker defeats this vault, as they defeat every secret in a loopback process. The vault protects *at rest*, against database-file exfiltration and accidental plaintext writes, not against the machine's own root user.

### 6.5 Implemented in Phase 13 — the first live provider credential (GitHub PAT)

The vault of §6.4 now holds a real secret shape: a GitHub fine-grained PAT (ADR-053). The rules that make that safe are code, not operator diligence.

- **Least privilege is the only offered shape.** The connector asks for Metadata, Issues and Pull requests (read) and nothing else; the gateway registers no tool that could write to GitHub, so a compromised gateway cannot spend the token on content the PAT does not grant anyway. The token's reach is whatever the operator's PAT grants — the gateway displays when the token was last proved (`validatedAt`), not a fabricated scope list.
- **The HTTP client is provider-owned and closed.** Fixed origin `https://api.github.com`, HTTPS only, no caller-suppliable URL (nothing an agent or operator types can redirect the client), and redirects refused outright (`redirect: 'error'`, Phase 15) so no hop can carry the token to another host; the headers are exactly `Authorization: Bearer`, `X-GitHub-Api-Version: 2026-03-10`, `Accept: application/vnd.github+json`, `User-Agent: universal-mcp-gateway`. The token never rides a query string, never appears in an error, a metric label, an audit row, or activity metadata — the audit vocabulary is closed (`integration.connection.*`) and metadata fields are whitelisted ids and names.
- **The provider cannot speak through the gateway.** GitHub prose never crosses the connector boundary: every failure is mapped into the connector's own vocabulary (`reauthorization_required`, `invalid_request`, `provider_error`, `unreachable`), so an operator or agent reading an error sees the gateway's words, not injected provider text.
- **The dashboard holds the PAT for one keystroke-path, not longer.** The credential input is `type="password"` with `autoComplete="off"`; the field is cleared when the request answers, success or failure; the token is never rendered back, never written to storage, cookie, or URL — all asserted in the component suite. The only credential fact on the page is the vault reference.
- **Storing, proving, and connecting are three separate decisions.** `credential` seals and stops; `test` proves with no state change (data either way, so a refused token cannot masquerade as a server error); `enable` is the only transition to `connected` and the only one that stamps `validatedAt`. A stored-but-unproven token is reported as exactly that (`pending`, `validatedAt: null`).
- **No test dials GitHub.** The client takes an injectable `fetch`; every suite exercises fixture responses, so the repository makes zero outbound calls to `api.github.com`. The first live call happens when an operator runs `test` or `enable` with a real token — behind the operator session, from the operator's machine.

Phase 16 adds the second live credential shape under the same rules (ADR-055, `docs/providers/NOTION.md`): a Notion **internal connection token** — a workspace-scoped static bearer token, no OAuth. Least privilege is the portal's single **Read content** checkbox; the connection sees only explicitly shared pages, access inherited by children. The client's facts differ and stay Notion's own: fixed origin `https://api.notion.com`, headers exactly `Authorization: Bearer`, `Notion-Version: 2026-03-11`, `Accept: application/json` (`Content-Type: application/json` on POSTs; no User-Agent — Notion's docs ask for none), the same bounded single retry, the same closed five-kind failure vocabulary, the same injectable-`fetch` rule — zero calls to `api.notion.com` from the repository. Notion offers **no capability-listing endpoint**, so the handshake (`GET /v1/users/me`) proves the token's authenticity, not its capability breadth; the docs and dashboard state the requirement instead of pretending to verify it, and the bot user's workspace name is never stored.

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

### 8.1 Implemented in Phase 10.0 — operator identity

- **The dashboard has a login.** `/login` posts to `/api/login`, a dashboard route
  handler that forwards the credentials to the gateway over loopback and re-issues
  the resulting cookie on the dashboard origin (a cookie set by
  `127.0.0.1:8787` would never be sent to `localhost:3000`). The dashboard never
  verifies a password and never mints a session; the gateway remains the only
  place either happens. A dashboard that is down is therefore not an
  authentication bypass, and a dashboard that is up is not the guard.
- **The protected tree asks the gateway, it does not guess.**
  `getOperatorSession()` probes `GET /api/v1/auth/session` with the browser's
  cookie, wrapped in React `cache()` so a layout, header, and page in one render
  make one request. A revoked or expired cookie is indistinguishable from no
  cookie — which is exactly what a cookie-existence check would get wrong. The
  `(dashboard)` layout calls `requireOperator(pathname)` and redirects to
  `/login?next=…` only when that probe fails.
- **`next` cannot become an open redirect.** `safeNextPath` resolves the candidate
  through `URL` and accepts only `/dashboard` and paths beneath it, rejecting
  `//host`, `/\host`, absolute URLs, and traversal such as
  `/dashboard/../../etc` (`apps/dashboard/tests/auth-login.test.ts`).
- **The re-issued cookie keeps its protections.** Only name/value are copied from
  the gateway's `Set-Cookie`; `HttpOnly`, `SameSite=Strict`, and `Path=/` are
  restated, and `Max-Age` is forwarded rather than re-invented so the browser-side
  lifetime cannot drift from the session's. `Secure` is set only when
  `GATEWAY_ORIGIN` is https.
- **Sign-out revokes before it forgets.** `/api/logout` calls the gateway's
  `/logout` first, then deletes the local cookie. Clearing the cookie alone would
  leave a usable session that a copied cookie could still replay. The account menu
  in the header shows the identity the gateway confirmed on the server — never a
  value the browser supplied.
- **The browser still cannot reach the management API.** The gateway binds
  `127.0.0.1` and sends no CORS headers. Server components call it over loopback;
  client-side refresh goes through `/api/proxy/[...path]`, a same-origin
  **allowlist** of documented `GET` reads enforced server-side. It forwards only
  the operator cookie, not the whole jar, and it is not a passthrough.
- **`GATEWAY_ORIGIN` is server-only.** It is deliberately not `NEXT_PUBLIC_*`, so
  the browser never learns the gateway's address. No secret, hash, or session
  token is ever placed in `NEXT_PUBLIC_*`, `localStorage`, or `sessionStorage`.
- **No secrets in the UI path.** The client normalises failures into an
  `ApiError` whose `userMessage` cannot carry a stack trace, SQL text, or request
  URL. The reads it renders (`/overview`, `/monitoring*`, `/diagnostics`,
  `/settings`) already withhold secrets server-side (§3.1).
- **No mutation control exists yet.** Every module route except `/dashboard` is a
  placeholder, so there is nothing to protect beyond the reads. The gateway-side
  boundary is nevertheless complete, so the first mutation control added inherits
  enforcement rather than needing it retrofitted.

### 8.2 Not yet implemented — required before any of it can be claimed

- CSP and security headers on the dashboard origin.
- Rate limits for login beyond the per-account lockout (no per-IP limiter yet).
- Authorization for sensitive management operations: one `owner` role, no RBAC.
- TLS. Loopback only; the password crosses plaintext HTTP within the host.
- Multi-operator support, password change UI, and session listing UI.
- **Changing or resetting an operator password.** No route exists: `POST
  /api/v1/auth/login` and `POST /api/v1/auth/logout` are the only writes under
  `/api/v1/auth`. `OperatorService.revokeAllFor(id, 'operator_password_changed')`
  is implemented and tested at service level, but nothing calls it from a
  request. Recovery today means shell access on the gateway host: stop the
  process, delete the operator row, run `pnpm operator:create` again. That is a
  deliberate non-feature, not an oversight — a password reset that does not
  re-verify the old password is account takeover for anyone who reaches the
  session, and `operator:create` refuses to overwrite an existing operator
  precisely so it cannot be used as a silent reset. **Do not add a reset route
  that skips verification.** When password change ships it must (a) require the
  current password, (b) hash with `hashPassword`, (c) call
  `revokeAllFor(..., 'operator_password_changed')` and audit
  `operator.password_changed`, and (d) re-issue only the acting session or force
  re-login.
- **Revoking operator sessions on shutdown.** `gateway.close()` terminates MCP
  sessions (`gateway_shutdown`) but not operator sessions; operator rows survive
  a restart and are re-validated per request, which is intended (a restart is not
  a sign-out). `OperatorService.sweep()` is never scheduled either — expiry is
  enforced on read and the refusing request writes `revocation_reason='cleanup'`,
  so an unswept row cannot grant access. The consequence is only that
  `revoked_at` lags for sessions nobody touched. `gateway_shutdown` and
  `operator_deleted` exist in the reason `CHECK` and the domain enum but no code
  writes them: both are vocabulary reserved for a future dispose/delete route.

### 8.3 The rule that governs the gap

**Do not present a control as protected when it is not.** The inverse now applies
too: a module page may only show a create/edit/delete/connect/issue-credential
control once the gateway actually enforces it — which it now does for every
`/api/v1` route. What must not reappear is a lock icon over an open door, or a
"permission" label backed by a role check that does not exist.

MCP agent authentication (Phase 6, §4.1) is a *separate* boundary and was not
weakened by this work: `/mcp` still requires a per-agent bearer credential and
default-deny policy evaluation on every request, with no cookie consulted.

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
- The actor is recorded as `{ type: "admin", id: "local-operator" }`. Since Phase 10.0 the management-mutation paths resolve the single configured operator instead, so new rows carry a real id; `local-operator` remains the fallback for an instance with no operator configured (a blank install). Recording an explicit id means Phase 3 rows will not later read as anonymous or system-generated.
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

### 9.1.4 Correlation and telemetry stores (Phase 11)

The phase adds two mechanisms an operator will rely on, so both get the same
treatment as the trails above: what they must never carry is decided before
what they do.

- An inbound `X-Correlation-Id` is accepted only when it matches
  `^[A-Za-z0-9._-]{1,64}$`; anything else is replaced. The id is an operator
  convenience for joining log lines, not an input to trust — an unsanitized
  header would be a log-injection primitive (newlines, ANSI escapes, forged
  JSON fields). `tests/correlation.test.ts` pins the validation, the isolation
  between concurrent requests, and the absence of leaked context.
- The id travels via `AsyncLocalStorage`, never a global: concurrent requests
  cannot read each other's context, and no mutable module state exists to
  leak across a boundary.
- The metrics registry is an **identity-free store**: label values are closed
  enums, so no series can name a tool, agent, username, or free-form string. A
  hostile client cannot create a series at all — only the gateway's own call
  sites increment, with values from fixed vocabularies. Validation drops
  anything else and counts it in `umg_metrics_dropped_total`, so an attempt is
  visible without succeeding.
- The recent-error ring stores `{code, component, at, requestId}` — codes
  from the fixed `ErrorCode` set, components from a fixed vocabulary, and the
  id the gateway issued. No message, stack, driver text, or path enters it,
  because the ring's whole job is to be safe to paste into a bug report.
- One store per fact, no duplication: activity = operational, audit =
  security, metrics = aggregate, logs = diagnostic. The registry never
  records what a row already records, so no new surface repeats an old
  disclosure.

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

Phase 8 additions (covered by `tests/ops-api.test.ts`, `tests/openapi.test.ts`, `tests/policies-api.test.ts`):

- `/settings` and `/diagnostics` searched for the hashing secret, a token, `process.env`, a database path, and the words `secret`/`token`/`password`/`authorization` (never present).
- A credential issued to a real agent, then `/overview` searched for its raw token (never present).
- `/audit` list response checked for `metadata`; the detail response checked for it (the list must not carry it).
- Every write verb against `/audit`, `/audit/:id`, `/activity`, `/activity/:id`, and `/settings`: `404`, and the audit row count is unchanged afterwards.
- `/activity` searched for `arguments` and `result` (the table never stores them).
- Unknown enum values, malformed dates, malformed UUIDs, and `limit` above 100 on both log endpoints: `400 VALIDATION_ERROR`, not a silently empty page.
- Error bodies from those refusals: no `at `, `sqlite`, or `SELECT` text.
- `/ready` closed-database case: `503` with `database: unavailable`, and no secret in the body.
- `/policies?backendId=` naming nothing: `404` rather than an empty page, so a policy filter cannot be used to probe which backend ids exist more cheaply than by id lookup (the same `404`).
- Policy `backendId` filtering moved into SQL, so a filtered page and its `total` cannot be read as proof of how many policies the gateway holds.

## 11. Release gate

No non-loopback exposure until:
- Authentication and authorization are implemented. **MCP is done (Phase 6); the management API now requires an operator session (Phase 10.0, §4.3).** Both boundaries are complete for loopback use; neither makes remote exposure safe.
- TLS/reverse-proxy assumptions are documented.
- Host/Origin and CSRF defenses are tested.
- Secrets are protected — `CREDENTIAL_HASH_SECRET` is required in production and never enters `Config`, but it is still a symmetric secret in the environment with the limits in 6.3.
- Threat review and operational rollback plan are complete.

**Explicitly not satisfied by Phases 6–10.0:** TLS, per-operator RBAC or multiple operators, a per-IP login rate limiter, dashboard CSP, any form of non-loopback exposure, tunnel, or reverse proxy. The operator password and session cookie cross **plaintext HTTP over loopback**; that is acceptable only because loopback never leaves the host, and it is exactly why `OPERATOR_COOKIE_SECURE` exists as a setting rather than a guess. Do not put this behind a tunnel on the strength of a password login. The session management and read surfaces inherit §3.1 in full: `/audit` renders administrative history, and administrative history is exactly what an attacker wants.
