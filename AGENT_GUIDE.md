# Master Instructions for Local Coding Agents

You are implementing **Universal MCP Gateway**, a full self-hosted MCP control plane with a complete administration dashboard. Read all documents in `docs/` before coding.

## 1. Product target

Read:
- `PRD.md`
- `ARCHITECTURE.md`
- `DASHBOARD.md`
- `BACKEND_SPEC.md`
- `SECURITY.md`
- `DATABASE.md`
- `MONITORING.md`
- `ROADMAP.md`
- `DECISIONS.md`

The full product includes gateway core, backend registry, adapters, tool routing, agent profiles, authorization, session isolation, concurrency protection, monitoring, audit, and a full web dashboard.

## 2. Current repository baseline

- Project: `~/projects/universal-mcp-gateway`
- Node.js 26.13.1
- pnpm 11.7.0
- TypeScript ESM / NodeNext
- Hono + `@hono/node-server`
- Official MCP SDK v2 (`@modelcontextprotocol/server` 2.4.0, `client` 2.4.0, `hono` 2.0.2)
- Zod 4, Pino, YAML, `better-sqlite3`, Vitest
- Phases 1–8 are complete, Phase 9 (dashboard foundation) is complete in its
  adjusted scope, **Phase 10.0 (dashboard operator identity and
  authentication) is implemented** (ADR-045), Phase 11 (observability) is
  implemented (ADR-046/047), Phase 12 (integration-ready architecture) is
  implemented (ADR-048–052), **Phase 13 (first real provider — GitHub,
  ADR-053) is implemented**, and **Phase 14 (agent compatibility) is
  implemented** — `docs/AGENT_COMPATIBILITY.md` is the client matrix;
  `tests/compatibility/` is its SDK harness. `pnpm typecheck`, `pnpm build`,
  and `pnpm test` pass (731 tests), and the dashboard passes its own
  typecheck, build, and 470 tests.
