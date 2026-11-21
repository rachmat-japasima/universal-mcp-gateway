import { PageSkeleton } from '@/components/feedback/loading';
import { PageContainer } from '@/components/layout/page-container';

/**
 * The streamed fallback for every dashboard page.
 *
 * One file at this segment covers all nested routes: Next walks up to the nearest
 * `loading.tsx`, and every page below `/dashboard` has the same shape (a header,
 * then tiles or a table). It is also what makes the `<Suspense>` boundary the
 * App Router needs for a server component that awaits a read — so the shell and
 * the sidebar paint before the gateway answers.
 */
export default function Loading(): React.ReactElement {
  return (
    <PageContainer>
      <PageSkeleton />
    </PageContainer>
  );
}
