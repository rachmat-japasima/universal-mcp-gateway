'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { EmptyStateCard } from '@/components/feedback/states';
import type { Agent, AgentQuery, ClientType, Pagination } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import { ClientTypeLabel, EnabledBadge } from './agent-status';

/**
 * Astryx `Table` is generic over `Record<string, unknown>`, which an interface
 * (no implicit index signature) does not satisfy. A local row alias does, and it
 * states exactly the fields these columns read.
 */
type Row = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  clientType?: ClientType;
  lastAuthenticatedAt?: string;
  createdAt: string;
};

/**
 * The agent registry table.
 *
 * A client component because Astryx `Table` takes a `renderCell` function, which
 * cannot cross the server boundary. The page has already read the data; nothing
 * here requests anything.
 *
 * Filters are the gateway's own (`search`, `status`, `clientType`) and live in
 * the URL via a real `<form method="get">`, so a filtered view is reproducible.
 * `clientType` is free text rather than a dropdown of the current page's values:
 * the gateway accepts any string up to 64 characters and there is no endpoint
 * that enumerates them.
 */

function columnsFor(): TableColumn<Row>[] {
  return [
    {
      key: 'name',
      header: 'Agent',
      width: proportional(4, { minWidth: 220 }),
      renderCell: (agent) => (
        <VStack gap={0}>
          <Link href={`/dashboard/agents/${agent.id}`} className="underline">
            {agent.name}
          </Link>
          {agent.description === undefined ? null : (
            <Text type="supporting" maxLines={1}>
              {agent.description}
            </Text>
          )}
        </VStack>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (agent) => <EnabledBadge enabled={agent.enabled} />,
    },
    {
      key: 'clientType',
      header: 'Client',
      width: proportional(2, { minWidth: 130 }),
      renderCell: (agent) => <ClientTypeLabel clientType={agent.clientType} />,
    },
    {
      key: 'lastAuthenticatedAt',
      header: 'Last authenticated',
      width: proportional(2, { minWidth: 160 }),
      renderCell: (agent) =>
        agent.lastAuthenticatedAt === undefined ? (
          <Text type="supporting">Never</Text>
        ) : (
          <Text type="supporting">{formatTimestamp(agent.lastAuthenticatedAt)}</Text>
        ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (agent) => <Text type="supporting">{formatTimestamp(agent.createdAt)}</Text>,
    },
  ];
}

function filterHref(query: AgentQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.clientType !== undefined && query.clientType !== '') params.set('clientType', query.clientType);
  if (page > 1) params.set('page', String(page));

  const search = params.toString();
  return search === '' ? '/dashboard/agents' : `/dashboard/agents?${search}`;
}

function hasFilters(query: AgentQuery): boolean {
  return (
    (query.search !== undefined && query.search !== '') ||
    query.status !== undefined ||
    (query.clientType !== undefined && query.clientType !== '')
  );
}

export function AgentsTable({
  agents,
  pagination,
  query,
}: {
  agents: Agent[];
  pagination: Pagination;
  query: AgentQuery;
}): React.ReactElement {
  const rows: Row[] = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    enabled: agent.enabled,
    ...(agent.clientType === undefined ? {} : { clientType: agent.clientType }),
    ...(agent.lastAuthenticatedAt === undefined ? {} : { lastAuthenticatedAt: agent.lastAuthenticatedAt }),
    createdAt: agent.createdAt,
  }));

  return (
    <VStack gap={3}>
      <Card padding={3}>
        <form action="/dashboard/agents" method="get" role="search" className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[220px] flex-1 flex-col gap-1">
            <span className="text-sm">Search</span>
            <input
              type="search"
              name="search"
              defaultValue={query.search ?? ''}
              placeholder="Agent name or description"
              maxLength={200}
              className="rounded-md border border-solid px-3 py-2 text-sm"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm">Status</span>
            <select name="status" defaultValue={query.status ?? ''} className="rounded-md border border-solid px-3 py-2 text-sm">
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm">Client type</span>
            <input
              type="text"
              name="clientType"
              defaultValue={(query.clientType as ClientType | undefined) ?? ''}
              placeholder="e.g. claude-code"
              maxLength={64}
              className="rounded-md border border-solid px-3 py-2 text-sm"
            />
          </label>

          <Button label="Apply filters" type="submit" variant="secondary" />
          {hasFilters(query) ? <Button label="Clear" href="/dashboard/agents" as={Link} variant="ghost" /> : null}
        </form>
      </Card>

      {agents.length === 0 ? (
        hasFilters(query) ? (
          <EmptyStateCard
            title="No agents match these filters"
            description="Nothing in the registry matches the search and filters above. Clear them to see every agent."
            actions={<Button label="Clear filters" href="/dashboard/agents" as={Link} variant="secondary" />}
          />
        ) : (
          <EmptyStateCard
            title="No agents registered"
            description="An agent is an identity that authenticates to the gateway with a credential and is authorized by its assigned policies."
            actions={<Button label="Add agent" href="/dashboard/agents/new" as={Link} variant="secondary" />}
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
              {pagination.total} agent{pagination.total === 1 ? '' : 's'}
              {pagination.totalPages > 1 ? ` · page ${pagination.page} of ${pagination.totalPages}` : ''}
            </Text>
            {pagination.totalPages > 1 ? (
              <HStack gap={2}>
                {pagination.page > 1 ? (
                  <Button label="Previous" href={filterHref(query, pagination.page - 1)} as={Link} variant="secondary" size="sm" />
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
