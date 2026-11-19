'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { Backend } from '@/lib/api/types';
import { actionAvailability, type BackendAction } from '@/lib/backends/actions';
import { send } from '@/lib/backends/browser';

/**
 * Lifecycle controls for one backend.
 *
 * Every action goes through the dashboard's own write proxy, which forwards the
 * operator cookie and the CSRF token derived from it — the browser never talks
 * to the gateway and never holds either.
 *
 * Three behaviours that are requirements, not polish:
 *
 *   * **One action at a time.** While a request is in flight every button is
 *     disabled, so `connect` and `disable` cannot race and leave a runtime row
 *     describing something neither of them meant.
 *   * **Availability comes from the gateway's own rules** (`actionAvailability`),
 *     so a button that would answer `409` on a disabled backend is not offered.
 *   * **Delete asks first**, names the backend, and says what is lost. It then
 *     navigates to the list rather than refreshing a page whose subject is gone.
 *
 * The proxy's answer is the only success signal: nothing is reported as done
 * before the gateway has replied.
 */

function actionPath(action: BackendAction, backendId: string, version: number): string {
  if (action === 'delete') return `/api/backends/${backendId}`;
  if (action === 'enable' || action === 'disable') {
    // Compare-and-set: the version proves this operator saw current state.
    return `/api/backends/${backendId}/${action}?expectedVersion=${version}`;
  }
  return `/api/backends/${backendId}/${action}`;
}

export function BackendActions({
  backend,
  layout = 'row',
}: {
  backend: Backend;
  /** `row` renders compact buttons for a table cell; `page` renders the detail toolbar. */
  layout?: 'row' | 'page';
}): React.ReactElement {
  const router = useRouter();
  const [pending, setPending] = useState<BackendAction | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [isDeleteOpen, setDeleteOpen] = useState(false);

  const available = actionAvailability(backend);
  const busy = pending !== null;
  const size = layout === 'row' ? 'sm' : 'md';

  async function run(action: BackendAction, method: 'POST' | 'DELETE' = 'POST'): Promise<void> {
    setFailure(undefined);
    setPending(action);

    const result = await send(actionPath(action, backend.id, backend.version), { method });
    setPending(null);

    if (!result.ok) {
      // A lost session is worth saying plainly; the gateway's own wording for the
      // rest is safer than anything this component could invent.
      setFailure(result.message);
      return;
    }

    if (action === 'delete') {
      router.push('/dashboard/backends');
      return;
    }

    // A new server render is the refresh: the gateway owns the post-action
    // state, so re-reading is cheaper and more honest than guessing.
    router.refresh();
  }

  const button = (
    action: BackendAction,
    label: string,
    variant: 'primary' | 'secondary' = 'secondary',
  ): React.ReactElement => (
    <Button
      label={label}
      size={size}
      variant={variant}
      isDisabled={busy}
      isLoading={pending === action}
      onClick={() => void run(action)}
    />
  );

  return (
    <VStack gap={2}>
      <HStack gap={2} wrap="wrap">
        {available.connect ? button('connect', 'Connect', 'primary') : null}
        {available.reconnect ? button('reconnect', 'Reconnect') : null}
        {available.disconnect ? button('disconnect', 'Disconnect') : null}
        {available.enable ? button('enable', 'Enable') : null}
        {available.disable ? button('disable', 'Disable') : null}
        <Button
          label="Delete"
          size={size}
          variant="destructive"
          isDisabled={busy}
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

      {isDeleteOpen ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setDeleteOpen(false);
          }}
          title={`Delete ${backend.name}?`}
          description="The backend is removed from the registry and can no longer serve tools. Its configuration is tombstoned rather than erased, so audit history keeps a valid reference, but it will not appear here again and cannot be restored from the dashboard."
          actionLabel="Delete backend"
          cancelLabel="Keep backend"
          actionVariant="destructive"
          isActionLoading={pending === 'delete'}
          onAction={() => void run('delete', 'DELETE')}
        />
      ) : null}
    </VStack>
  );
}
