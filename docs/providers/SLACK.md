# Slack Provider (ADR-056)

Slack is the gateway's third code-registered managed provider (Phase 17).
It exists to prove the Phase 12–16 platform with a provider whose failure
model is unlike either predecessor — **HTTP 200 answers that are
application failures** — behind a manually supplied bot token, with **zero
provider-specific logic anywhere outside `src/integrations/slack/`**: the
registry, the vault, the lifecycle, the catalog, the authorization model,
the execution pipeline, the operator API, and the audit/metrics paths are
reused unchanged. Everything in this document is also the honest ceiling:
the gateway implements exactly what is written here and nothing more.

## 1. Role and scope

Read-only conversations: channels, private groups, DMs, and multi-party
DMs; their message history; their threads; and the people in them. No tool
in this provider can write, and no code path exists that could — there is
no write endpoint in the client, no write tool in the catalog, and the MCP
annotations say `readOnlyHint: true`. The provider is registered as code
(`slackRegistration` in `src/integrations/registry.ts`), never as
configuration: no dynamic loading, no marketplace entry, nothing an operator
can widen at runtime.

## 2. Credential model and least privilege

The credential is a **Bot User OAuth Token** — a static bearer token whose
string form starts with `xoxb-`. There is **no OAuth flow in the gateway**:
an operator creates a Slack app at
[api.slack.com/apps](https://api.slack.com/apps), adds the bot user, requests
the scopes below on the **OAuth & Permissions** page, installs the app into
the workspace, and pastes the token through the dashboard's write-only
credential field. Nothing is ever redirected, refreshed, or renewed: expiry
and revocation surface as `reauthorization_required` (Phase 15 policy), and
the operator's fix is to paste a new token.

Least privilege is exactly what the five tools need — nine read scopes,
nothing else:

`channels:read`, `channels:history`, `groups:read`, `groups:history`,
`im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`.

The gateway requests no write scope (`chat:write`), no management scope
(`channels:manage`, `admin.*`), no commands scope, and no email scope
(`users:read.email` — which is why `get_user_info` never returns an address).
The connector refuses a non-bot token before any request leaves the
gateway: a user (`xoxp-`) or app (`xapp-`) token would pass `auth.test` yet
miss the scopes every tool needs, so the prefix check turns a silently
half-broken connection into an honest configuration answer.

The token is stored through the same write-only vault path as every
provider credential (ADR-051): sealed in an envelope, never readable back,
the row stores only the vault reference, and a replacement deletes the
previous envelope in the same transaction.

## 3. The membership model — what a bot can see

Slack's security model is scopes **and** membership. The read scopes permit
the calls; membership decides the answers:

- **Public channels:** visible to the bot by scope alone.
- **Private channels:** the bot must be **invited**, by any member, from
  the channel's details → Add apps. Until it is, `list_conversations` does
  not show the channel and per-channel calls answer `channel_not_found` /
  `not_in_channel`.
- **DMs and groups:** a bot is in a DM only because a person opened one with
  it, and joins a group DM only from inside Slack itself. The gateway can
  invite nothing — inviting would be a write.

`validatedAt` on the connection row says when the token was *proved*,
never what it can *see*: the gateway does not fabricate a membership list.
The dashboard's credential panel states the invite step, because an
otherwise-valid token with no private memberships fails every private
request and an operator who does not know why will blame the token.

## 4. The two-envelope rule — 200 is not success

Slack's signature semantic: **application failures arrive as HTTP 200 with
`{ok: false, error: "<code>"}`**. The client therefore reads both halves of
every answer — the transport status **and** the app-level `ok` — and a 200
is not a success until the body says so. Neither half alone decides
anything: a 200 with `ok: false` is the failure it says it is, and a
non-200 with a JSON body is still a transport failure. The stable `error`
code is a closed vocabulary, not prose, so it is quoted inside the
gateway's own message; nothing else from a failure body (no `detail`, no
`needed` scope hints, no warnings) ever crosses the connector boundary.

## 5. API transport boundaries

