/**
 * The dashboard's route table, in navigation order.
 *
 * One list feeds the sidebar, the breadcrumbs, and each page's title, so a new
 * destination cannot exist in the sidebar but not in the heading. `phase` says
 * which routes are real today: Phase 9 implements Overview; the rest render an
 * explicit "not implemented yet" placeholder rather than a fabricated screen.
 */

export interface NavItem {
  /** Path inside the app. */
  href: string;
  label: string;
  /** Semantic Astryx icon name, verified against `astryx docs icons`. */
  icon: string;
  /** `false` renders as a real placeholder, never as fake content. */
  implemented: boolean;
  /** One sentence used by the placeholder page. */
  summary: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [
      {
        href: '/dashboard',
        label: 'Overview',
        icon: 'info',
        implemented: true,
        summary: 'Gateway status and the counts the management API reports.',
      },
    ],
  },
  {
    title: 'Registry',
    items: [
      {
        href: '/dashboard/backends',
        label: 'Backends',
        icon: 'externalLink',
        implemented: true,
        summary: 'Registered MCP backends, their transport, and runtime state.',
      },
      {
        href: '/dashboard/tools',
        label: 'Tools',
        icon: 'wrench',
        implemented: false,
        summary: 'The discovered tool catalog, including withheld name conflicts.',
      },
      {
        href: '/dashboard/agents',
        label: 'Agents',
        icon: 'info',
        implemented: false,
        summary: 'Agent profiles and the credentials they authenticate with.',
      },
      {
        href: '/dashboard/policies',
        label: 'Access Policies',
        icon: 'check',
        implemented: false,
        summary: 'Allow/deny rules and their assignment to agents.',
      },
    ],
  },
  {
    title: 'Operations',
    items: [
      {
        href: '/dashboard/sessions',
        label: 'Sessions',
        icon: 'clock',
        implemented: false,
        summary: 'Live MCP sessions, their binding, and lifecycle controls.',
      },
      {
        href: '/dashboard/activity',
        label: 'Activity',
        icon: 'funnel',
        implemented: false,
        summary: 'Operational history: calls, connections, and failures.',
      },
      {
        href: '/dashboard/monitoring',
        label: 'Monitoring',
        icon: 'viewColumns',
        implemented: false,
        summary: 'Runtime, storage, and backend health in one view.',
      },
      {
        href: '/dashboard/audit',
        label: 'Audit Trail',
        icon: 'eyeSlash',
        implemented: false,
        summary: 'Administrative history of every change the gateway recorded.',
      },
    ],
  },
  {
    title: 'Configuration',
    items: [
      {
        href: '/dashboard/settings',
        label: 'Settings',
        icon: 'wrench',
        implemented: false,
        summary: 'Effective, non-secret gateway configuration. Read-only.',
      },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/**
 * Longest matching prefix wins, so `/dashboard/backends/new` highlights
 * "Backends" rather than falling back to "Overview".
 */
export function findActiveItem(pathname: string): NavItem | undefined {
  return [...ALL_NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
