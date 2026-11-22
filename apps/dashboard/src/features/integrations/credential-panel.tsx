'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { IntegrationConnection, IntegrationVerifyResult } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

/**
 * The one component in the dashboard that holds a provider token.
 *
 * The token exists in the input's state and nowhere else, and even that does
 * not outlive the submit: the field is cleared as soon as the request completes,
 * success or failure. It is never rendered back, never written to storage, and
 * no response can carry it — the gateway answers with the row, whose only
 * credential fact is the vault reference.
 *
 * `test` is deliberately not `connect`: it answers as data and moves nothing.
 */

const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens';
const NOTION_CONNECTIONS_URL = 'https://app.notion.com/developers/connections';

export function CredentialPanel({ connection }: { connection: IntegrationConnection }): React.ReactElement {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [pending, setPending] = useState<'store' | 'test' | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [announcement, setAnnouncement] = useState<{ status: 'success' | 'warning'; title: string; text?: string } | undefined>(undefined);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const busy = pending !== null;
  const hasStored = connection.credentialId !== null;
  const isGitHub = connection.providerId === 'github';
  const isNotion = connection.providerId === 'notion';

  async function store(): Promise<void> {
    if (busy) return;
    setFailure(undefined);
    setAnnouncement(undefined);
    setPending('store');

    const result = await send<IntegrationConnection>(`/api/integrations/connections/${connection.id}/credential`, {
      method: 'POST',
      body: { token: token.trim() },
    });
    // Cleared after submit, either way: keeping a rejected token in the field
    // is state a crash or a screenshot could expose, for no benefit.
    setToken('');
    setPending(null);
    setConfirmReplace(false);

    if (!result.ok) {
      setFailure(result.message ?? 'The token could not be stored.');
      return;
    }

    setAnnouncement({
      status: 'success',
      title: hasStored ? 'Token replaced.' : 'Token sealed in the vault.',
      text: 'Storing proves nothing — run Test to check it, or Connect to verify and publish the tools.',
    });
    router.refresh();
  }

  async function test(): Promise<void> {
    if (busy) return;
    setFailure(undefined);
    setAnnouncement(undefined);
    setPending('test');

    const result = await send<IntegrationVerifyResult>(`/api/integrations/connections/${connection.id}/test`, {
      method: 'POST',
    });
    setPending(null);

    if (!result.ok) {
      setFailure(result.message ?? 'The test could not run.');
      return;
    }

    // Data either way: a refused handshake is an answer, not an error.
    if (result.data?.ok === true) {
      setAnnouncement({ status: 'success', title: 'The token works.' });
      return;
    }

    setAnnouncement({
      status: 'warning',
      title: 'The token was rejected.',
      text:
        result.data === undefined
          ? 'The gateway answered but the result could not be read. Treat the token as unverified.'
          : result.data.kind === 'reauthorization_required'
            ? 'Store a new token to continue.'
            : `${result.data.message} (kind: ${result.data.kind})`,
    });
  }

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Text type="supporting" as="p">
            {hasStored
              ? 'A token is sealed in the vault. Storing a replacement deletes the previous one immediately — no grace period, and the connection keeps its current status until it is reconnected.'
              : 'No token stored yet. The token is written to the vault and can never be read back; the row will only say that one exists.'}
          </Text>
          {isGitHub ? (
            <Text type="supporting" as="p">
              GitHub fine-grained token. Read-only: Metadata, Issues and Pull requests are enough — this gateway asks
              for no write permission. Create one at{' '}
              <a href={GITHUB_TOKEN_URL} rel="noreferrer noopener" className="underline">
                github.com/settings/personal-access-tokens
              </a>
              .
            </Text>
          ) : null}
          {isNotion ? (
            <Text type="supporting" as="p">
              Notion internal connection token. Read content only — this gateway asks for no update, insert, comment,
              or user-information permission. Create the connection in the{' '}
              <a href={NOTION_CONNECTIONS_URL} rel="noreferrer noopener" className="underline">
                Notion developer portal
              </a>{' '}
              and copy the API token from its Configuration tab. The connection sees nothing until content is shared
              with it: use the portal&apos;s Content access tab, or a page&apos;s ••• → Connections → Add connection.
            </Text>
          ) : null}
        </VStack>

        {failure === undefined ? null : (
          <div role="alert" aria-live="assertive">
            <Banner status="error" title={failure} />
          </div>
        )}
        {announcement === undefined ? null : (
          <div role="status" aria-live="polite">
            <Banner
              status={announcement.status}
              title={announcement.title}
              // The answer's detail is the reason the banner exists — it must
              // not start behind a toggle the operator has to notice.
              collapsible={{ defaultIsOpen: true }}
            >
              {announcement.text === undefined ? null : <Text type="supporting">{announcement.text}</Text>}
            </Banner>
          </div>
        )}

        <HStack gap={2} wrap="wrap" align="end">
          <div className="min-w-[280px] flex-1">
            <TextInput
              label={hasStored ? 'Replacement token' : 'Access token'}
              type="password"
              value={token}
              autoComplete="off"
              description="Pasted here, sealed in the vault, then cleared from this field. Never displayed again."
              isDisabled={busy}
              onChange={setToken}
            />
          </div>
          <Button
            label={hasStored ? 'Replace token' : 'Store token'}
            variant="primary"
            isDisabled={busy || token.trim() === ''}
            isLoading={pending === 'store'}
            onClick={() => (hasStored ? setConfirmReplace(true) : void store())}
          />
          <Button
            label="Test token"
            variant="secondary"
            isDisabled={busy || !hasStored}
            isLoading={pending === 'test'}
            onClick={() => void test()}
          />
        </HStack>

        {!hasStored ? <Text type="supporting">Test needs a stored token; Connect without one will refuse with the same answer.</Text> : null}

        {confirmReplace ? (
          <AlertDialog
            isOpen
            onOpenChange={(open) => {
              if (!open) setConfirmReplace(false);
            }}
            title="Replace the stored token?"
            description="The previous token's envelope is deleted in the same transaction. Calls already proven keep working until the connection is reconnected; the stored replacement is not verified until you Test or Connect."
            actionLabel="Replace the stored token"
            cancelLabel="Keep current token"
            isActionLoading={pending === 'store'}
            onAction={() => void store()}
          />
        ) : null}
      </VStack>
    </Card>
  );
}
