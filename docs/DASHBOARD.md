# Dashboard Product and UI Specification

## 1. Design system decision

**Use Astryx directly:** https://astryx.atmeta.com/

Astryx is the chosen UI component library and design system for the dashboard. This is not an instruction to imitate Astryx with another component library.

### Mandatory rules
- Use Astryx components, tokens, themes, and patterns according to official documentation.
- Verify current package installation and APIs from Astryx documentation before implementation.
- Do not install or use shadcn/ui.
- Do not use Radix UI as a substitute/fallback component library.
- Do not introduce a second competing design system.
- Build product-specific compositions only when Astryx does not provide the required component/pattern.
- Do not invent Astryx package names, props, CLI options, or import paths.
- If a required Astryx feature is unavailable or incompatible, report the gap and propose a solution before adding another UI library.

## 2. Experience goals

- Developer-tooling product, not a generic admin template.
- High information density without visual clutter.
- Clear hierarchy and predictable navigation.
- Operational states are immediately understandable.
- Dangerous actions are deliberate and reversible where possible.
- Consistent empty/loading/error/success states.
- Keyboard accessible and responsive.
- Use real data only; no fake production metrics.

## 3. Application shell

### Sidebar
Primary navigation:
- Overview
- Backends
- Tools
- Agents
- Access Policies
- Sessions
- Activity
- Monitoring
- Audit Trail
- Settings

Sidebar requirements:
- Collapsible if supported by the chosen Astryx patterns.
- Active route clearly indicated.
- Group related navigation items.
- Display gateway connection/health indicator.
- Avoid decorative items without function.

### Top bar
- Breadcrumbs.
- Current page title/context.
- Global gateway status.
- Optional command/search entry point if implemented.
- User/account menu.
- Responsive mobile navigation.

## 4. Pages and requirements

### 4.1 Overview — `/dashboard`
Widgets:
- Gateway status.
- Backend totals by state.
- Registered agents.
- Active sessions.
- Discovered tools.
- Request throughput.
- Error rate.
- Latency percentiles.
- Recent events.
- Backend health summary.

Each widget must show loading, empty, unavailable, and error states. Charts must use real aggregated data.

Phase 8 status, per widget:

| Widget | Endpoint | Available |
| --- | --- | --- |
| Gateway status | `/api/v1/overview` (`status`, `database`) | yes |
| Backend totals by state | `/api/v1/overview` (`backends`) | yes |
| Registered agents | `/api/v1/overview` (`agents`) | yes |
| Active sessions | `/api/v1/overview` (`sessions`) | yes |
| Discovered tools | `/api/v1/overview` (`tools`) | yes |
| Recent events | `/api/v1/activity` | yes |
| Backend health summary | `/api/v1/monitoring/backends` | yes |
| Error rate | `/api/v1/activity?outcome=failure` | partial — counts only, no rate over time |
| Request throughput | — | **not collected** |
| Latency percentiles | — | **not collected** |

Render the last three as "not collected" rather than a flat line at zero. `/overview` is one
snapshot, so no two widgets on this page can disagree about the same instant; branch on `null`
(unavailable) before formatting a number.

### 4.2 Backends — `/dashboard/backends`
- Search and filters by status and transport.
- Table/list with name, transport, health, enabled state, tools count, last connected.
- Actions: view, edit, validate, enable/disable, reconnect, delete.
- Add backend CTA.
- Empty state explains that the registry is empty.

### 4.3 Add backend — `/dashboard/backends/new`
Wizard or structured form:
1. Select transport.
2. Enter backend identity and description.
3. Enter transport-specific configuration.
4. Configure timeout and concurrency.
5. Reference credentials/secrets.
6. Validate configuration.
7. Test connection.
8. Review and save disabled or enabled as explicitly selected.

Never execute a submitted command until the user confirms and the backend configuration passes validation. Display a security warning for stdio process launch.

### 4.4 Backend detail — `/dashboard/backends/[backendId]`
Tabs/sections:
- Summary and connection status.
- Configuration (secrets masked).
- Tools exposed by backend.
- Health and reconnect history.
- Recent calls/errors.
- Lifecycle actions.

### 4.5 Tool Explorer — `/dashboard/tools`
- Search by public/original name.
- Filter by backend and access.
- Show description and schema availability.
- Show backend source.
- Show enabled/disabled/blocked status.

Tool detail:
- Input JSON Schema viewer.
- Backend identity.
- Agent access matrix/effective access.
- Recent invocation statistics.
- Admin test invocation with explicit confirmation and clear warning.

### 4.6 Agents — `/dashboard/agents`
- Agent list with status, client type, last seen, request count.
- Create agent profile.
- Generate credential and show it once.
- Rotate/revoke credential.
- Enable/disable profile.
- View activity and assigned policies.
- Provide connection instructions per client without modifying local agent configuration automatically.

### 4.7 Agent detail — `/dashboard/agents/[agentId]`
- Identity and status.
- Credentials metadata (never reveal stored token again).
- Effective permissions.
- Usage summary.
- Recent activity.
- Sessions.
- Revoke/disable actions.

### 4.8 Access Policies — `/dashboard/policies`
- Policy list and editor.
- Assign agent to backend/tool permissions.
- Allow/deny rules with documented precedence.
- Effective access preview.
- Warn when a policy grants broad access.
- Default deny.

### 4.9 Sessions — `/dashboard/sessions`
- Active sessions.
- Agent/client.
- Started time and duration.
- Active calls.
- Backend/tool currently running.
- Revoke session or cancel call where safely supported.
- Session state must reflect actual server data.

### 4.10 Activity — `/dashboard/activity`
- Searchable invocation history.
- Filters: time, agent, backend, tool, status, request ID.
- Show duration and outcome.
- Payloads hidden/redacted by default.
- No sensitive argument/result capture by default.

### 4.11 Monitoring — `/dashboard/monitoring`
- Throughput over time.
- Latency percentiles.
- Error rate.
- Backend uptime/health.
- Reconnect counts.
- Queue depth and lock wait where applicable.
- Time-range selection.
- Clearly indicate missing metrics.

### 4.12 Audit Trail — `/dashboard/audit`
- Admin login/security events.
- Backend create/update/enable/disable/delete.
- Agent create/disable/credential rotation.
- Policy changes.
- Settings changes.
- Include actor, action, target, time, result, request ID.
- Prevent ordinary UI users from editing/deleting audit history.

### 4.13 Settings — `/dashboard/settings`
Sections:
- General.
- Gateway/network.
- Authentication/security.
- Logging and retention.
- Backup/restore.
- Diagnostics.
- Version and environment.

Changing bind address away from loopback must require explicit warning and security confirmation.

## 5. Component inventory

Use Astryx equivalents where available:
- App shell/sidebar/navigation.
- Header/breadcrumbs.
- Cards/panels.
- Data table/list.
- Tabs.
- Dialog/drawer.
- Forms and validation.
- Select/combobox.
- Switch/toggle.
- Badge/status indicator.
- Tooltip/popover.
- Toast/notification.
- Skeleton/loading.
- Empty state.
- Error state.
- Code/JSON viewer composition.
- Charts (if provided; otherwise select a charting library only after checking Astryx ecosystem and approval).

Do not recreate an existing Astryx component merely to change its appearance. Compose or theme it using documented APIs.

## 6. Visual and interaction requirements

- Consistent spacing and typography through Astryx tokens.
- Status color semantics consistent across all pages.
- Tables support loading, empty, error, and pagination where necessary.
- Destructive actions require confirmation.
- Forms show inline validation and server errors.
- Long-running operations show progress/status and allow safe cancellation when supported.
- No fake “live” indicators.
- Avoid excessive gradients, decorative charts, and unnecessary animation.
- Respect reduced-motion preferences.
- Keyboard navigation and visible focus states.
- Responsive layout must not hide critical security controls.

## 7. UI acceptance checklist

- [ ] Astryx installed and used according to official current documentation.
- [ ] No shadcn/ui dependency or generated shadcn components.
- [ ] No Radix UI fallback component library.
- [ ] Shared application shell and navigation.
- [ ] All specified routes implemented.
- [ ] All pages connected to real API data.
- [ ] Empty registry and zero-tool states designed.
- [ ] Loading/error/empty/success states implemented.
- [ ] Permission-sensitive controls are server-authorized.
- [ ] Responsive and keyboard accessible.
- [ ] No fake production metrics or placeholder backends.

---

# Part II — Implemented foundation (Phase 9)

Part I is the product target. This part records what actually exists today, so
the two are never confused. Anything not listed here is still Phase 10 work.

Status legend: **Implemented** · **Placeholder** (route exists, states plainly
that it is not built) · **Not implemented**.

## 8. What Phase 9 shipped
| Area | Status | Notes |
| --- | --- | --- |
| Next.js App Router app at `apps/dashboard` | Implemented | Next 16.4.6, React 19.3.1, TS strict |
| Astryx design system | Implemented | `@astryxdesign/core` 0.7.16 + `theme-neutral` |
| Tailwind CSS v4 + Astryx bridge | Implemented | Official `tailwind-theme.css` bridge |
| App shell (sidebar, header, responsive drawer) | Implemented | Astryx `AppShell` + `SideNav` + `TopNav` |
| Theme infrastructure (light/dark/system) | Implemented | Astryx `<Theme mode>` is the only owner |
| Typed API client + error normalisation | Implemented | Server-side only, `lib/api/*` |
| Same-origin read proxy | Implemented | Allowlist, not a passthrough |
| Loading / empty / error / unavailable states | Implemented | `components/feedback/*` |
| `/dashboard` overview | Implemented | Reads `GET /api/v1/overview` |
| All other module routes | Placeholder | No sample data, no fake counters |
| `/dashboard/backends/new`, detail routes | Placeholder | Routes exist so URLs are real |
| Unknown routes | Implemented | Shell-preserving not-found page |

## 9. Routes as implemented

