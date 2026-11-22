import type { Metadata } from 'next';

import { LinkButton } from '@/components/ui/link-button';

import { EmptyStateCard, ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { ConnectionsTable } from '@/features/integrations/connections-table';
import { listConnections, listProviders } from '@/lib/api/integrations';
import { isApiError } from '@/lib/api/errors';
import type { IntegrationConnection, IntegrationProvider } from '@/lib/api/types';

export const metadata: Metadata = { title: 'Integrations' };

export const dynamic = 'force-dynamic';

/**
 * Managed-integration connections (Phase 13).
 *
 * Two reads, deliberately independent: the connections table is the subject,
 * and the provider list only names the registered providers in the empty
 * state — a registry read that fails must not hide the connections that exist.
 */

export default async function Page(): Promise<React.ReactElement> {
  let connections: IntegrationConnection[] | undefined;
  let connectionError: unknown;

  try {
    connections = await listConnections();
  } catch (error) {
    connectionError = error;
  }

  // The empty state names the real way forward, so the provider list is worth
  // one extra read — but never at the cost of the page.
  let providers: IntegrationProvider[] = [];
  if (connections !== undefined && connections.length === 0) {
    try {
      providers = await listProviders();
    } catch {
      // The empty state falls back to the generic sentence.
    }
  }

  const providerNames = providers.map((provider) => provider.name).join(', ');
  const emptyDescription =
    providerNames === ''
      ? 'A managed-integration connection is a sealed credential plus a set of read-only tools the gateway publishes on your behalf.'
      : `A managed-integration connection is a sealed credential plus a set of read-only tools the gateway publishes on your behalf. ${providerNames} ${providers.length === 1 ? 'is' : 'are'} registered and ready.`;

  return (
    <PageContainer>
      <PageHeader
        title="Integrations"
        description="Code-registered providers, connected with credentials the gateway seals and never shows again."
        actions={
          <LinkButton label="Connect provider" href="/dashboard/integrations/new" variant="primary" />
        }
      />

      {connections === undefined ? (
        <ErrorState error={connectionError} title="Connections unavailable" />
      ) : connections.length === 0 ? (
        <EmptyStateCard
          title="No connections yet"
          description={emptyDescription}
          actions={<LinkButton label="Connect provider" href="/dashboard/integrations/new" variant="secondary" />}
        />
      ) : (
        <ConnectionsTable connections={connections} />
      )}
    </PageContainer>
  );
}
