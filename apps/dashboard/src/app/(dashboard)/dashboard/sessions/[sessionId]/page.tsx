import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer } from '@/components/layout/page-container';
import { isApiError } from '@/lib/api/errors';
import { getSession } from '@/lib/api/sessions';
import type { Session } from '@/lib/api/types';
import { SessionDetail } from '@/features/sessions/session-detail';

export const metadata: Metadata = { title: 'Session' };

export const dynamic = 'force-dynamic';

/**
 * Session detail.
 *
 * The item read decides existence: a `404` means the session row is absent, so
 * the page is genuinely not found. A non-UUID id is a `400`, not a `404` — the
 * gateway refuses to let an error distinguish "no such id" from "malformed id",
 * and this page renders that as an error rather than as a missing session.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}): Promise<React.ReactElement> {
  const { sessionId } = await params;

  let session: Session;
  try {
    session = await getSession(sessionId);
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.code === 'RESOURCE_NOT_FOUND')) notFound();
    return (
      <PageContainer>
        <ErrorState error={error} title="The session could not be read" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <SessionDetail session={session} />
    </PageContainer>
  );
}
