'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { Agent } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

/**
 * Lifecycle controls for one agent.
 *
 * Everything goes through the same-origin write proxy. Three behaviours that are
 * requirements rather than polish:
 *
 *  * **One action at a time**, so enable and delete cannot race.
 *  * **Disabling states the real consequence before it happens.** It is not a
 *    soft flag: `AgentService.setEnabled(false)` refuses new sessions *and*
 *    invalidates the agent's live ones in the same transaction. An operator who
 *    thinks it is a pause button would be surprised by dropped work.
 *  * **Delete asks first and names the blast radius.** `AgentService.remove`
 *    tombstones the agent, revokes its credentials and drops its policy
 *    assignments, and the gateway returns how many of each. The dialog says that
 *    before it happens; the list is where the operator lands afterwards.
 *
 * Success is only announced after the proxy answers.
 */

export function AgentActions({ agent, layout = 'row' }: { agent: Agent; layout?: 'row' | 'page' }): React.ReactElement {
  const router = useRouter();
  const [pending, setPending] = useState<'enable' | 'disable' | 'delete' | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [isDeleteOpen, setDeleteOpen] = useState(false);

  const busy = pending !== null;
  const size = layout === 'row' ? 'sm' : 'md';

  async function run(action: 'enable' | 'disable' | 'delete'): Promise<void> {
    if (busy) return;
    setFailure(undefined);
    setPending(action);

    const result = await send(
      action === 'delete' ? `/api/agents/${agent.id}` : `/api/agents/${agent.id}/${action}`,
      { method: action === 'delete' ? 'DELETE' : 'POST' },
    );
    setPending(null);

    if (!result.ok) {
      setFailure(result.message ?? 'The action could not be completed.');
      return;
    }

    if (action === 'delete') {
      // The page's subject no longer exists; refreshing it would be a 404.
      router.push('/dashboard/agents');
      return;
    }

    setDeleteOpen(false);
    router.refresh();
  }

  return (
    <VStack gap={2}>
      <HStack gap={2} wrap="wrap">
        {agent.enabled ? (
          <Button
            label="Disable"
            size={size}
            variant="secondary"
            isDisabled={busy}
            isLoading={pending === 'disable'}
            onClick={() => void run('disable')}
          />
        ) : (
          <Button
            label="Enable"
            size={size}
            variant="secondary"
            isDisabled={busy}
            isLoading={pending === 'enable'}
            onClick={() => void run('enable')}
          />
        )}
        {layout === 'page' ? (
          <Button label="Edit" size={size} variant="secondary" href={`/dashboard/agents/${agent.id}/edit`} as={Link} />
        ) : null}
        <Button
          label="Delete"
          size={size}
          variant="destructive"
          isDisabled={busy}
          isLoading={pending === 'delete'}
          onClick={() => setDeleteOpen(true)}
        />
      </HStack>

      {failure === undefined ? null : (
        <div role="alert" aria-live="assertive">
          <Text type="supporting" as="p">
            {failure}
          </Text>
        </div>
      )}

      {agent.enabled && layout === 'page' ? (
        <Text type="supporting" as="p">
          Disabling refuses new sessions and invalidates the agent&apos;s live ones immediately. Enable it again and
          existing credentials keep working — only the sessions were ended.
        </Text>
      ) : null}

      {isDeleteOpen ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setDeleteOpen(false);
          }}
          title={`Delete ${agent.name}?`}
          description="Deleting removes the agent from the registry, revokes every credential it holds, and drops every policy assignment. Sessions opened with those credentials stop working. The record is tombstoned rather than erased so audit history keeps a valid reference, but the agent cannot be restored or re-authenticated from the dashboard."
          actionLabel="Delete agent"
          cancelLabel="Keep agent"
          actionVariant="destructive"
          isActionLoading={pending === 'delete'}
          onAction={() => void run('delete')}
        />
      ) : null}
    </VStack>
  );
}
