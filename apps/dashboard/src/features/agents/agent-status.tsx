'use client';

import { Badge } from '@astryxdesign/core/Badge';
import { Text } from '@astryxdesign/core/Text';

import type { AgentCredential, ClientType } from '@/lib/api/types';

/**
 * Agent state as the operator reads it.
 *
 * `enabled` is the gateway's own configuration fact and `status` is the server's
 * derived word for it; the badge prints both, so a greyscale screenshot and a
 * screen reader still carry the meaning.
 */

const CLIENT_LABELS: Record<ClientType, string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  opencode: 'OpenCode',
  deepseek: 'DeepSeek',
  'deepseek-desktop': 'DeepSeek Desktop',
  other: 'Other',
};

export function EnabledBadge({ enabled }: { enabled: boolean }): React.ReactElement {
  return <Badge variant={enabled ? 'success' : 'neutral'} label={enabled ? 'Active' : 'Disabled'} />;
}

/** An unset client type is not "Other": it is simply not recorded. */
export function ClientTypeLabel({ clientType }: { clientType?: ClientType }): React.ReactElement {
  return (
    <Text type="body">
      {clientType === undefined ? 'Not set' : (CLIENT_LABELS[clientType] ?? clientType)}
    </Text>
  );
}

/** Credential state, derived server-side from `revokedAt` and `expiresAt`. */
export function CredentialStatusBadge({ status }: { status: AgentCredential['status'] }): React.ReactElement {
  if (status === 'active') return <Badge variant="success" label="Active" />;
  if (status === 'expired') return <Badge variant="warning" label="Expired" />;
  return <Badge variant="neutral" label="Revoked" />;
}
