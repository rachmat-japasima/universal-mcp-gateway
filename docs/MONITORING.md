# Monitoring, Logging, Audit, and Operations

## 1. Objectives

Provide enough operational visibility to answer:
- Is the gateway running?
- Is each backend connected and healthy?
- Which agents are active?
- Which tools are being called?
- Are calls slow or failing?
- Are queues/locks saturated?
- What administrative/security changes occurred?

## 2. Health endpoints

- `/health`: process liveness and basic service status.
- A separate readiness endpoint may be added when readiness depends on external resources.
- Management API should provide detailed diagnostics to authenticated administrators.
- Do not expose internal paths, environment variables, secrets, or stack traces.

## 3. Structured logs

Use Pino JSON logs. Standard fields:
- timestamp
- level
- service
- requestId
- event
- agentId (if authenticated)
- backendId (if applicable)
- toolName (if applicable)
- durationMs
- outcome
- errorCode

Current behavior (Phase 1):
- Handler faults log at `error` with the stack.
- Input the gateway refuses (malformed JSON-RPC, empty batch, unsupported protocol
  version, wrong content type) logs at `warn` with the message only — no stack,
  since the gateway itself is healthy.

Discovery and routing (Phase 5):
- `tools.list` / `tools.call` activity rows: `backendId`, public tool name,
  outcome, `errorCode`, `durationMs`, bounded request id. Discovery also logs at
  `info` with `{ backendId, requestId, added, removed, changed }` counts, and at
  `warn` when a tool is rejected or a listing fails.
- A schema that cannot be compiled is logged with `{ backendId, tool }` and
  `unvalidatedReason` — the call still forwards, so the operator must be able to
  find it.
- A name collision is logged once at `error` with the public name and every
  claimant, and recorded as a failed `tools.list` activity: a silently withheld
  tool otherwise looks like a discovery bug.
- Never logged: tool arguments, tool results, or the remote schema body. Names
  and counts only; a result can contain anything the backend decided to return.

Do not log:
- authorization tokens
- passwords
- secret environment values
- full tool arguments/results by default
- sensitive headers
- raw process environment

## 4. Metrics

Recommended metrics:
- HTTP request count and duration.
- MCP initialize count/failures.
- tools/list count/duration.
- tools/call count/duration by backend/tool.
- error rate by category.
- backend connection state and uptime.
- reconnect attempts.
- active sessions.
- active calls.
- queue depth and lock wait time.
- dashboard API latency.

Use bounded labels; never use arbitrary user input as unbounded metric labels.

## 5. Dashboard visualizations

- Gateway status card.
- Backend health table.
- Request throughput chart.
- Latency percentile chart.
- Error-rate chart.
- Tool-call distribution.
- Recent event timeline.
- Session/queue overview.

All charts must distinguish zero from unavailable/no data. Never populate production charts with fabricated demo data.

## 6. Audit events

Record:
- admin login/logout and failed login attempts.
- backend create/update/delete/enable/disable/reconnect.
- agent create/disable/delete.
- credential creation/rotation/revocation (never token content).
- policy changes.
- security and network setting changes.
- backup/restore actions.
- authorization denials where useful.

Audit entries include actor, action, target, timestamp, result, and request ID.

### 6.1 Implemented in Phase 3

`backend.created`, `backend.updated`, `backend.enabled`, `backend.disabled`,
`backend.deleted`, and `backend.validation_failed`.

- Actor is `admin` / `local-operator` until authentication exists (ADR-030); `requestId` is
  not yet persisted on audit rows (the column exists, the service does not thread it through).
- `metadata_json` holds a whitelist of primitives only: `{transport, enabled}`, `{changed}`,
  `{name}`, or `{operation, reason, fields}`. A connection config is never copied in.
- No row is written for a no-op, so the log reflects changes rather than requests.
- `backend.validation_failed` has no `target_type`/`target_id`: validation persists nothing.
- Audit is append-only with no application delete path; deletion of a backend tombstones the
  definition instead of cascading, so history stays resolvable.

