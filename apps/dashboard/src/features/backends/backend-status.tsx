import { Badge } from '@astryxdesign/core/Badge';
import { HStack } from '@astryxdesign/core/HStack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';

import type { BackendRuntimeStatus, BackendTransport } from '@/lib/api/types';
import { isTransientStatus } from '@/lib/backends/actions';
import { runtimeStatus, type Tone } from '@/lib/utils/status';

/**
 * Runtime state as the operator reads it.
 *
 * The word always accompanies the colour, so the state survives a greyscale
 * screenshot and a screen reader. Transient states use StatusDot's own
 * `isPulsing`, which already honours `prefers-reduced-motion` — no bespoke
 * animation and no CSS to keep in sync.
 *
 * The raw enum value is available via `showRaw` on the detail page, where a
 * support conversation needs the exact word the API recorded rather than the
 * dashboard's label for it.
 */
export function RuntimeStatus({
  status,
  showRaw = false,
}: {
  status: BackendRuntimeStatus;
  showRaw?: boolean;
}): React.ReactElement {
  const label = runtimeStatus(status);

  return (
    <HStack gap={2} align="center" wrap="wrap">
      <StatusDot variant={dotVariant(label.tone)} label={label.label} isPulsing={isTransientStatus(status)} />
      <Text type="body">{label.label}</Text>
      {showRaw ? <Text type="code">{status}</Text> : null}
    </HStack>
  );
}

/** Enabled is a configuration fact, deliberately separate from runtime state. */
export function EnabledBadge({ enabled }: { enabled: boolean }): React.ReactElement {
  return <Badge variant={enabled ? 'success' : 'neutral'} label={enabled ? 'Enabled' : 'Disabled'} />;
}

export function TransportLabel({ transport }: { transport: BackendTransport }): React.ReactElement {
  return <Text type="body">{transport === 'stdio' ? 'STDIO' : 'Streamable HTTP'}</Text>;
}

function dotVariant(tone: Tone): 'success' | 'warning' | 'error' | 'neutral' | 'accent' {
  return tone === 'info' ? 'accent' : tone;
}
