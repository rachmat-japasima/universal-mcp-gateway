'use client';

import { Card } from '@astryxdesign/core/Card';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import type { IntegrationConnection } from '@/lib/api/types';
import { StatusIndicator } from '@/components/ui/status-badge';
import { connectionStatus, formatTimestamp } from '@/lib/utils/status';

/**
 * Astryx `Table` is generic over `Record<string, unknown>`, which an interface
 * (no implicit index signature) does not satisfy. A local row alias does, and
 * states exactly the fields these columns read.
 */
type Row = {
  id: string;
  name: string;
  provider: string;
  status: IntegrationConnection['status'];
  credentialStored: boolean;
  validatedAt?: string;
  updatedAt: string;
};

function columnsFor(): TableColumn<Row>[] {
  return [
    {
      key: 'name',
      header: 'Connection',
      width: proportional(3, { minWidth: 180 }),
      renderCell: (connection) => <Link href={`/dashboard/integrations/${connection.id}`}>{connection.name}</Link>,
    },
    {
      key: 'provider',
      header: 'Provider',
      width: proportional(2, { minWidth: 130 }),
      renderCell: (connection) => <Text type="supporting">{connection.provider}</Text>,
    },
    {
      key: 'status',
      header: 'Status',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (connection) => <StatusIndicator status={connectionStatus(connection.status)} />,
    },
    {
      key: 'credentialStored',
      header: 'Token',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (connection) => <Text type="supporting">{connection.credentialStored ? 'Sealed' : 'None'}</Text>,
    },
    {
      key: 'validatedAt',
      header: 'Validated',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (connection) =>
        connection.validatedAt === undefined ? (
          <Text type="supporting">Never</Text>
        ) : (
          <Text type="supporting">{formatTimestamp(connection.validatedAt)}</Text>
        ),
    },
    {
      key: 'updatedAt',
      header: 'Updated',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (connection) => <Text type="supporting">{formatTimestamp(connection.updatedAt)}</Text>,
    },
  ];
}

export function ConnectionsTable({ connections }: { connections: IntegrationConnection[] }): React.ReactElement {
  const rows: Row[] = connections.map((connection) => ({
    id: connection.id,
    name: connection.name,
    // The provider name is present while the provider stays registered; a
    // missing one is a fact about the registry, not a rendering gap.
    provider: connection.providerName ?? connection.providerId,
    status: connection.status,
    // A vault reference is proof a token exists; the value never leaves the
    // vault, so the honest column is "sealed", not a masked token.
    credentialStored: connection.credentialId !== null,
    ...(connection.validatedAt === null ? {} : { validatedAt: connection.validatedAt }),
    updatedAt: connection.updatedAt,
  }));

  return (
    <Card padding={0}>
      <Table<Row>
        data={rows}
        columns={columnsFor()}
        idKey="id"
        density="compact"
        dividers="rows"
        textOverflow="truncate"
      />
    </Card>
  );
}
