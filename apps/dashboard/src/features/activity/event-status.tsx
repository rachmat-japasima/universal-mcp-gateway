'use client';

import { Badge } from '@astryxdesign/core/Badge';
import { Text } from '@astryxdesign/core/Text';

import type { ActivityOutcome, ActivityType } from '@/lib/api/types';

/**
 * Activity vocabulary as the operator reads it.
 *
 * Kept apart from `features/audit/audit-status.tsx` on purpose: activity answers
 * "what did the gateway do?", audit answers "who changed what?". They share the
 * words success/failure/denied, but they are separate enums with separate pages,
 * and one shared badge would invite one page to be built from the other's shape.
 *
 * Colour never carries meaning alone: every badge prints its word.
 */

type Variant = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const OUTCOME: Record<ActivityOutcome, { label: string; variant: Variant }> = {
  success: { label: 'Success', variant: 'success' },
  failure: { label: 'Failure', variant: 'error' },
  denied: { label: 'Denied', variant: 'warning' },
};

export function ActivityOutcomeBadge({ outcome }: { outcome: ActivityOutcome }): React.ReactElement {
  const { label, variant } = OUTCOME[outcome];
  return <Badge variant={variant} label={label} />;
}

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  'mcp.initialize': 'Session initialized',
  'tools.list': 'Tool list',
  'tools.call': 'Tool call',
  'backend.connected': 'Backend connected',
  'backend.disconnected': 'Backend disconnected',
  'backend.error': 'Backend error',
  'request.failed': 'Request failed',
};

export function activityTypeLabel(type: ActivityType): string {
  return ACTIVITY_TYPE_LABELS[type] ?? type;
}

/**
 * The stored type is shown beside the human sentence: an operator matching a row
 * against `docs/API_REFERENCE.md` needs the exact machine name.
 */
export function ActivityTypeLabel({ type }: { type: ActivityType }): React.ReactElement {
  return (
    <span className="inline-flex flex-col">
      <Text type="body">{activityTypeLabel(type)}</Text>
      <Text type="code">{type}</Text>
    </span>
  );
}
