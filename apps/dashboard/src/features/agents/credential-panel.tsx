'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { AgentCredential, IssuedCredential } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

import { CredentialStatusBadge } from './agent-status';

/**
 * Credential lifecycle for one agent.
 *
 * **The raw token lives in this component's state and nowhere else.** It is
 * returned exactly once by `POST …/credentials` (issue) or
 * `POST …/credentials/:id/rotate`, cannot be retrieved again, and is not written
 * to `localStorage`, `sessionStorage`, a cookie, the URL, a log, or an audit
 * field. Closing the panel unmounts it and the string is gone; refreshing the
 * page cannot bring it back, and the panel says so rather than letting an
 * operator discover it later.
 *
 * Three semantic facts the copy states plainly, because each one surprises
 * someone who assumes otherwise:
 *
 *  * **Rotation is replace-semantics with no grace period.** The previous
 *    credential is revoked in the same transaction, in the same store write.
 *  * **Sessions bound to a rotated or revoked credential are invalidated.** A
 *    client that keeps its old token gets `401`, not a deprecation window.
 *  * **A revoked credential cannot be rotated** — the gateway answers `409`; it
 *    must be re-issued instead.
 *
 * Nothing is reported as done before the gateway answers, and the list is
 * re-read from the server afterwards rather than patched locally.
 */

type Pending = 'issue' | `revoke:${string}` | `rotate:${string}` | null;

type IssueForm = { name: string; expiresAt: string };

const EMPTY_FORM: IssueForm = { name: '', expiresAt: '' };

