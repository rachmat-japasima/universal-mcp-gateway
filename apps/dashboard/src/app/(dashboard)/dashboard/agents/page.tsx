import type { Metadata } from 'next';

import { Button } from '@astryxdesign/core/Button';
import Link from 'next/link';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { MetricCard } from '@/components/ui/metric-card';
import { listAgents } from '@/lib/api/agents';
import { getOverview } from '@/lib/api/endpoints';
import type { Agent, AgentQuery, Page as AgentPage } from '@/lib/api/types';
import { AgentsTable } from '@/features/agents/agents-table';

export const metadata: Metadata = { title: 'Agents' };

export const dynamic = 'force-dynamic';

/**
 * The agent registry.
 *
 * Two reads, both real:
 *
 *  * `GET /api/v1/agents` is the table, with the gateway's own `search`,
 *    `status`, `clientType` and pagination;
 *  * `GET /api/v1/overview` supplies the counts. `/monitoring` does not report
 *    agents, and the list is filtered and paginated — counting its rows would
 *    report "1 agent" on page one of twenty. `/overview` is the payload that
 *    carries registry-wide agent counts, and the landing page reads the same
 *    one, so the two screens cannot disagree.
 *
 * A failed list read is an error state, not an empty registry. A failed counts
 * read degrades the tiles only.
 */

/** Only the parameters the gateway accepts are read; it rejects anything else too. */
function parseQuery(params: Record<string, string | string[] | undefined>): AgentQuery {
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const search = single(params.search)?.trim();
  const clientType = single(params.clientType)?.trim();
  const status = single(params.status);
  const page = Number(single(params.page) ?? '1');

  return {
    ...(search === undefined || search === '' ? {} : { search }),
    ...(status === 'active' || status === 'disabled' ? { status } : {}),
    ...(clientType === undefined || clientType === '' ? {} : { clientType }),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
  };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const query = parseQuery(await searchParams);

  let list: AgentPage<Agent> | undefined;
  let listError: unknown;

  try {
    list = await listAgents(query);
  } catch (error) {
    listError = error;
  }

  const counts = await getOverview()
    .then((overview) => overview.agents)
    .catch(() => null);

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Agents"
          description="Identities that authenticate to the gateway with a credential. What each one may call is decided by its assigned policies."
          actions={<Button label="Add agent" href="/dashboard/agents/new" as={Link} variant="primary" />}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MetricCard label="Agents" value={counts?.total ?? null} />
          <MetricCard label="Active" value={counts?.enabled ?? null} />
          <MetricCard label="Disabled" value={counts?.disabled ?? null} />
        </div>

        {list === undefined ? (
          <ErrorState error={listError} title="The agent registry could not be read" />
        ) : (
          <AgentsTable agents={list.data} pagination={list.pagination} query={query} />
        )}
      </div>
    </PageContainer>
  );
}
