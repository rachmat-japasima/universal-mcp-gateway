# Monitoring, Logging, Audit, and Operations

## 1. Objectives

Implemented through Phase 8. The questions the surface answers today:

- Is the gateway running? — `/health`, `/ready`.
- Is each backend connected and healthy? — `/api/v1/monitoring/backends`, `…/:id/runtime`.
- Which agents are active? — `/api/v1/overview` (`agents`), `/api/v1/agents?status=active`.
- Which tools are being called? — `/api/v1/activity?type=tools.call`.
- What administrative/security changes occurred? — `/api/v1/audit`.
- Are sessions accumulating or expiring? — `/api/v1/monitoring/sessions`.

Still unanswerable, and therefore not shown: queue depth and saturation.
Request and tool-call **duration distributions are now kept** (Phase 11
histograms — counts and buckets, reset on restart); what stays unbuilt is the
time-series history and any derived figure a dashboard could invent from one
snapshot. See §4.3.

## 2. Health endpoints

Implemented:

- `/health` — **liveness only**. Answers while the process can serve. Deliberately does not fail when a backend is disconnected or authentication is unconfigured; those are reported in the body, not as a status.
- `/ready` — **readiness**. Checks that the database answers and the migration ledger is readable. `200` with `status: "ready"`, or `503` with `status: "not_ready"` and the failing check named. Optional backends are excluded by design: a gateway with every backend disconnected is still ready to accept work. It lives outside `/api/v1` (an infrastructure probe should not follow an API version) and is mounted only when a store exists — without one, the gateway has no evidence to report and a `503` would be a claim it cannot support.
- `/api/v1/system/health` — management-plane liveness, distinct from both.
- `/api/v1/diagnostics` — safe incident facts, read-only by construction.

Neither probe, nor any `ops` endpoint, reveals a private path, an environment value, a secret, or a stack trace (`tests/ops-api.test.ts` asserts it).

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

### 3.1 Correlation and redaction (Phase 11)

Every response carries `X-Request-Id`: generated as a UUIDv4 when absent or
malformed, and the same middleware accepts an inbound `X-Correlation-Id`
(**validated, never trusted** — it must match `^[A-Za-z0-9._-]{1,64}$` or it is
replaced, because an attacker-supplied string must not become a log-injection
vector). Both are carried through AsyncLocalStorage, not a global variable or a
threaded parameter: any log line inside a request can call
`correlationLogFields()` and get the ids without a signature change, and a
concurrent request cannot see another's context.

The logger redacts before serializing: pino's redaction list covers
`authorization`, `cookie`, and the `*.token|credential|credentialHash|password|
secret|apiKey` families, so a stray field cannot leak a verifier even if a
future call site adds one by accident. Tool arguments and upstream responses are
never logged at all (`describeErrorForLog` keeps messages but drops payload
objects); activity rows carry names and outcomes, never content.

`correlation_id` is persisted on `activity_events` (migration `0007`), so an
operator can follow one external correlation id from log line to activity row
without cross-joining by request id. Audit rows keep `requestId` only — the
security trail records who did what, not the caller's trace id.

## 4. Metrics

Implemented in Phase 8 as **read endpoints over live state**, not as a metrics
store. There is no sampler, no time series, and no cache: every value is read
from a repository, the lifecycle manager, or the in-memory catalog at request
time. A time-series backend remains unbuilt, and adding one without a concrete
need would be a second source of truth.

Phase 11 added the second kind: an **in-memory aggregate registry**
(`src/monitoring/metrics.ts`) — counters, gauges and bucketed histograms the
gateway maintains itself, exported for a scraper and for the dashboard. It is
process memory only: it resets on restart, keeps no history, and is therefore a
source of *current rates and ratios*, never a record. See §4.3.

