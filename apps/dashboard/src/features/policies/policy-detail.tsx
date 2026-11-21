import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { PageHeader, SectionBlock } from '@/components/layout/page-container';
import { DetailRow } from '@/components/ui/metric-card';
import { getAgentAccess } from '@/lib/api/agents';
import { isApiError } from '@/lib/api/errors';
import { listAgents } from '@/lib/api/agents';
import { listPolicyAssignments } from '@/lib/api/policies';
import type { Agent, AgentAccess, Policy, PolicyRule } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import { PolicyActions } from './policy-actions';
import { PolicyAssignments } from './policy-assignments';
import { EffectBadge, ResourceLabel, TargetLabel } from './policy-status';

/**
 * One policy: its rules, who holds it, and what it actually produces.
 *
 * Three reads, and the failure of either secondary one degrades only its own
 * section — an assignment read failure must not hide the rules an operator came
 * to correct.
 *
 * **The effective-access preview calls the gateway's evaluator.** It is
 * `GET /agents/:agentId/access` for a chosen *assigned* agent, rendered verbatim.
 * There is deliberately no browser-side rule engine here: two implementations of
 * deny-overrides-allow would eventually disagree, and the browser's answer would
 * be the one on screen. The agent picker is a `GET` form, so the preview is
 * reproducible and needs no client state or proxy allowlist entry.
 */

type Row = {
  resource: PolicyRule['resource'];
  target: string;
  effect: PolicyRule['effect'];
};

function ruleColumns(backendNames: Map<string, string>): TableColumn<Row>[] {
  return [
    {
      key: 'effect',
      header: 'Effect',
      width: proportional(1, { minWidth: 100 }),
      renderCell: (row) => <EffectBadge effect={row.effect} />,
    },
    {
      key: 'resource',
      header: 'Applies to',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (row) => <ResourceLabel resource={row.resource} />,
    },
    {
      key: 'target',
      header: 'Target',
      width: proportional(5, { minWidth: 260 }),
      renderCell: (row) =>
        row.target === '*' ? (
          <TargetLabel target={row.target} />
        ) : (
          <VStack gap={0}>
            <TargetLabel target={row.target} />
            {row.resource === 'backend' ? (
              <Text type="supporting">
                {backendNames.get(row.target) ?? 'Not in the current registry — rules survive a removed backend.'}
              </Text>
            ) : null}
          </VStack>
        ),
    },
  ];
}

function failureMessage(error: unknown): string {
  return isApiError(error) ? error.userMessage : 'This section could not be read.';
}