```text
/                                   → redirects to /dashboard
/dashboard                          → Overview (real API data)
/dashboard/backends                 → placeholder
/dashboard/backends/new             → placeholder
/dashboard/backends/[backendId]     → placeholder
/dashboard/tools                    → placeholder
/dashboard/tools/[toolId]           → placeholder
/dashboard/agents                   → placeholder
/dashboard/agents/[agentId]         → placeholder
/dashboard/policies                 → placeholder
/dashboard/sessions                 → placeholder
/dashboard/activity                 → placeholder
/dashboard/monitoring               → placeholder
/dashboard/audit                    → placeholder
/dashboard/settings                 → placeholder
/api/proxy/[...path]                → same-origin GET proxy (allowlisted)
```

`src/lib/navigation.ts` is the single source for the sidebar, breadcrumbs,
page titles, and placeholder copy — a destination cannot appear in the sidebar
without a corresponding page.

## 10. Astryx integration, as built

Astryx is consumed as a **package set**, not copied source:

```jsonc
"@astryxdesign/core": "0.7.16",
"@astryxdesign/theme-neutral": "0.7.16",
"@stylexjs/stylex": "^0.19.2",   // peer dependency of core
```

- Theme wiring is generated by the CLI (`astryx theme add neutral`) into
  `src/astryx-themes.js`. Do not hand-edit that file; re-run the CLI.
  `src/astryx-themes.d.ts` types it because `allowJs` is off.
- Only `./SideNav` is a package export for `SideNav`, `SideNavHeading`,
  `SideNavItem`, and `SideNavSection`; importing a subcomponent path directly
  fails.
- Cascade-layer order is declared once in `src/app/globals.css` and must stay
  the first import in `src/app/layout.tsx`:

  ```css
  @layer reset, theme, base, astryx-base, astryx-theme, components, utilities;
  ```

- No `color-scheme` rule is defined locally. `@astryxdesign/core/reset.css`
  maps `data-theme` to `color-scheme`; unlayered CSS here would override it and
  pin the page to light.

## 11. API integration and trust boundary

The gateway binds `127.0.0.1` and grants **no CORS**, so the browser cannot
reach it. Every request is therefore made server-side:

- **Server components** call the gateway directly via `lib/api/client.ts`.
- **Client-side refresh** uses `/api/proxy/*`, a same-origin allowlisted route.

`GATEWAY_ORIGIN` is server-only and deliberately **not** `NEXT_PUBLIC_*`.

| Variable | Default | Scope |
| --- | --- | --- |
| `GATEWAY_ORIGIN` | `http://127.0.0.1:8787` | server only |
| `GATEWAY_TIMEOUT_MS` | `5000` | server only |
| `PORT` (dashboard) | `3000` | Next dev/start |

Types in `lib/api/types.ts` are hand-written from `docs/API_REFERENCE.md` rather
than generated, because `z.toJSONSchema()` describes shapes but not the
`null`-vs-`0` semantics that matter most: `null` means "the read failed",
`0` means "none". The UI renders `null` as "Unavailable", never `0`.

## 12. Development commands

```bash
pnpm install            # workspace install
pnpm dev:gateway        # gateway on 127.0.0.1:8787 (root package)
pnpm dev:dashboard      # dashboard on localhost:3000
pnpm dev                # gateway only (legacy alias, unchanged)

pnpm typecheck          # gateway
pnpm typecheck:dashboard
pnpm test               # gateway suite (tests/)
pnpm test:dashboard     # dashboard suite (apps/dashboard/tests)
pnpm verify             # both typechecks + both suites

pnpm build              # gateway
pnpm build:dashboard
```

Run the gateway and the dashboard in two terminals. The dashboard shows
"Gateway unreachable" until the gateway is up; that is a real state, not an
error to work around.

## 13. Known limitations

- **Phase 10 is not implemented.** Every module except Overview is an honest
  placeholder. No tables, forms, CRUD, credential issuance, or settings
  mutation exist.
- **Operator authentication is implemented (Phase 10.0), with limits.** The
  dashboard has a real login and the gateway enforces the boundary on every
  `/api/v1` route. What does not exist: multiple operators, RBAC beyond a single
  `owner`, a password-change UI, a session-listing UI, a per-IP login rate limit,
  dashboard CSP, and TLS. The password and session cookie cross plaintext HTTP on
  loopback, so this must not be exposed beyond `127.0.0.1`. See Part III and
  `docs/SECURITY.md` §4.3.
- **Browser click-path testing is unverified.** No browser automation
  (Playwright/Puppeteer) is installed and none was added. Component behaviour is
  covered by jsdom tests; layout was verified by SSR HTML inspection and the
  production build, not by a real browser. The same holds for the login form: its
  behaviour is covered by `tests/login-form.test.tsx`, but no real browser was
  driven through sign-in.
- **JSDOM CSS warning.** Astryx injects CSS anchor positioning
  (`@position-try`, `position-area`) at runtime for overlay components such as
  `Tooltip`. JSDOM 27.4 cannot parse those rules and logs
  "Could not parse CSS stylesheet". This is a documented JSDOM limitation and
  has no effect on the built CSS or on browser rendering; tests pass regardless.
- **Hand-written API types** must be kept in sync with
  `docs/API_REFERENCE.md`. Only read endpoints are wrapped, because Phase 9
  ships no mutation UI.

## 14. Phase 9 acceptance checklist

- [x] Astryx installed and used per official documentation.
- [x] No shadcn/ui dependency or generated components.
- [x] No Radix UI fallback component library.
- [x] Shared application shell and navigation.
- [x] All specified routes exist (Overview functional; others placeholders).
- [x] Overview connected to real API data; other pages deliberately not faked.
- [x] Empty registry and zero-tool states designed and verified.
- [x] Loading/error/empty/success states implemented.
- [ ] Permission-sensitive controls — none exist yet. The gateway now enforces
      the operator session on every `/api/v1` route (Phase 10.0), so the first
      mutation control added inherits enforcement.
- [x] Responsive shell and keyboard accessibility implemented; verified by SSR
      inspection, the production build, and component tests.
- [x] No fake production metrics or placeholder backends.
- [ ] Real-browser click-path verification — **not verified** (no browser
      automation available in this environment; not added on purpose).
- [x] Dashboard operator authentication — **implemented in Phase 10.0** (Part
      III).

## 14.1 Phase 9 status interpretation

Phase 9 delivers the **foundation**, and that foundation is complete and
verified: shell, navigation, theme, tokens, Astryx integration, typed API client,
same-origin allowlisted proxy, feedback states, one real page, and the readiness
probe.

Two items are **explicitly out of scope**, recorded here so neither is mistaken
for finished work:

| Item | Status | Why |
| --- | --- | --- |
| Operator authentication / auth guard | Implemented in Phase 10.0 (Part III) | Gateway-enforced session, dashboard login/logout |
| Browser E2E click-path | Not verified | No browser automation in this environment; installing one was declined |
| Phase 10 module pages | Backends implemented in Phase 10.1 (Part IV); the rest are intentional placeholders | Registry management is real; no other module page exists yet |

The dashboard is a **local operator tool** with a real login. It must not be
exposed beyond loopback: the session cookie crosses plain HTTP within the host.
See `docs/SECURITY.md` §8.

# Part III — Operator authentication (Phase 10.0)

Part III records what shipped for operator identity, so a reader can tell a real
control from a planned one.

## 15. Phase 10.0 routes

```text
/login                              → sign-in form (outside the shell)
/api/login                          → POST: forwards credentials to the gateway,
                                      re-issues the cookie on this origin
/api/logout                         → POST: revokes at the gateway, clears cookie
/dashboard/**                       → protected: layout probes the gateway first
```

`/login` and the two route handlers live outside the `(dashboard)` group. The
group layout is where protection is applied, once, rather than per page.

## 16. How sign-in works

1. The form posts `{ username, password, next }` to `/api/login` — never to the
   gateway, which is loopback-only and sends no CORS headers.
2. `/api/login` forwards `{ username, password }` to `POST /api/v1/auth/login`
   over loopback. The gateway verifies the password, applies lockout and
   enumeration defence, rotates any existing session, and mints a new one.
3. If the gateway answers `200`, the route handler copies the cookie **name and
   value** only and re-issues it on the dashboard origin with `HttpOnly`,
   `SameSite=Strict`, `Path=/`, and the gateway's `Max-Age`. `Secure` is added
   only when `GATEWAY_ORIGIN` is https. A cookie set by `127.0.0.1:8787` would
   never be sent to `localhost:3000`, which is the whole reason for re-issuing.
4. If the gateway refuses, the route returns its `401` and message verbatim, the
   form keeps what was typed, and nothing navigates. An unreachable gateway
   becomes `503` and a connection message, not a credentials message.
5. On success the browser does a full navigation to `next` (validated by
   `safeNextPath`), not a client-side push — the protected tree must be rendered
   by a request that carries the new cookie.

## 17. How protection works

`src/proxy.ts` sets an `x-pathname` header (no authentication decision) so the
`(dashboard)/layout.tsx` knows which page to return the operator to.
`getOperatorSession()` probes `GET /api/v1/auth/session` with the browser's
cookie, wrapped in React `cache()` so a layout, header, and page in one render
make one request. `requireOperator(pathname)` redirects to `/login?next=…` only
when that probe fails.

A revoked cookie and an absent cookie are indistinguishable there — a
cookie-existence check would treat them the same way, which is the bug this
avoids. **The probe is not the security boundary**: the gateway enforces the
session on every request, and `/mcp` enforcement is untouched.

## 18. Sign-out

The account menu in the header shows the identity the gateway confirmed on the
server and a **Sign out** button. It posts to `/api/logout`, which calls the
gateway's `/logout` *first* and only then deletes the local cookie — clearing the
cookie alone would leave a session a copied cookie could still replay. The button
navigates with `window.location.assign('/login')` so the next render is produced
by a request with no cookie.

## 19. Files

