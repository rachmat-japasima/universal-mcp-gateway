import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { getBackend } from '@/lib/api/backends';
import { isApiError } from '@/lib/api/errors';
import { BackendForm } from '@/features/backends/backend-form';

export const metadata: Metadata = { title: 'Edit backend' };

export const dynamic = 'force-dynamic';

/**
 * Edit flow.
 *
 * Reads the current backend and seeds the form from it, including its `version`.
 * The version is what makes the save a compare-and-set: if another tab (or
 * another operator) changed the backend in the meantime, `PATCH` answers `409`
 * instead of overwriting them.
 *
 * The form sends the whole configuration, not a diff, because that is what the
 * operator sees. `toUpdateInput` then handles the one thing a whole-object PUT
 * would get wrong: a cleared description must become `null` (clear it) rather
 * than `undefined` (leave it), and a dropped concurrency limit must be cleared
 * when the mode stops being `limited`.
 */
export default async function Page({ params }: { params: Promise<{ backendId: string }> }): Promise<React.ReactElement> {
  const { backendId } = await params;

  let backend;
  try {
    backend = await getBackend(backendId);
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.code === 'RESOURCE_NOT_FOUND')) notFound();
    return (
      <PageContainer>
        <ErrorState error={error} title="The backend could not be read" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title={`Edit ${backend.name}`}
          description="Saving changes never reconnects a live backend. If connection settings change, the gateway invalidates the runtime and you can reconnect deliberately."
        />
        <BackendForm backend={backend} />
      </div>
    </PageContainer>
  );
}
