import type { Metadata } from 'next';

import { RefreshButton } from '@/components/feedback/refresh-button';
import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { OverviewContent } from '@/features/overview/overview-content';
import { getOverview } from '@/lib/api/endpoints';
import { isApiError } from '@/lib/api/errors';

export const metadata: Metadata = { title: 'Overview' };

/**
 * The only fully implemented Phase 9 screen, and the pattern Phase 10 follows:
 *
 *   * a server component, so the gateway is called from the Node process — never
 *     from the browser, which cannot reach a loopback-only, CORS-free gateway;
 *   * a `no-store` read: these are live operational counts, and a cached number
 *     is a wrong number;
 *   * a failed read renders an error state, never an empty one. Rendering "0
 *     backends" because the gateway is down is the exact false claim the API's
 *     `null` was designed to prevent.
 *
 * The read is awaited in the page rather than streamed from a child. A server
 * component's thrown error cannot be caught by a parent's try/catch once it has
 * been streamed, so a separate boundary would have looked correct and never run.
 */
export default async function OverviewPage(): Promise<React.ReactElement> {
  let content: React.ReactNode;
  try {
    content = <OverviewContent overview={await getOverview()} />;
  } catch (error) {
    if (!isApiError(error)) throw error;
    content = <ErrorState error={error} title="Could not read the overview" />;
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Overview"
          description="Live state of the gateway, read from the management API."
          actions={<RefreshButton label="Refresh overview" />}
        />
        {content}
      </div>
    </PageContainer>
  );
}
