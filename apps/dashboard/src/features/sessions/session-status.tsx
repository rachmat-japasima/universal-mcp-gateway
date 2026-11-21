'use client';

import { Badge } from '@astryxdesign/core/Badge';
import { Text } from '@astryxdesign/core/Text';

import type { SessionStatus } from '@/lib/api/types';
import type { StatusLabel, Tone } from '@/lib/utils/status';

/**
 * Session state as words plus colour.
 *
 * The statuses are the gateway's effective ones: `expired` covers a session
 * whose lifetime lapsed even if the sweep has not written the row back yet, so
 * the badge and the filter can never disagree. Colour is never the only carrier:
 * every badge prints the status word.
 */

const LABELS: Record<SessionStatus, StatusLabel> = {
  active: { label: 'Active', tone: 'success' },
  expired: { label: 'Expired', tone: 'warning' },
  terminated: { label: 'Terminated', tone: 'neutral' },
  invalidated: { label: 'Invalidated', tone: 'error' },
};

export function sessionStatus(status: SessionStatus): StatusLabel {
  return LABELS[status];
}

export function SessionStatusBadge({ status }: { status: SessionStatus }): React.ReactElement {
  const { label, tone } = sessionStatus(status);
  const variant: Record<Tone, 'success' | 'warning' | 'error' | 'info' | 'neutral'> = {
    success: 'success',
    warning: 'warning',
    error: 'error',
    info: 'info',
    neutral: 'neutral',
  };

  return <Badge variant={variant[tone]} label={label} />;
}

/**
 * Why a session ended. A reason is not a status: `cleanup` and `idle_timeout`
 * both mean "expired", but only the reason says which mechanism ended it.
 * The reason vocabulary is the gateway's; an unknown value from a newer
 * gateway renders as itself rather than being relabelled.
 */
export function TerminationReason({ reason }: { reason: string }): React.ReactElement {
  return (
    <Text type="supporting">
      {reason === 'operator_terminated' ? 'Ended by an operator' : `Reason: ${reason}`}
    </Text>
  );
}
