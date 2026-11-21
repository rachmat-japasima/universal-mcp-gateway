import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer } from '@/components/layout/page-container';
import { getAgent } from '@/lib/api/agents';
import { isApiError } from '@/lib/api/errors';
import type { Agent } from '@/lib/api/types';
import { AgentDetail } from '@/features/agents/agent-detail';

export const metadata: Metadata = { title: 'Agent' };

export const dynamic = 'force-dynamic';

/**
 * Agent detail.
 *
 * The profile read decides existence: a 404 means the agent is absent or
 * tombstoned, so this page is genuinely not found. Every other read on the page
 * (credentials, effective access) is a separate question that degrades on its
 * own — an access-evaluation failure must not hide the credentials an operator
 * came here to revoke.
 */
export default async function Page({ params }: { params: Promise<{ agentId: string }> }): Promise<React.ReactElement> {
  const { agentId } = await params;

  let agent: Agent;
  try {
    agent = await getAgent(agentId);
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.code === 'RESOURCE_NOT_FOUND')) notFound();
    return (
      <PageContainer>
        <ErrorState error={error} title="The agent could not be read" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <AgentDetail agent={agent} />
    </PageContainer>
  );
}
