import type { Metadata } from 'next';

import { EmptyStateCard, ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { ConnectionForm } from '@/features/integrations/connection-form';
import { listProviders } from '@/lib/api/integrations';
import type { IntegrationProvider } from '@/lib/api/types';

export const metadata: Metadata = { title: 'Connect provider' };

export const dynamic = 'force-dynamic';

/**
 * Create a connection — the step that takes no secret.
 *
 * The provider list is the selector's source and is code-registered, so it is
 * short by design. An empty registry is not an error: it is the honest "no
 * provider ships in this build" state, and the form is not offered because
 * there is nothing valid to select.
 */

export default async function Page(): Promise<React.ReactElement> {
  let providers: IntegrationProvider[] | undefined;
  let error: unknown;

  try {
    providers = await listProviders();
  } catch (caught) {
    error = caught;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Connect provider"
        description="Creates the connection as Pending: it exists, nothing is verified, nothing is callable. The token has its own step on the next screen."
      />

      {providers === undefined ? (
        <ErrorState error={error} title="Provider registry unavailable" />
      ) : providers.length === 0 ? (
        <EmptyStateCard
          title="No providers registered"
          description="The provider registry is code-registered: providers ship with the gateway, and none is registered in this build. There is nothing to connect yet."
        />
      ) : (
        <ConnectionForm providers={providers} />
      )}
    </PageContainer>
  );
}