| Endpoint | Answers |
| --- | --- |
| `GET /api/v1/overview` | Every aggregate a dashboard home screen shows, in one snapshot. |
| `GET /api/v1/monitoring` | Runtime, storage status, backends, sessions, tools, activity. |
| `GET /api/v1/monitoring/health` | Storage status plus backend counts. |
| `GET /api/v1/monitoring/backends` | Counts, per-backend runtime states, discovery reports, conflicts. |
| `GET /api/v1/monitoring/sessions` | Effective session distribution, or `available: false`. |
| `GET /api/v1/monitoring/runtime` | Service version, Node version, platform, uptime. |
| `GET /api/v1/monitoring/metrics` | The registry as JSON: every family, its samples, recent errors. |
| `GET /metrics` | The same registry as Prometheus text 0.0.4, for a scraper. |

Available now, all real: backend totals and enabled/disabled split, the runtime
status distribution across every backend, tool totals by availability, backends
with a catalog, discovery failures, agent totals and split, session counts by
effective status, activity totals grouped by type and by outcome — plus, since
Phase 11, per-surface request/latency/tool/auth/backend aggregates (§4.3).

**Not available, and therefore not shown:** queue depth and lock wait time (tool
calls are not queue-gated yet — `docs/ARCHITECTURE.md` §11.2) and saturation.
Request and tool-call **durations are now recorded as histograms**; a *derived*
percentile or rate is still not served, because one snapshot of a
reset-on-restart registry cannot honestly produce either. A dashboard renders
what is stored, never arithmetic invented from one instant.

### 4.1 Two rules the numbers keep

1. **Fabricate nothing.** Every figure comes from a repository, the lifecycle
   manager, or the catalog. An empty registry reports zeros; nothing is sampled,
   estimated, seeded, or defaulted to a plausible-looking value.
2. **`null` is not `0`.** When a storage read fails, `database` becomes
   `"unavailable"`, `status` becomes `"degraded"`, and every storage-backed field
   becomes `null`. The in-memory catalog is still reported, because it survived
   the outage. Rendering `0` for an unavailable store is a false claim and the
   dashboard must branch on `null`.

### 4.2 One reader

`/overview`, `/monitoring*`, and `/diagnostics` all call `opsSnapshot()`
(`src/api/ops.ts`). Three endpoints computing backend counts down three code
paths is the classic dashboard bug — two widgets on one screen disagreeing about
the same instant. With one reader they cannot, and one fix corrects all of them.
The count queries are single statements (grouped `SUM(CASE …)` and `GROUP BY`),
so the overview does not become an N+1.

Use bounded labels; never use arbitrary user input as unbounded metric labels.
The `byType`/`byOutcome` maps are keyed by closed enums, not by user input.

### 4.3 The aggregate registry (Phase 11)

A hand-rolled registry, not a client library: no Prometheus, OpenTelemetry, or
time-series dependency was added, because the requirement is counts in memory
and two exports, and a SDK would import a second pipeline the gateway does not
have. `src/monitoring/metrics.ts` defines counter/gauge/histogram primitives
with per-metric validation:

- **Labels are closed enums.** Route class (`health|ready|metrics|mcp|api|
  unmatched`), MCP method (`initialize|tools.list|tools.call`), outcome
  (`success|failure|denied`), transport, error code (`^[A-Z][A-Z_]{0,63}$`),
  HTTP status (`^\d{3}$`). Tool names, agent ids, usernames, and anything a
  caller chose are **never** labels — an unbounded label is a cardinality bomb
  and a disclosure in one. Violations are dropped and counted in
  `umg_metrics_dropped_total`, so under-counting is visible, and no metric call
  can throw into a request path.
- **Every family is `umg_`-prefixed and series-capped** (256 by default), so a
  hostile label flood cannot grow memory without bound.

The families: HTTP requests/duration/in-flight by route class; MCP methods and
duration; session denials; tool calls by outcome, failure code, and duration;
backend connections/reconnects/disconnects/changes; authentication by surface
and outcome; credential revocations; authorization denials by surface; errors by
code; plus process gauges (uptime, RSS/heap, event-loop delay via
`monitorEventLoopDelay`) and the live MCP-session and backend-runtime gauges.

