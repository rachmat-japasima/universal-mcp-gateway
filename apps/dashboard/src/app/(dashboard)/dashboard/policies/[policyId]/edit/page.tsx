import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { listBackends } from '@/lib/api/backends';
import { isApiError } from '@/lib/api/errors';
import { getPolicy } from '@/lib/api/policies';
import type { Policy } from '@/lib/api/types';
import { PolicyForm } from '@/features/policies/policy-form';

export const metadata: Metadata = { title: 'Edit policy' };

export const dynamic = 'force-dynamic';

/**
 * Edit flow.
 *
 * The policy is re-read here rather than passed from the detail page, so the
 * diff that decides whether a save widens access is against what the gateway
 * holds now — not against a page that may be minutes old. The policy has no
 * `version` field, so the form cannot promise compare-and-set; it re-reads after
 * saving instead.
 */
export default async function Page({ params }: { params: Promise<{ policyId: string }> }): Promise<React.ReactElement> {
  const { policyId } = await params;

  let policy: Policy;
  try {
    policy = await getPolicy(policyId);
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.code === 'RESOURCE_NOT_FOUND')) notFound();
    return (
      <PageContainer>
        <ErrorState error={error} title="The policy could not be read" />
      </PageContainer>
    );
  }

  const backends = await listBackends({ limit: 100, sort: 'name' })
    .then((page) => page.data.map((backend) => ({ id: backend.id, name: backend.name })))
    .catch(() => []);

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title={`Edit ${policy.name}`}
          description="Saving replaces the whole rule list. Removing a DENY rule or adding an ALLOW rule widens access for every assigned agent, and you will be asked to confirm before that happens."
        />
        <PolicyForm policy={policy} backends={backends} />
      </div>
    </PageContainer>
  );
}
