# Notion Provider (ADR-055)

Notion is the gateway's second code-registered managed provider (Phase 16).
It exists to prove the Phase 12–15 platform with a provider that is
structurally different from GitHub — a workspace-scoped, cursor-paginated,
block-tree document API behind a static internal token — with **zero
provider-specific logic anywhere outside `apps/gateway/src/integrations/notion/`**: the
registry, the vault, the lifecycle, the catalog, the authorization model, the
execution pipeline, the operator API, and the audit/metrics paths are reused
unchanged. Everything in this document is also the honest ceiling: the
gateway implements exactly what is written here and nothing more.

## 1. Role and scope

Read-only workspace content: search, pages, content blocks, databases, and
data-source rows. No tool in this provider can write, and no code path exists
that could — there is no write endpoint in the client, no write tool in the
catalog, and the MCP annotations say `readOnlyHint: true`. The provider is
registered as code (`notionRegistration` in `apps/gateway/src/integrations/registry.ts`),
never as configuration: no dynamic loading, no marketplace entry, nothing an
operator can widen at runtime.

## 2. Credential model and least privilege

The credential is an **internal connection API token** — a static bearer
token, no OAuth flow. A Workspace Owner creates the connection in the
[Notion developer portal](https://app.notion.com/developers/connections)
(Developer connections tab → New connection → Authentication method: API
token) and copies the token from the connection's **Configuration** tab.

Least privilege is a single checkbox: **Read content** only. The gateway
requests no update-content, insert-content, comment, or user-information
capability, and registers no tool that could exercise one. The token is
stored through the same write-only vault path as every provider credential
(ADR-051): it arrives over the operator's authenticated session, is sealed
in an envelope, and can never be read back — the row stores only the vault
reference. A replacement deletes the previous envelope in the same
transaction.

## 3. The sharing model — what a connection can see

A Notion connection sees **nothing by default**. Content must be explicitly
shared with it, in either of two ways, and access is inherited by children:

- the developer portal's **Content access** tab (Edit access → pick pages
  and databases), or
- a page's `•••` → **Connections → Add connection**.

This is the security model, not an inconvenience: the token's reach is
exactly the set of shared pages and their descendants. The dashboard's
credential panel states this on the Notion connection page, because an
otherwise-valid token with nothing shared fails every tool with `404`, and an
operator who does not know why will blame the token. `validatedAt` on the
connection row says when the token was *proved*, never what it can *see* —
the gateway does not fabricate a scope list.

## 4. API version and transport boundaries

- **Origin:** the constant `https://api.notion.com` in connector code. No
  route, form, tool argument, or response field can change it; redirects are
  refused outright (`redirect: 'error'`), so no hop can carry the token
  anywhere else. HTTPS via the platform `fetch` with no custom agent — the
  standard TLS verification applies.
- **Version:** every request carries `Notion-Version: 2026-03-11` — the
  current official API version, required by every endpoint. The version
  lives in exactly one constant in `apps/gateway/src/integrations/notion/client.ts`.
- **Headers:** `Authorization: Bearer <token>`, `Notion-Version`,
  `Accept: application/json`, and `Content-Type: application/json` on POSTs.
  The token never rides a URL or a query string, and this module has no
  logger — there is nothing to accidentally log the token into.
- **Timeouts and cancellation:** owned by the gateway (`withCancellation`
  wraps both connector methods); the client only forwards the signal.

## 5. The data-source model and the six tools

Notion split databases from **data sources** in the `2025-09-03` API: a
database is a container whose response lists its queryable data sources
(`data_sources: [{ id, name }]`), and rows are queried per data source. The
six mandated tools map one-to-one onto the current read endpoints — no
alternative shapes were needed:

| Tool | Endpoint | Returns |
| --- | --- | --- |
| `search` | `POST /v1/search` | pages and data sources shared with the connection |
| `get_page` | `GET /v1/pages/{page_id}` | one page's metadata and rendered properties |
| `get_block` | `GET /v1/blocks/{block_id}` | one content block |
| `list_block_children` | `GET /v1/blocks/{block_id}/children` | a page's or block's direct children, one page at a time |
| `get_database` | `GET /v1/databases/{database_id}` | database metadata including its `data_sources` |
| `query_data_source` | `POST /v1/data_sources/{data_source_id}/query` | rows (pages) with rendered properties |

