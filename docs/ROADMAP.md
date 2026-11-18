# Full Project Implementation Roadmap

The full product scope is approved in this document. Implement sequentially; do not attempt the entire product in one change.

## Phase 0 — Bootstrap (completed)
- [x] pnpm project initialized.
- [x] TypeScript ESM / NodeNext configured.
- [x] Agreed base dependencies installed.
- [x] Hono server and MCP endpoint skeleton created.
- [x] Pino logger and environment config created.
- [x] `/health` endpoint works.
- [x] `pnpm typecheck` passes.
- [x] `pnpm build` passes.
- [x] User verified dev server and health endpoint.
- [x] Production backend registry remains empty.

## Phase 1 — MCP protocol correctness (next)
- Audit installed SDK versions and declarations.
- Verify transport lifecycle against actual SDK.
- Add official MCP Client SDK integration tests.
- Test initialize and tools/list returns empty array.
- Test multiple clients/session semantics.
- Test malformed requests, host validation, and cleanup.
- Ensure typecheck/build/test pass.

## Phase 2 — Core domain and configuration
- Define domain types and Zod schemas.
- Define error taxonomy.
- Define backend configuration format.
- Define registry repository interfaces.
- Add SQLite migrations foundation.
- No real backend integrations.

## Phase 3 — Backend registry and management API
- Implement backend CRUD and validation.
- Add enable/disable lifecycle.
- Persist definitions in SQLite.
- Separate persisted definition and runtime status.
- Add tests and API documentation.
- Registry remains empty until user adds a backend.

## Phase 4 — Adapter framework
- Implement stdio adapter.
- Implement Streamable HTTP adapter.
- Use official MCP Client SDK.
- Implement process lifecycle, timeouts, reconnect, cleanup.
- Use test fixtures only; do not add permanent production backends.

## Phase 5 — Tool catalog and routing
- Discover tools.
- Namespacing and collision detection.
- Tool call routing.
- Timeout/cancellation.
- Error normalization.
- Tool catalog cache/invalidation.
- Integration tests with isolated fixtures.

## Phase 6 — Identity, authentication, and policies
- Agent profiles.
- Per-agent credentials.
- Dashboard owner authentication.
- Policy engine.
- Default-deny authorization.
- Filter tools/list and enforce tools/call.
- Secret redaction and audit events.

## Phase 7 — Session isolation and concurrency
- Finalize transport/session model.
- Session tracking and expiration.
- Per-backend concurrency modes.
- Resource-scoped queue/locks.
- Cancellation and stale-lock recovery.
- Concurrent client tests.

## Phase 8 — Management API completion
- Agents, policies, sessions, activity, settings APIs.
- Validation, pagination, filtering.
- API contracts and integration tests.
- Secure backup/restore APIs.

## Phase 9 — Astryx dashboard foundation
- Read current official Astryx docs.
- Install and configure Astryx directly.
- Do not install shadcn/ui or Radix UI as fallback.
- Build app shell, navigation, theme, tokens, responsive behavior.
- Establish typed API client and auth guard.
- Implement reusable product compositions using Astryx.

## Phase 10 — Dashboard feature pages
Implement:
1. Overview.
2. Backend list/create/detail.
3. Tool Explorer.
4. Agents and credential lifecycle.
5. Access Policies.
6. Sessions.
7. Activity.
8. Monitoring.
9. Audit Trail.
10. Settings and diagnostics.

Every page must use real API data and complete loading/empty/error/success states.

## Phase 11 — Observability and operations
- Structured request logs.
- Metrics aggregation.
- Health/diagnostics.
- Reconnect/backoff.
- Audit retention.
- Backup/restore and runbooks.

## Phase 12 — Agent compatibility
- Verify Claude Code, Codex CLI, OpenCode, and DeepSeek client compatibility.
- Connect one client at a time.
- Direct HTTP where supported.
- Local stdio bridge only where necessary.
- Do not alter agent configs without user approval.

## Phase 13 — First real backend integration
- Select one pilot backend with user approval.
- Start with read-only/safe tools.
- Validate permissions and concurrency.
- Add further backends only after pilot is stable.
- FigCraft is a candidate, not a required first integration.

## Phase 14 — Hardening and release
- Security review.
- Performance and soak tests.
- Failure/recovery tests.
- Backup/restore verification.
- Documentation and versioning.
- Local deployment and process supervision.
- Explicit security gate before non-loopback exposure.

## Phase 15 — Optional enhancements
- Import/export configuration.
- Advanced alerting.
- More transports.
- Multi-user administration.
- Remote access with strong security.
- Additional dashboards/analytics.

## Rules
- One phase at a time.
- No real backend integration before adapter/routing/security foundation.
- No dashboard before stable API contracts.
- No fake production backends or metrics.
- Do not modify agent configuration without explicit approval.
- Report exact files, tests, results, and remaining risks at each phase.
