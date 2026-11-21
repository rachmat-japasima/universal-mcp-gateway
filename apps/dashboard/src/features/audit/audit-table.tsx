'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { EmptyStateCard } from '@/components/feedback/states';
import type { AuditEvent, AuditQuery, Pagination } from '@/lib/api/types';
import { AUDIT_ACTIONS, AUDIT_ACTORS, AUDIT_RESULTS, AUDIT_TARGET_TYPES } from '@/lib/api/types';
import { auditHasFilters, auditHref } from '@/lib/events/query';
import { formatTimestamp } from '@/lib/utils/status';

import { AuditActorBadge, AuditActionLabel, AuditResultBadge } from './audit-status';

/**
 * The administrative and security record: who changed what.
 *
 * A separate table, separate filters, and a separate page from activity. The two
 * answer different questions and have different retention; merging them into one
 * "events" view would make the security record look like operational noise, and
 * an operator filtering for a denied tool call could land on an unrelated policy
 * edit.
 *
 * `metadata` is deliberately not in this table and not in this payload: the list
 * endpoint omits it (`toAuditListItem`), so metadata is reachable only by opening
 * one record. That is the disclosure boundary, and this page respects it rather
 * than reconstructing it from a detail read per row.
 *
 * There is no edit and no delete control anywhere, because the gateway exposes
 * neither — the repository has no update or delete method.
 */

type Row = {
  id: string;
  createdAt: string;
  actorType: AuditEvent['actorType'];
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  result: AuditEvent['result'];
};

function columnsFor(): TableColumn<Row>[] {
  return [
    {
      key: 'createdAt',
      header: 'When',
      width: proportional(2, { minWidth: 170 }),
      renderCell: (row) => (
        <Link href={`/dashboard/audit/${row.id}`} className="underline">
          <Text type="supporting">{formatTimestamp(row.createdAt)}</Text>
        </Link>
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      width: proportional(2, { minWidth: 160 }),
      renderCell: (row) => (
        <span className="inline-flex flex-col gap-0.5">
          <AuditActorBadge actorType={row.actorType} />
          <Text type="supporting">{row.actorId}</Text>
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      width: proportional(4, { minWidth: 220 }),
      renderCell: (row) => <AuditActionLabel action={row.action} />,
    },
    {
      key: 'target',
      header: 'Target',
      width: proportional(3, { minWidth: 200 }),
      renderCell: (row) => (
        <span className="inline-flex flex-col gap-0.5">
          <Text type="supporting">{row.targetType}</Text>
          <Text type="code">{row.targetId}</Text>
        </span>
      ),
    },
    {
      key: 'result',
      header: 'Result',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (row) => <AuditResultBadge result={row.result} />,
    },
  ];
}

export function AuditTable({
  events,
  pagination,
  query,
}: {
  events: AuditEvent[];
  pagination: Pagination;
  query: AuditQuery;
}): React.ReactElement {
  const rows: Row[] = events.map((event) => ({
    id: event.id,
    createdAt: event.createdAt,
    actorType: event.actorType,
    actorId: event.actorId ?? 'Not recorded',
    action: event.action,
    targetType: event.targetType ?? '—',
    targetId: event.targetId ?? '—',
    result: event.result,
  }));

  return (
    <VStack gap={3}>
      <Card padding={3}>
        <form action="/dashboard/audit" method="get" role="search" className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[220px] flex-col gap-1">
            <span className="text-sm">Action</span>
            <select name="action" defaultValue={query.action ?? ''} className="rounded-md border border-solid px-3 py-2 text-sm">
              <option value="">Any action</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm">Actor</span>
            <select
              name="actorType"
              defaultValue={query.actorType ?? ''}
              className="rounded-md border border-solid px-3 py-2 text-sm"
            >
              <option value="">Any actor</option>
              {AUDIT_ACTORS.map((actor) => (
                <option key={actor} value={actor}>
                  {actor}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm">Target type</span>
            <select
              name="targetType"
              defaultValue={query.targetType ?? ''}
              className="rounded-md border border-solid px-3 py-2 text-sm"
            >
              <option value="">Any target</option>
              {AUDIT_TARGET_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm">Result</span>
            <select
              name="result"
              defaultValue={query.result ?? ''}
              className="rounded-md border border-solid px-3 py-2 text-sm"
            >
              <option value="">Any result</option>
              {AUDIT_RESULTS.map((result) => (
                <option key={result} value={result}>
                  {result}
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
              placeholder="Target id or request id"
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
          {auditHasFilters(query) ? (
            <Button label="Clear" href="/dashboard/audit" as={Link} variant="ghost" />
          ) : null}
        </form>
      </Card>

      {rows.length === 0 ? (
        auditHasFilters(query) ? (
          <EmptyStateCard
            title="No audit events match these filters"
            description="The audit trail has records, but none match the filters above. Clear them to see the whole trail."
            actions={<Button label="Clear filters" href="/dashboard/audit" as={Link} variant="secondary" />}
          />
        ) : (
          <EmptyStateCard
            title="No audit events recorded"
            description="The trail is written when something changes: backends, agents, credentials, policies, settings, and every operator sign-in. Nothing here is a sample record."
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
                    href={auditHref(query, pagination.page - 1)}
                    as={Link}
                    variant="secondary"
                    size="sm"
                  />
                ) : null}
                {pagination.page < pagination.totalPages ? (
                  <Button
                    label="Next"
                    href={auditHref(query, pagination.page + 1)}
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
