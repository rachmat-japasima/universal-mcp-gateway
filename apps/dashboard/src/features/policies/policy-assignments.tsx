'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { Agent } from '@/lib/api/types';
import { send } from '@/lib/api/write-client';

/**
 * Which agents hold this policy.
 *
 * Reads `GET /policies/:policyId/assignments` — the reverse of the per-agent
 * access view, added in Phase 10.4 because the detail screen otherwise could
 * state what a policy grants but not who receives it. The gateway excludes
 * tombstoned agents, so an assignment row here is one an agent can actually use.
 *
 * Assignment is idempotent at the API (`POST` twice is not an error), and
 * unassignment answers `404` when the pair does not exist — the panel reports
 * both rather than pretending the click worked.
 */

type Pending = `unassign:${string}` | 'assign' | null;

type Row = { id: string; name: string; enabled: boolean; clientType: string };

function columns(): TableColumn<Row>[] {
  return [
    {
      key: 'name',
      header: 'Agent',
      width: proportional(4, { minWidth: 220 }),
      renderCell: (row) => (
        <Link href={`/dashboard/agents/${row.id}`} className="underline">
          {row.name}
        </Link>
      ),
    },
    {
      key: 'enabled',
      header: 'Status',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (row) => <Text type="body">{row.enabled ? 'Active' : 'Disabled'}</Text>,
    },
    {
      key: 'clientType',
      header: 'Client',
      width: proportional(2, { minWidth: 140 }),
      renderCell: (row) =>
        row.clientType === '' ? <Text type="supporting">Not set</Text> : <Text type="body">{row.clientType}</Text>,
    },
  ];
}

export function PolicyAssignments({
  policyId,
  policyName,
  assignments,
  agents,
}: {
  policyId: string;
  policyName: string;
  /** Agents currently holding the policy, from the gateway. */
  assignments: Agent[];
  /** Every active agent, for the picker. A filtered list here would hide who *could* be assigned. */
  agents: Array<{ id: string; name: string }>;
}): React.ReactElement {
  const router = useRouter();
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [confirmUnassign, setConfirmUnassign] = useState<Agent | undefined>(undefined);

  const busy = pending !== null;
  const assignedIds = new Set(assignments.map((agent) => agent.id));
  const available = agents.filter((agent) => !assignedIds.has(agent.id));

  const rows: Row[] = assignments.map((agent) => ({
    id: agent.id,
    name: agent.name,
    enabled: agent.enabled,
    clientType: agent.clientType ?? '',
  }));

  async function assign(): Promise<void> {
    if (busy || selected === '') return;
    setFailure(undefined);
    setPending('assign');

    const result = await send(`/api/policies/${policyId}/assignments`, {
      method: 'POST',
      body: { agentId: selected },
    });
    setPending(null);

    if (!result.ok) {
      setFailure(result.message ?? 'The policy could not be assigned.');
      return;
    }

    setSelected('');
    router.refresh();
  }

  async function unassign(agent: Agent): Promise<void> {
    if (busy) return;
    setFailure(undefined);
    setPending(`unassign:${agent.id}`);

    const result = await send(`/api/policies/${policyId}/assignments/${agent.id}`, { method: 'DELETE' });
    setPending(null);
    setConfirmUnassign(undefined);

    if (!result.ok) {
      setFailure(result.message ?? 'The policy could not be unassigned.');
      return;
    }

    router.refresh();
  }

  return (
    <VStack gap={3}>
      {failure === undefined ? null : (
        <div role="alert" aria-live="assertive">
          <Banner status="error" title={failure} />
        </div>
      )}

      <Card padding={3}>
        <VStack gap={2}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void assign();
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <label className="flex min-w-[240px] flex-1 flex-col gap-1">
              <span className="text-sm">Assign to agent</span>
              <select
                value={selected}
                disabled={busy || available.length === 0}
                onChange={(event) => setSelected(event.target.value)}
                className="rounded-md border border-solid px-3 py-2 text-sm"
              >
                <option value="">
                  {available.length === 0 ? 'Every agent already holds this policy' : 'Choose an agent'}
                </option>
                {available.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>

            <Button
              label={pending === 'assign' ? 'Assigning…' : 'Assign policy'}
              type="submit"
              variant="secondary"
              isLoading={pending === 'assign'}
              isDisabled={busy || selected === ''}
            />
          </form>

          <Text type="supporting" as="p">
            Assignment grants nothing by itself: access is the policy&apos;s rules, evaluated for that agent. Removing an
            assignment withdraws every rule in this policy from that agent immediately.
          </Text>
        </VStack>
      </Card>

      {rows.length === 0 ? (
        <Card padding={4}>
          <Text type="supporting" as="p">
            No agents hold this policy, so its rules currently apply to nobody.
          </Text>
        </Card>
      ) : (
        <VStack gap={2}>
          <Card padding={0}>
            <Table<Row> data={rows} columns={columns()} idKey="id" density="compact" dividers="rows" textOverflow="truncate" />
          </Card>

          <VStack gap={2}>
            {assignments.map((agent) => (
              <HStack key={agent.id} gap={2} wrap="wrap" align="center">
                <Text type="body">{agent.name}</Text>
                <Button
                  label={pending === `unassign:${agent.id}` ? 'Removing…' : 'Remove'}
                  variant="destructive"
                  size="sm"
                  isDisabled={busy}
                  isLoading={pending === `unassign:${agent.id}`}
                  onClick={() => setConfirmUnassign(agent)}
                />
              </HStack>
            ))}
          </VStack>
        </VStack>
      )}

      {confirmUnassign === undefined ? null : (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirmUnassign(undefined);
          }}
          title={`Remove ${confirmUnassign.name} from ${policyName}?`}
          description="That agent immediately loses every rule in this policy. Anything it currently reaches only through these rules becomes denied, and its live sessions keep running with the narrower access."
          actionLabel="Remove assignment"
          cancelLabel="Keep assignment"
          actionVariant="destructive"
          isActionLoading={pending === `unassign:${confirmUnassign.id}`}
          onAction={() => void unassign(confirmUnassign)}
        />
      )}
    </VStack>
  );
}
