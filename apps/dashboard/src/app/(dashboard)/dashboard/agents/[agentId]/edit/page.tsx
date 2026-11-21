import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { getAgent } from '@/lib/api/agents';
import { isApiError } from '@/lib/api/errors';
import type { Agent } from '@/lib/api/types';
import { AgentForm } from '@/features/agents/agent-form';

export const metadata: Metadata = { title: 'Edit agent' };

export const dynamic = 'force-dynamic';

/**
 * Edit flow.
 *
 * The profile is re-read rather than passed from the list, so a stale row cannot
 * be saved back over a newer value. There is no `version` on an agent, so the
 * form cannot promise a compare-and-set; it re-reads after saving instead.
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
      <div className="flex flex-col gap-6">
        <PageHeader
          title={`Edit ${agent.name}`}
          description="Profile fields only. Credentials have their own panel on the detail page, because a token must be shown once and this form has nowhere safe to put one."
        />
        <AgentForm agent={agent} />
      </div>
    </PageContainer>
  );
}