`get_database` deliberately surfaces the `dataSources` array so an agent can
chain: `search` → `get_database` → `query_data_source`. A page's content is
read through `list_block_children` with the page id (a page is its top-level
block); nested content is the caller's explicit, bounded decision — the
gateway never auto-fetches children.

## 6. Input validation

Advertised JSON Schemas are strict (`additionalProperties: false` everywhere)
and the router enforces them before the connector runs; the connector
re-checks defensively for any caller that reaches it another way.

- **Ids:** a UUID, dashed or undashed (both are documented); a pattern
  refuses free text, so no argument can steer a URL.
- **Pagination:** `page_size` is an integer 1–100 (Notion's own maximum). No
  default is promised — when omitted, Notion's applies.
- **Cursors:** opaque strings, bounds-checked (1–300) and passed back
  verbatim; the gateway never inspects or synthesizes their format.
- **`query_data_source` grammar:** the `filter` object is bounded in size
  (≤50 keys) and the `sorts` array in length (≤10, each an exact property-
  direction or timestamp-direction object); their internals stay Notion's to
  validate — the gateway bounds, it does not re-model.

## 7. Output normalization — untrusted content handling

Notion content is **data, never instructions**: nothing in a page, block, or
property is parsed as a direction to the gateway, an agent, or a policy, and
no URL found in content is ever fetched. File/media names are rendered as
text at most. Normalization follows the official client guidance:

- **Unknown response fields are ignored** — extraction is lenient, never
  reject-on-surprise.
- **Unknown and future block types are recorded, not dropped**: the block's
  `type` always survives, with `text: null` as the honest "present but not
  rendered". Notion's own `unsupported` block records the underlying
  `block_type` as `[unsupported: <type>]`.
- **Properties render as plain text best-effort**, with the property's
  `type` always recorded beside a `null` text — a `null` is a statement, not
  a silent drop.
- The closed output shapes are enforced with zod `.strict()` schemas, so a
  future edit that renames a field is a dropped entry, never a silent shape
  change on the wire. A client never sees raw Notion JSON.

## 8. Pagination

Cursor-based and caller-driven: every list tool returns **one page per
call** — `items`, `hasMore`, `nextCursor`. Continuation is the caller's
explicit `start_cursor`. The gateway never loops, never accumulates results,
and never fetches beyond the one page it was asked for, so there is no
unbounded traversal, no total-item cap to enforce, and no cursor-injection
surface: a cursor is validated for bounds and echoed verbatim.

## 9. Rate limits and retries

Notion limits requests per connection (180/min on most plans, 600 on
Business/Enterprise) and additionally per workspace; an over-limit call
returns `429` with `Retry-After` set to the window reset. The gateway's
policy is the same bounded one as GitHub: **at most one retry, only when
`Retry-After ≤ 5 s`**. A longer wait fails fast with the reset fact in the
connector's own vocabulary, because sleeping through the caller's budget is
worse than an honest refusal. The budget is per-request, not per-process:
there is no token bucket in the gateway.

## 10. Error mapping

Notion's error body (`{ object: 'error', code, message, status }`) is
untrusted text and its `message` never crosses the connector boundary — the
operator sees the gateway's vocabulary, not injected provider prose.

| Notion answer | Connector kind | Meaning for the operator |
| --- | --- | --- |
| `401 unauthorized` | `reauthorization_required` | the token is gone or rotated — store a new one |
| `400` (`validation_error`, `invalid_request`, `missing_version`, …) | `invalid_request` | the request was wrong; not a credential problem |
| `403 restricted_resource` | `invalid_request` | a capability is missing in the portal configuration, or the content is restricted |
| `404 object_not_found` | `invalid_request` | absent **or not shared with this connection** — Notion does not distinguish, and the message does not pretend to |
| `406` / `409` | `invalid_request` | row-limit and conflict answers |
| `429 rate_limited` | one bounded retry, then `provider_error` with the reset fact | see §9 |
| `5xx` / `529` / non-JSON body | `provider_error` | Notion's problem, retry later |
| network failure | `unreachable` | the origin could not be reached |
| timeout / cancellation | `timeout` | the gateway's own budget closed the call |

## 11. Lifecycle and the verification handshake — an honest limitation

`connect`/`enable` runs the provider handshake: one authenticated
`GET /v1/users/me`, the **get-self** endpoint, which succeeds for any
connection with a content capability. This proves the token is real and
live — which is what `validatedAt` records.

**Notion offers no endpoint that lists a token's capabilities.** They are
configured in the developer portal, and the API enforces them per request.
So the handshake proves *authenticity*, not *capability breadth*: a token
created without Read content will connect cleanly and then fail closed on
every tool with `403` → `invalid_request`. The dashboard and this document
state the requirement instead of pretending to verify it. The bot user's
response is used only for the 200 — the workspace it names is deliberately
never stored, logged, or exposed as a label. The lifecycle itself is the
generic one: `pending → connecting → connected`, `enable` as the refresh,
failed discovery landing in `reauthorization_required` with tools withdrawn
(Phase 15 policy), the same concurrency rules, the same disconnect/reconnect
re-proof.

## 12. Observability

Notion adds no metric, no audit action, and no label. Calls ride the existing
`umg_tool_calls_total` counter with its closed `source_type` label;
per-provider attribution stays where it already is — activity and audit rows
name the connection, the connection names its provider. Labels stay bounded:
no workspace names, page or database ids, user emails, or provider error text
ever become labels or metadata.

## 13. Operator API and dashboard

There is **no Notion-specific management API**: the provider appears in the
generic `/api/v1/integrations/providers` listing and every lifecycle action
(create, store-credential, test, enable, disable, disconnect, delete, tools)
runs through the same contracts as GitHub's. On the dashboard, the
integrations list and detail pages are the generic screens; the one
provider-specific sentence is the credential panel's Notion hint — the
read-content capability, the developer-portal link, and the sharing
explanation of §3. The token field is write-only and cleared after submit,
identical to the GitHub flow.

## 14. Testing discipline

Every HTTP exchange in the repository is a fixture: the client takes an
injectable `fetch`, the connector is built from it, and **no test dials
`api.notion.com`**. `apps/gateway/tests/integrations-notion.test.ts` pins: the client
boundary (origin, pinned headers, redirect refusal, the status map, the
bounded 429 retry, unreachable, non-JSON), the six tools' schemas and
normalizers (ids both shapes, bounds, unicode, unknown/future/unsupported
blocks, cursor pass-back), the connector's defensive refusals, the full
lifecycle through the production service and catalog, and — through the
production router — two Notion connections with two agents plus a GitHub
connection publishing alongside, each call proven to carry its own
connection's sealed token. The registry-pin and API tests state the
two-provider truth.

**Live Notion account validation: NOT PERFORMED — requires separate user
approval.** The first live call happens when an operator stores a real
internal-connection token and runs Test or Connect.

## 15. Limitations, non-goals, and references

**Not built, deliberately:** OAuth or public connections; any write tool;
webhooks (which would be the gateway's first inbound provider surface);
arbitrary URL fetching from content; a capability-listing handshake (§11);
a per-process rate budget; personal access tokens (the internal connection
is the team-owned shape; a PAT acts as its creator instead of a bot, a
different trust model). Each is a separate decision with its own blast
radius. Blocks with `hasChildren` are listed, not auto-recursed — the caller
pays for depth explicitly.

**References** (official, current):
[Versioning](https://developers.notion.com/reference/versioning) ·
[Internal connections guide](https://developers.notion.com/guides/connections-and-tokens/internal-connections) ·
[Connection capabilities](https://developers.notion.com/reference/capabilities) ·
[Retrieve your token's bot user](https://developers.notion.com/reference/get-self) ·
[Search](https://developers.notion.com/reference/post-search) ·
[Retrieve a page](https://developers.notion.com/reference/retrieve-a-page) ·
[Retrieve a block](https://developers.notion.com/reference/retrieve-a-block) ·
[Retrieve block children](https://developers.notion.com/reference/get-block-children) ·
[Retrieve a database](https://developers.notion.com/reference/retrieve-database) ·
[Query a data source](https://developers.notion.com/reference/query-a-data-source) ·
[Status codes](https://developers.notion.com/reference/status-codes) ·
[Request limits](https://developers.notion.com/reference/request-limits) ·
[Pagination](https://developers.notion.com/reference/pagination)
