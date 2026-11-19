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
| Phase 10 module pages | Not implemented | Every module route except Overview is an intentional placeholder |

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