| File | Role |
| --- | --- |
| `src/app/login/page.tsx` | Sign-in page; redirects a live session straight to `next` |
| `src/features/auth/login-form.tsx` | Client form: masking, reveal toggle, live-region error, pending state |
| `src/app/api/login/route.ts` | Forwards credentials; re-issues the cookie on this origin |
| `src/app/api/logout/route.ts` | Revokes at the gateway, then clears the local cookie |
| `src/lib/auth/session.ts` | `getOperatorSession()` probe, cached per render |
| `src/lib/auth/guard.ts` | `requireOperator`, `operatorCookieHeader` |
| `src/lib/auth/login.ts` | `loginWithGateway`, `dashboardCookie`, `maxAgeOf`, `safeNextPath` |
| `src/components/layout/account-menu.tsx` | Confirmed identity + sign-out |
| `src/proxy.ts` | Passes `x-pathname`; makes no auth decision |
| `tests/login-form.test.tsx` | Form behaviour (masking, error, no navigation on failure) |
| `tests/auth-login.test.ts` | `safeNextPath`, cookie attributes, `Max-Age` parsing |

## 20. Bootstrap and verification status

An operator is created **on the gateway host**, once:

```bash
pnpm operator:create
```

The password is read from a TTY/stdin prompt — never argv — and the command
refuses to run when an operator already exists. There is no default password.
An unconfigured instance answers login with *"No operator is configured. Run
`pnpm operator:create` on the gateway host."*

**There is no password change and no password reset.** The only writes under
`/api/v1/auth` are `login` and `logout`. Recovery requires shell access on the
gateway host: stop the process, delete the operator row, re-run
`pnpm operator:create`. That is intentional — any reset that does not verify the
current password is account takeover for whoever holds the session. See
`docs/SECURITY.md` §8.2 before adding one.

**Lockout is the brute-force control** (5 failures → 15 minutes), and it gates
login only: an existing session keeps working while the account is locked, so
triggering the lock cannot evict a signed-in operator. It is bounded, never
permanent, and clears on the next successful login. There is no per-IP limiter.

Verified: gateway test suite (528 tests, including 42 operator identity/auth
tests) covers the boundary, cookie attributes, CSRF, lockout, rotation, expiry,
revocation, audit contents, and both negations (`/mcp` rejects an operator
cookie; `/api/v1` rejects an agent bearer). Dashboard: typecheck, 38 jsdom tests,
and the production build.

**Not verified:** a real browser sign-in. No browser automation is installed in
this environment, so no browser was driven through the form, the redirect, or the
cookie. This is recorded rather than claimed.

## 21. Official references consulted

- https://astryx.atmeta.com/ — overview, "React 19+ and StyleX"
- https://astryx.atmeta.com/docs/getting-started
- https://astryx.atmeta.com/docs/styling-libraries — Tailwind coexistence
- https://astryx.atmeta.com/docs/theme — `Theme`, `defineTheme`
- Component docs via `npx @astryxdesign/cli component <Name>`
- Icons via `npx @astryxdesign/cli docs icons available-names`
- Tokens via `npx @astryxdesign/cli docs tokens-color`
- Reference app: `meta/astryx` → `apps/example-nextjs-tailwind`

# Part IV — Backend management (Phase 10.1)

Part IV records the first module page. The requirements in §4.2–§4.4 are the
product intent; this section is what was built, and where it deliberately
differs.

## 22. Phase 10.1 routes

Where this differs from the product requirements in §4.2–§4.4, deliberately:

- **No "Test connection" step.** Connecting is itself the test, and it is a
  separate, explicit action that spawns a process or opens a socket. The form
  offers *Validate* (`POST /validate`), which persists and dials nothing. A
  wizard step that dialled on "next" would make the review step a lie.
- **No tools section, no per-backend call history.** Those need the tool and
  activity APIs, which are outside this phase.
- **No tabbed detail.** Three sections on one page, so nothing important is
  behind a hidden tab.
- **A single-page form, not a wizard.** The transport switch is the only
  branching, and it stays visible.

```text
/dashboard/backends                     → registry list, server-side filters, counts
/dashboard/backends/new                 → create form (no reads)
/dashboard/backends/[backendId]         → detail: overview, configuration, runtime
/dashboard/backends/[backendId]/edit    → the same form, seeded from the item read

/api/backends/[...path]                 → POST/PATCH/DELETE write proxy (allowlisted)
```

The four pages are server components; only the table, the form and the action bar
are client components, because Astryx `Table` takes a `renderCell` function and
the other two own draft/pending state.

## 23. Gateway operations used

Everything below is read from `src/api/routes/backends.routes.ts` and
`src/domain/backend.ts` — nothing here is inferred from the product spec.

| Operation | Route | Notes |
| --- | --- | --- |
| List | `GET /api/v1/backends` | `search`, `transport`, `enabled`, `sort`, `order`, `page`, `limit` (≤100) |
| Create | `POST /api/v1/backends` | `201`; never connects |
| Validate | `POST /api/v1/backends/validate` | `200 {valid, transport?, errors?, normalized?}`; persists and dials nothing |
| Item | `GET /api/v1/backends/:id` | `toPublicBackend()` |
| Item runtime | `GET /api/v1/backends/:id/runtime` | the full `RuntimeView` |
| All runtime | `GET /api/v1/backends/runtime` | wrapped, not yet rendered |
| Update | `PATCH /api/v1/backends/:id?expectedVersion=` | compare-and-set |
| Enable / disable | `POST /api/v1/backends/:id/{enable,disable}?expectedVersion=` | compare-and-set |
| Connect / disconnect / reconnect | `POST /api/v1/backends/:id/{connect,disconnect,reconnect}` | `409` on a disabled backend |
| Delete | `DELETE /api/v1/backends/:id` | tombstone; returns the pre-deletion representation |

**`expectedVersion` is a query parameter.** A body field with that name is not
read, which would quietly turn a compare-and-set into a blind overwrite. The
dashboard always sends the version it rendered.

Filtering by **runtime status** is not possible: the list accepts `search`,
`transport` and `enabled` only. The toolbar says so rather than shipping a
control that filters nothing.

## 24. Counts and runtime state

Summary tiles come from `GET /api/v1/monitoring/backends`, whose `counts` covers
the whole registry. Counting the rendered page would report "1 backend" on a
filtered page of 1 out of 20.

Runtime state has two sources and the difference is visible:

- the **list** carries a reduced `runtime: {status, updatedAt}`;
- the **detail page** reads `…/runtime` for `lastConnectedAt`,
  `lastHealthCheckAt`, `reconnectAttempts` and `lastError*`.

When the runtime read fails, the detail page says the live state could not be
read and still shows the configuration. It does not substitute the reduced list
status and present it as complete.

The dashboard labels a backend with no runtime row as `disconnected` (enabled) or
`disabled` (not enabled). That is a configuration fact, not an invented
connection state.

## 25. Secrets are references, not values

`env` and `headers` values must match `^(?:secret|env):[A-Za-z0-9._:/-]+$`. The
dashboard therefore:

- explains the reference syntax beside every row;
- refuses a literal value locally with the same message the gateway would give
  (`in buildCreateInput`), because the likeliest cause is a pasted secret;
- displays references on the detail page as they are — there is no value to mask,
  and no placeholder that could become one.

No secret input exists anywhere in this phase. `stdio.command` is a single
executable token (`SHELL_SYNTAX = /[\s;&|<>`$()]/`); arguments are one per line,
which preserves spaces inside a path instead of splitting on whitespace.

## 26. Write path and auth

```text
browser → POST/PATCH/DELETE /api/backends/…   (dashboard origin, same-origin)
        → route handler: allowlist → operator cookie + CSRF from one probe
        → http://127.0.0.1:8787/api/v1/backends/…
