import type { Metadata } from 'next';

import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { BackendForm } from '@/features/backends/backend-form';

export const metadata: Metadata = { title: 'New backend' };

/**
 * Create flow.
 *
 * The form is a client component because it owns draft state; the page itself
 * does no reads. `POST /api/v1/backends` never connects a backend, so a
 * successful create lands on a detail page showing `disconnected` — which is the
 * truth, not a missing refresh.
 */
export default function Page(): React.ReactElement {
  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Add backend"
          description="Register an MCP server. Creating it stores configuration only; nothing is launched or dialled until you connect it."
        />
        <BackendForm />
      </div>
    </PageContainer>
  );
}
