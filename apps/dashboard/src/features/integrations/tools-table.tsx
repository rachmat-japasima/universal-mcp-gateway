'use client';

import { Card } from '@astryxdesign/core/Card';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import Link from 'next/link';

import { EmptyStateCard } from '@/components/feedback/states';
import type { IntegrationTool } from '@/lib/api/types';
import { availabilityStatus } from '@/lib/utils/status';

/**
 * The tools one connection publishes. A client component because Astryx
 * `Table` takes a `renderCell` function, which cannot cross the server
 * boundary. The page has already read the data; nothing here requests
 * anything.
 *
 * Empty is a real state, not a failure: a connection that is not `connected`
 * publishes nothing, and the page says which of the two it is.
 */

type Row = {
  publicName: string;
  title?: string;
  availability: IntegrationTool['availability'];
  description?: string;
};

function columnsFor(): TableColumn<Row>[] {
  return [
    {
      key: 'publicName',
      header: 'Public name',
      width: proportional(3, { minWidth: 220 }),
      renderCell: (tool) => (
        <Link href={`/dashboard/tools/${encodeURIComponent(tool.publicName)}`} className="underline">
          {tool.publicName}
        </Link>
      ),
    },
    {
      key: 'title',
      header: 'Tool',
      width: proportional(3, { minWidth: 180 }),
      renderCell: (tool) => (
        <Text type="supporting" maxLines={1}>
          {tool.title ?? tool.publicName.split('__')[1] ?? tool.publicName}
        </Text>
      ),
    },    {
      key: 'availability',
      header: 'Availability',
      width: proportional(2, { minWidth: 120 }),
      renderCell: (tool) => <Text type="supporting">{availabilityStatus(tool.availability).label}</Text>,
    },
  ];
}

export function ConnectionTools({ tools, isConnected }: { tools: IntegrationTool[]; isConnected: boolean }): React.ReactElement {
  if (tools.length === 0) {
    return (
      <EmptyStateCard
        title={isConnected ? 'No tools published' : 'Not connected'}
        description={
          isConnected
            ? 'The provider reported no tools for this connection, so the catalog has nothing to route.'
            : 'A connection publishes tools only while it is connected. Connect to verify the token and publish them.'
        }
      />
    );
  }

  const rows: Row[] = tools.map((tool) => ({
    publicName: tool.publicName,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    availability: tool.availability,
  }));

  return (
    <Card padding={0}>
      <Table<Row>
        data={rows}
        columns={columnsFor()}
        idKey="publicName"
        density="compact"
        dividers="rows"
        textOverflow="truncate"
      />
    </Card>
  );
}