- `src/integrations/` holds the managed-integration domain: source refs,
  provider registration (the registry is code; its first entry is
  `githubRegistration` — read-only, fine-grained PAT), connection lifecycle
  as data, the bounded connector contract, the AES-256-GCM envelope vault
  (`INTEGRATION_MASTER_KEY` only, lazy fail-closed), and
  `IntegrationService`. The router dispatches managed tools through one seam
  **after** authorization; the operator API under `/api/v1/integrations`
  covers both reads and the write lifecycle (create, write-only credential,
  test-as-data, enable, disable, disconnect, delete). **No OAuth, no GitHub
  Apps, no webhooks, no enterprise hosts, no write tools** — and no test
  dials `api.github.com` (the connector's `fetchImpl` is injectable).
- `src/core/gateway.ts` builds the app via `createGateway({ config, logger, store?, credentialKeys? })`:
  SDK `createMcpHandler` + Host/Origin middleware for non-API paths + `/health`, mounts the
  management API at `/api/v1` when a store is present, and mounts bearer authentication on
  `/mcp` whenever auth services exist.
- `src/auth/` holds MCP authentication (`auth-service.ts`), policy evaluation
  (`authorization.ts`), credential keying/digests (`credential-key.ts`), and
  operator password hashing (`operator-password.ts`, scrypt). Only
  `credential-key.ts` reads the environment, and `CREDENTIAL_HASH_SECRET` is
  deliberately outside `Config` (ADR-039).
- `src/api/` is the HTTP layer (routes, guards, envelopes); `src/registry/backend-service.ts`
  holds backend business rules, transactions, audit, and sanitization.
  `src/registry/{agent,credential,policy}-service.ts` hold the Phase 6 rules, and
  `src/registry/operator-service.ts` holds Phase 10.0 operator login, lockout,
  session lifecycle, rotation, and CSRF derivation.
- **Two authentication boundaries, never interchangeable:** `src/api/middleware/mcp-auth.ts`
  guards `/mcp` with a per-agent bearer credential; `src/api/middleware/operator-auth.ts`
  guards every `/api/v1` route with an operator cookie (default-deny, closed
  exemption list `POST /api/v1/auth/{login,logout}`, plus `X-CSRF-Token` on
  non-safe methods). `/health` and `/ready` stay unauthenticated.
- `src/domain/` holds entities, Zod schemas, and repository interfaces
  (`operator.ts` for Phase 10.0 operator identity/session); `src/shared/errors.ts`
  the error taxonomy; `src/config/config.ts` the pure config parser;
  `src/infrastructure/database/` the SQLite foundation and repositories.
- Persistence: one connection per process, WAL + `synchronous=FULL`, transactional
  checksummed migrations, tombstones for backends/agents, derived credential/session status.
- Gateway endpoint target: `http://127.0.0.1:8787/mcp`.
- Health endpoint: `http://127.0.0.1:8787/health`.
- Dashboard: `apps/dashboard`, a pnpm workspace package (Next 16, React 19, Astryx
  0.7.16), served at `localhost:3000` and reading the gateway through
  `GATEWAY_ORIGIN` server-side (default `http://127.0.0.1:8787`). The gateway stays
  the **root** package — there is no `apps/gateway/package.json`.
- Production backend registry must remain empty initially, and the **provider
  registry is code** (ADR-050): `githubRegistration` is its first entry
  (Phase 13). Do not register a second provider, and do not store a real
  credential or make a live provider call without explicit user approval.

Inspect actual repository state before editing. This document may lag the code.

## 3. Immediate assignment

Phases 1–14 are complete in their stated scopes (Phase 13 is the first real
provider — GitHub, read-only, ADR-053; Phase 14 is agent compatibility —
`docs/AGENT_COMPATIBILITY.md`, harness in `tests/compatibility/`). The
remaining Phase 10 module pages are not started. **Phase 15 (hardening and
release) is not started and must not be started without explicit approval**;
the roadmap renumbered during execution — the originally planned Phase 13/14
swap was leapfrogged when the first-real-provider work landed as Phase 13,
and agent compatibility took Phase 14.

Phase 14's rules, which outlive the phase: the gateway has **no
agent-specific code** — compatibility is protocol-level and stays that way;
`docs/AGENT_COMPATIBILITY.md` never claims more than its evidence (the
vocabulary is VERIFIED / PROTOCOL VERIFIED / PARTIAL / NOT VERIFIED /
UNSUPPORTED); and real-client probes always use isolated temp configs —
never an existing Claude Code, Codex, or OpenCode configuration.

Phase 9 built the dashboard foundation: shell, navigation, theme, Astryx
integration, typed API client, same-origin read proxy, and feedback compositions.
10.0 added operator identity and the gateway-enforced boundary those pages will
rely on. Phase 13 built the integrations module — three routes (`/dashboard/
integrations`, `/new`, `/[connectionId]`), the write proxy's fourth mount — so
the "no dashboard page" absence recorded at Phase 12 close is resolved for
cause: the registry now holds GitHub and the gateway owns the write API.

**Two authentication boundaries exist and must stay separate.** `/mcp` requires a
per-agent bearer credential (Phase 6); every `/api/v1` route requires an operator
session (Phase 10.0). Neither is accepted by the other, they share no table, and
`tests/operator-auth.test.ts` asserts both negations. Do not "unify" them, and do
not treat an operator session as a way to call tools. Phase 12 adds a third
domain on the same principle: a **connection** is neither an agent nor an
operator, and a `backend`-scoped policy rule naming a connection id is rejected
at creation — identity domains never merge (ADR-048).

The management API is no longer unauthenticated, but it is still **loopback-only
and not remote-ready**: there is no TLS, no RBAC beyond a single `owner`, and no
per-IP login rate limit. Anything that widens reachability is a security-posture
change and needs the user's approval. The dashboard inherits the same rule: do
not expose it beyond loopback.

The gateway remains the root package. `apps/dashboard` is the only workspace
package; use `pnpm --filter @universal-mcp-gateway/dashboard …` rather than
inventing a package name.

Evidence to build on:
- `tests/mcp-auth.test.ts` — the authentication/authorization boundary over a real socket:
  uniform 401s, session-id replay, header spoofing, per-agent `tools/list`, and a denied call
  being byte-identical to an unknown tool.
- `tests/credentials.test.ts`, `tests/authentication.test.ts`, `tests/authorization.test.ts` —
  digest/key handling, failure reasons, and policy precedence.
- `tests/gateway.test.ts` — MCP protocol tests over the real loopback server using the official MCP Client SDK.
- `tests/compatibility/` — the Phase 14 harness: six scenario files (A–F) over
  a shared boot (`harness.ts`), each driven as a client drives the gateway;
  `docs/AGENT_COMPATIBILITY.md` records what it proves and what only a real
  client could.
- Both protocol eras work: 2025 `initialize` and 2026-07-28 `server/discover`.
- Serving is stateless per exchange; see ADR-020 in `DECISIONS.md` before changing session behavior.
- Do not re-add the Hono JSON body middleware (ADR-021): it degrades JSON-RPC parse errors to plain text.
  The management API uses its own guard (`src/api/middleware/guards.ts`) for the same reason.
- Phase 2/3 tests: `tests/domain-*.test.ts`, `tests/config.test.ts`, `tests/errors.test.ts`,
  `tests/database.test.ts`, `tests/repositories.test.ts`, `tests/backend-service.test.ts`,
  `tests/api.test.ts` — all on isolated temp databases.
- `tests/api.test.ts` includes one real-socket test. `app.request()` cannot reproduce adaptor
  header behaviour (it always presents a body stream and may add `Content-Length: 0`), and an
  in-process-only suite once hid a bug that rejected bodyless `POST .../enable` and `DELETE`.
  Keep at least one real-listener test for anything that inspects request framing.

Contracts to use rather than invent:
- Use `create*Input` types (Zod `z.input`) for caller payloads; `z.infer` output types are for values read back from storage.
- Backend rules go in `BackendService`, never in a route handler. A handler parses HTTP and formats; it contains no SQL and no business rule.
- Enable/disable are configuration-only and must stay idempotent; only `disabled` ↔ `disconnected` may be synced. Never fabricate a `connected` runtime state.
- Public responses are built by `toPublicBackend()`, not by serializing a row. Add fields there deliberately.
- Update schemas intentionally have **no defaults** — a default there overwrites stored values the caller never mentioned. `undefined` means "leave it", `null` means "clear it".
- Throw `AppError` with a stable `ErrorCode`; never return raw SQLite or OS text to a client.
- Reach the database only through `src/domain/repositories.ts`; SQL belongs in `src/infrastructure/database/`.
- Register a new schema change as a new `NNNN_*.sql` migration. Never edit an applied migration (the checksum gate refuses startup).
- Operator authentication rules live in `src/registry/operator-service.ts`; the
  HTTP boundary lives in `src/api/middleware/operator-auth.ts`. A route never
  verifies a password or mints a session itself. New `/api/v1` routes are
  protected by default — the exemption list is closed, so do not add to it
  casually.
- Operator sessions store only an HMAC digest (`token_hash`); never store, log, or
  return the raw cookie value. The CSRF token is derived, not stored.
- `tests/operator-auth.test.ts` and `tests/operator-identity.test.ts` are the
  boundary contracts. Extend them when adding a route or a session rule.
- The repo is now a pnpm workspace with one package: `apps/dashboard`. The gateway
  intentionally remains the root package — do not move it into `apps/gateway` (see
  ADR-022 on directory moves).

## 4. Hard constraints

- Do not add real MCP backends.
- Do not connect, spawn, or dial anything in Phase 4 without explicit user approval of the pilot backend.
- Do not integrate FigCraft, Context7, Chrome DevTools, Supabase, GitHub, filesystem, or any other real backend.
- Do not add a permanent dummy backend to production registry.
- Do not modify Claude Code, Codex CLI, OpenCode, or DeepSeek MCP configuration.
- Dashboard work starts at Phase 10 (Phase 9 foundation exists). Workstream 10.0
  (operator identity) is implemented; module feature pages are next.
- Do not add a placeholder auth guard, a dummy operator, or a session that means
  nothing just to make a phase checkbox pass. No real backend behind the UI.
- Do not merge or reuse the two identity boundaries. An operator session must
  never authenticate `/mcp`; an agent credential must never authenticate
  `/api/v1`.
- Do not weaken operator authentication to make a test or a manual check easier
  (no disabling CSRF, no trusting a forwarded header, no hardcoded credentials).
- Do not switch from pnpm to npm.
- Do not change agreed backend stack without documenting the reason and requesting approval.
- Do not expose gateway beyond `127.0.0.1`.
- Do not store plaintext secrets or log credentials.
- Avoid unrelated refactors.

## 5. Mandatory frontend rules

Phase 9 established these; they apply to all dashboard work:
- Use Next.js + React + TypeScript.
- Use **Astryx directly**: https://astryx.atmeta.com/
- Read current official Astryx documentation before installing or coding.
- Follow official Astryx installation, component, token, theme, and styling guidance.
- Do not use shadcn/ui.
- Do not install shadcn CLI or generate shadcn components.
- Do not use Radix UI as a fallback component library.
- Do not invent Astryx package names, import paths, props, or CLI arguments.
- Custom components are allowed for product-specific compositions or genuine gaps.
- If Astryx is incompatible or lacks a required component, report the exact gap and propose options before introducing another UI library.
- The browser never calls the gateway directly: reads go server-side via
  `lib/api/client.ts`, client refreshes go through `/api/proxy/*` (allowlisted
  GET). Keep `GATEWAY_ORIGIN` server-only.
- A `503` is not sufficient evidence of anything: `/ready` answers `503` when the
  gateway is genuinely not ready, and the proxy answers `503` when the gateway is
  absent. Decide on payload shape.

## 6. Engineering rules

- Use official MCP SDK types and APIs.
- Avoid `any` and unsafe casts.
- Keep transport, domain, registry, routing, adapters, policy, and UI boundaries clear.
- Validate untrusted input with Zod.
- Keep backend failures isolated.
- Use migrations for persistent schema changes; applied migrations are immutable.
- Store secret references (`secret:<path>`, `env:<VAR>`), never secret values.
- Keep domain (`src/domain`) free of infrastructure imports.
- Make changes small and testable.
- Do not claim tests passed unless you ran them.
- Do not invent runtime metrics or sample production data.

## 7. Completion report after each phase

Report:
1. Phase completed.
2. Files created/changed.
3. Design decisions and tradeoffs.
4. Commands actually run.
5. Test results.
6. Security considerations.
7. Remaining issues.
8. Confirmation production registry remains empty (until user authorizes a backend).
9. Confirmation agent configurations remain unchanged.
10. Next phase recommendation; do not start it automatically.

## 8. User interaction

If a decision changes product scope, security posture, dependency stack, or agent configuration, stop and ask the user. Do not infer approval from the PRD alone for risky operations.
