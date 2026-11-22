# Agent Compatibility

## 1. Objectives and vocabulary

Implemented in Phase 14. This document answers one question: **which MCP
clients can talk to this gateway, and what is the evidence?** The gateway core
contains no agent-specific code — every client reaches the same `/mcp`
surface, authenticates the same way, and is bounded by the same authorization
and session rules. There are no per-client branches to test, so what varies
between clients is only how they speak the protocol.

Every claim uses one of five statuses, and nothing earns a status without
evidence produced by that claim's own run:

- **VERIFIED** — the real, locally installed client completed a full round
  trip against a live gateway: initialize, tool discovery, and a tool call
  whose response the client displayed.
- **PROTOCOL VERIFIED** — the protocol behavior a client of this kind needs
  was exercised by the official TypeScript SDK (`@modelcontextprotocol/client`
  2.4.0 — the same client library these agents embed) driving the real HTTP
  surface in `tests/compatibility/`. The client itself was not driven
  end-to-end.
- **PARTIAL** — some links of the chain are verified and others are not; the
  entry says exactly which.
- **NOT VERIFIED** — no evidence exists. Absence of an installation is not
  evidence of compatibility, so this status implies nothing negative either.
- **UNSUPPORTED** — the gateway deliberately does not implement this; listed
  so nobody mistakes silence for an oversight.

A configuration example, a health check, or a `--help` page never raises a
status above PARTIAL.

## 2. The stack under test

Verified against the installed packages, not their documentation:

| Package | Version |
| --- | --- |
| `@modelcontextprotocol/server` | 2.4.0 |
| `@modelcontextprotocol/client` | 2.4.0 |
| `@modelcontextprotocol/hono` | 2.0.2 |
| `hono` | 4.13.19 |
| `zod` | 4.6.7 |

`LATEST_PROTOCOL_VERSION` is **`2025-11-25`**; the server accepts
`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`.
Era routing is the SDK's own `isLegacyRequest`: sessionful 2025-era traffic
(`initialize`, `mcp-session-id`) and the stateless per-exchange leg
(including the 2026 `server/discover` flow) are both served, and both are
exercised by the harness.

## 3. Client matrix

| Client | Version | Status | Evidence |
| --- | --- | --- | --- |
| Claude Code | 2.1.330 | **VERIFIED** | §3.1 |
| OpenCode | 2.3.2 | **VERIFIED** | §3.2 |
| Codex CLI | 0.171.0 | **PARTIAL** | §3.3 |
| DeepSeek Desktop | not installed | **NOT VERIFIED** | §3.4 |
| Any standards-compliant MCP client | — | **PROTOCOL VERIFIED** | §4 |

All real-client evidence below was produced on 2026-11-22 against a scratch
gateway (loopback, temp store, stdio fixture backend named
`b29eac27-e864-4d40-a500-36b4906ee21e`) using a test-only agent credential.
No production backend, no real upstream credential, and none of the author's
existing client configurations were involved: each client was driven from a
temporary project directory or an isolated config flag/env, and every file
that held the test token was deleted after the run.

### 3.1 Claude Code 2.1.330 — VERIFIED

Driven headless with an isolated `--mcp-config` (plus
`--strict-mcp-config`, so no other MCP registration could load) and a scoped
`--allowedTools` grant, against the existing local login used read-only:

```json
{
  "mcpServers": {
    "gateway": {
      "type": "http",
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": { "Authorization": "Bearer <agent token>" }
    }
  }
}
```

The session called `<backend>__unicode_echo` with `text: "claude probe"` and
printed the gateway's answer verbatim, unicode intact:

```
回显 “claude probe” ✓ emoji: 🛠️
```

### 3.2 OpenCode 2.3.2 — VERIFIED

Driven entirely inside a temporary project directory with an isolated
`opencode.json` (project-level config; nothing global was touched):

```bash
opencode mcp add gateway --url http://127.0.0.1:PORT/mcp \
  --header "Authorization=Bearer <agent token>"
opencode mcp list          # → ✓ gateway  connected
opencode run --auto "…call <backend>__unicode_echo with text 'opencode probe'…"
```

`opencode mcp list` health-checked the server (`✓ gateway connected`), and the
run's model invoked the tool through the gateway and printed:

```
回显 “opencode probe” ✓ emoji: 🛠️
```

### 3.3 Codex CLI 0.171.0 — PARTIAL

Codex's own registration accepted the gateway as a streamable HTTP server
with a bearer token supplied through an environment variable — the exact
shape this gateway exposes:

```bash
codex mcp add gateway --url http://127.0.0.1:PORT/mcp \
  --bearer-token-env-var UMG_AGENT_TOKEN
codex mcp list   # → gateway … enabled, "Bearer token"
```

**Verified:** registration, URL shape, bearer-token plumbing, and `mcp list`
recognition. **Not verified:** an end-to-end session — the locally installed
Codex login holds an OpenAI API key the model endpoint rejects
(`401 invalid_api_key`), so no agent turn could run. `codex mcp list` prints
configuration status, not a connection probe, so no handshake was observed
either. This entry rises to VERIFIED the day a working local login exists;
nothing on the gateway side blocks it, and the SDK-level handshake Codex
depends on is covered by the harness (§4).

### 3.4 DeepSeek Desktop — NOT VERIFIED

Not installed on this machine. Installing a client requires explicit user
approval, which was not requested, so no claim is made. What can be said:
the gateway speaks the standard Streamable HTTP transport with bearer
authentication and no client-specific behavior, and every DeepSeek-version
unknown is a client-side question, not a gateway-side one.

## 4. The SDK harness (`tests/compatibility/`)

Six files, 34 tests, run by the root vitest suite. Everything is driven the
way a real client drives it: the official SDK `Client` over
`StreamableHTTPClientTransport` against a real loopback socket, with raw
`fetch` only for the wire-level facts the SDK cannot express (a missing
header, a foreign session id, a `DELETE`, a stale cursor). Backends are real
stdio subprocesses (`tests/fixtures/catalog-fixture.ts`), so discovery,
schema forwarding, and execution cross the real transport.

- **A — basic protocol** (`basic-protocol.test.ts`): initialize, the
  `notifications/initialized` round trip (including a duplicate, which must
  be harmless), a stale/invented cursor answered with one bounded snapshot
  and no `nextCursor`, unknown tool → `-32602` with no internal detail, the
  client `DELETE` → session terminated and the dead id refused, clean SDK
  disconnect, and the same flow on the per-request era.
- **B — authentication** (`authentication.test.ts`): missing, invalid,
  malformed, revoked, and expired credentials all answer with one
  byte-identical 401; the right agent is authenticated and a default-deny
  agent is not; a stolen session id plus one's own working credential is
  still refused.
- **C — authorization** (`authorization.test.ts`): the list and the call
  boundary agree (exact-name grants, default-deny invisible, deny
  overriding allow); a denied tool's error is indistinguishable from a
  fabricated name's; a denial produces no routing activity.
- **D — session isolation** (`sessions.test.ts`): two agents two sessions,
  concurrent same-identity sessions, cross-agent id refusal, revocation, and
  idle-expiry enforced per request, not by the sweep.
- **E — tool interoperability** (`tool-interop.test.ts`): nested objects,
  arrays, enums, nullables, invalid-enum rejection, structured content,
  verbatim schema and output-schema forwarding, unicode, multi-block
  responses, a 256 KB payload, and a tool-level `isError` failure that is
  not a protocol error. Backed by the `shapes` fixture mode.
- **F — failure and resilience** (`resilience.test.ts`): a disabled backend
  vanishing from the catalog mid-session without disclosure, a backend that
  never came up not disturbing anyone else, the tool-call budget answering a
  protocol error and the gateway staying up, caller cancellation, malformed
  JSON (`-32700`), unsupported methods on both legs (`-32601`), concurrent
  agents without cross-talk, and a client that disappears without goodbye.

## 5. Deliberate non-features

- **STDIO transport** — UNSUPPORTED. The gateway serves Streamable HTTP only;
  a client that can only spawn a stdio server cannot use it. This is the
  design (loopback HTTP, one authority boundary), not a gap to fix.
- **MCP-surface rate limiting** — UNSUPPORTED. Failure budgets are enforced
  per backend and per operator session, not per MCP request; there is no
  `429` leg to verify, so the compatibility plan's rate-limit scenario is
  recorded here as absent rather than faked.
- **OAuth** — UNSUPPORTED. Bearer credentials issued by the operator API are
  the only MCP authentication. No client is asked to run an OAuth flow, and
  none may.

## 6. What a client operator should know

- Point the client at `http://127.0.0.1:8787/mcp` (or the configured
  `PORT`/`MCP_ENDPOINT`), HTTP type, with one header:
  `Authorization: Bearer <agent token>` from
  `POST /api/v1/agents/{id}/credentials`.
- The credential binds to one agent; its policy decides the catalog the
  client sees. An empty tool list means "no grants", not "broken".
- The gateway binds loopback only. Any remote/LAN exposure is out of scope
  and blocked elsewhere in the design.