- **Origin:** the constant `https://slack.com/api` in connector code. No
  route, form, tool argument, or response field can change it; redirects
  are refused outright (`redirect: 'error'`), so no hop can carry the token
  anywhere else. HTTPS via the platform `fetch` with no custom agent — the
  standard TLS verification applies.
- **Headers:** `Authorization: Bearer <token>`, `Accept: application/json`,
  and `Content-Type: application/json` on the one POST. Slack requires no
  version header and no `User-Agent`, and neither is sent. The token never
  rides a URL or a query string — GET arguments are request parameters, and
  the credential is always the header — and this module has no logger:
  there is nothing to accidentally log the token into.
- **Method mix:** `auth.test` is a POST with an empty JSON body; every
  other call is a GET with query parameters.
- **Timeouts and cancellation:** owned by the gateway (`withCancellation`
  wraps both connector methods); the client only forwards the signal.

## 6. The five tools

| Tool | Endpoint | Returns |
| --- | --- | --- |
| `list_conversations` | `GET conversations.list` | conversations the bot can see, one page at a time |
| `get_conversation_info` | `GET conversations.info` | one conversation: kind, name, topic, purpose, member count |
| `get_conversation_history` | `GET conversations.history` | a conversation's messages, newest first, one page at a time |
| `get_thread_replies` | `GET conversations.replies` | one thread's replies, oldest first, one page at a time |
| `get_user_info` | `GET users.info` | one user: names, bot flag — never an email |

`get_conversation_history` surfaces `replyCount` and `latestReply` on
thread parents, so an agent can chain: `list_conversations` →
`get_conversation_history` → `get_thread_replies`. Fetching a thread is the
caller's explicit, bounded decision — the gateway never auto-follows a
thread.

## 7. Input validation

Advertised JSON Schemas are strict (`additionalProperties: false`
everywhere) and the router enforces them before the connector runs; the
connector re-checks defensively for any caller that reaches it another way.

- **Conversation ids:** `C…` (channel), `G…` (private group or mpim), `D…`
  (DM), followed by id characters. A pattern refuses free text, so no
  argument can steer a request.
- **Timestamps are string ids:** a `ts` value is `epoch.microseconds` —
  exactly the form a previous response reported. The schema accepts only
  that pattern and the connector re-checks it; a number is refused, because
  parsing one would round away the microseconds that make a `ts` an
  identity.
- **User ids:** `U…` or `W…`, same discipline.
- **Pagination:** `limit` is an integer 1–200 — a deliberate gateway bound
  below Slack's documented maxima (999 for `conversations.list`, 1000 for
  history/replies) to keep pages modest.
- **Cursors:** opaque strings, bounds-checked (1–300) and passed back
  verbatim; the gateway never inspects or synthesizes their format.
- **Conversation kinds:** `types` is a closed enum array
  (`public_channel`, `private_channel`, `mpim`, `im`, unique, ≤4). Omitted,
  Slack's documented default applies: public channels only.

## 8. Output normalization — untrusted content handling

Slack content is **data, never instructions**: nothing in a message is
parsed as a direction to the gateway, an agent, or a policy, and no URL
found in content is ever fetched. File references inside messages are text
at most. Normalization follows the official client guidance:

- **Unknown response fields are ignored** — extraction is lenient, never
  reject-on-surprise. Reactions and reply-user lists are simply not read.
- **Unknown and future message subtypes are recorded, not dropped**: the
  `subtype` string always survives into the output.
- **`ts` values are carried as exact strings, never float-parsed** — a
  Slack timestamp is an id (`epoch.microseconds`), and its fractional
  digits are identity: the thread parent's `ts` is the address of the
  thread. The one deliberate conversion goes the other way: a
  conversation's `created` epoch-seconds becomes readable ISO 8601, because
  it is metadata, not an id.
- **A bot-authored message reports `user: null` and its `botId`** — both
  facts, neither guessed.
- The closed output shapes are enforced with zod `.strict()` schemas, so a
  future edit that renames a field is a dropped entry, never a silent shape
  change on the wire. A client never sees raw Slack JSON.

