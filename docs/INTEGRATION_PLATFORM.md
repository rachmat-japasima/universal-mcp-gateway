# The Managed Integration Platform

Implemented across Phases 12–13 (ADR-048–053), hardened in Phase 15 (ADR-054).
This document describes the platform **as built**, for two readers: an operator
deciding whether to connect a provider, and the developer who will add the
second one. Every claim here is backed by a test; where something is
deliberately absent, the text says so instead of implying a feature.

## 1. Provider architecture

One seam, two tool sources. An MCP backend (`sourceType: mcp_backend`) and a
managed integration (`sourceType: managed_integration`) enter the same catalog,
the same authorization model, the same activity/audit/metrics trail, and the
same execution order: authenticate → authorize → resolve → validate → execute →
record. Only the *execution adapter* differs — backends go through the MCP SDK
client, managed tools through a connector — because the two transports are
genuinely different. Nothing else branches on the source type except the
structural places that must (activity rows name one source id, by type).

Three identity domains never merge (ADR-048):

| Concept | What it is | Where it lives |
| --- | --- | --- |
| Provider | A code registration: definition + connector | `src/integrations/registry.ts` (`REGISTRATIONS`) |
| Connection | An operator's instance of a provider | `integration_connections` rows |
| Credential | An encrypted envelope linked to a connection | `integration_credentials` rows |

The registry is code, not a table (ADR-050): no dynamic loading, no
marketplace, no plugin directory. A provider exists because a developer wrote
it into `REGISTRATIONS`, which makes every entry reviewed, typed, and covered
by connector-contract tests. There is no operator write path to the registry,
so there is no second copy of it to drift from the code. Production registers
exactly one provider: **GitHub**, read-only, through a fine-grained personal
access token (ADR-053).

## 2. Provider definition

`providerDefinitionSchema` (`src/integrations/provider.ts`):

- `id` — lowercase slug (`github`), stable once published; connections
  reference it by this string. Not a row id: it appears in operator-facing
  views and renaming one breaks stored references, so it is treated as
  immutable.
- `name`, `description` — operator-facing, bounded lengths.
- `capabilities` — a non-empty subset of `{discovery, execution}`. Discovery
  without execution is a list-only provider (tools visible, never callable).
  The registry refuses a registration whose connector does not implement
  every declared capability, and duplicate ids fail closed instead of
  overwriting.
- `metadata` — open-shaped, non-secret provider facts. What is closed is the
  rule: no credential ever appears here. Validation happens at the
  connection boundary; values live in the vault.
- `registeredAt` — stamped by the registry at build time, not persisted.

Authentication method is not a free-form field: it is implied by the
connector's behavior and documented by the provider's `metadata` (GitHub's
entry says "fine-grained PAT"). The only credential surface the platform
offers is the one-token vault path in §5; a provider needing something else
needs a design review before it needs code.

## 3. The connector contract

`Connector` (`src/integrations/connector.ts`) is two optional methods,
`discoverTools` and `executeTool`, present exactly when the corresponding
capability is declared. No provider is forced to implement a lifecycle
operation it does not have.

Everything a connector receives is a `ConnectorContext` — a whitelist, not a
convenience bag (ADR-049, pinned by test):

```
{ connectionId, credentialId (a reference, or null), metadata,
  resolveCredential, timeoutMs, signal }
```

Notably absent: no database handle, no logger, no services, no agent or
operator identity, no credential *value*. A connector asks
`resolveCredential(credentialId)` for the one value it may see, and the
resolver refuses any reference that does not belong to this connection —
cross-connection reads are a `RESOURCE_NOT_FOUND`, not a leak.

Outcomes are a closed type: `{ ok: true, value }` or
`{ ok: false, error: { kind, message } }` with exactly five kinds —
`timeout`, `unreachable`, `invalid_request`, `reauthorization_required`,
`provider_error`. The gateway, not the connector, enforces the timeout and
cancellation: `withCancellation` wraps every call, so a connector cannot
outlive its budget or ignore an abort. A connector that throws is normalized
to `provider_error` — it cannot crash the gateway or smuggle a stack trace to
a client.

Each connector owns its own HTTP client (the GitHub client in
`src/integrations/github/client.ts` is the model: fixed origin, closed header
set, redirects refused, injectable `fetch`/`sleep` for tests). The gateway
hands connectors no network policy because the connector's boundaries are its
own review obligation — see §13.

## 4. The integration connection model

A connection is a row (`integration_connections`): `id` (gateway-minted UUID),
`providerId`, operator `name`, `status`, `credentialId` (a vault reference or
`null` — never a value), non-secret `metadata`, `validatedAt` (when the
credential was last proved against the provider; honestly `null` until then),
timestamps. One provider, many connections: two GitHub orgs are two rows with
independent credentials and tool sets. Nothing is keyed by `providerId` alone.

