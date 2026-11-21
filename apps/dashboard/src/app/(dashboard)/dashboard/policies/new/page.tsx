import type { Metadata } from 'next';

import { Text } from '@astryxdesign/core/Text';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { listBackends } from '@/lib/api/backends';
import { PolicyForm } from '@/features/policies/policy-form';

export const metadata: Metadata = { title: 'New policy' };

export const dynamic = 'force-dynamic';

/**
 * Create flow.
 *
 * The only read is the backend list, so a `backend` rule can pick a real id
 * instead of asking an operator to paste a UUID. A failed read is not fatal: the
 * form still accepts a wildcard and the gateway still validates the target, so
 * the page degrades to a notice rather than refusing to render.
 */
export default async function Page(): Promise<React.ReactElement> {
  let backends: Array<{ id: string; name: string }> | undefined;
  let error: unknown;

  try {
    const page = await listBackends({ limit: 100, sort: 'name' });
    backends = page.data.map((backend) => ({ id: backend.id, name: backend.name }));
  } catch (caught) {
    error = caught;
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Create policy"
          description="Rules are the policy. With no matching rule an agent is denied, so a policy with no ALLOW rules grants nothing — even once assigned."
        />

        {backends === undefined ? (
          <div className="flex flex-col gap-2">
            <ErrorState error={error} title="The backend list could not be read" />
            <Text type="supporting" as="p">
              Backend rules can still be written as a wildcard; only the backend picker is unavailable. The gateway
              validates an id it is given either way.
            </Text>
          </div>
        ) : null}

        <PolicyForm backends={backends ?? []} />
      </div>
    </PageContainer>
  );
}