Two counting decisions are recorded here because they are deliberate:

- **`initialize` counts at session creation** (`onsessioninitialized`), the one
  outcome the gateway owns; the SDK answers the initialize request itself, and
  a refused or malformed initialize is an SDK-reported failure this process
  cannot observe. The family's help text says so.
- **MCP-handler refusals count `outcome: failure`** — denials are
  indistinguishable on the wire by design (a caller must not learn *why*), so
  the denial split lives in the router's counters, which an operator reads.

The error side is split by category: client-category refusals (a bad `limit`, an
unknown tool) feed `umg_errors_total{code,component}` only — they are business
as usual. Internal-category and unhandled errors additionally enter a bounded
ring of 20 `{code, component, at, requestId}` entries — **never messages** —
which diagnostics and the metrics snapshot expose as `recentErrors`.

**Access model.** Root `GET /metrics` (Prometheus text) sits **behind the same
operator session cookie and loopback check as `/api/v1`** — an unauthenticated
metrics port is the classic leak, so there is none. It is mounted only when an
operator row exists at assembly time, the same semantics as a restart after
`pnpm operator:create`. The JSON twin `GET /api/v1/monitoring/metrics` lives
inside the versioned API's existing boundary. A scrape renders before counting
itself, so one scrape's own request appears in the next.

**Reset semantics.** In memory only; restart zeroes every family. These are
current facts, not history — the durable trail is `/api/v1/activity` and
`/api/v1/audit`. DB operation durations are deliberately not instrumented:
better-sqlite3 is synchronous, so a "duration" would measure a function call,
not a query.

`tests/metrics.test.ts` covers registry mechanics, validation, export formats,
and access control; `tests/instrumentation.test.ts` proves each writer site
against the live surface.

## 5. Dashboard visualizations

Every page in `docs/DASHBOARD.md` must be buildable from the endpoints above, with no fixture data.

- Gateway status card — `/api/v1/overview` (`status`, `database`, `authentication`).
- Backend health table — `/api/v1/monitoring/backends` (`runtimes`, `counts`).
- Session/queue overview — `/api/v1/monitoring/sessions`; queue depth is not collected.
- Telemetry card — `/api/v1/monitoring/metrics`: counters read by exact metric
  and label set. A failed read renders "not read"; a family nobody has
  incremented reads 0, which is a counter's true value. No sums, no rates, no
  chart — the registry keeps counts, not history.
- Recent activity timeline — `/api/v1/activity`.
- Audit trail — `/api/v1/audit` (list) and `/api/v1/audit/:eventId` (metadata).
- Settings and diagnostics pages — `/api/v1/settings`, `/api/v1/diagnostics`.
- Request-rate, latency-percentile, and error-trend charts — **still not
  renderable**: the registry resets on restart and keeps no history, so a trend
  line would be invented. Render "not collected" rather than a flat line.

All charts must distinguish zero from unavailable/no data. Never populate production charts with fabricated demo data, and branch on `null` before formatting a number.

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

Login/logout and settings events arrive with later phases (dashboard operator auth is Phase 10.0, ADR-044).
Credential and policy events landed in Phase 6, and session events in Phase 7. Phase 8 added the
read API over this trail, not new actions: `GET /api/v1/audit` (filterable, paginated, `metadata`
omitted) and `GET /api/v1/audit/:eventId` (metadata included). `/api/v1/activity` is the separate
operational log. Neither has a write verb.

The distinction is enforced by the type system, not by convention: the audit list returns
`AuditListItem`, which has no `metadata` field. A collection response therefore cannot carry
free-form context by accident, and reading one record is an explicit operator act.

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

Not implemented. Phase 8 exposes the data an alerting layer would need — counts,
status distribution, discovery failures, error outcomes — but adds no evaluator,
no thresholds, no cooldowns, and no external notification integration. Adding one
before there is a concrete need would introduce a background loop the gateway
does not currently have.

