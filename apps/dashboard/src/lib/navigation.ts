/**
 * The dashboard's route table, in navigation order.
 *
 * One list feeds the sidebar and the active-route highlight, so a destination
 * cannot exist in the sidebar but not as a page. Every route below is built: as
 * of Phase 10.8 there is no placeholder module left, and a route that is not in
 * this table has no page.
 */

export interface NavItem {
  /** Path inside the app. */
  href: string;
  label: string;
  /** Semantic Astryx icon name, verified against `astryx docs icons`. */
  icon: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Overview',
    items: [{ href: '/dashboard', label: 'Overview', icon: 'info' }],
  },
  {
    title: 'Registry',
    items: [
      { href: '/dashboard/backends', label: 'Backends', icon: 'externalLink' },
      { href: '/dashboard/tools', label: 'Tools', icon: 'wrench' },
      { href: '/dashboard/integrations', label: 'Integrations', icon: 'externalLink' },
      { href: '/dashboard/agents', label: 'Agents', icon: 'info' },
      { href: '/dashboard/policies', label: 'Access Policies', icon: 'check' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/dashboard/sessions', label: 'Sessions', icon: 'clock' },
      { href: '/dashboard/activity', label: 'Activity', icon: 'funnel' },
      { href: '/dashboard/monitoring', label: 'Monitoring', icon: 'viewColumns' },
      { href: '/dashboard/audit', label: 'Audit Trail', icon: 'eyeSlash' },
    ],
  },
  {
    title: 'Configuration',
    items: [{ href: '/dashboard/settings', label: 'Settings', icon: 'wrench' }],
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
