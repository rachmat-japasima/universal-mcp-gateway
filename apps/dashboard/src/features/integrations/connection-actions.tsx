'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { IntegrationConnection, IntegrationEnableResult } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

/**
 * Lifecycle controls for one connection.
 *
 * Everything goes through the same-origin write proxy. Four behaviours that are
 * requirements rather than polish:
 *
 *  * **One action at a time**, so enable and delete cannot race.
 *  * **`enable` is the only path to `connected`** — and the only exit from
 *    `disabled`, and the only reconnect from `disconnected`. On a live
 *    connection the same action is the refresh: it re-runs the handshake and
 *    re-publishes tools in place. The label says which of those it is; nothing
 *    reconnects automatically.
 *  * **Disable and disconnect state their real consequence before they
 *    happen:** the tools are withdrawn in the same instant, and any agent
 *    mid-call through this connection loses it.
 *  * **Delete asks first and names the blast radius:** tools, then the row,
 *    then the sealed credential — hard delete, not tombstone.
 */

type Action = 'enable' | 'disable' | 'disconnect' | 'delete';

function enableLabel(status: IntegrationConnection['status']): string {
  switch (status) {
    case 'connected':
      return 'Refresh';
    case 'disabled':
      return 'Enable';
    case 'disconnected':
    case 'reauthorization_required':
      return 'Reconnect';
    default:
      return 'Connect';
  }
}

export function ConnectionActions({ connection }: { connection: IntegrationConnection }): React.ReactElement {
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [announcement, setAnnouncement] = useState<string | undefined>(undefined);

  const busy = pending !== null;
  const isConnected = connection.status === 'connected';

  async function run(action: Action): Promise<void> {
    if (busy) return;
    setFailure(undefined);
    setAnnouncement(undefined);
    setPending(action);

    const result =
      action === 'delete'
        ? await send<never>(`/api/integrations/connections/${connection.id}`, { method: 'DELETE' })
        : await send<IntegrationEnableResult>(`/api/integrations/connections/${connection.id}/${action}`, {
            method: 'POST',
          });
    setPending(null);

    if (!result.ok) {
      setConfirm(null);
      setFailure(result.message ?? 'The action could not be completed.');
      return;
    }

    if (action === 'delete') {
      // The page's subject no longer exists; refreshing it would be a 404.
      router.push('/dashboard/integrations');
      return;
    }

    if (action === 'enable') {
      // The outcome is data: what the catalog learned is worth saying, and
      // "no tools published" is a fact an operator would otherwise have to
      // check by hand. A refresh reports the diff, not a false "published 0".
      const added = result.data?.tools.added.length;
      const removed = result.data?.tools.removed.length;
      setAnnouncement(
        connection.status === 'connected'
          ? added === undefined
            ? 'Refreshed. The tool list was not in the response — re-open the page to see what published.'
            : `Refreshed. ${added} new tool${added === 1 ? '' : 's'}, ${removed ?? 0} removed.`
          : added === undefined
            ? 'Connected. The tool list was not in the response — re-open the page to see what published.'
            : `Connected. ${added === 0 ? 'No tools published' : `${added} tool${added === 1 ? '' : 's'} published`}.`,
      );
    } else {
      setConfirm(null);
    }

    router.refresh();
  }

  return (
    <VStack gap={2}>
      <div className="flex flex-wrap items-center gap-2">
        {connection.status === 'connecting' ? (
          <Button label="Connecting…" size="sm" variant="secondary" isDisabled />
        ) : (
          <Button
            label={enableLabel(connection.status)}
            size="sm"
            variant="primary"
            isDisabled={busy}
            isLoading={pending === 'enable'}
            onClick={() => void run('enable')}
          />
        )}

        {isConnected ? (
          <>
            <Button
              label="Disable"
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onClick={() => setConfirm('disable')}
            />
            <Button
              label="Disconnect"
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onClick={() => setConfirm('disconnect')}
            />
          </>
        ) : null}

        <Button
          label="Delete"
          size="sm"
          variant="destructive"
          isDisabled={busy}
          onClick={() => setConfirm('delete')}
        />
      </div>

      {failure === undefined ? null : (
        <div role="alert" aria-live="assertive">
          <Text type="supporting" as="p">
            {failure}
          </Text>
        </div>
      )}

      {announcement === undefined ? null : (
        <div role="status" aria-live="polite">
          <Text type="supporting" as="p">
            {announcement}
          </Text>
        </div>
      )}

      {confirm === 'disable' ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          title={`Disable ${connection.name}?`}
          description="The tools this connection publishes are withdrawn immediately; any agent calling them starts failing on the next request. The row and its sealed token survive — Enable is the way back."
          actionLabel="Disable connection"
          cancelLabel="Keep it connected"
          isActionLoading={pending === 'disable'}
          onAction={() => void run('disable')}
        />
      ) : null}

      {confirm === 'disconnect' ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          title={`Disconnect ${connection.name}?`}
          description="The tools are withdrawn and the row rests at Disconnected. The token stays sealed and is not re-proved until you reconnect, which runs the verification handshake again."
          actionLabel="Disconnect connection"
          cancelLabel="Keep it connected"
          isActionLoading={pending === 'disconnect'}
          onAction={() => void run('disconnect')}
        />
      ) : null}

      {confirm === 'delete' ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          title={`Delete ${connection.name}?`}
          description="Hard delete. The tools are withdrawn, the connection row is removed, and the sealed credential is destroyed with it. There is no tombstone and no undo; a deleted connection must be created again from scratch."
          actionLabel="Delete connection"
          cancelLabel="Keep connection"
          actionVariant="destructive"
          isActionLoading={pending === 'delete'}
          onAction={() => void run('delete')}
        />
      ) : null}
    </VStack>
  );
}
