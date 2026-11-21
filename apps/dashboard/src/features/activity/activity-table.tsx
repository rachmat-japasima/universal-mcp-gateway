'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { EmptyStateCard } from '@/components/feedback/states';
import type { ActivityEvent, ActivityQuery, Pagination } from '@/lib/api/types';
import { ACTIVITY_OUTCOMES, ACTIVITY_TYPES } from '@/lib/api/types';
import { activityHasFilters, activityHref } from '@/lib/events/query';
import { formatDuration, formatTimestamp } from '@/lib/utils/status';

import { ActivityOutcomeBadge, ActivityTypeLabel, activityTypeLabel } from './event-status';

/**
 * Operational history: what the gateway did.
 *
 * Every filter is one the gateway defines for this table, and every one is
 * applied server-side — `type`, `outcome`, `agentId`, `backendId`, `search`
 * (tool name or request id) and `order`. Filtering the visible page in the
 * browser would silently answer a different question than the count below the
 * table, which is measured over the whole filtered set.
 *
 * Nothing here is derived: no rate, no percentile, no "average latency". The
 * rows carry what was recorded and nothing else.
 */

type Row = {
  id: string;
  type: ActivityEvent['type'];
  outcome: ActivityEvent['outcome'];
  agentLabel: string;
  backendLabel: string;
  toolName?: string;
  durationMs?: number;
  errorCode?: string;
  createdAt: string;
};

function columnsFor(): TableColumn<Row>[] {
  return [
    {
      key: 'createdAt',
      header: 'When',
      width: proportional(2, { minWidth: 170 }),
      renderCell: (row) => (
        <Link href={`/dashboard/activity/${row.id}`} className="underline">
          <Text type="supporting">{formatTimestamp(row.createdAt)}</Text>
        </Link>
      ),
    },
    {
      key: 'type',
      header: 'Event',
      width: proportional(3, { minWidth: 180 }),
      renderCell: (row) => <ActivityTypeLabel type={row.type} />,
    },
    {
      key: 'outcome',
      header: 'Outcome',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (row) => <ActivityOutcomeBadge outcome={row.outcome} />,
    },
    {
      key: 'agent',
      header: 'Agent',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (row) => <Text type="supporting">{row.agentLabel}</Text>,
    },
    {
      key: 'backend',
      header: 'Backend',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (row) => <Text type="supporting">{row.backendLabel}</Text>,
    },
    {
      key: 'toolName',
      header: 'Tool',
      width: proportional(2, { minWidth: 160 }),
      renderCell: (row) =>
        row.toolName === undefined ? (
          <Text type="supporting">—</Text>
        ) : (
          <Text type="code">{row.toolName}</Text>
        ),
    },
    {
      key: 'durationMs',
      header: 'Recorded duration',
      width: proportional(1, { minWidth: 140 }),
      renderCell: (row) =>
        row.durationMs === undefined ? (
          <Text type="supporting">Not recorded</Text>
        ) : (
          <Text type="supporting">{formatDuration(row.durationMs)}</Text>
        ),
    },
  ];
}

export function ActivityTable({
  events,
  pagination,
  query,
  agents,
  backends,
}: {
  events: ActivityEvent[];
  pagination: Pagination;
  query: ActivityQuery;
  /** `undefined` when that read failed; rows then fall back to the id. */
  agents?: Array<{ id: string; name: string }>;
  backends?: Array<{ id: string; name: string }>;
}): React.ReactElement {
  const agentNames = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
  const backendNames = new Map((backends ?? []).map((backend) => [backend.id, backend.name]));

  const rows: Row[] = events.map((event) => ({
    id: event.id,
    type: event.type,
    outcome: event.outcome,
    agentLabel: event.agentId === undefined ? '—' : (agentNames.get(event.agentId) ?? event.agentId),
    backendLabel: event.backendId === undefined ? '—' : (backendNames.get(event.backendId) ?? event.backendId),
    ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    createdAt: event.createdAt,
  }));

  return (
    <VStack gap={3}>
      <Card padding={3}>
        <form action="/dashboard/activity" method="get" role="search" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm">Event type</span>
            <select name="type" defaultValue={query.type ?? ''} className="rounded-md border border-solid px-3 py-2 text-sm">
              <option value="">Any type</option>
              {ACTIVITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {activityTypeLabel(type)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm">Outcome</span>
            <select
              name="outcome"
              defaultValue={query.outcome ?? ''}
              className="rounded-md border border-solid px-3 py-2 text-sm"
            >
              <option value="">Any outcome</option>
              {ACTIVITY_OUTCOMES.map((outcome) => (
                <option key={outcome} value={outcome}>
                  {outcome}
                </option>
              ))}
            </select>
          </label>

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

          <label className="flex min-w-[200px] flex-col gap-1">
            <span className="text-sm">Backend</span>
            <select
              name="backendId"
              defaultValue={query.backendId ?? ''}
              className="rounded-md border border-solid px-3 py-2 text-sm"
            >
              <option value="">Any backend</option>
              {(backends ?? []).map((backend) => (
                <option key={backend.id} value={backend.id}>
                  {backend.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-[220px] flex-1 flex-col gap-1">
            <span className="text-sm">Search</span>
            <input
              type="search"
              name="search"
              defaultValue={query.search ?? ''}
              placeholder="Tool name or request id"
              maxLength={200}
              className="rounded-md border border-solid px-3 py-2 text-sm"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm">Order</span>
            <select name="order" defaultValue={query.order ?? 'desc'} className="rounded-md border border-solid px-3 py-2 text-sm">
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </label>

          <Button label="Apply filters" type="submit" variant="secondary" />
          {activityHasFilters(query) ? (
            <Button label="Clear" href="/dashboard/activity" as={Link} variant="ghost" />
          ) : null}
        </form>
      </Card>

      {rows.length === 0 ? (
        activityHasFilters(query) ? (
          <EmptyStateCard
            title="No activity matches these filters"
            description="The gateway has activity records, but none match the filters above. Clear them to see the whole history."
            actions={<Button label="Clear filters" href="/dashboard/activity" as={Link} variant="secondary" />}
          />
        ) : (
          <EmptyStateCard
            title="No activity recorded"
            description="Activity is written as agents use the gateway: session initialization, tool listing and calls, backend connects, and failed requests. Nothing here is a sample record."
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
              {pagination.total} matching event{pagination.total === 1 ? '' : 's'}
              {pagination.totalPages > 1 ? ` · page ${pagination.page} of ${pagination.totalPages}` : ''}
            </Text>
            {pagination.totalPages > 1 ? (
              <HStack gap={2}>
                {pagination.page > 1 ? (
                  <Button
                    label="Previous"
                    href={activityHref(query, pagination.page - 1)}
                    as={Link}
                    variant="secondary"
                    size="sm"
                  />
                ) : null}
                {pagination.page < pagination.totalPages ? (
                  <Button
                    label="Next"
                    href={activityHref(query, pagination.page + 1)}
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
