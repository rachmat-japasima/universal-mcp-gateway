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
- No `0.0.0.0` default.
- Host/Origin validation according to MCP SDK guidance.
- Do not expose through tunnel, reverse proxy, LAN, or WAN without authentication and explicit review.
- If remote access is added, require TLS and strong authentication.

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

## 11. Release gate

No non-loopback exposure until:
- Authentication and authorization are implemented.
- TLS/reverse-proxy assumptions are documented.
- Host/Origin and CSRF defenses are tested.
- Secrets are protected.
- Threat review and operational rollback plan are complete.
