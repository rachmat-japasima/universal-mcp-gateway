import { Card } from '@astryxdesign/core/Card';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { VStack } from '@astryxdesign/core/VStack';

import { RefreshButton } from '@/components/feedback/refresh-button';
import { isApiError } from '@/lib/api/errors';

/**
 * The four states every data surface needs, in one place so no page invents a
 * fifth. The distinction that matters most: an *empty* registry is a real
 * `0`, while an *unavailable* read is unknown. They are different components
 * because they are different claims.
 */

export function EmptyStateCard({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <Card padding={0}>
      <EmptyState title={title} description={description} headingLevel={2} actions={actions} />
    </Card>
  );
}

/**
 * Errors are rendered from the normalised `ApiError`, never from a raw thrown
 * value: `userMessage` is written for an operator and cannot contain a stack
 * trace, SQL text, or the request URL.
 *
 * The retry affordance is `<RefreshButton>` rather than an `onRetry` callback.
 * These pages are server components — a function prop cannot cross that
 * boundary, so an `onRetry` parameter could only ever be `undefined` and the
 * button it guarded was unreachable. `RefreshButton` re-runs the same server
 * render that produced the error, which is the actual retry for a `no-store`
 * read.
 */
export function ErrorState({
  error,
  title = 'Something went wrong',
}: {
  error: unknown;
  title?: string;
}): React.ReactElement {
  const message = isApiError(error) ? error.userMessage : 'An unexpected error occurred.';
  const requestId = isApiError(error) ? error.requestId : undefined;
  // A contract mismatch will answer the same way until a version changes, so
  // retrying it would only produce the same screen again.
  const retryable = isApiError(error) && error.kind !== 'invalid-response';

  return (
    <Card padding={0}>
      <EmptyState
        title={title}
        description={requestId === undefined ? message : `${message} (request ${requestId})`}
        headingLevel={2}
        actions={
          retryable ? (
            <VStack gap={0}>
              <RefreshButton label="Retry" />
            </VStack>
          ) : undefined
        }
      />
    </Card>
  );
}