Statuses (`connection.ts`, transitions declared as data so a test enumerates
every pair):

```
pending → connecting → connected
connecting → error | reauthorization_required | disconnected | disabled
connected → connecting (the Phase 15 refresh edge)
connected → disconnected | error | reauthorization_required | disabled
disconnected → connecting | disabled
error → connecting | disabled
reauthorization_required → connecting | disabled
disabled → connecting (the explicit operator re-enable)
```

Every non-terminal status has a `→ disabled` edge; `disabled` exits only
through the explicit operator `enable`. Only `connected` is dispatchable.
Illegal edges throw `RESOURCE_CONFLICT` — the state machine never "repairs"
input, because a machine that repairs input has a history that lies.

## 5. Credential vault integration

One vault (`src/integrations/vault.ts`, ADR-051). There is no second
encryption system and no plaintext fallback anywhere.

At rest, a credential is an envelope: a fresh random 32-byte data key per
record, that key wrapped by the master key (AES-256-GCM with an AAD binding
the format version and key id), the payload sealed under the data key. The
master key comes from `INTEGRATION_MASTER_KEY` (base64, 32 bytes) and exists
only in the environment — never in the database, `Config`, a log line, or an
API response. Key ids are digest-derived from the key material, so rotation
can tell which key sealed a record without trusting labels;
`INTEGRATION_MASTER_KEY_PREVIOUS` holds the old key during a manual rotation
— the only rotation there is, by design (§14).

Lifecycle behavior:

- **Create/replace** — `storeCredential` seals the value and swaps the
  reference in one transaction, deleting the previous envelope with it. A
  replaced credential cannot survive as a second readable secret, and the
  audit row names both references. A credential replacement during an
  in-flight tool call lets that call finish on the value it already resolved;
  the next call uses the new one.
- **Resolution** — server-side only, scoped to the requesting connection,
  audited on **every** resolution (`integration.credential.resolved` — the
  event exists precisely because a connector pulling a secret is the thing the
  trail must record). Resolution happens only inside connector execution,
  only after authorization, and the dispatch gate checks resolvability
  without opening the envelope.
- **Revocation/deletion** — deleting a connection cascades its credential
  rows (migration `0008`); a dangling reference fails closed at `dispatchable`.
- **Missing master key** — the gateway boots and serves MCP traffic, and the
  first seal/unseal attempt fails with a configuration error. Lazy
  fail-closed: integrations are optional, but nothing degrades to weaker
  storage when the key is absent. No reveal endpoint exists on any surface,
  so a credential is write-only for its whole life.

## 6. The unified execution pipeline

Both source types ride the same pipeline; only step 11's adapter differs.

1. MCP `tools/call` arrives at `/mcp`.
2. Bearer authentication (`mcpAuthenticate`) — one uniform 401 on any failure.
3. Session resolution and ownership checks (2025-era traffic).
4. `ToolRouter.call()` — **authorization first**: the policy decision happens
   before any connection read, reachability check, or schema compile, and a
   denial is byte-identical to an unknown name.
5. Catalog resolve: public name → tool, with `sourceType` and `sourceId`.
6. Source branch: `managed_integration` → the integration seam. No MCP
   fallback exists behind it.
7. `dispatchable(connectionId)` — re-reads the row: status must be
   `connected`, provider registered and declaring execution, credential
   reference (if any) present and the vault configured. Unseal happens later,
   never here.
8. Argument validation against the connector-reported input schema.
9. Connector context built (whitelist of §3), carrying the caller's
   cancellation signal.
10. `withCancellation` — the outer timeout budget.
11. The connector executes: resolves its credential through the scoped
    resolver, dials its own fixed-origin client, normalizes the response into
    a closed shape.
12. Outcome normalized: a `reauthorization_required` failure flips the
    connection status and withdraws its tools in the same instant; every other
    failure is one call's failure.
13. Activity row written — `connectionId`, never a backend id, and never
    both (the schema refuses such a row).
14. Metrics counted (§11).
15. MCP-compatible result returned; tool-level `isError` passes through as a
    routed failure, not a protocol error.

Authorization (step 4) precedes credential resolution (step 11) by
construction, and an unauthorized caller never reaches a connector — pinned
by tests at the service level *and* through the production wiring.

## 7. Tool catalog

Catalog identity is the pair `sourceType + sourceId` plus the original name;
the public name is deterministic: `<connectionId>__<tool>` for managed tools
(the same path MCP tools use), so a stored client configuration never changes
meaning and two connections to the same provider can never shadow each other.
Snapshots are keyed `"<sourceType>:<sourceId>"` — a freak duplicate id cannot
let one source overwrite another. A name claimed by more than one tool
withholds **both** claimants (fail closed; discovery order decides nothing).
The catalog is an in-memory derived view (ADR-038): it holds nothing that a
reconnect cannot rebuild, and it is not persisted — a stored catalog would be
a claim about a process that no longer exists.

