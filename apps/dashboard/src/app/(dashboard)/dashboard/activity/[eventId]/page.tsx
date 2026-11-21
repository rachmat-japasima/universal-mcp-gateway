import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { isApiError } from '@/lib/api/errors';
import { getActivityEvent } from '@/lib/api/endpoints';
import type { ActivityEvent } from '@/lib/api/types';
import { ActivityDetail } from '@/features/activity/activity-detail';

export const metadata: Metadata = { title: 'Activity event' };

export const dynamic = 'force-dynamic';

/**
 * One activity event.
 *
 * The item read decides existence: a `404` means the row is absent, so the page
 * is genuinely not found. A non-UUID id is a `400`, which is an error rather than
 * a missing event — the same distinction the sessions detail makes.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ eventId: string }>;
}): Promise<React.ReactElement> {
  const { eventId } = await params;

  let event: ActivityEvent;
  try {
    event = await getActivityEvent(eventId);
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.code === 'RESOURCE_NOT_FOUND')) notFound();
    return (
      <PageContainer>
        <ErrorState error={error} title="The activity event could not be read" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <ActivityDetail event={event} />
    </PageContainer>
  );
}
