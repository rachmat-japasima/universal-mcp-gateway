import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { MetricCard } from '@/components/ui/metric-card';
import { listAgents } from '@/lib/api/agents';
import { getOverview } from '@/lib/api/endpoints';
import { listSessions } from '@/lib/api/sessions';
import type { Agent, Page as SessionPage, Session, SessionQuery, SessionStatus } from '@/lib/api/types';
import { SessionsTable } from '@/features/sessions/sessions-table';

export const metadata: Metadata = { title: 'Sessions' };

export const dynamic = 'force-dynamic';

/**
 * MCP agent sessions, and nothing else.
 *
 * These are rows from `sessions` — the protocol sessions an MCP client opened
 * with an agent credential. The dashboard's own operator sessions live in a
 * different table with a different lifetime and are deliberately **not** listed
 * here: merging them would erase the distinction that keeps either identity
 * meaningful (ADR-045).
 *
 * Reads, all real:
 *
 *  * `GET /api/v1/sessions` is the table, with the gateway's own `agentId`,
 *    `status`, `sort`, `order` and pagination. There is no `search` parameter in
 *    the contract, so there is no search box on the list; an id lookup redirects
 *    to the detail route, which is the API's real answer.
 *  * `GET /api/v1/overview` supplies registry-wide session counts. Counting the
 *    visible page would report "1 active" on page one of twenty.
 *  * `GET /api/v1/agents` supplies names for the agent column. A failed agent
 *    read degrades the label to the id, never hides the session.
 *
 * The `status` filter is the gateway's effective status, so `expired` includes
 * rows whose lifetime lapsed before the sweep wrote them back. The badge reads
 * the same field, so the two cannot disagree.
 */

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const STATUSES: readonly SessionStatus[] = ['active', 'expired', 'terminated', 'invalidated'];

/** Only the parameters the gateway accepts are read; it rejects anything else too. */
function parseQuery(params: Record<string, string | string[] | undefined>): SessionQuery {
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const agentId = single(params.agentId)?.trim();
  const status = single(params.status);
  const sort = single(params.sort);
  const order = single(params.order);
  const page = Number(single(params.page) ?? '1');

  return {
    ...(agentId === undefined || !UUID.test(agentId) ? {} : { agentId }),
    ...(status === undefined || !STATUSES.includes(status as SessionStatus)
      ? {}
      : { status: status as SessionStatus }),
    ...(sort === 'lastActivityAt' ? { sort } : {}),
    ...(order === 'asc' ? { order } : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
  };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const lookup = (Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId)?.trim();

  // An id lookup is a detail read, not a list filter. A malformed id stays here
  // so the gateway is not asked a question that could only answer 400.
  if (lookup !== undefined && lookup !== '') {
    if (UUID.test(lookup)) redirect(`/dashboard/sessions/${lookup}`);
  }

  const query = parseQuery(params);

  let list: SessionPage<Session> | undefined;
  let listError: unknown;

  try {
    list = await listSessions(query);
  } catch (error) {
    listError = error;
  }

  const counts = await getOverview()
    .then((overview) => overview.sessions)
    .catch(() => null);

  const agents = await listAgents({ limit: 100, sort: 'name' })
    .then((page: SessionPage<Agent>) => page.data.map((agent) => ({ id: agent.id, name: agent.name })))
    .catch(() => undefined);

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Sessions"
          description="MCP sessions opened by agents with a credential. These are protocol sessions with your MCP clients, not dashboard sign-ins."
        />

        {lookup !== undefined && lookup !== '' && !UUID.test(lookup) ? (
          <div role="alert">
            <p className="text-sm text-secondary">
              “{lookup}” is not a session id. A session id is a UUID, as listed below.
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Active" value={counts?.active ?? null} />
          <MetricCard label="Expired" value={counts?.expired ?? null} />
          <MetricCard label="Terminated" value={counts?.terminated ?? null} />
          <MetricCard label="Invalidated" value={counts?.invalidated ?? null} />
        </div>

        {list === undefined ? (
          <ErrorState error={listError} title="The session list could not be read" />
        ) : (
          <SessionsTable
            sessions={list.data}
            pagination={list.pagination}
            query={query}
            {...(agents === undefined ? {} : { agents })}
          />
        )}
      </div>
    </PageContainer>
  );
}