Refresh consistency (Phase 15): `enable` on a `connected` connection
re-discovers **in place**. During the flight the previous tool set stays
listed but calls fail closed (`connecting` is not dispatchable). A successful
flight replaces the snapshot wholesale and reports the diff
(`added`/`removed`/`changed`, keyed on original names). A failed flight
withdraws the snapshot and lands the row in `error` or
`reauthorization_required` — the documented policy, matching the backend-side
precedent: an unusable source is unlisted, not listed-and-failing. Nothing
downstream ever sees a half-updated source; snapshots swap atomically.

## 8. Connection lifecycle

Every operation is one service method behind one API route, all operator
session + CSRF protected, all audited:

| Operation | Route | Status effect |
| --- | --- | --- |
| Create | `POST /api/v1/integrations/connections` | `pending` (exists, verifies nothing) |
| Store/replace credential | `POST …/{id}/credential` | none (reference swap) |
| Test | `POST …/{id}/test` | none — the handshake's answer is data |
| Connect / enable / **refresh** | `POST …/{id}/enable` | `connecting → connected` on success; `error`/`reauthorization_required` on failure |
| Disable | `POST …/{id}/disable` | `disabled`, tools withdrawn instantly |
| Disconnect | `POST …/{id}/disconnect` | `disconnected`, tools withdrawn instantly |
| Delete | `DELETE …/{id}` | gone: tools, row, credential cascade |
| List tools | `GET …/{id}/tools` | read-only |

Concurrency (Phase 15, ADR-054) — discovery is a network flight, and the rule
is ownership, not locking:

- A **second connect while one is in flight** is `409 RESOURCE_CONFLICT`; one
  attempt at a time, enforced by the state machine itself.
- A **delete, disconnect, or disable during the flight wins**. The connect
  continuation re-reads the row after discovery: gone → `404` with nothing
  published; moved on → `409`, and the racing action's outcome stands. A
  connect can never resurrect a connection another action took down.
- A **failed refresh** withdraws tools and lands `error`/`reauthorization_required`
  (§7); a successful one replaces them. Either way the row is consistent.
- **Disable during an in-flight tool call**: the call finishes on the value
  it already resolved; the *next* call fails closed. Execution is
  request-scoped, and revoking a live request's credential mid-flight is
  cancellation, not disablement.

All four behaviors are pinned by `tests/integrations-concurrency.test.ts`
against the production service with a gated fixture connector.

## 9. Authorization model

Unchanged from the MCP side, deliberately: policies are tool-scoped rules on
public names (exact or `*`), plus `backend`-scoped rules for MCP tools only —
a `backend` rule naming a connection id is rejected at creation. Default is
deny; deny overrides allow; a connection's tools are invisible to an agent
without a grant, and a denied call is indistinguishable from an unknown one
(byte-identical code and message). A tool entering or leaving the catalog
changes nothing about who may call it: grants are names, and names are
stable (§7).

## 10. Error handling

Connector errors normalize onto the existing public codes — a client cannot
tell a managed failure from a backend failure it has already seen:

| Connector kind | Public code | Meaning |
| --- | --- | --- |
| `timeout` | `BACKEND_TIMEOUT` | the budget expired |
| `unreachable` | `BACKEND_UNAVAILABLE` | the provider could not be reached |
| `invalid_request` | `VALIDATION_ERROR` | arguments or permission refused |
| `reauthorization_required` | `TOOL_UNAVAILABLE` | the stored credential was refused; the row flips, tools withdraw |
| `provider_error` | `BACKEND_CONNECTION_ERROR` | the provider failed; one call's failure |

The connector's message rides in `details` for operators and logs, never in
the client-facing message; provider prose is untrusted text and is not copied
through. A connector that throws is `provider_error`; one that returns
malformed output is a shape failure, also `provider_error`. No failure path
crashes the gateway, and no failure path quotes a credential.

## 11. Observability

**Audit** (operator actions, closed vocabulary, connection-targeted):
`integration.connection.created` / `.updated` (including every status change,
with `result: 'failure'` for a failed connect/refresh attempt) / `.deleted`;
`integration.credential.sealed` / `.replaced` / `.resolved` (reference ids
only — the audit log cannot quote a value even by accident).

**Activity**: one `tools.call` row per call, carrying the `connectionId`, the
public tool name, outcome, duration, and request correlation — the per-tool
and per-connection history that metrics deliberately do not keep.

