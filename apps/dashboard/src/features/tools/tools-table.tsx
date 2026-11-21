'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { EmptyStateCard } from '@/components/feedback/states';
import type { Page as ToolPage, Pagination, Tool, ToolQuery } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import { AvailabilityBadge } from './tool-status';

/**
 * The tool catalog table.
 *
 * A client component for the same reason as `BackendsTable`: Astryx `Table` takes
 * a `renderCell` function, which cannot cross the server boundary. Nothing here
 * requests anything — the page already read the catalog.
 *
 * Filtering is a real `<form method="get">`, so the query lives in the URL and a
 * filtered view is reproducible and shareable.
 *
 * The filters offered are exactly the gateway's: `search`, `backendId` and
 * `availability`. There is no "access" filter, because a tool's *agent* access is
 * a policy question answered per agent, not a property of the catalog row.
 */

type Row = {
  publicName: string;
  originalName: string;
  backendId: string;
  description: string;
  availability: Tool['availability'];
  updatedAt: string;
};

function columnsFor(backendNames: Map<string, string>): TableColumn<Row>[] {
  return [
    {
      key: 'publicName',
      header: 'Tool',
      width: proportional(4, { minWidth: 240 }),
      renderCell: (row) => (
        <VStack gap={0}>
          <Link href={`/dashboard/tools/${encodeURIComponent(row.publicName)}`} className="underline">
            {row.publicName}
          </Link>
          {row.originalName === row.publicName ? null : (
            <Text type="supporting" maxLines={1}>
              original: {row.originalName}
            </Text>
          )}
        </VStack>
      ),
    },
    {
      key: 'backend',
      header: 'Backend',
      width: proportional(2, { minWidth: 160 }),
      renderCell: (row) => (
        <Link href={`/dashboard/backends/${row.backendId}`} className="underline">
          {backendNames.get(row.backendId) ?? row.backendId}
        </Link>
      ),
    },
    {
      key: 'availability',
      header: 'Availability',
      width: proportional(1, { minWidth: 130 }),
      renderCell: (row) => <AvailabilityBadge availability={row.availability} />,
    },
    {
      key: 'description',
      header: 'Description',
      width: proportional(4, { minWidth: 220 }),
      renderCell: (row) =>
        row.description === '' ? (
          <Text type="supporting">No description</Text>
        ) : (
          <Text maxLines={2}>{row.description}</Text>
        ),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (row) => <Text type="supporting">{formatTimestamp(row.updatedAt)}</Text>,
    },
  ];
}

function filterHref(query: ToolQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.backendId !== undefined) params.set('backendId', query.backendId);
  if (query.availability !== undefined) params.set('availability', query.availability);
  if (page > 1) params.set('page', String(page));

  const search = params.toString();
  return search === '' ? '/dashboard/tools' : `/dashboard/tools?${search}`;
}

function hasFilters(query: ToolQuery): boolean {
  return query.search !== undefined || query.backendId !== undefined || query.availability !== undefined;
}

export function ToolsTable({
  tools,
  pagination,
  query,
  backends,
}: {
  tools: Tool[];
  pagination: Pagination;
  query: ToolQuery;
  /** Id → name for the rows on this page. A backend the registry no longer has falls back to its id. */
  backends: Array<{ id: string; name: string }>;
}): React.ReactElement {
  const rows: Row[] = tools.map((tool) => ({
    publicName: tool.publicName,
    originalName: tool.originalName,
    backendId: tool.backendId,
    description: tool.description ?? '',
    availability: tool.availability,
    updatedAt: tool.updatedAt,
  }));

  return (
    <VStack gap={3}>
      <Card padding={3}>
        <VStack gap={2}>
          <form action="/dashboard/tools" method="get" role="search" className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1">
              <span className="text-sm">Search</span>
              <input
                type="search"
                name="search"
                defaultValue={query.search ?? ''}
                placeholder="Public or original tool name"
                maxLength={200}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm">Backend</span>
              <select
                name="backendId"
                defaultValue={query.backendId ?? ''}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="">Any</option>
                {backends.map((backend) => (
                  <option key={backend.id} value={backend.id}>
                    {backend.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm">Availability</span>
              <select
                name="availability"
                defaultValue={query.availability ?? ''}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="">Any</option>
                <option value="available">Available</option>
                <option value="unavailable">Unavailable</option>
                <option value="conflict">Name conflict</option>
              </select>
            </label>

            <Button label="Apply filters" type="submit" variant="secondary" />
            {hasFilters(query) ? (
              <Button label="Clear" href="/dashboard/tools" as={Link} variant="ghost" />
            ) : null}
          </form>

          <Text type="supporting" as="p">
            Availability is the gateway&apos;s routing verdict. A tool listed here is not necessarily callable by an
            agent — access policy decides that, per agent.
          </Text>
        </VStack>
      </Card>

      {rows.length === 0 ? (
        hasFilters(query) ? (
          <EmptyStateCard
            title="No tools match these filters"
            description="Nothing in the catalog matches the search and filters above. Clear them to see every discovered tool."
            actions={<Button label="Clear filters" href="/dashboard/tools" as={Link} variant="secondary" />}
          />
        ) : (
          <EmptyStateCard
            title="No tools discovered"
            description="The catalog is empty. Connect a backend, or refresh discovery, to populate it."
            actions={<Button label="View backends" href="/dashboard/backends" as={Link} variant="secondary" />}
          />
        )
      ) : (
        <>
          <Card padding={0}>
            <Table<Row>
              data={rows}
              columns={columnsFor(new Map(backends.map((backend) => [backend.id, backend.name])))}
              idKey="publicName"
              density="compact"
              dividers="rows"
              textOverflow="truncate"
              rowIndexStart={(pagination.page - 1) * pagination.limit + 1}
              rowCount={pagination.total}
            />
          </Card>

          <HStack gap={3} align="center" wrap="wrap">
            <Text type="supporting">
              {pagination.total} tool{pagination.total === 1 ? '' : 's'}
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