## 9. Pagination

Cursor-based and caller-driven: every list tool returns **one page per
call** — `items`, `hasMore`, `nextCursor`. `conversations.list` speaks
`channels` + `response_metadata.next_cursor` (and answers an **empty
string** cursor when exhausted, which reads as "no cursor");
`conversations.history` and `conversations.replies` add `has_more`. Both
dialects reduce to one rule — a present cursor means more — so `hasMore`
is the truncation indication for all three. Continuation is the caller's
explicit `cursor`. The gateway never loops, never accumulates results, and
never fetches beyond the one page it was asked for, so there is no
unbounded traversal, no total-item cap to enforce, and no cursor-injection
surface: a cursor is validated for bounds and echoed verbatim.

## 10. Rate limits and retries

Slack rate-limits **per method, per workspace, per app** in documented
tiers: Tier 2 (`conversations.list`, 20+/min), Tier 3 (`conversations.info`
and both history/replies reads, 50+/min), Tier 4 (`users.info`, 100+/min),
and a special budget for `auth.test`, which the gateway calls only as the
connect-time handshake — once per connect, never per tool call. An
over-limit call returns `429` with `Retry-After`. The gateway's policy is
the same bounded one as GitHub and Notion: **at most one retry, only when
`Retry-After ≤ 5 s`**. A longer wait fails fast with the reset fact in the
connector's own vocabulary. The budget is per-request, not per-process:
there is no token bucket in the gateway.

## 11. Error mapping

Slack's failure body is `{ok: false, error: "<code>"}` — the code is a
closed vocabulary, quoted in the gateway's message; any other body field is
untrusted text and never crosses the connector boundary.

| Slack answer | Connector kind | Meaning for the operator |
| --- | --- | --- |
| `ok:false` `not_authed` / `invalid_auth` / `account_inactive` / `token_expired` / `token_revoked` / `missing_scope` | `reauthorization_required` | the token is dead or short a scope — store a new one |
| `ok:false` `channel_not_found` / `user_not_found` / `not_in_channel` / `invalid_arguments` / `invalid_cursor` / `invalid_ts` | `invalid_request` | this call, not the connection: wrong or invisible id |
| `ok:false` `ratelimited` | `provider_error` | rate limiting (§10); the transport-level 429 carries the bounded retry |
| `ok:false` `internal_error` / `fatal_error` / any unknown future code | `provider_error` | Slack's problem, retry later |
| `ok:false` with no code at all | `provider_error` | a failure with no vocabulary is still not a success |
| `401` | `reauthorization_required` | transport-level rejection of the token |
| `400` / `403` / `404` | `invalid_request` | transport-level refusal of the request |
| `429` | one bounded retry, then `provider_error` with the reset fact | see §10 |
| `5xx` | `provider_error` | Slack's problem, retry later |
| non-JSON body on a 200 | `provider_error` | the answer was not an envelope anyone could read |
| network failure | `unreachable` | the origin could not be reached |
| timeout / cancellation | `timeout` | the gateway's own budget closed the call |

## 12. Lifecycle and the verification handshake — an honest limitation

`connect`/`enable` runs the provider handshake: one `POST auth.test` — the
one Slack method that needs no scope — which proves the token, the
workspace, and the bot's identity. This is what `validatedAt` records.

**Slack offers no endpoint that lists a token's scopes.** They are
configured on the app's OAuth & Permissions page, and the API enforces them
per request. So the handshake proves *authenticity*, not *capability
breadth*: a token missing `channels:history` connects cleanly and then
fails closed on every history tool with `missing_scope` →
`reauthorization_required`. The dashboard and this document state the
requirement instead of pretending to verify it. The identity `auth.test`
returns is used only for the `ok` — the workspace and bot user it names are
deliberately never stored, logged, or exposed as a label. The lifecycle
itself is the generic one: `pending → connecting → connected`, `enable` as
the refresh, failed discovery landing in `reauthorization_required` with
tools withdrawn (Phase 15 policy), the same concurrency rules, the same
disconnect/reconnect re-proof.

