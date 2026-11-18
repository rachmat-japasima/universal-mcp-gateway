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
- Phases 1–3 are complete: `pnpm typecheck`, `pnpm build`, and `pnpm test` pass (190 tests).
- `src/core/gateway.ts` builds the app via `createGateway({ config, logger, store? })`:
  SDK `createMcpHandler` + Host/Origin middleware for non-API paths + `/health`, and
  mounts the management API at `/api/v1` when a store is present.
- `src/api/` is the HTTP layer (routes, guards, envelopes); `src/registry/backend-service.ts`
  holds backend business rules, transactions, audit, and sanitization.
- `src/domain/` holds entities, Zod schemas, and repository interfaces; `src/shared/errors.ts`
  the error taxonomy; `src/config/config.ts` the pure config parser;
  `src/infrastructure/database/` the SQLite foundation and repositories.
- Persistence: one connection per process, WAL + `synchronous=FULL`, transactional
  checksummed migrations, tombstones for backends/agents, derived credential/session status.
- Gateway endpoint target: `http://127.0.0.1:8787/mcp`.
- Health endpoint: `http://127.0.0.1:8787/health`.
- Production backend registry must remain empty initially.

Inspect actual repository state before editing. This document may lag the code.

## 3. Immediate assignment

Phases 1–3 are complete. Start **Phase 4 — adapter framework** in `ROADMAP.md`.

Phase 4 is the first phase that touches the network and spawns processes. Before any of
that: the management API is currently unauthenticated and loopback-only (ADR-030). Connecting
real backends raises the blast radius of that gap, so re-read `docs/SECURITY.md` §3.1 and
decide whether authentication must land before adapters rather than after — that is a
security-posture change and needs the user's approval.

Do not start dashboard implementation yet. The dashboard depends on stable APIs.

Evidence to build on:
- `tests/gateway.test.ts` — MCP protocol tests over the real loopback server using the official MCP Client SDK.
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
- No monorepo split yet; see ADR-022 before moving directories.

## 4. Hard constraints

- Do not add real MCP backends.
- Do not connect, spawn, or dial anything in Phase 4 without explicit user approval of the pilot backend.
- Do not integrate FigCraft, Context7, Chrome DevTools, Supabase, GitHub, filesystem, or any other real backend.
- Do not add a permanent dummy backend to production registry.
- Do not modify Claude Code, Codex CLI, OpenCode, or DeepSeek MCP configuration.
- Do not build dashboard before Phase 9.
- Do not switch from pnpm to npm.
- Do not change agreed backend stack without documenting the reason and requesting approval.
- Do not expose gateway beyond `127.0.0.1`.
- Do not store plaintext secrets or log credentials.
- Avoid unrelated refactors.

## 5. Mandatory frontend rules for later phases

When dashboard phase begins:
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
