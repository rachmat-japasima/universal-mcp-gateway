'use client';

import { Badge } from '@astryxdesign/core/Badge';
import { Text } from '@astryxdesign/core/Text';

import type { AuditActorType, AuditResult } from '@/lib/api/types';

/**
 * Audit vocabulary, separate from activity's.
 *
 * An audit row is a security claim, so the actor is printed as the gateway's own
 * word plus the id it recorded. `admin` is rendered "Operator" because that is
 * who it is locally, but `agent` and `system` stay literal: a client acted
 * through its credential, or the gateway itself acted on a sweep.
 */

type Variant = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const RESULT: Record<AuditResult, { label: string; variant: Variant }> = {
  success: { label: 'Success', variant: 'success' },
  failure: { label: 'Failure', variant: 'error' },
  denied: { label: 'Denied', variant: 'warning' },
};

export function AuditResultBadge({ result }: { result: AuditResult }): React.ReactElement {
  const { label, variant } = RESULT[result];
  return <Badge variant={variant} label={label} />;
}

const ACTOR: Record<AuditActorType, { label: string; variant: Variant }> = {
  admin: { label: 'Operator', variant: 'info' },
  agent: { label: 'Agent', variant: 'neutral' },
  system: { label: 'System', variant: 'neutral' },
};

export function AuditActorBadge({ actorType }: { actorType: AuditActorType }): React.ReactElement {
  const { label, variant } = ACTOR[actorType];
  return <Badge variant={variant} label={label} />;
}

/**
 * An action is a stable machine name (`session.terminated`) and its prefix is
 * already the target kind. It is printed verbatim rather than humanised, because
 * an audit reader matching a row against the documented vocabulary needs the
 * exact string — and because a "friendly" relabelling here could drift from the
 * gateway's enum without anything failing.
 */
export function AuditActionLabel({ action }: { action: string }): React.ReactElement {
  return <Text type="code">{action}</Text>;
}
