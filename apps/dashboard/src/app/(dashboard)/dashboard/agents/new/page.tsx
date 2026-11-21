import type { Metadata } from 'next';

import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { AgentForm } from '@/features/agents/agent-form';

export const metadata: Metadata = { title: 'New agent' };

/**
 * Create flow.
 *
 * The page does no reads. `POST /api/v1/agents` creates a profile only — no
 * credential — so the form lands on the detail page, where the credential panel
 * can show a token once in a panel built for exactly that.
 */
export default function Page(): React.ReactElement {
  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Add agent"
          description="Register an identity. Creating it stores the profile only: it cannot authenticate until you issue a credential, and it cannot call anything until a policy grants access."
        />
        <AgentForm />
      </div>
    </PageContainer>
  );
}
