import { Badge } from '@astryxdesign/core/Badge';
import { HStack } from '@astryxdesign/core/HStack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';

import type { DiscoveryReport, ToolAvailability } from '@/lib/api/types';
import { availabilityStatus } from '@/lib/utils/status';

/**
 * Tool state as the operator reads it.
 *
 * `availability` is the gateway's own routing verdict, not something the
 * dashboard infers from a description or a schema: `unavailable` and `conflict`
 * tools are never routed, and the wording here says so. Colour never carries the
 * meaning alone — every state is a word too.
 */

export function AvailabilityBadge({ availability }: { availability: ToolAvailability }): React.ReactElement {
  const status = availabilityStatus(availability);

  return <Badge variant={status.tone} label={status.label} />;
}

const DISCOVERY_LABELS: Record<DiscoveryReport['status'], { label: string; dot: 'success' | 'error' | 'neutral' }> = {
  ok: { label: 'Discovery succeeded', dot: 'success' },
  failed: { label: 'Discovery failed', dot: 'error' },
  never: { label: 'Never discovered', dot: 'neutral' },
};

/**
 * Last discovery outcome for one backend. `never` is absence, not a failure.
 *
 * No conflict count is rendered from the report: `conflictCount` is a baseline
 * zero there by design, and the live number is `GET /tools/conflicts`, which the
 * explorer reads separately. Printing the report's zero would claim a clean
 * catalog that the gateway never asserted.
 */
export function DiscoveryStatus({ report }: { report: DiscoveryReport }): React.ReactElement {
  const { label, dot } = DISCOVERY_LABELS[report.status];

  return (
    <HStack gap={2} align="center" wrap="wrap">
      <StatusDot variant={dot} label={label} />
      <Text type="supporting">
        {label} · {report.toolCount} tool{report.toolCount === 1 ? '' : 's'}
        {report.rejectedCount > 0 ? ` · ${report.rejectedCount} rejected` : ''}
      </Text>
    </HStack>
  );
}
