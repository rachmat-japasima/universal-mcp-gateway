import Link from 'next/link';

import { PageContainer, PageHeader } from '@/components/layout/page-container';

/**
 * Unknown route.
 *
 * A not-found page inside the dashboard still needs the shell around it, which
 * the `(dashboard)` layout provides; this file only owns the message. Actions are
 * ordinary links, so they work before hydration and are keyboard-reachable
 * without JavaScript.
 */
export default function NotFound(): React.ReactElement {
  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader title="Page not found" description="That route does not exist in this dashboard." />
        <p className="text-sm text-secondary">
          <Link className="underline" href="/dashboard">
            Return to the overview
          </Link>
        </p>
      </div>
    </PageContainer>
  );
}
