'use client';

import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import { TopNav } from '@astryxdesign/core/TopNav';
import { usePathname } from 'next/navigation';

import { AccountMenu } from '@/components/layout/account-menu';
import { useThemeMode, type ThemeMode } from '@/components/theme/dashboard-theme';
import { findActiveItem } from '@/lib/navigation';

/**
 * Header: current location, theme control, operator identity, and the gateway
 * connection indicator (`children`, passed from the server-rendered layout so it
 * can carry a real readiness probe result).
 *
 * The account area shows the identity the gateway confirmed for this request
 * (Phase 10.0) and offers sign-out. It is rendered from the server component, so
 * the username is never a value the browser supplied.
 */
export function AppHeader({
  children,
  operator,
}: {
  children?: React.ReactNode;
  operator?: { username: string; role: string };
}): React.ReactElement {
  const pathname = usePathname();
  const active = findActiveItem(pathname);

  return (
    <TopNav
      label="Dashboard header"
      heading={
        <HStack gap={2} align="center">
          <span
            aria-hidden="true"
            className="h-6 w-6 shrink-0 rounded-md bg-[var(--color-accent)]"
          />
          <Text type="label">Universal MCP Gateway</Text>
        </HStack>
      }
      startContent={
        <Breadcrumbs variant="supporting">
          <BreadcrumbItem href="/dashboard">Dashboard</BreadcrumbItem>
          {active === undefined || active.href === '/dashboard' ? (
            <BreadcrumbItem isCurrent>Overview</BreadcrumbItem>
          ) : (
            <BreadcrumbItem isCurrent>{active.label}</BreadcrumbItem>
          )}
        </Breadcrumbs>
      }
      endContent={
        <HStack gap={3} align="center">
          <ThemeControl />
          {children}
          {operator === undefined ? null : <AccountMenu username={operator.username} role={operator.role} />}
        </HStack>
      }
    />
  );
}

/** The only colour-mode control. It writes through to Astryx's `<Theme mode>`. */
export function ThemeControl(): React.ReactElement {
  const { mode, setMode } = useThemeMode();

  return (
    <SegmentedControl
      label="Colour theme"
      size="sm"
      value={mode}
      onChange={(value) => setMode(value as ThemeMode)}
    >
      <SegmentedControlItem value="light" label="Light" />
      <SegmentedControlItem value="dark" label="Dark" />
      <SegmentedControlItem value="system" label="System" />
    </SegmentedControl>
  );
}

/** Page-level heading rendered inside the content area, not the header bar. */
export function HeaderTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return <Heading level={1}>{children}</Heading>;
}
