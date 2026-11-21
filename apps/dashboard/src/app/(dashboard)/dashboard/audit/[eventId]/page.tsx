import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer } from '@/components/layout/page-container';
import { isApiError } from '@/lib/api/errors';
import { getAuditEvent } from '@/lib/api/endpoints';
import type { AuditEvent } from '@/lib/api/types';
import { AuditDetail } from '@/features/audit/audit-detail';

export const metadata: Metadata = { title: 'Audit event' };

export const dynamic = 'force-dynamic';

/**
 * One audit event, with metadata.
 *
 * The detail read is the only place metadata is disclosed. A `404` is a
 * genuinely absent record; a `400` (non-UUID id) is an error, because the
 * gateway refuses to let a malformed id look like a missing one.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ eventId: string }>;
}): Promise<React.ReactElement> {
  const { eventId } = await params;

  let event: AuditEvent;
  try {
    event = await getAuditEvent(eventId);
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.code === 'RESOURCE_NOT_FOUND')) notFound();
    return (
      <PageContainer>
        <ErrorState error={error} title="The audit event could not be read" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <AuditDetail event={event} />
    </PageContainer>
  );
}
