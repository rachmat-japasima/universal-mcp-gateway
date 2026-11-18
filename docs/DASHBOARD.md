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
