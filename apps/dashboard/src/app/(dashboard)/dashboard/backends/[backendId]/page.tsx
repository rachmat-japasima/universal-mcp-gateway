import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer } from '@/components/layout/page-container';
import { getBackend, getBackendRuntime } from '@/lib/api/backends';
import { isApiError } from '@/lib/api/errors';
import type { BackendRuntimeView } from '@/lib/api/types';
import { BackendDetail } from '@/features/backends/backend-detail';

export const metadata: Metadata = { title: 'Backend' };

export const dynamic = 'force-dynamic';

/**
 * Backend detail.
 *
 * Two reads, and the difference between them matters:
 *
 *  * `GET /api/v1/backends/:id` is the configuration. If it 404s the backend is
 *    absent or tombstoned, and the page is genuinely not found.
 *  * `GET /api/v1/backends/:id/runtime` is the live state, and the only source of
 *    `lastConnectedAt`, `reconnectAttempts` and the `lastError*` fields. The list
 *    view carries only `{status, updatedAt}`.
 *
 * A failed runtime read does not hide the configuration: the runtime section
 * reports the failure and the rest of the page still renders. Reporting an empty
 * runtime instead would be the exact "0 means the read failed" lie this API's
 * `null` semantics exist to prevent.
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

  let runtime: BackendRuntimeView | undefined;
  let runtimeError: string | undefined;

  try {
    runtime = await getBackendRuntime(backendId);
  } catch (error) {
    runtimeError = isApiError(error) ? error.userMessage : 'The runtime state could not be read.';
  }

  return (
    <PageContainer>
      <BackendDetail backend={backend} runtime={runtime} runtimeError={runtimeError} />
    </PageContainer>
  );
}