```

- `lib/api/write-policy.ts` (`lib/backends/proxy-policy.ts` before Phase 10.2)
  holds the perimeter and is unit-tested. Item
  patterns are UUID-only and anchored with `$`, so `/backends/../../agents`
  cannot be expressed as a match. Methods outside `POST|PATCH|DELETE` are refused.
- A write with no live session is answered `401` by the handler **before** the
  gateway is called, so an expired session reads as "sign in again", not as a
  permission problem.
- Writes get a 30 s ceiling rather than the 5 s read budget: `connect` dials the
  backend and discovers its tools before answering, bounded by the gateway's own
  `TOOL_DISCOVERY_TIMEOUT_MS` (15 s default). The read budget would abort first
  and report a timeout for a connection that succeeded.
- `expectedVersion` is preserved by copying the request's query string.
- The body is forwarded as bytes; re-serialising would make this a second schema.
- The browser holds no cookie value and no CSRF token, and no
  `localStorage`/`sessionStorage` is used.

This proxy is not the security boundary: the gateway re-checks the session and
the CSRF token on every request.

## 27. Action availability

Derived from the lifecycle manager's own rules, so no offered button answers
`409`:

| Action | Offered when |
| --- | --- |
| Connect | enabled, and status is not `connected`/`connecting` |
| Reconnect | enabled, and no transition is in flight |
| Disconnect | status is above rest (`connected`, `unhealthy`, `error`) |
| Enable | not enabled |
| Disable | enabled |
| Delete | always |

One action runs at a time; while it is in flight every button is disabled and the
form refuses re-entry (Enter in a field is a second submit path). Delete opens an
`AlertDialog` that names the backend and states the tombstone consequence, then
navigates to the list — refreshing a page whose subject is gone would be a stale
read.

## 28. Files

| File | Role |
| --- | --- |
| `src/lib/api/backends.ts` | The 11 endpoint wrappers; contract in code |
| `src/lib/backends/form.ts` | Form model, reference-row rules, `parseArgs`, `buildCreateInput`, `toUpdateInput`, `issuesToErrors` |
| `src/lib/backends/actions.ts` | Availability and status helpers |
| `src/lib/api/write-client.ts` | The client's only write path: the dashboard proxy (was `lib/backends/browser.ts`) |
| `src/lib/api/write-policy.ts` | `isAllowedWrite` — the perimeter (was `lib/backends/proxy-policy.ts`) |
| `src/lib/api/write-proxy.ts` | The forwarding itself, shared by all three write routes |
| `src/app/api/backends/[...path]/route.ts` | Write proxy: cookie + CSRF, allowlist, timeout mapping |
| `src/app/(dashboard)/dashboard/backends/page.tsx` | List + counts |
| `src/app/(dashboard)/dashboard/backends/new/page.tsx` | Create |
| `src/app/(dashboard)/dashboard/backends/[backendId]/page.tsx` | Detail |
| `src/app/(dashboard)/dashboard/backends/[backendId]/edit/page.tsx` | Edit |
| `src/features/backends/backends-table.tsx` | Table, GET filter form, empty vs no-match |
| `src/features/backends/backend-form.tsx` | Create + edit, transport-adaptive |
| `src/features/backends/backend-detail.tsx` | Overview / configuration / runtime |
| `src/features/backends/backend-actions.tsx` | Lifecycle buttons + delete dialog |
| `src/features/backends/backend-status.tsx` | Runtime status, enabled badge, transport label |
| `tests/backends-client.test.ts` | Contract: list/empty/errors/auth/payloads/validate |
| `tests/backend-form.test.ts` | Local rules and payload construction |
| `tests/backend-actions.test.ts` | Availability and status helpers |
| `tests/backend-proxy.test.ts` | Allowlist acceptances and refusals |
| `tests/backends-list.test.tsx` | List states, counts, filters, pagination |
| `tests/backend-form-component.test.tsx` | Form behaviour and create/edit payloads |
| `tests/backend-detail.test.tsx` | Runtime display, references, degraded runtime, 404 |
| `tests/backend-actions-component.test.tsx` | Confirmation, pending state, failures, delete |

## 29. Phase 10.1 acceptance checklist

- [x] List with server-side search/transport/enabled filters, pagination, and
      empty vs no-match states.
- [x] Counts from monitoring, not from the rendered page.
- [x] Create and edit with transport-specific fields and local validation
      mirroring the domain schema.
- [x] Gateway validation as an explicit, non-persisting action.
- [x] Detail page with configuration and full runtime, degrading honestly when
      the runtime read fails.
- [x] Enable/disable/connect/disconnect/reconnect/delete, with availability
      matching the gateway and compare-and-set versions.
- [x] Delete confirmation with the tombstone consequence.
- [x] Secret-reference-only inputs; no stored secret rendered anywhere.
- [x] Writes only through the same-origin proxy; no token in browser storage.
- [x] Error, empty, and pending states on every surface.
- [x] 148 dashboard tests, typecheck, and build green; gateway suite and build
      unchanged at 528 tests.
- [ ] Real-browser click-path — **not verified** (no browser automation here).
- [ ] Runtime-status filter — **not implemented**, because the API has no such
      parameter.


## 30. Phase 10.2 routes

```text
/dashboard/tools                        → catalog list, server-side filters, counts
/dashboard/tools/[toolId]               → one tool by public name, schemas, routing state

/api/tools/refresh                      → POST, global rediscovery (allowlisted)
/api/backends/[id]/tools/refresh        → POST, one backend (allowlisted)
```

The list page is a server component reading four endpoints: `GET /api/v1/tools`
(the table), `GET /api/v1/tools/discovery` (last run per backend),
`GET /api/v1/tools/conflicts` (withheld names) and `GET /api/v1/monitoring` (the
counts). The table and the refresh control are the only client components.

### The detail URL parameter is a public name

`/dashboard/tools/[toolId]` passes the segment to
`GET /api/v1/tools/:publicName`, so the parameter is
`<backend_id>__<original_name>`, not an id. The page decodes it once and the
client re-encodes it when building the URL; a name containing `.`, `_` or `-` is
therefore safe and a name containing anything else cannot be expressed.

### What this phase deliberately does not do

- **No tool invocation console.** `tools.routes.ts` documents the absence on
  purpose: a call goes through `/mcp` under an agent's credential and policy, and
  a REST "test call" would need its own authorization model and its own result
  contract. The detail page says this in words rather than rendering a disabled
  button that implies a missing feature.
- **No per-agent access matrix on the tool page.** Access is a property of an
  agent's policies, not of the catalog row; the answer would be "depends which
  agent", and Phase 10.4's effective-access preview is where it belongs.
- **No availability filter invented beyond the gateway's.** `search`,
  `backendId` and `availability` are the three parameters the route accepts.
- **No conflict count in the discovery report.** `conflictCount` is a baseline
  `0` by design (`src/routing/discovery.ts`), so the live number is read from
  `/tools/conflicts`, which the page does.

### Schemas are inert

`inputSchema`, `outputSchema` and `annotations` come from a remote backend. They
are rendered with Astryx `CodeBlock`, which takes a string and returns DOM it
built itself — no HTML injection, no `dangerouslySetInnerHTML`, no evaluation.
`JSON.stringify` is the only transformation.

## 31. Phase 10.2 files

| File | Purpose |
| --- | --- |
| `src/lib/api/tools.ts` | List/get/discovery/conflicts/refresh, one function per route |
| `src/lib/api/types.ts` | `Tool`, `ToolQuery`, `DiscoveryReport` (corrected to the wire shape), `ToolRefreshResult` |
| `src/app/(dashboard)/dashboard/tools/page.tsx` | List + counts + conflicts + discovery |
| `src/app/(dashboard)/dashboard/tools/[toolId]/page.tsx` | Detail by public name |
| `src/features/tools/tools-table.tsx` | Table, GET filter form, empty vs no-match |
| `src/features/tools/tool-status.tsx` | Availability badge, discovery report |
| `src/features/tools/tool-refresh.tsx` | Global/per-backend refresh with partial-failure reporting |
| `src/lib/api/write-policy.ts` | One write allowlist for backends, agents, policies |
| `src/lib/api/write-proxy.ts` | The one forwarding implementation |
| `src/lib/api/write-client.ts` | The browser's only path to a write |
| `tests/tools-client.test.ts` | Contract: list/empty/envelope/404/encoded name/schema passthrough |
| `tests/tools-list.test.tsx` | List states, counts, filters, degraded side reads |
| `tests/tool-detail.test.tsx` | Inert schema, conflict/disabled wording, 404, no console |
| `tests/tool-refresh-component.test.tsx` | Pending guard, partial failure, no premature success |
| `tests/write-proxy.test.ts` | Allowlist acceptances and refusals |

`backend-proxy.test.ts` became `write-proxy.test.ts` and `lib/backends/browser.ts`
became `lib/api/write-client.ts` when the proxy moved to one shared implementation
for the three management resources. Same behaviour, one perimeter.

## 32. Phase 10.2 acceptance checklist

- [x] List with the gateway's own search/backend/availability filters and
      pagination; empty and no-match states are distinct.
- [x] Counts from monitoring, so a filtered page cannot understate the catalog.
- [x] Detail resolved by public name, including 404 vs failed-read handling.
- [x] Input/output schemas and annotations rendered as inert text, with copy.
- [x] Availability explained in words, including why a conflict is withheld.
- [x] Refresh via the real routes, per-backend failures reported, one run at a
      time, page re-read only after the gateway answers.
- [x] No invocation console, and the page says why.
- [x] Writes only through the same-origin proxy; the read proxy gained `/tools`
      read paths only.
- [x] 187 dashboard tests, typecheck, dashboard build, gateway suite (528) and
      gateway typecheck green.
- [ ] Real-browser click-path — **not verified** (no browser automation here).
- [ ] Admin test invocation — **not implemented**, because the API has no
      invocation route.

## 33. Phase 10.3 routes

```text
/dashboard/agents                          → registry list, server-side filters, counts
/dashboard/agents/new                      → create profile (no credential)
/dashboard/agents/[agentId]                → identity, credentials, effective access
/dashboard/agents/[agentId]/edit           → the same form, seeded from the item read

