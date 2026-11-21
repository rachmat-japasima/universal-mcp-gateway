import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer } from '@/components/layout/page-container';
import { listBackends } from '@/lib/api/backends';
import { isApiError } from '@/lib/api/errors';
import { getPolicy } from '@/lib/api/policies';
import type { Policy } from '@/lib/api/types';
import { PolicyDetail } from '@/features/policies/policy-detail';

export const metadata: Metadata = { title: 'Policy' };

export const dynamic = 'force-dynamic';

/**
 * Policy detail.
 *
 * The policy read decides existence: a `404` means it is absent, so the page is
 * genuinely not found. Backends are read only to turn rule targets into names,
 * and a failure there degrades a column rather than the page — the ids are still
 * the truth the gateway stored.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ policyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const { policyId } = await params;
  const search = await searchParams;

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

  const raw = search.previewAgentId;
  const previewAgentId = (Array.isArray(raw) ? raw[0] : raw)?.trim();

  return (
    <PageContainer>
      <PolicyDetail
        policy={policy}
        backends={backends}
        {...(previewAgentId === undefined || previewAgentId === '' ? {} : { previewAgentId })}
      />
    </PageContainer>
  );
}
