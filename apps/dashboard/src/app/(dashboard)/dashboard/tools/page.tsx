import type { Metadata } from 'next';

import { Card } from '@astryxdesign/core/Card';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader, SectionBlock } from '@/components/layout/page-container';
import { MetricCard } from '@/components/ui/metric-card';
import { listBackends } from '@/lib/api/backends';
import { getMonitoring } from '@/lib/api/endpoints';
import { getDiscoveryReports, getToolConflicts, listTools } from '@/lib/api/tools';
import type {
  DiscoveryReport,
  Page as CatalogPage,
  Tool,
  ToolAvailability,
  ToolConflict,
  ToolQuery,
} from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';
import { DiscoveryStatus } from '@/features/tools/tool-status';
import { ToolRefresh } from '@/features/tools/tool-refresh';
import { ToolsTable } from '@/features/tools/tools-table';

export const metadata: Metadata = { title: 'Tools' };

export const dynamic = 'force-dynamic';

/**
 * The tool catalog.
 *
 * Four reads, each a different question:
 *
 *  * `GET /api/v1/tools` — the table, with the gateway's own `search`,
 *    `backendId`, `availability` and pagination;
 *  * `GET /api/v1/tools/discovery` — what the last refresh per backend produced;
 *  * `GET /api/v1/tools/conflicts` — public names withheld because more than one
 *    backend tool claimed them;
 *  * `GET /api/v1/monitoring` — the catalog counts, because the list is filtered
 *    and paginated and counting its rows would report "1 tool" on page one of
 *    twenty. `/overview` reads the same payload, so the two screens cannot
 *    disagree.
 *
 * A failed catalog read is an error state — not an empty catalog — because those
 * are different claims. A failed side read degrades to its own notice, so a
 * discovery-report outage does not take the table with it.
 */

/** Only parameters the gateway accepts are read; it rejects anything else too. */
function parseQuery(params: Record<string, string | string[] | undefined>): ToolQuery {
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const search = single(params.search)?.trim();
  const page = Number(single(params.page) ?? '1');
  const availability = single(params.availability);

  return {
    ...(search === undefined || search === '' ? {} : { search }),
    ...(single(params.backendId) === undefined || single(params.backendId) === ''
      ? {}
      : { backendId: single(params.backendId) }),
    ...(availability === 'available' || availability === 'unavailable' || availability === 'conflict'
      ? { availability: availability as ToolAvailability }
      : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
  };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const query = parseQuery(await searchParams);

  let list: CatalogPage<Tool> | undefined;
  let listError: unknown;

  try {
    list = await listTools(query);
  } catch (error) {
    listError = error;
  }

  // The table shows backend names; the catalog stores an id. `limit: 100` is the
  // API maximum, and the form needs the same list, so one read serves both. When
  // it fails the columns fall back to ids and the filter offers only "Any".
  const backends = await listBackends({ limit: 100 })
    .then((page) => page.data.map((backend) => ({ id: backend.id, name: backend.name })))
    .catch(() => []);

  const counts = await getMonitoring()
    .then((monitoring) => monitoring.tools)
    .catch(() => null);

  const reports: DiscoveryReport[] | null = await getDiscoveryReports().catch(() => null);
  const conflicts: ToolConflict[] | null = await getToolConflicts().catch(() => null);

  return (
    <PageContainer>
      <VStack gap={6}>
        <PageHeader
          title="Tools"
          description="Every tool the gateway discovered from its backends, including the ones it withholds. A listed tool is not necessarily callable by an agent — policy decides that."
          actions={<ToolRefresh />}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Known tools" value={counts?.total ?? null} />
          <MetricCard label="Available" value={counts?.available ?? null} />
          <MetricCard
            label="Withheld"
            value={counts === null ? null : counts.unavailable + counts.conflict}
            detail="Unavailable or withheld by a name conflict"
          />
          <MetricCard
            label="Backends with a catalog"
            value={counts?.backendsWithCatalog ?? null}
            detail="Discovery has run for these"
          />
        </div>

        {list === undefined ? (
          <ErrorState error={listError} title="The tool catalog could not be read" />
        ) : (
          <ToolsTable tools={list.data} pagination={list.pagination} query={query} backends={backends} />
        )}

        <SectionBlock
          title="Name conflicts"
          description="A public name claimed by more than one backend tool. Both are withheld from routing until the collision is resolved; the gateway never picks a winner by ordering."
        >
          <Card padding={4}>
            {conflicts === null ? (
              <Text type="supporting" as="p">
                The conflict list could not be read. Routing is unaffected — this is a report, not a control.
              </Text>
            ) : conflicts.length === 0 ? (
              <Text type="supporting" as="p">
                No name conflicts. Every discovered public name is unique.
              </Text>
            ) : (
              <VStack gap={3}>
                {conflicts.map((conflict) => (
                  <div key={conflict.publicName}>
                    <Text type="code">{conflict.publicName}</Text>
                    <VStack gap={1}>
                      {conflict.claimants.map((claimant) => (
                        <Text key={`${claimant.backendId}-${claimant.originalName}`} type="supporting">
                          {claimant.originalName} ·{' '}
                          {backends.find((backend) => backend.id === claimant.backendId)?.name ?? claimant.backendId}
                        </Text>
                      ))}
                    </VStack>
                  </div>
                ))}
              </VStack>
            )}
          </Card>
        </SectionBlock>

        <SectionBlock
          title="Discovery"
          description="What the last catalog refresh per backend produced. Refreshing is the only catalog write the gateway offers — it dials each backend."
        >
          <Card padding={4}>
            {reports === null ? (
              <Text type="supporting" as="p">
                Discovery reports could not be read.
              </Text>
            ) : reports.length === 0 ? (
              <Text type="supporting" as="p">
                No backend has been discovered yet. Connect a backend, then refresh.
              </Text>
            ) : (
              <VStack gap={3}>
                {reports.map((report) => (
                  <VStack key={report.backendId} gap={1}>
                    <DiscoveryStatus report={report} />
                    <Text type="supporting">
                      {backends.find((backend) => backend.id === report.backendId)?.name ?? report.backendId} · last
                      run {formatTimestamp(report.discoveredAt)}
                    </Text>
                    {report.lastError === undefined ? null : (
                      <Text type="supporting" as="p">
                        {report.lastError}
                      </Text>
                    )}
                  </VStack>
                ))}
              </VStack>
            )}
          </Card>
        </SectionBlock>
      </VStack>
    </PageContainer>
  );
}
