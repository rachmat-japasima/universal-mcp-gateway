import type { Metadata } from 'next';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { MetricCard } from '@/components/ui/metric-card';
import { listAgents } from '@/lib/api/agents';
import { listBackends } from '@/lib/api/backends';
import { getActivity, getOverview } from '@/lib/api/endpoints';
import type { ActivityEvent, Page as EventPage } from '@/lib/api/types';
import { parseActivityQuery, readerOf } from '@/lib/events/query';
import { ActivityTable } from '@/features/activity/activity-table';

export const metadata: Metadata = { title: 'Activity' };

export const dynamic = 'force-dynamic';

/**
 * Operational history: what the gateway did.
 *
 * One list read with the gateway's own filters, plus `/overview` for the totals
 * and two name reads so an id column is readable. The name reads are optional on
 * purpose — a failed agent list leaves the ids, which are still authoritative.
 *
 * This page is **not** the audit trail. Activity answers "what did the gateway
 * do?" (tool calls, initializations, backend connects, failed requests) and
 * audit answers "who changed what?" (administrative history). They are separate
 * tables, separate pages and separate filters, and merging them would make one
 * ambiguous table out of two different questions.
 *
 * Nothing here is a derived metric. There is no rate, no average, and no graph:
 * those numbers are not collected, so printing them would be an invention. The
 * tiles report the recorded event total and the recorded breakdown, and that is
 * all the API knows.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const query = parseActivityQuery(readerOf(await searchParams));

  let list: EventPage<ActivityEvent> | undefined;
  let listError: unknown;

  try {
    list = await getActivity(query);
  } catch (error) {
    listError = error;
  }

  const counts = await getOverview()
    .then((overview) => overview.activity)
    .catch(() => null);

  const agents = await listAgents({ limit: 100, sort: 'name' })
    .then((page) => page.data.map((agent) => ({ id: agent.id, name: agent.name })))
    .catch(() => undefined);

  const backends = await listBackends({ limit: 100 })
    .then((page) => page.data.map((backend) => ({ id: backend.id, name: backend.name })))
    .catch(() => undefined);

  const failures = counts?.byOutcome.failure;
  const denied = counts?.byOutcome.denied;

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Activity"
          description="What the gateway did: session initialization, tool listing and calls, backend connects, and failed requests. This is operational history, not the administrative audit trail."
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Recorded events" value={counts?.total ?? null} />
          <MetricCard
            label="Failures"
            value={failures ?? null}
            detail={counts === null ? undefined : 'Events whose recorded outcome was failure'}
          />
          <MetricCard
            label="Denied"
            value={denied ?? null}
            detail={counts === null ? undefined : 'Refused by policy or authentication'}
          />
          <MetricCard
            label="Event types recorded"
            value={counts === null ? null : Object.keys(counts.byType).length}
            detail="Distinct types present in the table"
          />
        </div>

        {list === undefined ? (
          <ErrorState error={listError} title="The activity list could not be read" />
        ) : (
          <ActivityTable
            events={list.data}
            pagination={list.pagination}
            query={query}
            {...(agents === undefined ? {} : { agents })}
            {...(backends === undefined ? {} : { backends })}
          />
        )}
      </div>
    </PageContainer>
  );
}