export async function PolicyDetail({
  policy,
  backends,
  previewAgentId,
}: {
  policy: Policy;
  backends: Array<{ id: string; name: string }>;
  /** From the URL. Only honoured when the agent actually holds this policy. */
  previewAgentId?: string;
}): Promise<React.ReactElement> {
  let assignments: Agent[] | undefined;
  let assignmentsError: string | undefined;

  try {
    assignments = await listPolicyAssignments(policy.id);
  } catch (error) {
    assignmentsError = failureMessage(error);
  }

  // The picker must offer every agent, not only the assigned ones, so an
  // operator can see that an agent is *not* affected by this policy.
  let activeAgents: Array<{ id: string; name: string }> | undefined;
  try {
    const page = await listAgents({ limit: 100, sort: 'name' });
    activeAgents = page.data.map((agent) => ({ id: agent.id, name: agent.name }));
  } catch {
    activeAgents = undefined;
  }

  const canPreview =
    previewAgentId !== undefined && assignments !== undefined && assignments.some((agent) => agent.id === previewAgentId);

  let access: AgentAccess | undefined;
  let accessError: string | undefined;

  if (canPreview) {
    try {
      access = await getAgentAccess(previewAgentId);
    } catch (error) {
      accessError = failureMessage(error);
    }
  }

  const backendNames = new Map(backends.map((backend) => [backend.id, backend.name]));

  const rows: Row[] = policy.rules.map((rule) => ({
    resource: rule.resource,
    target: rule.target,
    effect: rule.effect,
  }));

  const allows = policy.rules.filter((rule) => rule.effect === 'allow').length;
  const denies = policy.rules.length - allows;
  const wildcardAllows = policy.rules.filter((rule) => rule.effect === 'allow' && rule.target === '*').length;

  return (
    <VStack gap={6}>
      <PageHeader
        title={policy.name}
        description={policy.description ?? 'No description.'}
        actions={<PolicyActions policy={policy} />}
      />

      {wildcardAllows > 0 ? (
        <Card padding={4}>
          <Text type="body" as="p">
            <Text type="body">Broad access: </Text>
            This policy contains {wildcardAllows} ALLOW rule{wildcardAllows === 1 ? '' : 's'} with target{' '}
            <Text type="code">*</Text>, which grants everything at that level to every agent it is assigned to.
          </Text>
        </Card>
      ) : null}

      <SectionBlock title="Policy">
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Policy ID" value={<Text type="code">{policy.id}</Text>} />
            <DetailRow label="Priority" value={String(policy.priority)} />
            <DetailRow
              label="Rules"
              value={`${allows} allow · ${denies} deny (${policy.rules.length} total)`}
            />
            <DetailRow label="Created" value={formatTimestamp(policy.createdAt)} />
            <DetailRow label="Updated" value={formatTimestamp(policy.updatedAt)} />
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock
        title="Rules"
        description="Evaluated per agent. A rule that matches nothing is inert; with no matching rule the answer is deny."
      >
        <Card padding={0}>
          {rows.length === 0 ? (
            <div className="p-4">
              <Text type="supporting" as="p">
                This policy has no rules, so it grants nothing to anyone. Add an ALLOW rule on the edit page.
              </Text>
            </div>
          ) : (
            <Table<Row> data={rows} columns={ruleColumns(backendNames)} idKey="target" density="compact" dividers="rows" textOverflow="truncate" />
          )}
        </Card>
      </SectionBlock>

      <SectionBlock
        title="Assignments"
        description="A policy is shared. Assigning it does not copy its rules, and removing the assignment withdraws them."
      >
        {assignments === undefined ? (
          <Card padding={4}>
            <Text type="supporting" as="p">
              Assignments could not be read: {assignmentsError} Nothing was changed — assigning and removing are disabled
              until this list loads, because acting on a list you cannot see is how access is granted to the wrong agent.
            </Text>
          </Card>
        ) : (
          <PolicyAssignments
            policyId={policy.id}
            policyName={policy.name}
            assignments={assignments}
            agents={activeAgents ?? []}
          />
        )}
      </SectionBlock>

      <SectionBlock
        title="Effective access preview"
        description="Read from the gateway's evaluator for one agent. This is the same call the agent page uses — the dashboard never re-implements rule evaluation."
      >
        <Card padding={4}>
          <VStack gap={3}>
            <form action={`/dashboard/policies/${policy.id}`} method="get" className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-[240px] flex-1 flex-col gap-1">
                <span className="text-sm">Agent</span>
                <select
                  name="previewAgentId"
                  defaultValue={previewAgentId ?? ''}
                  className="rounded-md border border-solid px-3 py-2 text-sm"
                >
                  <option value="">Choose an agent</option>
                  {assignments === undefined
                    ? null
                    : assignments.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                </select>
              </label>
              <button type="submit" className="rounded-md border border-solid px-3 py-2 text-sm">
                Preview access
              </button>
            </form>

            {previewAgentId === undefined ? (
              <Text type="supporting" as="p">
                Pick an agent that holds this policy to see what it can actually call. {assignments === undefined ? '' : `${assignments.length} agent${assignments.length === 1 ? '' : 's'} hold${assignments.length === 1 ? 's' : ''} it.`}
              </Text>
            ) : access === undefined ? (
              <Text type="supporting" as="p">
                {canPreview
                  ? `Effective access could not be evaluated: ${accessError}`
                  : 'That agent does not hold this policy, so its access is unaffected by it. Pick one from the list.'}
              </Text>
            ) : (
              <VStack gap={3}>
                <VStack gap={1}>
                  <Text type="label" color="secondary">
                    Policies applied
                  </Text>
                  {access.policies.length === 0 ? (
                    <Text type="supporting" as="p">
                      None. Every tool is denied.
                    </Text>
                  ) : (
                    access.policies.map((applied) => (
                      <DetailRow
                        key={applied.id}
                        label={applied.name}
                        value={<Text type="supporting">priority {applied.priority}</Text>}
                      />
                    ))
                  )}
                </VStack>

                <VStack gap={1}>
                  <Text type="label" color="secondary">
                    Tools
                  </Text>
                  {access.visibleTools.length === 0 ? (
                    <Text type="supporting" as="p">
                      The catalog is empty, so there is nothing to evaluate.
                    </Text>
                  ) : (
                    access.visibleTools.map((tool) => (
                      <HStack key={tool.publicName} gap={2} wrap="wrap" align="center">
                        <Text type="code">{tool.publicName}</Text>
                        <Text type="body">{tool.allowed ? 'Allowed' : 'Denied'}</Text>
                        <Text type="supporting">{tool.reason}</Text>
                      </HStack>
                    ))
                  )}
                </VStack>

                <Text type="supporting" as="p">
                  <Link href={`/dashboard/agents/${access.agentId}`} className="underline">
                    Open this agent
                  </Link>{' '}
                  for its credentials and the same verdict in context.
                </Text>
              </VStack>
            )}
          </VStack>
        </Card>
      </SectionBlock>
    </VStack>
  );
}
