import type { Metadata } from 'next';

import { Card } from '@astryxdesign/core/Card';
import { VStack } from '@astryxdesign/core/VStack';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader, SectionBlock } from '@/components/layout/page-container';
import { DetailRow } from '@/components/ui/metric-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { ConnectionActions } from '@/features/integrations/connection-actions';
import { CredentialPanel } from '@/features/integrations/credential-panel';
import { ConnectionTools } from '@/features/integrations/tools-table';
import { getConnection, listConnectionTools } from '@/lib/api/integrations';
import { isApiError } from '@/lib/api/errors';
import type { IntegrationConnection, IntegrationTool } from '@/lib/api/types';
import { connectionStatus, formatTimestamp } from '@/lib/utils/status';

export const metadata: Metadata = { title: 'Connection' };

export const dynamic = 'force-dynamic';

/**
 * One connection: identity, the credential surface, the lifecycle, the tools.
 *
 * The profile read decides existence: a 404 means the connection is absent, so
 * this page is genuinely not found. The tools read is a separate question that
 * degrades on its own — a tools failure must not hide the credential panel an
 * operator came here to replace.
 */

export default async function Page({
  params,
}: {
  params: Promise<{ connectionId: string }>;
}): Promise<React.ReactElement> {
  const { connectionId } = await params;

  let connection: IntegrationConnection;
  try {
    connection = await getConnection(connectionId);
  } catch (error) {
    if (isApiError(error) && error.status === 404) notFound();
    return (
      <PageContainer>
        <PageHeader title="Connection" />
        <ErrorState error={error} title="Connection unavailable" />
      </PageContainer>
    );
  }

  let tools: IntegrationTool[] | undefined;
  let toolsError: unknown;
  try {
    tools = await listConnectionTools(connectionId);
  } catch (error) {
    toolsError = error;
  }

  return (
    <PageContainer>
      <PageHeader
        title={connection.name}
        description="A managed integration. The token is sealed in the vault; every fact below is the gateway's own record."
        actions={<StatusBadge status={connectionStatus(connection.status)} />}
      />

      <VStack gap={5}>
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Provider" value={connection.providerName ?? connection.providerId} />
            <DetailRow
              label="Status"
              value={<StatusBadge status={connectionStatus(connection.status)} />}
            />
            <DetailRow
              label="Token"
              value={connection.credentialId === null ? 'None stored' : 'Sealed in the vault'}
            />
            <DetailRow
              label="Validated"
              value={connection.validatedAt === null ? 'Never' : formatTimestamp(connection.validatedAt)}
            />
            <DetailRow label="Created" value={formatTimestamp(connection.createdAt)} />
            <DetailRow label="Updated" value={formatTimestamp(connection.updatedAt)} />
          </VStack>
        </Card>

        <SectionBlock
          title="Credential"
          description="Write-only: the token goes in, and only a vault reference comes back."
        >
          <CredentialPanel connection={connection} />
        </SectionBlock>

        <SectionBlock
          title="Lifecycle"
          description="Connect verifies the token and publishes the tools. Nothing reconnects on its own."
        >
          <ConnectionActions connection={connection} />
        </SectionBlock>

        <SectionBlock
          title="Published tools"
          description="Public names are namespaced by this connection (ADR-048). Empty until it is connected."
        >
          {tools === undefined ? (
            <ErrorState error={toolsError} title="Tools unavailable" />
          ) : (
            <ConnectionTools tools={tools} isConnected={connection.status === 'connected'} />
          )}
        </SectionBlock>
      </VStack>
    </PageContainer>
  );
}
