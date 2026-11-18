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
- Official MCP SDK server/client/Hono packages
- Zod 4, Pino, YAML, `better-sqlite3`, Vitest
- Existing files include `src/config/config.ts`, `src/monitoring/logger.ts`, `src/core/gateway.ts`, `src/index.ts`.
- `pnpm typecheck` passes.
- `pnpm build` passes.
- User verified `pnpm dev` and `GET /health`.
- Gateway endpoint target: `http://127.0.0.1:8787/mcp`.
- Health endpoint: `http://127.0.0.1:8787/health`.
- Production backend registry must remain empty initially.

Inspect actual repository state before editing. This document may lag the code.

## 3. Immediate assignment

Start with **Phase 1 — MCP protocol correctness** in `ROADMAP.md`.

Do not start dashboard implementation yet. The dashboard is a full-project requirement, but it depends on stable APIs and domain contracts.

Required:
1. Inspect installed MCP SDK package versions and declarations.
2. Audit current server/transport lifecycle.
3. Add Vitest tests using the official MCP Client SDK.
4. Test initialize.
5. Test `tools/list` returns an empty list.
6. Test multiple independent clients/session behavior.
7. Test malformed requests and loopback host validation.
8. Test cleanup and graceful shutdown.
9. Run typecheck/build/test.
10. Fix based on test evidence, not guesses.

## 4. Hard constraints

- Do not add real MCP backends.
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
- Use migrations for persistent schema changes.
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
