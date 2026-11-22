import { AppShell } from '@astryxdesign/core/AppShell';

import { GatewayStatus } from '@/components/feedback/gateway-status';
import { AppHeader, ThemeControl } from '@/components/layout/app-header';
import { PrimaryNavigation } from '@/components/navigation/primary-navigation';
import { fetchReadiness } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import type { Readiness } from '@/lib/api/types';

/**
 * The application shell.
 *
 * `AppShell` is Astryx's own page frame: it renders the skip link, the banner
 * landmark, the `<main>` landmark, and moves the side nav into a modal drawer
 * with focus trapping below the breakpoint. Building those by hand would be the
 * "small custom component" case the design-system rule reserves for genuine
 * gaps.
 *
 * `height="fill"` gives the dashboard an independently scrolling content area —
 * the documented choice for dashboard layouts — and `contentPadding={0}` lets
 * each page own its spacing.
 *
 * The readiness probe is read on the server so the first paint already shows a
 * real answer; a failed probe renders "unreachable" rather than a spinner that
 * never resolves. `/ready` stays unauthenticated, so this read is meaningful
 * even when the session has just expired.
 */
export async function AppShellLayout({
  children,
  operator,
}: {
  children: React.ReactNode;
  /** Confirmed by the gateway's session probe, never supplied by the browser. */
  operator?: { username: string; role: string };
}): Promise<React.ReactElement> {
  let readiness: Readiness | null = null;
  try {
    readiness = await fetchReadiness({ cache: 'no-store' });
  } catch (error) {
    if (!isApiError(error)) throw error;
    // An unreachable gateway is a reportable state, not a crash.
  }

  return (
    <AppShell
      height="fill"
      contentPadding={0}
      variant="section"
      topNav={
        <AppHeader {...(operator === undefined ? {} : { operator })}>
          <GatewayStatus initial={readiness} />
        </AppHeader>
      }
      sideNav={
        <PrimaryNavigation
          footer={
            /* Mobile drawer only: these controls leave the header below `md`
               so the hamburger keeps its place. A desktop rail still shows
               neither — the header carries them there. */
            <div className="flex flex-col gap-3 md:hidden">
              <GatewayStatus initial={readiness} />
              <ThemeControl />
            </div>
          }
        />
      }
    >
      {children}
    </AppShell>
  );
}
