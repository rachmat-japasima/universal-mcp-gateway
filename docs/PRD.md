# Product Requirements Document — Universal MCP Gateway

- **Product:** Universal MCP Gateway
- **Document version:** 1.0
- **Status:** Full-project target specification
- **Date:** 2026-11-18

## 1. Executive summary

Universal MCP Gateway is a self-hosted MCP orchestration and management platform for multiple AI coding agents and independently managed MCP servers. It centralizes MCP backend connections, tool discovery and routing, agent access policies, operational monitoring, and shared-resource safety behind one managed gateway.

The product includes:
1. A reliable MCP protocol gateway.
2. A dynamic backend registry and adapter framework.
3. Agent identities, profiles, credentials, and access policies.
4. Tool discovery, namespacing, filtering, and invocation routing.
5. Session isolation and concurrency controls.
6. A complete web administration dashboard.
7. Monitoring, logs, audit history, diagnostics, and operational controls.

The product is generic. It is not a FigCraft-specific connector. FigCraft, Context7, Chrome DevTools, Supabase, GitHub, filesystem MCP servers, and other MCP-compatible services are possible integrations, not hard-coded assumptions.

## 2. Product vision

Provide one secure, observable, reliable control plane through which multiple local coding agents can use centrally managed MCP tools without each agent maintaining a separate copy of every backend configuration and credential.

The platform should feel like professional developer infrastructure software: clear operational state, predictable controls, safe defaults, and a polished administration experience.

## 3. Users and roles

### 3.1 Owner / Super Admin
- Full system configuration and access.
- Create and manage agents, backends, credentials, policies, and system settings.
- View all logs, metrics, audit records, and diagnostics.
- Perform lifecycle actions such as enabling/disabling a backend.

### 3.2 Administrator
- Manage assigned backends and agent profiles.
- View permitted operational information.
- Cannot change owner-only security or system settings unless explicitly granted.

### 3.3 Read-only Operator
- View dashboard, backend health, tools, logs, and usage permitted by policy.
- Cannot change configuration or invoke administrative actions.

### 3.4 Agent / MCP Client
- Connect to the gateway using an assigned identity/credential.
- Discover and invoke only authorized tools.
- Does not receive administrative dashboard privileges by default.

For a single-user local deployment, the initial installation may have one owner account. The data model should not prevent future multi-user administration.

## 4. Goals

### 4.1 Full-product goals
- Centralize multiple MCP backends behind a stable gateway endpoint.
- Support multiple MCP client/agent identities.
- Support backend lifecycle management without rebuilding the gateway.
- Discover and route tools dynamically.
- Apply per-agent and per-tool authorization.
- Protect shared stateful resources from unsafe concurrent execution.
- Provide operational visibility through a dashboard.
- Keep credentials centralized and redacted.
- Recover from backend failures without taking down unrelated backends.
- Provide a clear audit trail for administrative and tool activity.

### 4.2 Initial release goals
- Keep the existing local gateway working.
- Prove protocol correctness with the official MCP SDK.
- Maintain an empty production backend registry.
- Add the registry and adapter foundation only after protocol tests pass.
- Build dashboard only after the backend API and core domain contracts are stable.
- Do not alter existing agent MCP configuration until the user explicitly approves.

## 5. Non-goals

- Public hosted SaaS service in the first product version.
- Public internet exposure by default.
- Replacing the MCP protocol or implementing a proprietary agent protocol.
- Hard-coding a specific MCP backend.
- Building a general-purpose workflow automation platform.
- Building a code editor or AI agent runtime.
- Storing plaintext secrets in source code, logs, or ordinary configuration exports.
- Requiring every agent to support the same transport; compatibility adapters may be needed.
- Automatically enabling integrations during installation.

## 6. Existing environment and baseline

- Development/runtime: Windows desktop + WSL2.
- Project directory: `~/projects/universal-mcp-gateway`.
- Node.js 26.13.1; pnpm 11.7.0.
- TypeScript ESM, strict mode, NodeNext.
- WSL systemd was offline at project bootstrap; foreground development is available.
- Default bind: `127.0.0.1`.
- Gateway endpoint: `http://127.0.0.1:8787/mcp`.
- Health endpoint: `http://127.0.0.1:8787/health`.
- Existing dependencies include Hono, `@hono/node-server`, official MCP server/client/Hono packages, Zod 4, Pino, YAML, `better-sqlite3`, Vitest, and TypeScript tooling.
- `pnpm typecheck` and `pnpm build` passed.
- User verified the development server and `/health`.
- Initial health reports `backendCount: 0`, `status: "empty"`.

Do not assume details not listed here; inspect the repository before editing.

## 7. Technology decisions

