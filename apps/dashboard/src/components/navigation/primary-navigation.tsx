'use client';

// Only `./SideNav` is a package export; the heading, item and section are
// re-exported from it (verified against the package's `exports` map).
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { NAV_SECTIONS, isActive } from '@/lib/navigation';

/**
 * Primary navigation.
 *
 * `isSelected` is what sets `aria-current="page"`, so the current destination is
 * announced rather than encoded in colour alone. `as={Link}` keeps navigation
 * client-side; `collapsible` gives the desktop rail and the mobile drawer the
 * same component, which AppShell moves between slots at the breakpoint.
 *
 * No account menu is rendered: there is no operator identity yet, and inventing
 * one would imply an authentication boundary the gateway does not have.
 */
export function PrimaryNavigation(): React.ReactElement {
  const pathname = usePathname();

  return (
    <SideNav
      collapsible
      header={
        <SideNavHeading heading="Universal MCP Gateway" headingHref="/dashboard" subheading="Control plane" />
      }
    >
      {NAV_SECTIONS.map((section) => (
        <SideNavSection key={section.title} title={section.title}>
          {section.items.map((item) => (
            <SideNavItem
              key={item.href}
              as={Link}
              href={item.href}
              label={item.label}
              icon={item.icon}
              isSelected={isActive(pathname, item.href)}
            />
          ))}
        </SideNavSection>
      ))}
    </SideNav>
  );
}