/** `datetime-local` gives `2026-01-01T10:00`; the gateway needs a full ISO instant. */
function toIsoInstant(local: string): string | undefined {
  if (local.trim() === '') return undefined;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function formatDate(value: string | undefined): string {
  if (value === undefined) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/** See `agents-table.tsx`: an interface cannot satisfy `Record<string, unknown>`. */
type CredentialRow = {
  id: string;
  name?: string;
  tokenPrefix?: string;
  status: AgentCredential['status'];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
};

function columns(): TableColumn<CredentialRow>[] {
  return [
    {
      key: 'name',
      header: 'Label',
      width: proportional(3, { minWidth: 160 }),
      renderCell: (credential) =>
        credential.name === undefined ? (
          <Text type="supporting">Unnamed</Text>
        ) : (
          <Text type="body">{credential.name}</Text>
        ),
    },
    {
      key: 'tokenPrefix',
      header: 'Prefix',
      width: proportional(2, { minWidth: 130 }),
      renderCell: (credential) =>
        credential.tokenPrefix === undefined ? (
          <Text type="supporting">—</Text>
        ) : (
          // Only the display prefix is stored and returned; it is not usable as a
          // credential and is the same string the gateway lists.
          <Text type="code">{credential.tokenPrefix}…</Text>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (credential) => <CredentialStatusBadge status={credential.status} />,
    },
    {
      key: 'createdAt',
      header: 'Issued',
      width: proportional(2, { minWidth: 160 }),
      renderCell: (credential) => <Text type="supporting">{formatDate(credential.createdAt)}</Text>,
    },
    {
      key: 'expiresAt',
      header: 'Expires',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (credential) => <Text type="supporting">{formatDate(credential.expiresAt)}</Text>,
    },
    {
      key: 'lastUsedAt',
      header: 'Last used',
      width: proportional(2, { minWidth: 150 }),
      renderCell: (credential) =>
        credential.lastUsedAt === undefined ? (
          <Text type="supporting">Never</Text>
        ) : (
          <Text type="supporting">{formatDate(credential.lastUsedAt)}</Text>
        ),
    },
  ];
}

export function CredentialPanel({
  agentId,
  agentName,
  credentials,
}: {
  agentId: string;
  agentName: string;
  credentials: AgentCredential[];
}): React.ReactElement {
  const router = useRouter();
  const [form, setForm] = useState<IssueForm>(EMPTY_FORM);
  const [pending, setPending] = useState<Pending>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [issued, setIssued] = useState<IssuedCredential | undefined>(undefined);
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'rotate'; credential: AgentCredential } | undefined>(
    undefined,
  );

  const busy = pending !== null;

  const rows: CredentialRow[] = credentials.map((credential) => ({
    id: credential.id,
    ...(credential.name === undefined ? {} : { name: credential.name }),
    ...(credential.tokenPrefix === undefined ? {} : { tokenPrefix: credential.tokenPrefix }),
    status: credential.status,
    createdAt: credential.createdAt,
    ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    ...(credential.lastUsedAt === undefined ? {} : { lastUsedAt: credential.lastUsedAt }),
  }));

  async function issue(): Promise<void> {
    if (busy) return;
    setFailure(undefined);
    setPending('issue');

    const name = form.name.trim();
    const expiresAt = toIsoInstant(form.expiresAt);

    if (form.expiresAt.trim() !== '' && expiresAt === undefined) {
      setPending(null);
      setFailure('That expiry date could not be read. Pick a date and time, then try again.');
      return;
    }

    const result = await send<IssuedCredential>(`/api/agents/${agentId}/credentials`, {
      method: 'POST',
      body: { ...(name === '' ? {} : { name }), ...(expiresAt === undefined ? {} : { expiresAt }) },
    });
    setPending(null);

    if (!result.ok) {
      setFailure(result.message ?? 'The credential could not be issued.');
      return;
    }

    if (result.data?.token === undefined) {
      // A 201 without a token would mean the response contract changed. Saying so
      // is safer than rendering an empty box an operator might reuse.
      setFailure('The gateway accepted the request but returned no token. Do not assume a credential exists — re-read the list.');
      router.refresh();
      return;
    }

    setIssued(result.data);
    setForm(EMPTY_FORM);
    router.refresh();
  }

  async function act(kind: 'revoke' | 'rotate', credential: AgentCredential): Promise<void> {
    if (busy) return;
    setFailure(undefined);
    setPending(`${kind}:${credential.id}`);

    const result =
      kind === 'revoke'
        ? await send<AgentCredential>(`/api/agents/${agentId}/credentials/${credential.id}/revoke`, { method: 'POST' })
        : await send<IssuedCredential>(`/api/agents/${agentId}/credentials/${credential.id}/rotate`, {
            method: 'POST',
            body: {},
          });

    setPending(null);
    setConfirm(undefined);

    if (!result.ok) {
      setFailure(result.message ?? `The credential could not be ${kind === 'revoke' ? 'revoked' : 'rotated'}.`);
      return;
    }

    if (kind === 'rotate') {
      const rotated = result.data as IssuedCredential | undefined;
      if (rotated?.token === undefined) {
        setFailure('The rotation was accepted but no token was returned. Re-read the list and issue a new credential if needed.');
      } else {
        setIssued(rotated);
      }
    }

    router.refresh();
  }

  return (
    <VStack gap={4}>
      {issued === undefined ? null : (
        <Card padding={4}>
          <VStack gap={3}>
            <Banner
              status="warning"
              title="Copy this token now — it will not be shown again"
              // The whole point of the banner is the token beneath it, so the
              // detail must not start behind a toggle.
              collapsible={{ defaultIsOpen: true }}
            >
              <VStack gap={2}>
                <Text type="supporting" as="p">
                  This token is the only thing an agent can authenticate with. The gateway stores a hash, so it cannot
                  display it a second time, and closing or reloading this page discards it permanently. Do not paste it
                  into a ticket, a chat, or a commit.
                </Text>
                <CodeBlock
                  code={issued.token}
                  language="text"
                  title={issued.name ?? 'Agent credential'}
                  hasCopyButton
                  isWrapped
                  width="100%"
                />
                <HStack gap={2} wrap="wrap">
                  <Text type="supporting">
                    Prefix {issued.tokenPrefix ?? '—'} · expires {formatDate(issued.expiresAt)}
                  </Text>
                  <Button label="Done, hide token" variant="secondary" size="sm" onClick={() => setIssued(undefined)} />
                </HStack>
              </VStack>
            </Banner>
          </VStack>
        </Card>
      )}

      {failure === undefined ? null : (
        <div role="alert" aria-live="assertive">
          <Banner status="error" title={failure} />
        </div>
      )}

      <Card padding={4}>
        <VStack gap={3}>
          <Text type="supporting" as="p">
            Issuing adds a credential; it does not replace an existing one. Rotate to replace, revoke to withdraw. A
            revoked credential cannot be rotated — issue a new one instead.
          </Text>

          <HStack gap={3} wrap="wrap" align="end">
            <div className="min-w-[220px] flex-1">
              <TextInput
                label="Label (optional)"
                value={form.name}
                description="For your own reference, e.g. the client name. At most 120 characters."
                onChange={(value) => setForm((current) => ({ ...current, name: value }))}
              />
            </div>
            <div className="min-w-[220px] flex-1">
              <TextInput
                label="Expires at (optional)"
                type="text"
                value={form.expiresAt}
                description="Absolute instant, e.g. 2027-01-01T00:00:00.000Z. Leave blank for no expiry."
                onChange={(value) => setForm((current) => ({ ...current, expiresAt: value }))}
              />
            </div>
            <Button
              label={pending === 'issue' ? 'Issuing…' : 'Issue credential'}
              variant="primary"
              isLoading={pending === 'issue'}
              isDisabled={busy}
              onClick={() => void issue()}
            />
          </HStack>
        </VStack>
      </Card>

      {credentials.length === 0 ? (
        <Card padding={4}>
          <Text type="supporting" as="p">
            {agentName} has no credentials. Issue one to let a client authenticate as this agent; without a credential
            every request it makes is unauthenticated.
          </Text>
        </Card>
      ) : (
        <VStack gap={2}>
          <Card padding={0}>
            <Table<CredentialRow> data={rows} columns={columns()} idKey="id" density="compact" dividers="rows" textOverflow="truncate" />
          </Card>

          <VStack gap={2}>
            {credentials.map((credential) => (
              <HStack key={credential.id} gap={2} wrap="wrap" align="center">
                <Text type="body">{credential.name ?? 'Unnamed credential'}</Text>
                <CredentialStatusBadge status={credential.status} />
                {credential.status === 'revoked' ? (
                  <Text type="supporting">Revoked — cannot be rotated; issue a new credential instead.</Text>
                ) : (
                  <Button
                    label={pending === `rotate:${credential.id}` ? 'Rotating…' : 'Rotate'}
                    variant="secondary"
                    size="sm"
                    isDisabled={busy}
                    isLoading={pending === `rotate:${credential.id}`}
                    onClick={() => setConfirm({ kind: 'rotate', credential })}
                  />
                )}
                {credential.status === 'revoked' ? null : (
                  <Button
                    label={pending === `revoke:${credential.id}` ? 'Revoking…' : 'Revoke'}
                    variant="destructive"
                    size="sm"
                    isDisabled={busy}
                    isLoading={pending === `revoke:${credential.id}`}
                    onClick={() => setConfirm({ kind: 'revoke', credential })}
                  />
                )}
              </HStack>
            ))}
          </VStack>
        </VStack>
      )}

      {confirm === undefined ? null : (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirm(undefined);
          }}
          title={
            confirm.kind === 'revoke'
              ? `Revoke ${confirm.credential.name ?? 'this credential'}?`
              : `Rotate ${confirm.credential.name ?? 'this credential'}?`
          }
          description={
            confirm.kind === 'revoke'
              ? 'The credential stops working immediately and every session opened with it is invalidated. This cannot be undone; the agent will need a new credential to authenticate.'
              : 'The new token replaces this one with no grace period: the previous credential is revoked in the same transaction and every session opened with it is invalidated. The client must be given the new token immediately.'
          }
          actionLabel={confirm.kind === 'revoke' ? 'Revoke credential' : 'Rotate credential'}
          cancelLabel={confirm.kind === 'revoke' ? 'Keep credential' : 'Cancel'}
          actionVariant={confirm.kind === 'revoke' ? 'destructive' : 'primary'}
          isActionLoading={pending === `${confirm.kind}:${confirm.credential.id}`}
          onAction={() => void act(confirm.kind, confirm.credential)}
        />
      )}
    </VStack>
  );
}
