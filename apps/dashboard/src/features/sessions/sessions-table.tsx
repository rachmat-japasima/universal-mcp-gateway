'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { EmptyStateCard } from '@/components/feedback/states';
import type { Pagination, Session, SessionQuery } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import { SessionStatusBadge } from './session-status';

/**
 * The MCP session table.
 *
 * A client component because Astryx `Table` takes a `renderCell` function. The
 * page has already done every read.
 *
 * Filters are the gateway's own: `agentId`, `status`, `sort`, `order`. There is
 * deliberately **no text search**: `listSessionsQuerySchema` has no `search`
 * parameter, so a search box would either be ignored by the gateway (and lie) or
 * filter the visible page (and lie differently). An operator who has a session id
 * uses the lookup above, which opens the real detail read.
 *
 * Every value shown is a stored field. `expiresAt` is the hard cap the gateway
 * recorded; when it is absent there is no cap, which is not the same as "never
 * expires by idle timeout" — the idle deadline is derived and shown on the detail
 * page instead of being guessed at here.
 */

type Row = {
  id: string;
  agentLabel: string;
  agentId: string;
  status: Session['status'];
  createdAt: string;
  lastActivityAt: string;
  expiresAt?: string;
};

function columnsFor(): TableColumn<Row>[] {
  return [
    {
      key: 'id',
      header: 'Session',
      width: proportional(4, { minWidth: 260 }),
      renderCell: (row) => (
        <VStack gap={0}>
          <Link href={`/dashboard/sessions/${row.id}`} className="underline">
            <Text type="code">{row.id}</Text>
          </Link>
          <Text type="supporting" maxLines={1}>
            {row.agentLabel}
          </Text>
        </VStack>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (row) => <SessionStatusBadge status={row.status} />,
    },
    {
      key: 'createdAt',
      header: 'Started',
      width: proportional(2, { minWidth: 170 }),
      renderCell: (row) => <Text type="supporting">{formatTimestamp(row.createdAt)}</Text>,
    },
    {
      key: 'lastActivityAt',
      header: 'Last activity',
      width: proportional(2, { minWidth: 170 }),
      renderCell: (row) => <Text type="supporting">{formatTimestamp(row.lastActivityAt)}</Text>,
    },
    {
      key: 'expiresAt',
      header: 'Hard cap',
      width: proportional(2, { minWidth: 170 }),
      renderCell: (row) =>
        row.expiresAt === undefined ? (
          <Text type="supporting">No cap recorded</Text>
        ) : (
          <Text type="supporting">{formatTimestamp(row.expiresAt)}</Text>
        ),
    },
  ];
}

const STATUS_OPTIONS = ['active', 'expired', 'terminated', 'invalidated'] as const;

function filterHref(query: SessionQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.agentId !== undefined) params.set('agentId', query.agentId);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.sort !== undefined && query.sort !== 'createdAt') params.set('sort', query.sort);
  if (query.order !== undefined && query.order !== 'desc') params.set('order', query.order);
  if (page > 1) params.set('page', String(page));

  const search = params.toString();
  return search === '' ? '/dashboard/sessions' : `/dashboard/sessions?${search}`;
}

function hasFilters(query: SessionQuery): boolean {
  return (
    query.agentId !== undefined ||
    query.status !== undefined ||
    (query.sort !== undefined && query.sort !== 'createdAt') ||
    (query.order !== undefined && query.order !== 'desc')
  );
}

const SORT_LABELS: Record<NonNullable<SessionQuery['sort']>, string> = {
  createdAt: 'Start time',
  lastActivityAt: 'Last activity',
};

const ORDER_LABELS: Record<NonNullable<SessionQuery['order']>, string> = {
  desc: 'Newest first',
  asc: 'Oldest first',
};