Login/logout and settings events arrive with later phases (dashboard auth is Phase 8/9).
Credential and policy events landed in Phase 6, below. There are no metrics endpoints yet,
so no backend counters are exposed beyond `/api/v1/system` counts.

### 6.3 Identity and authorization audit (Phase 6)

New actions: `agent.created`/`updated`/`enabled`/`disabled`/`deleted`,
`credential.created`/`rotated`/`revoked`, `policy.created`/`updated`/`deleted`/`assigned`/
`unassigned`, `auth.succeeded`, `auth.failed`, and `access.denied`.

- `auth.succeeded` carries `credentialId` and `hashKeyId`. `auth.failed` carries a fixed
  `reason` (`missing_header`, `malformed_header`, `malformed_token`, `unknown_credential`,
  `revoked_credential`, `expired_credential`, `agent_disabled`, `agent_missing`,
  `unknown_key`, `secret_missing`) and adds `credentialId`/`agentId` only when the row was located.
- `access.denied` carries the real decision reason, plus `backendId`/`toolId` where the target
  could be resolved, and `credentialId`.
- Actor is the authenticated agent for `auth.succeeded`/`access.denied`, `system` for
  `auth.failed`, and `admin`/`local-operator` for management-API writes (still no operator
  identity; ADR-030).
- No token, header value, or submitted secret is ever a metadata field, and the pino redaction
  list covers `authorization` plus `*.token|credential|credentialHash|password|secret|apiKey`.
- Volume control: failures are collapsed per reason and successes per agent within a fixed
  60-second window; suppressed repeats are counted and folded into the next written row as
  `suppressed`. The maps are in-process and bounded (512 keys), so a loop cannot grow either
  the table or memory without bound.
- Audit is best-effort: a failed write is logged and swallowed, because a request already
  refused for security reasons must not become a `500`.
- Successful authentication also updates `agents.last_authenticated_at`; that write is **not**
  audited, or every request would produce a row.

### 6.2 Lifecycle logging (Phase 4)

Connect, disconnect, failure, retry scheduled, retry exhausted, startup recovery, and shutdown
each emit one structured Pino line. They are **logged, not audited**: `AUDIT_ACTIONS` has no
lifecycle action yet and inventing one at a call site would break the contract.

| Event | Fields |
| --- | --- |
| Connected | `backendId`, `transport`, `requestId`, `durationMs` |
| Disconnected | `backendId`, `transport`, `reason` (`request`, `disable`, `reconcile`, `shutdown`, `failure`) |
| Connection failed | `backendId`, `transport`, `code`, `message` (sanitized) |
| Retry scheduled | `backendId`, `attempts`, `delayMs` |
| Retry exhausted | `backendId`, `attempts` |
| Startup recovery | `recovered`, `disconnected`, `disabled`, `error` (counts only) |

Never logged: connection configs, command lines, URLs with query strings, resolved header values,
resolved env values, or child stderr verbatim. The adapter keeps a credential-stripped target
string for logs only; runtime rows hold no connection detail at all.

Health polling of live backends is not implemented yet — `unhealthy` exists in the state machine
but nothing sets it in Phase 4. A health probe arrives with tool discovery in Phase 5.

Session refusals log one `warn` line with `reason` and `agentId` — the same internal detail the
audit row carries, never sent to the client. A session whose activity cannot be recorded logs
a `warn` and the request still proceeds: failing a valid request because a timestamp write
failed would be a worse outcome than a slightly stale idle clock. Transport close failures are
logged the same way, after the database has already recorded the end.

### 6.4 Session audit (Phase 7)

Seven actions, all with `target_type = 'session'` and `target_id = sessions.id` (the internal
id — never a protocol id as the target, so a session row can always be resolved):