/api/agents/[...path]                      → POST/PATCH/DELETE write proxy (allowlisted)
```

The list page reads `GET /api/v1/agents` (the table, with the gateway's own
`search`, `status`, `clientType` and pagination) and `GET /api/v1/overview` (the
counts). `/monitoring` does **not** report agents — that was verified against
`monitoringPayload()` in `src/api/routes/ops.routes.ts` — so `/overview`, the same
payload the landing page reads, is the only source of registry-wide agent counts.

The detail page reads three endpoints independently: the profile (whose `404`
makes the page genuinely not found), `GET /agents/:id/credentials` (metadata
only), and `GET /agents/:id/access` (the gateway's own evaluator). A failed access
evaluation degrades to a notice inside its section; it does not hide the revoke
controls an operator came for.

### The token exists once

`POST /agents/:id/credentials` and `POST /agents/:id/credentials/:id/rotate` are
the only two responses in the product that contain a raw token. The panel holds it
in React state, renders it in a `CodeBlock` with an explicit copy control, and
discards it when closed. It is never written to `localStorage`,
`sessionStorage`, a cookie, the URL, a log, or an audit field, and the gateway
stores only an HMAC digest — so a page refresh cannot bring it back. The banner
says that in words rather than letting an operator discover it later.

### Rotation and revocation semantics, as implemented

These are the gateway's, not the dashboard's invention:

- **Rotation is replace-semantics with no grace period.** `CredentialService.rotate`
  creates the replacement and revokes the previous credential in one transaction.
  There is no deprecation window and no second valid token.
- **Sessions bound to the removed credential are invalidated** in the same
  transaction (`invalidateFor({credentialId}, 'credential_rotated', 'invalidated')`),
  so a client holding the old token gets `401`, not a warning.
- **A revoked credential cannot be rotated** — the service answers
  `RESOURCE_CONFLICT` (`409`). The UI does not offer Rotate on a revoked row and
  tells the operator to issue a new credential instead.
- **Disabling an agent ends live sessions**, not just new ones
  (`setEnabled(false)` invalidates by agent id). The detail page states this next
  to the action and the delete dialog repeats the wider blast radius: credentials
  revoked and policy assignments dropped.
- **Deleting is a tombstone**, so audit history keeps a valid reference; the agent
  cannot be restored or re-authenticated from the dashboard.

### What this phase deliberately does not do

- **No credential is minted by "create agent".** A profile and a secret are
  separate decisions, and a create flow has nowhere safe to display a token once.
- **No `metadata` editor.** It is a free-form map with reserved-key rules and a
  20-entry cap; a JSON textarea would be a worse editor than none, and a
  mistaken save would overwrite the whole map (the API replaces rather than
  merges).
- **No compare-and-set on agent writes.** Agents have no `version` field, so the
  form does not pretend to detect a concurrent edit; it re-reads after saving.
- **No sessions, usage or activity sections.** Those need the session and
  activity APIs (§4.7 asks for them); reading them here would double the work of
  phases 10.5–10.7.
- **No per-client connection instructions.** §4.6 asks for them "without
  modifying local agent configuration automatically"; writing copy that is not
  derived from a real endpoint would be documentation-shaped guesswork, so it is
  deferred rather than approximated.

## 34. Phase 10.3 files

| File | Purpose |
| --- | --- |
| `src/lib/api/agents.ts` | List/get/create/update/delete/enable/disable, credentials, access |
| `src/lib/api/types.ts` | `Agent`, `AgentQuery`, `AgentCreateInput`, `AgentUpdateInput`, `AgentCredential`, `IssuedCredential`, `AgentAccess`, `CLIENT_TYPES` |
| `src/app/(dashboard)/dashboard/agents/page.tsx` | List + counts |
| `src/app/(dashboard)/dashboard/agents/new/page.tsx` | Create |
| `src/app/(dashboard)/dashboard/agents/[agentId]/page.tsx` | Detail (404 handling, independent reads) |
| `src/app/(dashboard)/dashboard/agents/[agentId]/edit/page.tsx` | Edit |
| `src/features/agents/agents-table.tsx` | Table, GET filter form, empty vs no-match |
| `src/features/agents/agent-form.tsx` | Create + edit |
| `src/features/agents/agent-detail.tsx` | Identity / credentials / effective access |
| `src/features/agents/agent-actions.tsx` | Enable/disable/delete with stated consequences |
| `src/features/agents/agent-status.tsx` | Enabled and credential-status badges, client label |
| `src/features/agents/credential-panel.tsx` | Issue/rotate/revoke; the one place a token is rendered |
| `src/app/api/agents/[...path]/route.ts` | Three thin verb exports over the shared write proxy |
| `tests/agents-client.test.ts` | Contract: routes, bodies, 201 token, 409/404 cases |
| `tests/agents-list.test.tsx` | List states, counts from `/overview`, filters |
| `tests/agent-form-component.test.tsx` | Create vs edit bodies, `null` clears, no credential on create |
| `tests/agent-actions-component.test.tsx` | Enable/disable paths, consequence copy, delete flow |
| `tests/credential-panel-component.test.tsx` | Token once, no storage/URL leakage, rotation semantics, 409 |
| `tests/agent-detail.test.tsx` | Evaluator verdict verbatim, degraded sections, default-deny copy |
| `tests/write-proxy.test.ts` | Extended with the agent/credential allowlist and refusals |

## 35. Phase 10.3 acceptance checklist

- [x] Agent list with the gateway's own search/status/clientType filters and
      pagination; empty and no-match states are distinct.
- [x] Counts from `/overview`, because `/monitoring` has no agent counts.
- [x] Create and edit; `null` clears a nullable field instead of storing `""`.
- [x] Enable/disable with the real consequence stated: new sessions refused and
      live ones invalidated.
- [x] Credential issue with explicit copy, shown once, unrecoverable after close
      or refresh, and never in storage, a URL, a log, or audit metadata.
- [x] Rotation states replace-semantics, no grace period, and session
      invalidation before it is confirmed; revoked credentials are not offered it.
- [x] Revocation is confirmed and states that sessions end immediately.
- [x] Effective access rendered from `GET /agents/:id/access`, never recomputed
      in the browser.
- [x] Delete confirms and names the blast radius (credentials revoked, assignments
      dropped, tombstoned record).
- [x] 253 dashboard tests, typecheck, dashboard build, gateway suite (528) and
      gateway typecheck green.
- [ ] Real-browser click-path and a real credential handshake — **not verified**
      (no browser automation, no live client here).

## 36. Phase 10.4 routes

```text
/dashboard/policies                            → registry list, search/effect filters
/dashboard/policies/new                        → create (rules + priority)
/dashboard/policies/[policyId]                 → rules, assignments, effective-access preview
/dashboard/policies/[policyId]/edit            → the same form, seeded from the item read
/dashboard/policies/[policyId]?previewAgentId= → a reproducible preview of one agent's access