**Metrics** (bounded labels only): `umg_tool_calls_total` splits by `outcome`
and `source_type` (the closed two-value enum of §1) — a managed call is
counted apart from a backend call at zero cardinality cost. Per-*provider*
figures are the activity/audit trail's job: a connection row names its
provider, and correlating by request id is exactly what that trail is for.
Denials are counted before the catalog read — no extra work for a denied
caller — so they carry `outcome` only, by design. Tool names, arguments,
credential values, and provider response bodies are never labels, never log
fields, and never audit metadata.

## 12. How a future provider should be added

1. Write an ADR first (what the provider is, which capabilities it declares,
   what its credential is, why read-only first). `docs/DECISIONS.md` carries
   ADR-053 as the model.
2. Add the definition + connector import to `REGISTRATIONS`
   (`src/integrations/registry.ts`). One line per file touched by hand.
3. Implement the connector in `src/integrations/<provider>/`, modeled on
   `github/`: a client module owning the fixed origin and closed headers, a
   tools module of pure schemas and normalizers, a connector module composing
   them. Injectable `fetch`/`sleep`; no test dials the network.
4. Declare the minimum capability set — `discovery` alone if the provider
   should be list-only to start.
5. Register tools read-only; annotations carry `readOnlyHint`. Write tools,
   webhooks, OAuth, sync workers are out of scope until a later phase says
   otherwise.
6. Add suites mirroring `tests/integrations-github.test.ts`: client boundary,
   normalizer honesty, execution through the production service. Extend
   `tests/integrations.test.ts`'s "ships exactly the real providers" test so
   the registry's production contents stay pinned.
7. Update this document, `SECURITY.md` §"managed providers", and the
   dashboard's provider list comes free (it reads the registry).

The registry doubling is a security event, not just a feature: the provider's
outbound behavior is new attack surface, and the review in §13 is the gate.

## 13. Security requirements for future providers

Non-negotiable, enforced by review because the contract cannot force them:

- **Fixed origin, HTTPS, no operator-suppliable URL.** The client's origin is
  a constant in connector code. Nothing an agent or operator types can change
  it, and redirects are refused outright (`redirect: 'error'`) so no hop can
  carry the token to another host.
- **Token in a header only.** Never a URL, query string, error message, log
  line, metric label, or response body.
- **A closed output shape.** Normalize untrusted provider JSON through
  validators; a client never sees a raw provider response, which is where
  third-party payloads turn into injection vectors.
- **The connector sees only its context (§3).** No store, no logger, no other
  connection's credential. If a connector needs something outside the
  whitelist, that is a design review, not a context extension.
- **A closed error vocabulary (§10).** Provider prose is untrusted text; the
  connector's five kinds are all a client may learn.
- **The timeout and cancellation are the gateway's (§3)**, so a provider
  cannot pin a tool call open.
- **Read-only first**, and no new provider ships without explicit user
  approval — the same gate that admitted GitHub.

## 14. Current limitations

- **One provider.** GitHub is the only registered provider, with six
  read-only tools. No OAuth, no GitHub Apps, no webhooks, no write
  operations, no synchronization workers — unsupported, not missing.
- **Manual key rotation.** `INTEGRATION_MASTER_KEY_PREVIOUS` exists so an
  operator can rotate by hand; there is no automatic rotation and no
  key-management service. Backup implication: without the master key, stored
  credentials are unrecoverable ciphertext — by design.
- **The connections list is unpaginated.** Backends paginate; connections do
  not, because an operator's connection count is small and changing the
  response shape would break the API contract for no present need.
- **Denial metrics are not source-typed** (§11) — deliberate, so a denied
  caller costs no extra read.
- **No per-provider metric label.** The activity/audit trail is the
  per-provider and per-connection record; a `provider` label would add
  registry coupling to the metrics path for numbers the trail already keeps.
- **`connect()` is synchronous from the operator's chair.** A slow provider
  slows the enable action, never the MCP request path (ADR-049's accepted
  limit, unchanged).

## Provider implementation checklist

Before a new provider's pull request is reviewable:

- [ ] An ADR exists, naming capabilities, credential shape, and why
      read-only first.
- [ ] The definition validates; the registry test pinning production
      registrations is updated, not bypassed.
- [ ] The connector implements exactly the declared capabilities and nothing
      else.
- [ ] The client has a fixed HTTPS origin, a closed header set, and
      `redirect: 'error'`; the token never leaves the `Authorization`
      header's value.
- [ ] Every output is a closed, validator-normalized shape; no raw provider
      JSON crosses the connector boundary.
- [ ] Every test runs against an injected `fetch`; the suite makes zero
      outbound calls. No real credential, PAT, or account is ever used in
      development or CI.
- [ ] Timeout/cancellation behavior is inherited from `withCancellation`,
      not reimplemented.
- [ ] This document, `SECURITY.md`, and `docs/ROADMAP.md` are updated.

This checklist is a floor, not a gate bypass: it does not replace the
security review, and it does not constitute user approval to register the
provider in production. Both are separate, explicit, and required.