| Action | Result | Metadata |
| --- | --- | --- |
| `session.created` | `success` | `mcpSessionId`, `agentId`, `credentialId`, `protocolVersion`, `clientType` |
| `session.authenticated` | `success` | `agentId`, `credentialId`, `suppressed` |
| `session.access.denied` | `denied` | `reason` (closed enum), `agentId`, `sessionId`, `suppressed` |
| `session.expired` | `success` | `reason` (`idle_timeout` \| `max_lifetime`), `agentId` |
| `session.terminated` | `success` | `reason`, `agentId`, `credentialId` |
| `session.invalidated` | `success` | `reason`, `agentId`/`credentialId`, or `affected` for a bulk end |
| `session.cleanup.completed` | `success` | `expired` (count) |

- `session.created` is written inside the initialization path, before the client receives the
  protocol id, so a session a client holds is always one the trail knows about.
- `session.invalidated` covers revocation, rotation, disable, delete, and explicit invalidation;
  the `reason` distinguishes them. A bulk end (revocation of a credential with several live
  sessions) writes **one** row with `affected`, not one per session.
- A repeated terminate writes nothing: the trail records transitions, not requests.
- `session.authenticated` is once per session per 60 s and `session.access.denied` once per
  reason per 60 s, using the same bounded-map pattern as `AuthService` (512 keys, suppressed
  count folded into the next row). A busy session does not write one row per request.
- Never present: the bearer token, any `Authorization` value, the HMAC secret, request or tool
  content, or transport objects. `mcpSessionId` is a routing handle with no authenticating
  power, and it is the only protocol-side value recorded.
- Session audit is **best-effort**: a failed write is logged and swallowed. The security
  decision has already been made by then and must not turn into a `500` — or, worse, into a
  served request.

Shutdown policy: `gateway.close()` terminates every active session (`gateway_shutdown`) **before**
closing transports and the store. The alternative — leaving `active` rows behind — would make
the next process believe sessions are live that nothing can serve.

## 7. Alerts and notifications

Initial local version:
- In-dashboard event/health indicators.
- Optional desktop/local notification can be considered later.
- Do not add external notification integrations until requested.
- Alert rules should support thresholds and cooldowns to prevent noisy repeated alerts.

## 8. Recovery

Implemented in Phase 4 (`src/adapters/lifecycle.ts`):

- Bounded exponential backoff with jitter: `initialDelayMs * 2^(n-1)`, capped at `maxDelayMs`, ± `jitterRatio`, at most `maxAttempts`. Off by default (`RECONNECT_ENABLED=false`) so a lost backend is not re-dialled behind the operator's back.
- Only transient failures retry (`BACKEND_TIMEOUT`, `BACKEND_UNAVAILABLE`). A missing executable, a policy refusal, or rejected credentials is permanent — retrying cannot change the answer.
- Clear backend state transitions enforced by `BACKEND_TRANSITIONS`; an illegal edge throws instead of persisting an impossible status.
- Graceful shutdown: the manager stops every connection, cancels every timer, and refuses new connects before the store closes.
- No retry storms: one promise chain per backend, so concurrent attempts collapse into one; jitter prevents lockstep retries.
- Last sanitized error is exposed on `GET /api/v1/backends/:id/runtime` (`lastErrorCode`, `lastErrorMessage`, capped at 500 chars).
- Manual `POST /backends/:id/reconnect` resets the attempt counter. No confirmation dialog yet — the API is loopback-only and unauthenticated, so a confirmation would be theatre until the dashboard exists (Phase 9).
- Startup recovery never reconnects: a persisted live state is a dead process's claim and is rewritten to `disconnected`/`disabled`.

## 9. Operational runbook

Document:
- Start/stop/restart.
- View logs.
- Run health checks.
- Run tests.
- Backup database.
- Restore database.
- Diagnose a disconnected backend.
- Rotate agent credentials.
- Recover after an unclean shutdown.
