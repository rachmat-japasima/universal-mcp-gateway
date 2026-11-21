'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { Session } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

/**
 * Ends one MCP session through the gateway.
 *
 * Why this is a real action and not a status edit: `POST /sessions/:id/terminate`
 * writes the row, releases the transport, records one `session.terminated` audit
 * event, and every later request carrying that protocol id is refused. The
 * dashboard performs the call; it never writes a status of its own.
 *
 * The confirmation names the consequence for the connected client, because an
 * operator about to click it needs to know the client is not "paused" — it must
 * re-initialize (with a valid credential) to work again. Termination does not
 * touch the credential, the agent, or any other session, and the copy says so.
 *
 * Duplicate submission is prevented twice over: the button is disabled while a
 * request is in flight, and the gateway's terminate is idempotent — a second
 * call returns the already-finished row instead of a second termination.
 *
 * Success is announced only after the proxy answers, and only then does the page
 * re-read.
 */

export function SessionTerminateAction({
  session,
  layout = 'row',
}: {
  session: Session;
  layout?: 'row' | 'page';
}): React.ReactElement {
  const router = useRouter();
  const [isOpen, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const finished = session.status !== 'active';
  const size = layout === 'row' ? 'sm' : 'md';

  async function run(): Promise<void> {
    if (pending) return;
    setFailure(undefined);
    setPending(true);

    const result = await send(`/api/sessions/${session.id}/terminate`, { method: 'POST' });
    setPending(false);

    if (!result.ok) {
      setFailure(result.message ?? 'The session could not be terminated.');
      return;
    }

    setOpen(false);
    router.refresh();
  }

  return (
    <VStack gap={2}>
      <HStack gap={2} wrap="wrap">
        <Button
          label="Terminate"
          size={size}
          variant="destructive"
          isDisabled={pending || finished}
          isLoading={pending}
          onClick={() => setOpen(true)}
        />
        {finished ? (
          <Text type="supporting" as="span">
            Already ended
          </Text>
        ) : null}
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
          title="Terminate this session?"
          description="The connected MCP client stops working immediately: its next request is refused, and it must initialize a new session with a valid credential to continue. The credential and the agent are unaffected, and no other session is ended. The record stays on this page as terminated, and an audit record is written."
          actionLabel="Terminate session"
          cancelLabel="Keep session"
          actionVariant="destructive"
          isActionLoading={pending}
          onAction={() => void run()}
        />
      ) : null}
    </VStack>
  );
}
