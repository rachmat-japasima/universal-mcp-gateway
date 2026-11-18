# Universal MCP Gateway

A self-hosted, local-first MCP gateway and control plane for multiple coding agents and independently managed MCP backends.

## Full product scope

- MCP Streamable HTTP gateway.
- Dynamic backend registry and adapters.
- Tool discovery, namespacing, and routing.
- Agent profiles and per-agent credentials.
- Authorization policies.
- Session isolation and concurrency controls.
- Complete administration dashboard.
- Monitoring, structured logs, diagnostics, and audit trail.
- Backup, recovery, and operational runbooks.

## Technology

### Backend
Node.js, TypeScript ESM, pnpm, Hono, official MCP TypeScript SDK, Zod, Pino, YAML, SQLite (`better-sqlite3`), Vitest.

### Dashboard
Next.js, React, TypeScript, and **Astryx directly** as the UI component library/design system.

**Do not use shadcn/ui or Radix UI as a fallback component library.** Follow current official Astryx documentation: https://astryx.atmeta.com/

## Current status

Bootstrap is complete:
- Typecheck passes.
- Build passes.
- User verified dev server and health endpoint.
- Production backend registry is empty.

## Development commands

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm build
pnpm test
```

Health:
```bash
curl -i http://127.0.0.1:8787/health
```

MCP endpoint:
```text
http://127.0.0.1:8787/mcp
```

## Documentation

- `PRD.md` — full product requirements.
- `ARCHITECTURE.md` — system architecture.
- `DASHBOARD.md` — complete dashboard and Astryx requirements.
- `BACKEND_SPEC.md` — management API and backend domain.
- `SECURITY.md` — security requirements.
- `DATABASE.md` — database model and persistence.
- `MONITORING.md` — logs, metrics, audit, operations.
- `ROADMAP.md` — implementation phases.
- `DECISIONS.md` — accepted decisions.
- `AGENT_GUIDE.md` — instructions for local coding agents.

## First task

Complete Phase 1 — MCP protocol correctness. Do not add real backends or modify agent configurations.
