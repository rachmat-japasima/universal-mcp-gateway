'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { Policy } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

/**
 * Delete for one policy.
 *
 * Deleting is a hard delete, and it is destructive in a specific way worth
 * naming before it happens: assignments cascade, so every agent holding this
 * policy loses every grant it carried, at once, with no undo. That is the safe
 * direction for access (failing closed) but not a reversible one, so the dialog
 * says so and the button lands on the list afterwards.
 */

export function PolicyActions({ policy }: { policy: Policy }): React.ReactElement {
  const router = useRouter();
  const [isOpen, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  async function remove(): Promise<void> {
    if (pending) return;
    setFailure(undefined);
    setPending(true);

    const result = await send(`/api/policies/${policy.id}`, { method: 'DELETE' });
    setPending(false);
    setOpen(false);

    if (!result.ok) {
      setFailure(result.message ?? 'The policy could not be deleted.');
      return;
    }

    router.push('/dashboard/policies');
  }

  return (
    <VStack gap={2}>
      <HStack gap={2} wrap="wrap">
        <Button label="Edit" variant="secondary" href={`/dashboard/policies/${policy.id}/edit`} as={Link} />
        <Button label="Delete" variant="destructive" isDisabled={pending} isLoading={pending} onClick={() => setOpen(true)} />
      </HStack>

      {failure === undefined ? null : (
        <div role="alert" aria-live="assertive">
          <Text type="supporting" as="p">
            {failure}
          </Text>
        </div>
      )}

      {isOpen ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setOpen(false);
          }}
          title={`Delete ${policy.name}?`}
          description="Deleting removes the policy and every assignment to it, so every agent that holds it loses its rules immediately. There is no undo and the policy cannot be restored from the dashboard."
          actionLabel="Delete policy"
          cancelLabel="Keep policy"
          actionVariant="destructive"
          isActionLoading={pending}
          onAction={() => void remove()}
        />
      ) : null}
    </VStack>
  );
}