### Backend
- Node.js + TypeScript (ESM)
- pnpm
- Hono + `@hono/node-server`
- Official MCP TypeScript SDK packages
- Zod 4
- Pino
- YAML for human-readable configuration where appropriate
- SQLite via `better-sqlite3` for local metadata and registry
- Vitest

### Frontend dashboard
- Next.js + React + TypeScript
- **Astryx (`https://astryx.atmeta.com/`) as the UI component library and design system**
- Astryx components, tokens, themes, and documented patterns directly
- Follow Astryx's official installation and styling requirements
- Do not use shadcn/ui
- Do not use Radix UI as a fallback component library
- Do not introduce a second competing design system
- Custom components are allowed only for product-specific compositions or gaps not covered by Astryx

### Important UI clarification
The decision is not “Astryx-inspired shadcn”. The decision is to use Astryx directly. shadcn/ui is excluded from the frontend plan and implementation. Do not install shadcn CLI or generate shadcn components. Verify Astryx's current package/API requirements from its official documentation before installing or writing integration code; do not invent package names or CLI arguments.

## 8. Functional requirements

### 8.1 Gateway and protocol

**FR-GW-01 — MCP endpoint**
- Expose a Streamable HTTP MCP endpoint at `/mcp`.
- Use official MCP SDK transports and server APIs.
- Implement initialization, notifications, tools/list, tools/call, cancellation, and supported HTTP methods according to the installed SDK/protocol version.
- Do not hand-roll JSON-RPC unless a narrowly scoped SDK-supported extension is required.

**FR-GW-02 — Health**
- `GET /health` reports process health, service version, timestamp, endpoint, backend count, and registry state.
- Health output must not expose credentials or sensitive configuration.
- Separate liveness from readiness if the service later has dependencies that can make it unready.

**FR-GW-03 — Empty registry**
- A new installation has zero active backends.
- Empty registry is a valid healthy state.
- `tools/list` returns an empty list when no authorized tools exist.

**FR-GW-04 — Transport/session lifecycle**
- Explicitly document stateless or stateful Streamable HTTP behavior.
- Ensure initialize and subsequent requests work with official clients.
- Isolate client state when sessions are used.
- Handle transport cleanup and graceful shutdown.
- Never assume a per-request server/transport lifecycle is correct without integration tests.

### 8.2 Backend registry

**FR-BE-01 — Backend inventory**
- List backends with ID, name, transport, enabled state, health, last check, and summary.
- Support search, filtering, and sorting.

**FR-BE-02 — Backend lifecycle**
- Create, inspect, edit, validate, enable, disable, reconnect/reconnect where applicable, and delete backend definitions.
- Require confirmation for destructive actions.
- Configuration changes must be validated before activation.
- Changes must not require rebuilding the application.

**FR-BE-03 — Transport support**
- Define a typed adapter interface.
- Initial target transports: stdio and Streamable HTTP.
- Add other transports only when supported by the official SDK and required by real clients.
- Keep process management and transport-specific behavior inside adapters.

**FR-BE-04 — Fault isolation**
- Backend failure must not crash the gateway or unrelated backends.
- Show clear state: connected, disconnected, starting, degraded, disabled, error.
- Support bounded reconnect/backoff.

**FR-BE-05 — Empty by default**
- No real backend is preconfigured or auto-enabled.
- Test fixtures must never become production registry records.

### 8.3 Tool catalog and routing

**FR-TOOL-01 — Discovery**
- Discover tools from enabled and healthy backends.
- Refresh tool catalog when backend lifecycle or backend tool list changes.
- Display backend source and discovery time.

**FR-TOOL-02 — Namespacing**
- Use deterministic collision-safe namespacing, proposed form `<backend_id>__<tool_name>`.
- Validate naming against MCP/client compatibility before finalizing.
- Preserve original backend ID and original tool name internally.
- Detect collisions and fail closed; never silently route ambiguously.

**FR-TOOL-03 — Routing**
- Route tool calls to the correct backend.
- Validate tool arguments against the discovered schema where appropriate.
- Preserve MCP-compatible content, structured content, and error semantics.
- Support timeout and cancellation.

**FR-TOOL-04 — Filtering**
- Apply agent and policy visibility before returning tools/list.
- A tool hidden from an agent must also be denied if invoked directly.

**FR-TOOL-05 — Tool explorer**
- Search and filter tools by backend, name, and permission.
- Show descriptions and JSON input schemas.
- Show which agents can access each tool.
- Provide a controlled test-invocation feature for administrators, disabled unless the admin explicitly confirms the action.

### 8.4 Agent management

**FR-AGENT-01 — Agent profiles**
- Create, edit, enable, disable, rotate credentials, and revoke profiles.
- Each profile has stable ID, display name, description, status, created/last-used timestamps, and policy assignments.
- Support multiple local clients such as Claude Code, Codex CLI, OpenCode, and future clients without hard-coding their behavior into the core.