## 13. Workspace independence

Two Slack connections in one gateway are two independent rows with two
independent sealed tokens — never one identity. A workspace id is not the
connection's identity: the catalog namespaces every tool by connection id
(`<connection_id>__list_conversations`), so two workspaces publish ten
distinct tools with zero collisions, and the router-seam test proves each
call carries its own connection's token. Nothing about a connection is
team-scoped, cached, or shared: the connector is stateless, a client is
built per operation, and the handshake's workspace answer is discarded.
Multiple workspaces are multiple pastes, which is the whole configuration
story.

## 14. Observability

Slack adds no metric, no audit action, and no label. Calls ride the
existing `umg_tool_calls_total` counter with its closed `source_type`
label; per-provider attribution stays where it already is — activity and
audit rows name the connection, the connection names its provider. Labels
stay bounded: no workspace names, channel or user ids, message text, or
provider error codes ever become labels or metadata.

## 15. Operator API and dashboard

There is **no Slack-specific management API**: the provider appears in the
generic `/api/v1/integrations/providers` listing and every lifecycle action
(create, store-credential, test, enable, disable, disconnect, delete, tools)
runs through the same contracts as GitHub's and Notion's. On the dashboard,
the integrations list and detail pages are the generic screens; the one
provider-specific sentence is the credential panel's Slack hint — the
`xoxb-` shape, the nine read scopes, the `api.slack.com/apps` link, and the
private-channel invite explanation of §3. The token field is write-only
and cleared after submit, identical to the other providers.

## 16. Testing discipline

Every HTTP exchange in the repository is a fixture: the client takes an
injectable `fetch`, the connector is built from it, and **no test dials
`slack.com`**. `tests/integrations-slack.test.ts` pins: the client boundary
(origin, pinned headers, redirect refusal, **the 200 + `ok:false` map with
every documented code and an unknown one**, the status map, the bounded 429
retry, unreachable, non-JSON), the five tools' schemas and normalizers
(all three id kinds, the ts-as-string rule, bounds, unknown subtypes,
cursor pass-back, the email that stays unread), the connector's defensive
refusals (including the non-bot token), the full lifecycle through the
production service and catalog, and — through the production router — two
Slack connections with two agents plus Notion and GitHub connections
publishing alongside, each call proven to carry its own connection's sealed
token. The registry-pin and API tests state the three-provider truth.

**Live Slack workspace validation: NOT PERFORMED — requires separate user
approval.** The first live call happens when an operator stores a real bot
token and runs Test or Connect.

## 17. Limitations, non-goals, and references

**Not built, deliberately:** `search.messages` — it is a **user-token-only**
method (`search:read` is a user scope, and bot tokens are not supported),
so the gateway does not implement it and does not approximate it with
anything synthetic; retrieval stays listing- and history-shaped. Also not
built: OAuth or app-installation flows; any write tool (posting, reacting,
inviting); Socket Mode (the gateway's only Slack surface is outbound
HTTPS); webhooks (which would be the gateway's first inbound provider
surface); file downloads or uploads (file references are text at most);
DM-listing guarantees beyond what membership returns; a per-process rate
budget. Each is a separate decision with its own blast radius. Threads are
fetched explicitly by parent `ts` — the gateway never walks a channel
assembling threads on its own.

**References** (official, current):
[Tokens](https://docs.slack.dev/authentication/tokens) ·
[Rate limits](https://docs.slack.dev/apis/web-api/rate-limits) ·
[Pagination](https://docs.slack.dev/apis/web-api/pagination) ·
[auth.test](https://docs.slack.dev/reference/methods/auth.test) ·
[conversations.list](https://docs.slack.dev/reference/methods/conversations.list) ·
[conversations.info](https://docs.slack.dev/reference/methods/conversations.info) ·
[conversations.history](https://docs.slack.dev/reference/methods/conversations.history) ·
[conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies) ·
[users.info](https://docs.slack.dev/reference/methods/users.info) ·
[search.messages (user-token constraint)](https://docs.slack.dev/reference/methods/search.messages)