Do not add external notification integrations until requested. When they land,
alert rules must support thresholds and cooldowns to prevent noisy repeats, and
must not use unbounded user input as a label.

## 8. Recovery

Implemented in Phase 4 (`src/adapters/lifecycle.ts`):

- Bounded exponential backoff with jitter: `initialDelayMs * 2^(n-1)`, capped at `maxDelayMs`, ± `jitterRatio`, at most `maxAttempts`. Off by default (`RECONNECT_ENABLED=false`) so a lost backend is not re-dialled behind the operator's back.
- Only transient failures retry (`BACKEND_TIMEOUT`, `BACKEND_UNAVAILABLE`). A missing executable, a policy refusal, or rejected credentials is permanent — retrying cannot change the answer.
- Clear backend state transitions enforced by `BACKEND_TRANSITIONS`; an illegal edge throws instead of persisting an impossible status.
- Graceful shutdown: the manager stops every connection, cancels every timer, and refuses new connects before the store closes.
- No retry storms: one promise chain per backend, so concurrent attempts collapse into one; jitter prevents lockstep retries.
- Last sanitized error is exposed on `GET /api/v1/backends/:id/runtime` (`lastErrorCode`, `lastErrorMessage`, capped at 500 chars).
- Manual `POST /backends/:id/reconnect` resets the attempt counter. No confirmation dialog yet — the API is loopback-only and requires an operator session plus a CSRF token on the write (Phase 10.0), so a second in-API confirmation would add a click, not a control; the dashboard can add one when it grows a mutation UI.
- Startup recovery never reconnects: a persisted live state is a dead process's claim and is rewritten to `disconnected`/`disabled`.

## 9. Operational runbook

Implemented as commands, with the real API surface:

- **Start / stop / restart.** `pnpm start` (compiled) or `pnpm dev`. `SIGINT`/`SIGTERM` runs `gateway.close()`: sessions are terminated as `gateway_shutdown`, connections close, then the store.
- **View logs.** Pino JSON on stdout. `LOG_LEVEL` controls verbosity.
- **Health checks.** `curl -s localhost:8787/health` (liveness) and `curl -s localhost:8787/ready` (readiness; `503` means storage or the migration ledger is unreadable).
- **Scrape metrics.** `curl -s localhost:8787/metrics -H "cookie: …"` (Prometheus text; operator session required, loopback only), or the JSON twin `curl -s localhost:8787/api/v1/monitoring/metrics -H "cookie: …"`. Both reset on restart; scrape *rates*, not history. `/metrics` answers `404` until an operator exists — create one and restart.
- **Snapshot for a bug report.** `curl -s localhost:8787/api/v1/diagnostics` — version, runtime, uptime, migration version, counts; contains no secret or environment value.
- **Check effective configuration.** `curl -s localhost:8787/api/v1/settings` — read-only, non-secret.
- **Check backend state.** `curl -s localhost:8787/api/v1/monitoring/backends` for the status distribution; `GET /api/v1/backends/:id/runtime` for one backend's last error.
- **Run tests.** `pnpm test`; `pnpm typecheck` and `pnpm build` before a commit.
- **Backup.** SQLite-safe copy (`.backup` or `VACUUM INTO`), never a copy of a live WAL file.
- **Restore.** Test on a copy first, then replace the file while the process is stopped. Migrations re-verify checksums on the next open.
- **Diagnose a disconnected backend.** Read `runtime.lastErrorCode`/`lastErrorMessage`, then the `backend.*` activity rows filtered by `backendId`, then the lifecycle log lines (`connect`, `failure`, `retry scheduled`, `retry exhausted`).
- **Rotate an agent credential.** `POST /api/v1/agents/:agentId/credentials/:credentialId/rotate` — the old token dies immediately and sessions bound to it are invalidated.
- **Recover after an unclean shutdown.** Start normally: `recover()` rewrites any persisted live state to `disconnected`/`disabled` and reconnects nothing. Then inspect `/ready` and `/api/v1/monitoring/backends`.