**FR-AGENT-02 — Credentials**
- Issue unique credentials per agent.
- Store only a secure verifier/hash where feasible; show plaintext token only once at creation/rotation.
- Support revoke and rotate.
- Never log tokens.
- Define a local-first authentication approach compatible with MCP HTTP clients.

**FR-AGENT-03 — Agent usage**
- Track request count, tool calls, errors, last activity, and permitted usage statistics.
- Do not retain sensitive tool arguments/results by default.

**FR-AGENT-04 — Compatibility**
- Maintain a compatibility matrix for direct Streamable HTTP support.
- Provide a local stdio bridge only for clients that cannot connect to the chosen HTTP transport.
- Do not modify user agent configuration without explicit approval.

### 8.5 Policies and permissions

**FR-POL-01 — Default deny**
- Unknown or unauthenticated identities cannot access protected tools.
- A new agent has no backend/tool access until assigned.

**FR-POL-02 — Policy scopes**
- Grant/revoke access by agent, backend, and individual tool.
- Support allow/deny rules with deterministic precedence.
- Provide preview of effective permissions before saving.

**FR-POL-03 — Administrative RBAC**
- Support owner/admin/read-only roles for dashboard operations.
- Enforce permissions on server APIs, not only by hiding UI controls.

**FR-POL-04 — Policy audit**
- Record who changed access and when.
- Record denied access attempts without logging secrets.

### 8.6 Session and concurrency management

**FR-SESSION-01 — Isolation**
- Keep agent/client sessions isolated.
- Do not share mutable state between unrelated sessions.
- Define session expiration and cleanup.

**FR-SESSION-02 — Shared resource policy**
- Support per-backend concurrency modes: parallel, serialized, and bounded.
- Support resource-scoped locking for stateful backends.
- Avoid a global lock for all backends.
- Provide queue timeout, cancellation, and stale-lock recovery.

**FR-SESSION-03 — Visibility**
- Show active sessions and running tool calls where safe.
- Allow administrators to revoke a session or stop a call if supported.

### 8.7 Dashboard

**FR-UI-01 — Application shell**
- Responsive sidebar/navigation, top bar, breadcrumbs, page title, global status, and account/settings menu.
- Support desktop-first layout while remaining usable on tablet and smaller screens.
- Use consistent loading, empty, error, success, and confirmation states.

**FR-UI-02 — Overview**
- Show total/healthy/degraded/disabled backends.
- Show registered agents and active sessions.
- Show tool count and recent tool activity.
- Show request volume, error rate, and latency trends.
- Show recent system events.
- All metrics must come from real backend data; do not fabricate demo numbers in production.

**FR-UI-03 — Backends**
- Backend list with search, filters, health state, transport, and actions.
- Add-backend flow with transport-specific form and validation.
- Backend detail page with configuration summary, tools, health, recent errors, and lifecycle actions.
- Sensitive fields masked.

**FR-UI-04 — Tool Explorer**
- Searchable catalog.
- Tool detail and schema viewer.
- Backend association.
- Effective agent access view.
- Optional admin test invocation with explicit confirmation.

**FR-UI-05 — Agents**
- Agent list and detail.
- Create/rotate/revoke credentials.
- Permission assignment.
- Usage and last-seen information.
- Connection instructions tailored to client type, without automatically editing config files.

**FR-UI-06 — Access Policies**
- Manage agent-to-backend and agent-to-tool access.
- Display effective permissions.
- Explain denied access.

**FR-UI-07 — Sessions and Activity**
- Active sessions, running calls, durations, client identity, backend/tool.
- Safe cancellation/revocation controls.
- Historical activity search.

**FR-UI-08 — Logs**
- Structured event log viewer.
- Filters by time, severity, agent, backend, tool, request ID.
- Redaction by default.
- Detail view excludes secrets and sensitive payloads.

**FR-UI-09 — Monitoring**
- Request throughput, latency percentiles, error rates, backend uptime/health.
- Time range selector.
- Clearly label unavailable metrics; do not invent values.

**FR-UI-10 — Audit**
- Immutable or tamper-evident audit history for admin actions, credential changes, policy changes, backend lifecycle, and relevant security events.
- Filter and inspect actor, action, target, timestamp, and result.

**FR-UI-11 — Settings**
- General gateway settings.
- Network/bind settings with warning before changing loopback.
- Logging and retention settings.
- Security/auth settings.
- Backup/export/import settings.
- System diagnostics and version information.

**FR-UI-12 — Empty states**
- Empty backend registry should explain that no backend is configured and provide an add-backend action.
- Empty tools and sessions should be clear, not treated as errors.
- Provide no fake demo backend.

### 8.8 Monitoring and operations

**FR-OPS-01 — Structured logging**
- Pino JSON logs with request correlation IDs.
- Configurable log level.
- Redact credentials and sensitive headers.
- Avoid logging full tool arguments/results by default.

