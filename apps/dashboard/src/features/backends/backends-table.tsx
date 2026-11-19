'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { EmptyStateCard } from '@/components/feedback/states';
import type { Backend, BackendQuery, BackendRuntimeStatus, Pagination } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import { BackendActions } from './backend-actions';
import { EnabledBadge, RuntimeStatus, TransportLabel } from './backend-status';

/**
 * The registry table.
 *
 * A client component because Astryx `Table` takes a `renderCell` function, and a
 * function cannot cross the server boundary. Everything it receives is plain
 * JSON the page already read, so no request happens here.
 *
 * Filtering is a real `<form method="get">` rather than controlled React state:
 * the query lives in the URL, a reload reproduces the view exactly, and a
 * filtered view survives a bookmark or a shared link. It also works before
 * hydration.
 *
 * Runtime status is deliberately **not** a filter. `GET /api/v1/backends`
 * accepts `search`, `transport` and `enabled` only; a control that quietly
 * filtered nothing would be worse than saying so, so the note under the toolbar
 * is explicit and the limitation is documented.
 */

type Row = {
  id: string;
  name: string;
  description: string;
  transport: Backend['transport'];
  enabled: boolean;
  status: BackendRuntimeStatus;
  updatedAt: string;
};

function runtimeOf(backend: Backend): BackendRuntimeStatus {
  // The list carries a reduced runtime (`status` + `updatedAt`). Absent means
  // the backend is registered but has no adapter history yet, and the
  // configuration fact is the honest answer.
  return backend.runtime?.status ?? (backend.enabled ? 'disconnected' : 'disabled');
}

function columnsFor(byId: Map<string, Backend>): TableColumn<Row>[] {
  return [
    {
      key: 'name',
      header: 'Name',
      width: proportional(3, { minWidth: 200 }),
      renderCell: (row) => (
        <VStack gap={0}>
          <Link href={`/dashboard/backends/${row.id}`} className="underline">
            {row.name}
          </Link>
          {row.description === '' ? null : (
            <Text type="supporting" maxLines={1}>
              {row.description}
            </Text>
          )}
        </VStack>
      ),
    },
    {
      key: 'transport',
      header: 'Transport',
      width: proportional(2, { minWidth: 120 }),
      renderCell: (row) => <TransportLabel transport={row.transport} />,
    },
    {
      key: 'enabled',
      header: 'Enabled',
      width: proportional(1, { minWidth: 100 }),
      renderCell: (row) => <EnabledBadge enabled={row.enabled} />,
    },
    {
      key: 'runtime',
      header: 'Runtime',
      width: proportional(2, { minWidth: 140 }),
      renderCell: (row) => <RuntimeStatus status={row.status} />,
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (row) => <Text type="supporting">{formatTimestamp(row.updatedAt)}</Text>,
    },
    {
      key: 'actions',
      header: 'Actions',
      width: proportional(3, { minWidth: 280 }),
      renderCell: (row) => {
        const backend = byId.get(row.id);
        // `byId` is built from the same array, so this is always present; the
        // guard keeps the render total rather than throwing on a table row.
        return backend === undefined ? null : <BackendActions backend={backend} layout="row" />;
      },
    },
  ];
}

function filterHref(query: BackendQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.transport !== undefined) params.set('transport', query.transport);
  if (query.enabled !== undefined) params.set('enabled', String(query.enabled));
  if (page > 1) params.set('page', String(page));

  const search = params.toString();
  return search === '' ? '/dashboard/backends' : `/dashboard/backends?${search}`;
}

function hasFilters(query: BackendQuery): boolean {
  return query.search !== undefined || query.transport !== undefined || query.enabled !== undefined;
}

export function BackendsTable({
  backends,
  pagination,
  query,
}: {
  backends: Backend[];
  pagination: Pagination;
  query: BackendQuery;
}): React.ReactElement {
  const rows: Row[] = backends.map((backend) => ({
    id: backend.id,
    name: backend.name,
    description: backend.description ?? '',
    transport: backend.transport,
    enabled: backend.enabled,
    status: runtimeOf(backend),
    updatedAt: backend.updatedAt,
  }));

  return (
    <VStack gap={3}>
      <Card padding={3}>
        <VStack gap={2}>
          <form action="/dashboard/backends" method="get" role="search" className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1">
              <span className="text-sm">Search</span>
              <input
                type="search"
                name="search"
                defaultValue={query.search ?? ''}
                placeholder="Name or description"
                maxLength={200}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm">Transport</span>
              <select
                name="transport"
                defaultValue={query.transport ?? ''}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="">Any</option>
                <option value="stdio">STDIO</option>
                <option value="streamable-http">Streamable HTTP</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm">Enabled</span>
              <select
                name="enabled"
                defaultValue={query.enabled === undefined ? '' : String(query.enabled)}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="">Any</option>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </label>

            <Button label="Apply filters" type="submit" variant="secondary" />
            {hasFilters(query) ? (
              <Button label="Clear" href="/dashboard/backends" as={Link} variant="ghost" />
            ) : null}
          </form>

          <Text type="supporting" as="p">
            Search matches names and descriptions. There is no runtime-status filter because the management API has no
            parameter for one.
          </Text>
        </VStack>
      </Card>

      {rows.length === 0 ? (
        hasFilters(query) ? (
          <EmptyStateCard
            title="No backends match these filters"
            description="Nothing in the registry matches the search and filters above. Clear them to see every backend."
            actions={<Button label="Clear filters" href="/dashboard/backends" as={Link} variant="secondary" />}
          />
        ) : (
          <EmptyStateCard
            title="No backends registered"
            description="No MCP servers have been configured for this gateway. Add one to let it serve that server's tools."
            actions={<Button label="Add Backend" href="/dashboard/backends/new" as={Link} variant="primary" />}
          />
        )
      ) : (
        <>
          <Card padding={0}>
            <Table<Row>
              data={rows}
              columns={columnsFor(new Map(backends.map((backend) => [backend.id, backend])))}
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
              {pagination.total} backend{pagination.total === 1 ? '' : 's'}
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
                  <Button label="Next" href={filterHref(query, pagination.page + 1)} as={Link} variant="secondary" size="sm" />
                ) : null}
              </HStack>
            ) : null}
          </HStack>
        </>
      )}
    </VStack>
  );
}
