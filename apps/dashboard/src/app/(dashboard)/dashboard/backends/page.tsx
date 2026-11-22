import type { Metadata } from 'next';

import { LinkButton } from '@/components/ui/link-button';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { MetricCard } from '@/components/ui/metric-card';
import { listBackends } from '@/lib/api/backends';
import { getMonitoringBackends } from '@/lib/api/endpoints';
import type { BackendCounts, BackendQuery, BackendTransport, Page as BackendPage } from '@/lib/api/types';
import type { Backend } from '@/lib/api/types';
import { BackendsTable } from '@/features/backends/backends-table';

export const metadata: Metadata = { title: 'Backends' };

export const dynamic = 'force-dynamic';

/**
 * The registry.
 *
 * Two reads, both real:
 *
 *  * `GET /api/v1/backends` is the table, with the gateway's own `search`,
 *    `transport`, `enabled` and pagination;
 *  * `GET /api/v1/monitoring/backends` supplies the summary counts.
 *
 * Counts come from monitoring rather than from the list because the list is
 * filtered and paginated: counting its rows would report "1 backend" on a page
 * of 1 out of 20. Monitoring reports the whole registry, including all seven
 * runtime states, so no number here is derived or guessed.
 *
 * A failed counts read does not take the table with it — the tiles say
 * "Unavailable" and the table still renders. A failed registry read does, and is
 * an error state rather than an empty list, because those are different claims.
 */

/** Only the parameters the gateway accepts are read; it ignores anything else too. */
function parseQuery(params: Record<string, string | string[] | undefined>): BackendQuery {
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const search = single(params.search)?.trim();
  const transport = single(params.transport);
  const enabled = single(params.enabled);
  const page = Number(single(params.page) ?? '1');

  return {
    ...(search === undefined || search === '' ? {} : { search }),
    ...(transport === 'stdio' || transport === 'streamable-http' ? { transport: transport as BackendTransport } : {}),
    ...(enabled === 'true' ? { enabled: true } : enabled === 'false' ? { enabled: false } : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
  };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const query = parseQuery(await searchParams);

  let list: BackendPage<Backend> | undefined;
  let listError: unknown;

  try {
    list = await listBackends(query);
  } catch (error) {
    listError = error;
  }

  // Read after the list so a registry failure is reported before a counts
  // failure; the counts are decoration beside the table, not the page.
  const counts: BackendCounts | null = await getMonitoringBackends()
    .then((monitoring) => monitoring.counts)
    .catch(() => null);

  const header = (
    <PageHeader
      title="Backends"
      description="MCP servers registered with this gateway. Each one is a configuration record; connecting it is a separate action."
      actions={<LinkButton label="Add Backend" href="/dashboard/backends/new" variant="primary" />}
    />
  );

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        {header}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Total backends" value={counts?.total ?? null} />
          <MetricCard label="Enabled" value={counts?.enabled ?? null} />
          <MetricCard label="Connected" value={counts?.runtime.connected ?? null} />
          <MetricCard
            label="Error or unhealthy"
            value={counts === null ? null : counts.runtime.error + counts.runtime.unhealthy}
            detail="Runtime states reported by the lifecycle manager"
          />
        </div>

        {list === undefined ? (
          <ErrorState error={listError} title="The backend registry could not be read" />
        ) : (
          <BackendsTable backends={list.data} pagination={list.pagination} query={query} />
        )}
      </div>
    </PageContainer>
  );
}