**FR-OPS-02 — Metrics**
- Request count, latency, error count, backend connection state, tool call count, active sessions, queue depth where applicable.
- Define metric retention and aggregation.

**FR-OPS-03 — Diagnostics**
- System status and dependency checks.
- Backend-specific health and last failure reason.
- Export a redacted diagnostic bundle.

**FR-OPS-04 — Recovery**
- Graceful shutdown.
- Backend reconnect with bounded exponential backoff and jitter.
- Process/transport cleanup.
- No unbounded retry loops.

**FR-OPS-05 — Backup**
- Backup/restore SQLite metadata.
- Validate restore procedure.
- Secrets stored externally or encrypted with a separately managed key.

### 8.9 Security

**FR-SEC-01 — Local-only default**
- Bind to `127.0.0.1`.
- Do not expose LAN/WAN by default.
- Require explicit configuration and security review for remote exposure.

**FR-SEC-02 — Authentication**
- Authenticate dashboard users and MCP clients separately.
- Use secure password/session handling for dashboard.
- Use per-agent credentials for MCP clients.
- Avoid trusting client-supplied agent names as identity.

**FR-SEC-03 — Authorization**
- Enforce permissions on every relevant API and MCP tool operation.
- Default deny for unknown identities.

**FR-SEC-04 — Secret management**
- No plaintext secrets in logs or source.
- Mask secret values in dashboard.
- Support rotation/revocation.
- Define encryption-at-rest and key management before storing secrets persistently.

**FR-SEC-05 — Input/process safety**
- Validate all configuration and request inputs.
- For stdio backends, use executable + argument arrays; do not interpolate untrusted shell strings.
- Control environment inheritance.
- Restrict process/filesystem permissions where feasible.

**FR-SEC-06 — Web security**
- CSRF protection where cookie-authenticated mutations are used.
- Secure, HttpOnly, SameSite cookies.
- Content Security Policy and security headers.
- Rate limits for authentication and sensitive endpoints.
- Validate Origin/Host according to MCP transport guidance.

**FR-SEC-07 — Audit**
- Record security-sensitive actions.
- Do not record credential plaintext or sensitive payloads.

## 9. Dashboard information architecture

Primary navigation:
1. Overview
2. Backends
3. Tools
4. Agents
5. Access Policies
6. Sessions
7. Activity / Logs
8. Monitoring
9. Audit Trail
10. Settings

Suggested page routes:
- `/dashboard`
- `/dashboard/backends`
- `/dashboard/backends/new`
- `/dashboard/backends/[backendId]`
- `/dashboard/tools`
- `/dashboard/tools/[toolId]`
- `/dashboard/agents`
- `/dashboard/agents/[agentId]`
- `/dashboard/policies`
- `/dashboard/sessions`
- `/dashboard/activity`
- `/dashboard/monitoring`
- `/dashboard/audit`
- `/dashboard/settings`

Route structure is a proposal and may be refined without changing product requirements.

## 10. Non-functional requirements

- **Security:** localhost-first, least privilege, secure credential handling, input validation.
- **Reliability:** isolated backend failures, graceful shutdown, bounded retries.
- **Maintainability:** typed contracts, modular boundaries, migrations, tests.
- **Performance:** avoid repeated unnecessary backend discovery; define cache invalidation.
- **Accessibility:** keyboard navigation, semantic controls, focus visibility, contrast.
- **Responsive design:** usable on desktop, tablet, and mobile.
- **Observability:** correlation IDs and operational metrics.
- **Data integrity:** transactional registry changes and recoverable migrations.
- **Compatibility:** official MCP SDK contracts and documented client support.

## 11. Acceptance criteria — full product

The product is complete when:
1. Gateway serves MCP correctly through official client tests.
2. Empty registry is healthy and returns zero tools.
3. Backends can be configured dynamically and lifecycle-managed.
4. Stdio and Streamable HTTP adapters work with supported MCP servers.
5. Tool discovery, namespacing, filtering, and routing are tested.
6. Multiple agent profiles can connect independently.
7. Per-agent authorization is enforced for both discovery and invocation.
8. Session isolation and concurrency policy are tested.
9. Dashboard covers every page in the information architecture.
10. Dashboard uses Astryx directly as the component library/design system.
11. No shadcn/ui or Radix UI component-library dependency is introduced.
12. Logs, metrics, diagnostics, and audit events work with redaction.
13. Backup/restore is documented and tested.
14. Security review is completed before any non-loopback exposure.
15. Existing agent configurations are changed only with explicit user approval.

## 12. Delivery strategy

The full product is specified now but must be implemented in milestones. Each milestone has its own acceptance criteria. Do not build dashboard screens on top of unstable or invented APIs; establish typed backend contracts first. Do not add real integrations until the adapter/routing/security foundation is ready.
