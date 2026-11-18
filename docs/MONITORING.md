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

## 7. Alerts and notifications

Initial local version:
- In-dashboard event/health indicators.
- Optional desktop/local notification can be considered later.
- Do not add external notification integrations until requested.
- Alert rules should support thresholds and cooldowns to prevent noisy repeated alerts.

## 8. Recovery

- Bounded exponential backoff with jitter for reconnects.
- Clear backend state transitions.
- Graceful shutdown and cleanup.
- Avoid retry storms.
- Expose last sanitized error.
- Provide manual reconnect action with confirmation where needed.

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
