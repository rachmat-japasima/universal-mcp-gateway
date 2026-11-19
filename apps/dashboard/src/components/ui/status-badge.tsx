import { Badge } from '@astryxdesign/core/Badge';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';

import type { StatusLabel, Tone } from '@/lib/utils/status';

const BADGE_VARIANT = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  info: 'info',
  neutral: 'neutral',
} as const;

/** A status in words plus colour, so the state is never carried by colour alone. */
export function StatusBadge({ status }: { status: StatusLabel }): React.ReactElement {
  return <Badge variant={BADGE_VARIANT[status.tone]} label={status.label} />;
}

/**
 * Compact status for dense rows (a top bar, a table cell). `label` is required by
 * StatusDot and is the accessible name, so the meaning survives with the colour
 * removed.
 */
export function StatusIndicator({ status }: { status: StatusLabel }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-2">
      <StatusDot variant={dotVariant(status.tone)} label={status.label} />
      <Text type="supporting">{status.label}</Text>
    </span>
  );
}

function dotVariant(tone: Tone): 'success' | 'warning' | 'error' | 'neutral' | 'accent' {
  return tone === 'info' ? 'accent' : tone;
}
