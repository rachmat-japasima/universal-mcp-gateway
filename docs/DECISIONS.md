# Architecture Decision Records

## ADR-001 — Generic gateway
**Status:** Accepted  
Universal MCP Gateway is a generic MCP control plane, not a FigCraft-specific bridge. Backend-specific behavior belongs in adapters.

## ADR-002 — Empty initial production registry
**Status:** Accepted  
Production registry starts with zero backends. Test fixtures are temporary and isolated.

## ADR-003 — Node.js + TypeScript ESM
**Status:** Accepted  
Use Node.js and TypeScript ESM with strict mode and NodeNext resolution.

## ADR-004 — pnpm
**Status:** Accepted  
Keep pnpm. Do not switch to npm.

## ADR-005 — Official MCP SDK
**Status:** Accepted  
Use official MCP TypeScript SDK packages for server/client/transport. Verify APIs against installed versions.

## ADR-006 — Hono
**Status:** Accepted  
Use Hono and `@hono/node-server` for HTTP application layer.

## ADR-007 — Local-first binding
**Status:** Accepted  
Default to `127.0.0.1:8787`, MCP `/mcp`, health `/health`. No remote exposure by default.

## ADR-008 — SQLite
**Status:** Accepted  
Use SQLite through `better-sqlite3` for local metadata/registry, with migrations and repository boundaries.

## ADR-009 — Dashboard is full-product scope
**Status:** Accepted  
A complete administration dashboard is required, including overview, backends, tools, agents, policies, sessions, activity, monitoring, audit, and settings.

## ADR-010 — Astryx is the direct UI library
**Status:** Accepted  
Use Astryx directly from `https://astryx.atmeta.com/` as the frontend component library and design system. Use its documented components, tokens, themes, and patterns.

## ADR-011 — No shadcn/ui
**Status:** Accepted  
Do not install, generate, or use shadcn/ui. This is not an Astryx-inspired shadcn implementation.

## ADR-012 — No Radix UI fallback library
**Status:** Accepted  
Do not introduce Radix UI as a substitute component library. If Astryx lacks a required component, create a focused custom component or propose an alternative for approval.

## ADR-013 — Next.js dashboard
**Status:** Accepted  
Use Next.js + React + TypeScript for the dashboard. Verify Astryx's current compatibility and setup requirements before implementation.

## ADR-014 — No dashboard before API/core stability
**Status:** Accepted with sequencing clarification  
Dashboard is part of the full product, but implementation begins after core APIs and domain contracts are stable.

## ADR-015 — Do not alter agent configuration yet
**Status:** Accepted  
Existing Claude Code, Codex CLI, OpenCode, and DeepSeek configurations remain untouched until the user explicitly approves connection work.

## ADR-016 — Session isolation and concurrency protection
**Status:** Accepted as product requirements  
Implement isolated sessions and per-backend/resource concurrency controls. Exact transport and locking design must be validated.

## ADR-017 — Windows + WSL2 boundary
**Status:** Accepted  
Gateway runs in WSL2; some desktop applications run on Windows. Do not assume shared paths/network behavior without testing.

## ADR-018 — Dynamic backend lifecycle
**Status:** Accepted  
Adding, updating, enabling, disabling, and removing a backend must not require rebuilding the gateway.

## ADR-019 — Local-first security
**Status:** Accepted  
Default deny for unknown identities, separate dashboard/MCP authentication, secret redaction, and explicit security review before remote exposure.
