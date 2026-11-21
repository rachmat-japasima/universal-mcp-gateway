'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { EmptyStateCard } from '@/components/feedback/states';
import type { Pagination, Policy, PolicyQuery } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

/**
 * The policy registry table.
 *
 * A client component because Astryx `Table` takes a `renderCell` function; the
 * page has already done every read.
 *
 * The filters are the gateway's own (`search`, `effect`) — nothing here invents
 * an "assigned" or "unused" filter, because the API cannot answer those without
 * a reverse lookup per row. `priority` is shown because it decides precedence
 * across an agent's policies: higher wins, and ties go to deny.
 *
 * The allow/deny split is a summary of the rule array, not a stored field: a
 * policy can hold both kinds of rule.
 */

type Row = {
  id: string;
  name: string;
  description: string;
  priority: number;
  allows: number;
  denies: number;
  updatedAt: string;
};

function summarise(policy: Policy): { allows: number; denies: number } {
  let allows = 0;
  let denies = 0;
  for (const rule of policy.rules) {
    if (rule.effect === 'allow') allows += 1;
    else denies += 1;
  }
  return { allows, denies };
}

function columnsFor(): TableColumn<Row>[] {
  return [
    {
      key: 'name',
      header: 'Policy',
      width: proportional(4, { minWidth: 240 }),
      renderCell: (row) => (
        <VStack gap={0}>
          <Link href={`/dashboard/policies/${row.id}`} className="underline">
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
      key: 'priority',
      header: 'Priority',
      width: proportional(1, { minWidth: 100 }),
      renderCell: (row) => <Text type="body">{row.priority}</Text>,
    },
    {
      key: 'rules',
      header: 'Rules',
      width: proportional(2, { minWidth: 160 }),
      renderCell: (row) => (
        <HStack gap={2} wrap="wrap" align="center">
          <Text type="supporting">{row.allows} allow</Text>
          <Text type="supporting">{row.denies} deny</Text>
        </HStack>
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

function filterHref(query: PolicyQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.effect !== undefined) params.set('effect', query.effect);
  if (page > 1) params.set('page', String(page));

  const search = params.toString();
  return search === '' ? '/dashboard/policies' : `/dashboard/policies?${search}`;
}

function hasFilters(query: PolicyQuery): boolean {
  return (query.search !== undefined && query.search !== '') || query.effect !== undefined;
}

export function PoliciesTable({
  policies,
  pagination,
  query,
}: {
  policies: Policy[];
  pagination: Pagination;
  query: PolicyQuery;
}): React.ReactElement {
  const rows: Row[] = policies.map((policy) => {
    const { allows, denies } = summarise(policy);
    return {
      id: policy.id,
      name: policy.name,
      description: policy.description ?? '',
      priority: policy.priority,
      allows,
      denies,
      updatedAt: policy.updatedAt,
    };
  });

  return (
    <VStack gap={3}>
      <Card padding={3}>
        <VStack gap={2}>
          <form action="/dashboard/policies" method="get" role="search" className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1">
              <span className="text-sm">Search</span>
              <input
                type="search"
                name="search"
                defaultValue={query.search ?? ''}
                placeholder="Policy name or description"
                maxLength={200}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm">Contains rule</span>
              <select
                name="effect"
                defaultValue={query.effect ?? ''}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="">Any</option>
                <option value="allow">ALLOW</option>
                <option value="deny">DENY</option>
              </select>
            </label>

            <Button label="Apply filters" type="submit" variant="secondary" />
            {hasFilters(query) ? (
              <Button label="Clear" href="/dashboard/policies" as={Link} variant="ghost" />
            ) : null}
          </form>

          <Text type="supporting" as="p">
            With no matching rule the answer is deny. An explicit DENY outranks any ALLOW at the same priority, and a
            higher priority outranks a lower one.
          </Text>
        </VStack>
      </Card>

      {rows.length === 0 ? (
        hasFilters(query) ? (
          <EmptyStateCard
            title="No policies match these filters"
            description="Nothing in the registry matches the search and filter above. Clear them to see every policy."
            actions={<Button label="Clear filters" href="/dashboard/policies" as={Link} variant="secondary" />}
          />
        ) : (
          <EmptyStateCard
            title="No access policies"
            description="Every agent is default-denied until a policy allows something. Create one and assign it to the agents that need it."
            actions={<Button label="Create policy" href="/dashboard/policies/new" as={Link} variant="secondary" />}
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
              {pagination.total} polic{pagination.total === 1 ? 'y' : 'ies'}
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
