'use client';

import { Badge } from '@astryxdesign/core/Badge';
import { Text } from '@astryxdesign/core/Text';

import type { PolicyEffect, PolicyResource } from '@/lib/api/types';

/**
 * Effect and resource labels.
 *
 * The word is always rendered beside the colour, so an ALLOW/DENY distinction —
 * the one difference that matters most on this screen — survives greyscale, a
 * colour-vision difference, and a screen reader. `deny` is not "off": it is an
 * explicit refusal that outranks any allow at the same priority.
 */

export function EffectBadge({ effect }: { effect: PolicyEffect }): React.ReactElement {
  return <Badge variant={effect === 'allow' ? 'success' : 'error'} label={effect.toUpperCase()} />;
}

const RESOURCE_LABELS: Record<PolicyResource, string> = {
  backend: 'Backend',
  tool: 'Tool',
};

export function ResourceLabel({ resource }: { resource: PolicyResource }): React.ReactElement {
  return <Text type="body">{RESOURCE_LABELS[resource]}</Text>;
}

/** A wildcard is broad access by definition, so it is called out wherever a rule is shown. */
export function TargetLabel({ target }: { target: string }): React.ReactElement {
  if (target === '*') {
    return (
      <Text type="code" color="primary">
        * <Text type="supporting">(everything at this level)</Text>
      </Text>
    );
  }

  return <Text type="code">{target}</Text>;
}