/api/policies/[...path]                        → POST/PATCH/DELETE write proxy (allowlisted)
```

The list reads `GET /api/v1/policies` with the gateway's own `search` and `effect`
filters. The API exposes **no registry-wide policy counts**, so the three tiles
are computed from the visible page and labelled "… on this page of N" — a figure
that describes what it actually covers rather than implying it is the whole
registry.

The detail page reads four things independently: the policy (whose `404` makes the
page genuinely not found), the backends (names for rule targets; a failure
degrades a column, the ids stay), the assignments, and — only when an assigned
agent is selected — that agent's access. An assignments failure does not hide the
rules, and an access failure does not hide the assignments.

### The one gateway addition: `GET /policies/:policyId/assignments`

The assignments sub-resource already had `POST` and `DELETE`, but no read. Without
it the detail page could state what a policy grants and not who receives it, which
makes an ALLOW rule impossible to assess before saving. The addition is the
smallest one consistent with the existing model:

- `PolicyRepository.listAgentsForPolicy(policyId)` — a join on
  `agent_policy_assignments` using the existing `idx_assignments_policy`, excluding
  tombstoned agents (an assignment to a deleted agent is not a usable grant).
- `PolicyService.listAssignments(policyId)` — `404` for an unknown policy, then the
  repository read.
- `GET /api/v1/policies/:policyId/assignments` — returns `toPublicAgent` objects,
  the same shape as the agent list, so no new serialisation exists.
- OpenAPI entry and four gateway tests (`tests/policies-api.test.ts`): the listing,
  the `404`, cascade-on-agent-delete, and agreement with the per-agent view in both
  directions.

No new architectural decision: this is the missing direction of a relation the
schema and the agent-side `listPoliciesForAgent` already modelled.

### Effects are words, and widening is confirmed

Every rule renders `ALLOW` or `DENY` as a badge **with the word**, never colour
alone. That distinction is the most consequential thing on the screen: deny
overrides allow at equal priority, higher priority wins, and no matching rule means
deny.

The form computes whether an edit **widens** access before it saves, and holds the
save behind a confirmation that lists each change:

- a new `allow` rule appears;
- a `deny` rule is flipped to `allow` (`changes from DENY to ALLOW`);
- a `deny` rule is **removed** — under deny-overrides-allow, deleting a denial
  restores whatever an allow would otherwise permit;
- any `*` allow, which is the broadest grant the model can express.

Nothing in the form ever rewrites an effect, reorders rules, or merges anything. A
narrowing edit saves without a prompt, because failing closed is the safe
direction.

A rule is not a resource: the gateway replaces `rules` wholesale on `PATCH`, so the
form always sends the full array. A partial send would silently keep rules the
operator just deleted.

### Effective access is the gateway's answer, not a browser's

The preview calls `GET /agents/:agentId/access` for an agent selected by a plain
`GET` form (`?previewAgentId=…`) and renders the verdict verbatim, including the
gateway's own `reason` string. There is deliberately **no rule engine in the
browser**: a second implementation of deny-overrides-allow would eventually
disagree, and the browser's answer would be the one on screen.

The preview is refused unless the selected agent actually holds the policy — the
page says so instead of evaluating a question the policy does not answer. The same
endpoint is what the agent page renders, so the two screens cannot disagree.

### What this phase deliberately does not do

- **No per-rule CRUD.** There is no such API; rules are a field. Inventing
  `POST /policies/:id/rules` would have been a new architectural surface for a
  convenience the form already provides.
- **No "policies with no effect" or "unused policy" filter.** It needs a reverse
  lookup per row; `GET …/assignments` is one policy at a time by design.
- **No client-side access simulation.** Repeated above because it is the single
  most tempting shortcut on this screen.
- **No bulk assignment.** The API assigns one agent per call; a bulk UI would
  fan out N requests and half-succeed without a transaction to hide behind.

## 37. Phase 10.4 files

| File | Purpose |
| --- | --- |
| `src/domain/repositories.ts` | `PolicyRepository.listAgentsForPolicy` |
| `src/infrastructure/database/repositories/policies.ts` | The join; reuses `toAgent`/`AgentRow` from the agent repository |
| `src/infrastructure/database/repositories/agents.ts` | `AgentRow`/`toAgent` exported for that reuse |
| `src/registry/policy-service.ts` | `listAssignments` |
| `src/api/routes/policies.routes.ts` | `GET /:policyId/assignments` |
| `src/api/openapi.ts` | OpenAPI entry for the new read |
| `tests/policies-api.test.ts` | Four new gateway tests (14 total in the file) |
| `src/lib/api/types.ts` | `POLICY_EFFECTS`, `POLICY_RESOURCES`, `PolicyRule`, `Policy`, `PolicyQuery`, `PolicyCreateInput`, `PolicyUpdateInput` |
| `src/lib/api/policies.ts` | List/get/create/update/delete/assign/unassign/assignments |
| `src/lib/policies/form.ts` | Validation mirroring the gateway; `broadeningChanges`; payload builders |
| `src/app/(dashboard)/dashboard/policies/**` | List, new, detail, edit |
| `src/features/policies/policies-table.tsx` | Table, GET filters, empty vs no-match |
| `src/features/policies/policy-form.tsx` | Create/edit, rule editor, widening confirmation |
| `src/features/policies/policy-detail.tsx` | Rules, assignments, evaluator-backed preview |
| `src/features/policies/policy-assignments.tsx` | Assign/unassign with stated consequences |
| `src/features/policies/policy-actions.tsx` | Delete with cascade warning |
| `src/features/policies/policy-status.tsx` | Effect badge (word + colour), resource/target labels |
| `src/app/api/policies/[...path]/route.ts` | Three thin verb exports over the shared write proxy |
| `src/lib/api/write-policy.ts` | Policy patterns; `DELETE`-only assignment pair |
| `tests/policies-client.test.ts` | Contract: routes, bodies, 409/400/404 |
| `tests/policy-form-logic.test.ts` | Widening detection, validation, payloads (no DOM) |
| `tests/policies-list.test.tsx` | List states, page-scoped tiles, filters |
| `tests/policy-form-component.test.tsx` | Widening gate, effect never auto-flipped, rule editor |
| `tests/policy-assignments-component.test.tsx` | Assign/unassign, picker, confirmation, pending |
| `tests/policy-detail.test.tsx` | Words not colour, wildcard callout, evaluator preview |
| `tests/policy-actions-component.test.tsx` | Delete cascade warning, pending, 403 |
| `tests/write-proxy.test.ts` | Policy allowlist and refusals, including PATCH on an assignment pair |

## 38. Phase 10.4 acceptance checklist

- [x] Policy list with the gateway's own `search`/`effect` filters; empty and
      no-match states are distinct.
- [x] Create and edit, with the whole rule array sent every time.
- [x] Rule editor: resource selector, backend picker for `backend` targets
      (including "not in the registry" so a saved rule is never silently dropped),
      free-text public name for `tool` targets, explicit `*`.
- [x] Effects rendered as ALLOW/DENY words beside colour; both shown per row.
- [x] Widening confirmed and enumerated (new allow, deny→allow, removed deny,
      wildcard allow). Narrowing saves without a prompt.
- [x] Nothing silently converts deny→allow or broadens access.
- [x] Effective-access preview calls `GET /agents/:agentId/access`, never a
      browser reimplementation; refused for an agent that does not hold the policy.
- [x] Assignments read from the gateway, with the reverse lookup added to the API
      and documented (`docs/API_REFERENCE.md` §3.6).
- [x] Assignment removal confirmed and states the agent loses access immediately.
- [x] Delete confirmed and states the cascade.
- [x] Loading/empty/error/refused states on every data surface; pending state and
      duplicate-submit protection on every mutation.
- [x] `POST /tools/call` denial behaviour untouched — no gateway auth, policy
      evaluation or default-deny code was modified.
- [x] 339 dashboard tests (up from 253), 532 gateway tests (up from 528), both
      typechecks, and the dashboard production build.
- [ ] Real-browser click-path and a live agent handshake — **not verified** (no
      browser automation, no live client here).

## 39. Phase 10.5 routes

```text
/dashboard/sessions               → session list, agent/status filters, id lookup
/dashboard/sessions/[sessionId]   → one session: binding, timing, client, terminate

/api/sessions/[...path]           → POST-only write proxy (one allowlisted target)
```

The list reads `GET /api/v1/sessions` with the gateway's own `agentId`, `status`,
`sort` and `order`, plus `GET /api/v1/overview` for the four registry-wide status
counts and `GET /api/v1/agents` for names. Counting the visible page would report
"1 active" on page one of twenty; the counts therefore come from `/overview`, the
same payload the landing page uses.

**These are MCP agent sessions, not dashboard sign-ins.** The rows come from
`sessions` — protocol sessions an MCP client opened with an agent credential.
Operator sessions live in `operator_sessions`, a different table with a different
lifetime and its own endpoints, and nothing on this page reads it (ADR-045). The
page says so in its description, because "session" is otherwise ambiguous.

### An id lookup is a detail read, not a list filter

`listSessionsQuerySchema` has **no `search` and no session-id parameter**. A
search box on the list would therefore be either ignored by the gateway (and
lie) or applied to the visible page (and lie differently). So the lookup form
posts `?sessionId=…` to the list route; a UUID redirects to
`/dashboard/sessions/:id`, which is the API's real answer, and a non-UUID shows
an inline notice without calling the gateway — a malformed id can only produce a
`400`, so asking is pointless.

The `status` filter is the **effective** status: the repository derives it from
the stored status plus the recorded lifetime and the idle deadline, so a session
whose lifetime lapsed before the sweep wrote the row back still answers
`expired`. The badge reads the same field, so filter and row cannot disagree.

### Termination is a server operation

`POST /api/v1/sessions/:sessionId/terminate` writes the row, releases the live
transport, records one `session.terminated` audit event, and refuses every later
request carrying that protocol id. It is idempotent: a repeat returns the
already-finished row and audits nothing, so a double click cannot produce two
terminations. The button is also disabled while a request is in flight, and the
page re-reads only after the proxy answers.

The confirmation names the real consequence — the connected client stops working
immediately and must initialize a new session with a valid credential — and says
what is *not* affected: the credential, the agent, and every other session. That
matters because "terminate" sounds like it might be a pause, and an operator who
believes that drops active work by accident.

The reason is the gateway's default, `operator_terminated`, so no body is sent.
`SESSION_TERMINATION_REASONS` is mirrored as a type for the detail page's display
of *why* a session ended — a reason is not a status (`cleanup` and
`idle_timeout` both mean "expired").

### What this phase deliberately does not do

- **No session creation, edit, or delete.** Sessions are created by a client
  initializing over MCP; the dashboard cannot and must not mint one.
- **No cleanup sweep UI.** `POST /sessions/cleanup` exists on the gateway, but no
  response field reports a sweep status worth showing, and a button that expires
  other clients' sessions is not an operator action this phase offers. It is
  also absent from the write allowlist, so the browser cannot reach it even by
  constructing the request by hand.
- **No `invalidate`.** That is a security response for credential revocation and
  agent disabling, performed by the gateway when those things happen. Offering it
  as a manual button would invite using it as a synonym for terminate while
  writing a different audit action.
- **No protocol-session-id lookup.** The list has no such filter; the detail route
  addresses the internal id. `mcpSessionId` is *displayed* on the detail page with
  a note that it is a routing handle, not a secret.
- **No token, hash, cookie, or transport state anywhere.** `toPublicSession()`
  does not emit one; the credential section reads metadata from
  `GET /agents/:id/credentials`, whose list contains no token (the token exists
  once, at issue time).

## 40. Phase 10.5 files

| File | Purpose |
| --- | --- |
| `src/lib/api/types.ts` | `SESSION_STATUSES`, `SESSION_TERMINATION_REASONS`, `SessionTerminationReason`, `Session`, `SessionQuery` |
| `src/lib/api/sessions.ts` | `listSessions`, `getSession`, `terminateSession` |
| `src/lib/api/write-policy.ts` | `SESSION_TERMINATE` pattern (UUID-anchored); cleanup and every other session verb excluded |
| `src/app/api/sessions/[...path]/route.ts` | `POST`-only thin export over the shared write proxy |
| `src/app/(dashboard)/dashboard/sessions/page.tsx` | List, query parsing, id-lookup redirect, counts, agent names |
| `src/app/(dashboard)/dashboard/sessions/[sessionId]/page.tsx` | Detail; `404` → `notFound()`, `400` → error state |
| `src/features/sessions/sessions-table.tsx` | Table, GET filters, empty vs no-match, pagination |
| `src/features/sessions/session-status.tsx` | Status badge (word + colour), termination reason |
| `src/features/sessions/session-detail.tsx` | Identity, binding, timing, client; independent degrading reads |
| `src/features/sessions/session-terminate-action.tsx` | Confirmation, pending state, duplicate guard, refresh on success |
| `src/lib/navigation.ts` | Sessions marked implemented, summary updated |
| `tests/sessions-client.test.ts` | Contract: filters forwarded, no `search`, bodyless terminate, 404/400 |
| `tests/sessions-list.test.tsx` | Empty vs error, agent-name degradation, filtered counts, lookup redirect |
| `tests/session-detail.test.tsx` | No secret in the DOM, degraded reads, revoked-credential explanation |
| `tests/session-terminate-component.test.tsx` | Confirm-first, single in-flight request, refusal not reported as success |
| `tests/write-proxy.test.ts` | Session allowlist and refusals (cleanup, create, PATCH, DELETE, invalidate) |
| `tests/sessions.test.ts` | **Fixture fix**: clock anchored to real now (see below) |

### One test fixture was a time bomb

`tests/sessions.test.ts` pinned its clock to `2026-11-19T10:00:00.000Z` while
`toSession` in `src/infrastructure/database/repositories/events.ts` derives a
lapsed lifetime from the **real** `Date.now()`. Once that date passed, every
freshly created session read back as `expired` and thirteen tests failed. Both
files were byte-identical to `HEAD`, so this was not a Phase 10 regression; the
fixture now starts at real now, and every assertion in the file was already
relative via `advance()`.

## 41. Phase 10.5 acceptance checklist

- [x] Session list with the gateway's own `agentId`/`status`/`sort`/`order`
      filters; no invented `search`.
- [x] An id lookup redirects to the real detail read; a malformed id explains
      itself without a gateway call.
- [x] Counts from `/overview`, not from the visible page.
- [x] Detail shows identity, immutable binding, both lifetimes, client metadata.
- [x] Termination: confirmation naming the client impact and the unaffected
      credential/agent/sessions, pending state, duplicate-submit protection,
      server-confirmed success, `router.refresh()` only after success, real error
      message on refusal.
- [x] A finished session offers no working terminate control.
- [x] No token, hash, cookie, or transport state rendered; the protocol session id
      is labelled as a routing handle.
- [x] Failed agent/credential reads degrade one value each and never hide the
      session or the control.
- [x] `POST /sessions/cleanup` and `invalidate` unreachable from the browser.
- [x] Operator sessions never read or listed on this page.
- [x] 366 dashboard tests (up from 339), 532 gateway tests, both typechecks, and
      the dashboard production build.
- [ ] Real-browser click-path and a live MCP client termination — **not verified**
      (no browser automation, no live client here).

## 42. Phase 10.6 routes

```text
/dashboard/activity                → operational history, server-side filters
/dashboard/activity/[eventId]      → one activity event
/dashboard/audit                   → administrative history, server-side filters + CSV
/dashboard/audit/[eventId]         → one audit event, including metadata

/api/audit-export                  → bounded CSV export, same filters as the page
```

### Two tables, because they answer two questions

Activity is **what the gateway did**: session initialization, tool listing and
calls, backend connects, failed requests. Audit is **who changed what**: backend,
agent, credential, policy and settings mutations, session lifecycle, and operator
sign-ins. They are separate tables on the gateway with separate retention, and
they are separate pages here with separate filters, tables, detail pages and
status vocabularies (`features/activity/` and `features/audit/`).

One combined "events" view was rejected. Operational volume would bury the
security record, and an operator filtering for `session.access.denied` would have
to page past tool calls to find it. The two near-identical table files are the
deliberate cost of that separation.

The vocabularies are the gateway's own enums, mirrored as closed types:
`ACTIVITY_TYPES`/`ACTIVITY_OUTCOMES` and `AUDIT_ACTIONS`/`AUDIT_ACTORS`/
`AUDIT_RESULTS`/`AUDIT_TARGET_TYPES`. A shared badge component was rejected for
the same reason the tables are separate.

### One URL → filter translation

`lib/events/query.ts` is the only place a query string becomes an API filter.
Three callers need the same answer — the list page, its pagination links, and the
CSV export — and parsing in each would let the export honour a filter the page
dropped. A value outside a closed enum, a non-UUID id, or a malformed instant is
**dropped rather than forwarded**: the gateway would answer `400`, and the
operator would see an error where they expected a filter.

Note `targetType`: the *event* schema allows `operator`, but `listAuditQuerySchema`
does not, so the filter menu offers only `backend|agent|credential|policy|session|
settings`. Offering `operator` would be a guaranteed `400`.

### Metadata is disclosed by the detail read only

`toAuditListItem` strips `metadata` from every list row, so the list payload
cannot leak it and the CSV — which is built from the list shape — cannot contain
it either. The audit detail page is the single disclosure boundary, and it renders
metadata as flat key/value pairs (the schema allows at most 20 entries of
string|number|boolean, no nesting). A test feeds a list row *with* metadata and
asserts the page still does not render it.

### The CSV export

`GET /api/audit-export` is a route handler, not a browser download: the gateway is
loopback-only, and building the CSV client-side would mean shipping the audit page
to the browser first. It forwards the operator cookie, so it is the same
authenticated read the page makes.

- **Same filters.** It parses the query with `parseAuditQuery` and builds its link
  with `auditExportHref`, so page and file cannot diverge, and a hand-crafted
  parameter is dropped before the gateway sees it.
- **Bounded.** `EXPORT_ROW_CAP = 1000` across at most 10 pages of 100. An
  unbounded export of a growing security table turns one click into a memory
  problem.
- **Truthful about truncation.** `x-audit-rows`, `x-audit-total` and
  `x-audit-truncated` report what happened rather than silently shipping a partial
  security record.
- **Formula-neutralised.** Every field is quoted with inner quotes doubled, and a
  leading `=`, `+`, `-`, `@`, tab or CR is prefixed with an apostrophe. Audit ids
  and enums are safe today, but `actorId`/`targetId` are free-form strings, so the
  escape is unconditional.
- **Failure is an error, not an empty file.** A gateway failure returns
  `AUDIT_EXPORT_FAILED` with the gateway's status (or `502`), and no CSV.

### Immutability is structural, not a hidden button

There is no edit and no delete control anywhere in the audit UI — and nothing to
add one to: `AuditRepository` has no update or delete method and the gateway
exposes no such route. The detail page says what that means rather than implying
the UI is merely read-only.

### No derived metrics

The activity tiles come from `/overview.activity` — the recorded total and the
recorded `byOutcome`/`byType` breakdown. There is no rate, no average latency, and
no graph, because those are not collected. A failed overview renders `Unavailable`
rather than `0`. The audit page has no tile at all: there is no audit-count
endpoint, and the number under the table is the filtered total the API returned.

### What this phase deliberately does not do

- **No activity write or retention UI.** Activity is written by the gateway.
- **No audit mutation of any kind.**
- **No export of activity.** Only audit was asked for, and activity has no
  retention story that makes a full dump a good idea.
- **No date-range pickers.** `after`/`before` are supported by the contract and by
  `parseActivityQuery`/`parseAuditQuery`, but the UI does not offer inputs for
  them, because a half-validated date control would produce `400`s. The parser
  accepts them so a bookmarked URL works.

## 43. Phase 10.6 files

| File | Purpose |
| --- | --- |
| `src/lib/api/types.ts` | `ActivityType`/`ActivityOutcome`, `AuditAction`/`AuditActorType`/`AuditResult`/`AuditTargetType`, rewritten `ActivityEvent`/`AuditEvent`, `ActivityQuery`/`AuditQuery` |
| `src/lib/api/endpoints.ts` | `getActivity`, `getActivityEvent`, `getAudit`, `getAuditEvent` |
| `src/lib/events/query.ts` | The single URL→filter allowlist; `activityHref`, `auditHref`, `auditExportHref` |
| `src/lib/events/csv.ts` | Columns, quoting, formula neutralisation, row/page caps, filename |
| `src/app/api/audit-export/route.ts` | Bounded, filter-preserving CSV handler |
| `src/app/(dashboard)/dashboard/activity/page.tsx` | List; tiles from `/overview`; agent/backend names degrade independently |
| `src/app/(dashboard)/dashboard/activity/[eventId]/page.tsx` | Detail; `404` → `notFound()`, `400` → error |
| `src/app/(dashboard)/dashboard/audit/page.tsx` | List + export |
| `src/app/(dashboard)/dashboard/audit/[eventId]/page.tsx` | Detail with metadata |
| `src/features/activity/{event-status,activity-table,activity-detail}.tsx` | Activity vocabulary, table, detail |
| `src/features/audit/{audit-status,audit-table,audit-detail,audit-export}.tsx` | Audit vocabulary, table, detail, export link |
| `src/lib/navigation.ts` | Activity and Audit Trail marked implemented |
| `tests/events-query.test.ts` | Allowlist, filter detection, href equality, CSV quoting/neutralisation/cap (18 tests) |
| `tests/audit-export-route.test.ts` | Filter fidelity, row cap, truncation header, failure without a file (6 tests) |
| `tests/activity-list.test.tsx` | Empty vs no-match vs error, name degradation, whole-table tiles (9 tests) |
| `tests/audit-list.test.tsx` | Empty vs no-match vs error, no mutation control, export filters, no metadata in list (8 tests) |

## 44. Phase 10.6 acceptance checklist

- [x] Activity and Audit Trail are separate views, with separate types, filters,
      tables, details and status vocabularies.
- [x] Filters are the gateway's own enums; `targetType` omits `operator` because
      the list schema does.
- [x] All filtering and pagination is server-side; a filter value outside the
      contract is dropped, never forwarded as a `400`.
- [x] Empty, no-match, unavailable and invalid-response are distinct states.
- [x] CSV export respects the page's filters, escapes correctly, neutralises
      formulas, is row-capped, and reports truncation.
- [x] Export failure returns an error envelope and no file.
- [x] Audit `metadata` is rendered only by the detail read; the list and the CSV
      cannot contain it.
- [x] No edit or delete control exists, and no gateway path could back one.
- [x] No metric is computed from a page of rows; failed counts render
      `Unavailable`.
- [x] 406 dashboard tests (up from 366) across 38 files; both typechecks; the
      dashboard production build emits `/dashboard/audit`, `/dashboard/audit/[eventId]`
      and `/api/audit-export`.
- [ ] A real browser click-path and downloading a CSV in a real spreadsheet —
      **not verified** (no browser automation here).

## 45. Phase 10.7 routes

```text
/dashboard/monitoring   → liveness, readiness, dependency health, backend runtime, diagnostics
/health                 → read raw (outside /api/v1, no envelope) and shape-validated
/ready                  → read raw, 200 or 503, shape-validated
/api/v1/monitoring/health, /monitoring/backends, /monitoring/sessions, /diagnostics
```

### Four questions, deliberately not collapsed

| Section | Endpoint | The question |
| --- | --- | --- |
| Liveness | `/health` | Is the process serving? Never consults storage. |
| Readiness | `/ready` | Can it serve? Storage answers and the migration ledger is readable. |
| Dependency health | `/api/v1/monitoring/health` | Storage plus the backend registry. |
| Backend runtime | `/api/v1/monitoring/backends` | What each connection is doing right now. |

One green dot for all four was rejected: liveness can pass while readiness fails,
and readiness deliberately ignores optional backends — a gateway with every
backend disconnected is still ready to accept work. A single status would have to
pick one of those to be wrong about.

### `/ready` is not a fetch failure

`fetch` does not throw on a non-2xx, and readiness answers `503` with a real
document. So the page trusts the **body**: `isReadiness` validates the payload,
because the dashboard's own proxy also answers `503` — with an `{error}` envelope
— when the gateway is not running at all. Same status, opposite meaning; the shape
decides. `fetchReadiness` now throws `invalid-response` rather than returning a
cast, so a proxy error page cannot render as "not ready" for a live gateway.

`/health` is read raw too (it has no `{data}` envelope) and is validated by
`isGatewayHealth` for the same reason.

### Seven independent reads, settled independently

The page issues all seven concurrently through `Promise.allSettled` and renders
each as a `Read<T>`: `{ok: true, value}` or `{ok: false, error}`. One endpoint
failing degrades one card. Sequencing would make the slowest endpoint the page's
latency, and a shared try/catch would hide six answers that are still true.

A failed section renders an error and never a zero. A failed snapshot leaves
Backends / Tools available / Uptime at `Unavailable`, which is a different claim
from `0`.

### No metric that is not recorded

There is no uptime percentage, request rate, latency percentile, error ratio, CPU
or memory figure, and no chart anywhere on this page. The gateway collects none of
them and keeps no history — `/settings` reports `features.metrics: false` — so a
trend line drawn from one snapshot would be the most convincing lie in the
dashboard. A test asserts the rendered text contains no `%`, `req/s`, `p95`, `p99`,
`CPU` or memory-size token.

**Historical metrics are deferred**, not faked. They need a time-series store the
gateway does not have; when it exists, this page gains one section and no other
part of it changes.

### Diagnostics is the safe payload, rendered as-is

`GET /diagnostics` returns a fixed non-secret shape: service and runtime identity,
storage status and migration version, environment and log level, registry counts,
the auth posture, and two request limits. The panel prints those fields and adds
nothing — no environment values, no secret or hash, no headers, no paths, no stack
trace. The page never falls back to reading the dashboard's own process
environment, because the dashboard's config is not the gateway's.

There is no "copy everything" button: the panel is four short lists, and a
clipboard button invites pasting unrelated context into a ticket.

### Manual refresh only

`RefreshButton` re-renders the server tree. It is `isDisabled` and `isLoading`
while pending, and the button's own in-flight ref guard prevents a second
transition from the same click. No polling and no WebSocket: an idle monitoring
tab is not a request generator, and live push would need infrastructure this
phase does not add.

## 46. Phase 10.7 files

| File | Purpose |
| --- | --- |
| `src/lib/api/types.ts` | `MonitoringHealth`; `GatewayHealth.timestamp` added to match the probe |
| `src/lib/api/client.ts` | `fetchLiveness`; `fetchReadiness` now validates instead of casting |
| `src/lib/api/endpoints.ts` | `getMonitoringHealth` |
| `src/lib/validation/liveness.ts` | `isGatewayHealth` — the raw-probe shape check |
| `src/app/(dashboard)/dashboard/monitoring/page.tsx` | Seven concurrent reads, each settled independently |
| `src/features/monitoring/monitoring-content.tsx` | Liveness, readiness, dependency health, backend runtime cards |
| `src/features/monitoring/diagnostics-panel.tsx` | The safe diagnostics payload, field by field |
| `src/features/monitoring/monitoring-status.ts` | The three status vocabularies, in words plus tone |
| `src/features/monitoring/read.ts` | `Read<T>` / `settled()` — a rejected read as a renderable value |
| `src/lib/navigation.ts` | Monitoring marked implemented |
| `tests/monitoring-page.test.tsx` | Four sections apart, 503 body trusted, per-section degradation, no fabricated metric (9 tests) |
| `tests/validation-liveness.test.ts` | Error envelope rejected, readiness document rejected, extra field tolerated (6 tests) |

## 47. Phase 10.7 acceptance checklist

- [x] Liveness, readiness, dependency health and backend runtime are separate
      sections with separate endpoints and separate vocabularies.
- [x] `/ready`'s `503` is read as a real answer via its validated body, and a proxy
      `503` error envelope is rejected rather than mistaken for "not ready".
- [x] `/health` is read raw and validated before use.
- [x] Each read settles independently; one failure degrades one card.
- [x] A failed count renders `Unavailable`/`Not enabled`, never `0`.
- [x] No uptime percentage, rate, latency, CPU, memory, or chart — none is
      collected, and the absence is asserted by a test.
- [x] Diagnostics renders only the documented safe payload; no env values,
      secrets, hashes, headers, paths, or stack traces.
- [x] Manual refresh with a pending state and duplicate-transition protection; no
      polling, WebSocket, or Redis.
- [x] Historical metrics documented as deferred.
- [x] 421 dashboard tests (up from 406) across 40 files; both typechecks; the
      production build emits `/dashboard/monitoring`.
- [ ] A real browser click-path against a gateway in each of the four states —
      **not verified** (no browser automation here).

## 48. Phase 10.8 routes

```text
/dashboard/settings   → the effective gateway configuration, read-only
/api/proxy/ready     → the only client-side gateway read left
```

### Settings is read-only because the gateway is

`GET /api/v1/settings` answers `readOnly: true` and `features.settingsMutation:
false`, and no settings write route exists. The page therefore renders the values
and says where they come from, rather than drawing disabled inputs that imply an
editor is one permission away.

Every value is **environment-managed** — resolved by the gateway at startup from
its own environment. The three governance categories are rendered as separate
sections so they cannot be mistaken for one:

- **Where the gateway listens** — host, port, environment, the three endpoints.
- **Limits and sessions** — request/discovery/call timeouts, body limit, idle and
  lifetime windows. All bounds on one request or one protocol session; none is a
  per-agent quota.
- **Backend connections** — reconnect policy, plus `allowPrivateNetwork`, which is
  reported with a warning tone *because it widens the SSRF surface*: a
  security-relevant flag, not a secret.

`features` is rendered as availability flags with the reason a flag might matter
(`settingsMutation` unavailable → why this page is read-only; `metrics`
unavailable → why Monitoring shows snapshots only). No generic environment
key/value editor exists anywhere, and a test asserts the page renders no `form`,
`input`, `select`, or submit control at all.

### Operator account: a documented procedure, not a fake form

There is no password-change API and no account-management route, so the page says
so and documents the real recovery: stop the gateway, delete the operator row,
run `pnpm operator:create`, restart, sign in again. Deleting the row invalidates
its sessions; audit records are untouched. A password form that posted nowhere
would be worse than no form.

### The placeholder module is gone

`features/placeholder/` is deleted, and `NavItem` no longer carries
`implemented` or `summary` — with no placeholder left, both fields were dead
weight the compiler could not catch. `ALL_NAV_ITEMS` still drives the sidebar and
the active-route highlight; a route not in the table has no page.

### The read proxy is narrower than it was

The allowlist in `app/api/proxy/[...path]/route.ts` previously forwarded
`/overview`, `/monitoring(/health|backends|sessions|runtime)`, `/diagnostics` and
`/settings` to the browser. Every one of those is read by a server component, so
the browser never fetches them through this route; the only client-side gateway
read in the dashboard is the readiness probe in `gateway-status.tsx`. The
allowlist now forwards **`/ready` only** — a proxied path with no caller is
surface area for nothing. When a second client-side read appears, it gets an
entry with the client that fetches it.

### Streaming fallback, once

`dashboard/loading.tsx` renders `PageSkeleton` inside `PageContainer` for every
page below `/dashboard`. Next walks up to the nearest `loading.tsx`, so one file
covers all twenty-three routes; it also supplies the Suspense boundary a server
component that awaits a `no-store` read needs, so the shell paints before the
gateway answers. `OverviewSkeleton` was renamed `PageSkeleton` because it is no
longer overview-specific.

### Route review (all 23 routes + `/login`)

- `/dashboard` redirects nothing; `/` redirects to `/dashboard`.
- Unknown route under `/dashboard` hits `(dashboard)/not-found.tsx`, which keeps
  the shell and links back to the overview.
- Every detail route maps a gateway `404` to `notFound()` and a `400` to an error
  state; none fabricates an empty record.
- Every page sets `metadata.title`, which the root template renders as
  `"<title> · Universal MCP Gateway"`.
- Sessions, agents, backends, tools, policies, activity and audit redirect an
  unauthenticated operator to `/login` with `next` preserved (the layout's
  `requireOperator`), so no protected page is reachable without a session.
- Navigation matches the route table exactly: verified by diffing
  `NAV_SECTIONS` hrefs against the on-disk `page.tsx` paths — ten module roots in
  the nav, ten in the tree, no orphans either direction (nested detail routes are
  not nav entries by design).

## 49. Phase 10.8 files

| File | Purpose |
| --- | --- |
| `src/features/settings/settings-content.tsx` | Read-only configuration; three governance categories; capability flags; operator procedure |
| `src/app/(dashboard)/dashboard/settings/page.tsx` | The read; failure is an error state, not blanks |
| `src/lib/navigation.ts` | `implemented`/`summary` removed; ten routes, all real |
| `src/features/placeholder/` | **Deleted** — no placeholder route remains |
| `src/app/(dashboard)/dashboard/loading.tsx` | One streamed fallback for every dashboard route |
| `src/components/feedback/loading.tsx` | `OverviewSkeleton` → `PageSkeleton` |
| `src/app/api/proxy/[...path]/route.ts` | Allowlist narrowed to `/ready`, the only client-side read |
| `tests/settings-page.test.tsx` | No form control, read-only labelling, error state (6 tests) |

## 50. Phase 10.8 acceptance checklist

- [x] Settings renders only what `/settings` returns; nothing invented, no
      config status guessed.
- [x] Read-only / safe-mutable / environment-managed are visibly separated; there
      is no generic env editor, and no form control at all (asserted).
- [x] Operator account features deferred with the documented recovery procedure.
- [x] Placeholder module deleted; no placeholder route remains in the build.
- [x] Navigation table matches the route tree exactly (diffed, no orphans).
- [x] Every route has a title; unknown routes hit a not-found page that keeps the
      shell; unauthenticated access lands on sign-in with `next`.
- [x] Read proxy allowlist reduced to the one path the browser actually fetches.
- [x] No `dangerouslySetInnerHTML`, no `console.*`, no token/hash/secret rendered
      anywhere (grepped across `src/`).
- [x] 427 dashboard tests (up from 421) across 41 files; both typechecks; the
      production build; gateway build clean.
- [ ] A real browser pass over all 23 routes — **not verified** here.