export function SessionsTable({
  sessions,
  pagination,
  query,
  agents,
}: {
  sessions: Session[];
  pagination: Pagination;
  query: SessionQuery;
  /** `undefined` when the agent read failed; ids are still rendered. */
  agents?: Array<{ id: string; name: string }>;
}): React.ReactElement {
  const names = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));

  const rows: Row[] = sessions.map((session) => ({
    id: session.id,
    agentId: session.agentId,
    agentLabel: names.get(session.agentId) ?? `Agent ${session.agentId}`,
    status: session.status,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
  }));

  return (
    <VStack gap={3}>
      <Card padding={3}>
        <VStack gap={3}>
          <form action="/dashboard/sessions" method="get" role="search" className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[200px] flex-col gap-1">
              <span className="text-sm">Agent</span>
              <select
                name="agentId"
                defaultValue={query.agentId ?? ''}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="">Any agent</option>
                {(agents ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm">Status</span>
              <select
                name="status"
                defaultValue={query.status ?? ''}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="">Any status</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm">Sort</span>
              <select
                name="sort"
                defaultValue={query.sort ?? 'createdAt'}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="createdAt">{SORT_LABELS.createdAt}</option>
                <option value="lastActivityAt">{SORT_LABELS.lastActivityAt}</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm">Order</span>
              <select
                name="order"
                defaultValue={query.order ?? 'desc'}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="desc">{ORDER_LABELS.desc}</option>
                <option value="asc">{ORDER_LABELS.asc}</option>
              </select>
            </label>

            <Button label="Apply filters" type="submit" variant="secondary" />
            {hasFilters(query) ? (
              <Button label="Clear" href="/dashboard/sessions" as={Link} variant="ghost" />
            ) : null}
          </form>

          <form action="/dashboard/sessions" method="get" className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[280px] flex-1 flex-col gap-1">
              <span className="text-sm">Open one session</span>
              <input
                type="text"
                name="sessionId"
                placeholder="Session id (a UUID)"
                maxLength={36}
                required
                className="rounded-md border border-solid px-3 py-2 font-mono text-sm"
              />
            </label>
            <Button label="Open session" type="submit" variant="secondary" />
          </form>
        </VStack>
      </Card>

      {rows.length === 0 ? (
        hasFilters(query) ? (
          <EmptyStateCard
            title="No sessions match these filters"
            description="Nothing matches the filters above. Clear them to see every recorded session."
            actions={<Button label="Clear filters" href="/dashboard/sessions" as={Link} variant="secondary" />}
          />
        ) : (
          <EmptyStateCard
            title="No sessions recorded"
            description="No MCP client has initialized a session yet. Sessions appear here as agents connect; nothing on this page is a sample record."
          />
        )
      ) : (
        <>
          <Card padding={0}>
            <Table<Row>
              data={rows}
              columns={columnsFor()}
              idKey="id"
              density="compact"
              dividers="rows"
              textOverflow="truncate"
              rowIndexStart={(pagination.page - 1) * pagination.limit + 1}
              rowCount={pagination.total}
            />
          </Card>

          <HStack gap={3} align="center" wrap="wrap">
            <Text type="supporting">
              {pagination.total} session{pagination.total === 1 ? '' : 's'}
              {pagination.totalPages > 1 ? ` · page ${pagination.page} of ${pagination.totalPages}` : ''}
            </Text>
            {pagination.totalPages > 1 ? (
              <HStack gap={2}>
                {pagination.page > 1 ? (
                  <Button
                    label="Previous"
                    href={filterHref(query, pagination.page - 1)}
                    as={Link}
                    variant="secondary"
                    size="sm"
                  />
                ) : null}
                {pagination.page < pagination.totalPages ? (
                  <Button
                    label="Next"
                    href={filterHref(query, pagination.page + 1)}
                    as={Link}
                    variant="secondary"
                    size="sm"
                  />
                ) : null}
              </HStack>
            ) : null}
          </HStack>
        </>
      )}
    </VStack>
  );
}
