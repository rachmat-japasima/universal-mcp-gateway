import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { PageHeader, SectionBlock } from '@/components/layout/page-container';
import { DetailRow } from '@/components/ui/metric-card';
import { getAgentAccess, listCredentials } from '@/lib/api/agents';
import { isApiError } from '@/lib/api/errors';
import type { Agent, AgentAccess, AgentCredential } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import { AgentActions } from './agent-actions';
import { ClientTypeLabel, EnabledBadge } from './agent-status';
import { CredentialPanel } from './credential-panel';

/**
 * One agent: identity, credentials, effective access.
 *
 * Three reads, and they are deliberately independent:
 *
 *  * the profile comes from the page, which already handled 404;
 *  * `GET /agents/:id/credentials` is metadata only — the token is never
 *    retrievable again, and this page cannot show one that already exists;
 *  * `GET /agents/:id/access` is the gateway's own evaluator
 *    (`AuthorizationService.describeAccess`). The dashboard renders its verdict
 *    and never re-implements rule evaluation in a browser: a second evaluator
 *    would be a second answer, and the wrong one would be believed.
 *
 * Credentials matter more than access here, so an access failure degrades to a
 * notice inside its own section rather than taking the revoke buttons with it.
 */

function failureMessage(error: unknown): string {
  return isApiError(error) ? error.userMessage : 'This section could not be read.';
}

export async function AgentDetail({ agent }: { agent: Agent }): Promise<React.ReactElement> {
  let credentials: AgentCredential[] | undefined;
  let credentialsError: string | undefined;

  try {
    credentials = await listCredentials(agent.id);
  } catch (error) {
    credentialsError = failureMessage(error);
  }

  let access: AgentAccess | undefined;
  let accessError: string | undefined;

  try {
    access = await getAgentAccess(agent.id);
  } catch (error) {
    accessError = failureMessage(error);
  }

  return (
    <VStack gap={6}>
      <PageHeader
        title={agent.name}
        description={agent.description ?? 'No description.'}
        actions={
          <HStack gap={2} wrap="wrap">
            <AgentActions agent={agent} layout="page" />
          </HStack>
        }
      />

      <SectionBlock title="Identity">
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Agent ID" value={<Text type="code">{agent.id}</Text>} />
            <DetailRow label="Status" value={<EnabledBadge enabled={agent.enabled} />} />
            <DetailRow label="Client type" value={<ClientTypeLabel clientType={agent.clientType} />} />
            <DetailRow label="Created" value={formatTimestamp(agent.createdAt)} />
            <DetailRow label="Updated" value={formatTimestamp(agent.updatedAt)} />
            <DetailRow
              label="Last authenticated"
              value={
                agent.lastAuthenticatedAt === undefined ? 'Never' : formatTimestamp(agent.lastAuthenticatedAt)
              }
            />
            {agent.metadata === undefined ? null : (
              <VStack gap={1}>
                <Text type="supporting" color="secondary">
                  Metadata
                </Text>
                {Object.entries(agent.metadata).map(([key, value]) => (
                  <DetailRow key={key} label={key} value={String(value)} />
                ))}
              </VStack>
            )}
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock
        title="Credentials"
        description="Each credential authenticates as this agent. Only its prefix is ever stored or shown again; the token itself exists once, at issue time."
      >
        {credentials === undefined ? (
          <Card padding={4}>
            <Text type="supporting" as="p">
              Credentials could not be read: {credentialsError} Nothing was changed — issue, rotate and revoke are
              disabled until this list loads, because acting on a list you cannot see is how a credential gets missed.
            </Text>
          </Card>
        ) : (
          <CredentialPanel agentId={agent.id} agentName={agent.name} credentials={credentials} />
        )}
      </SectionBlock>

      <SectionBlock
        title="Effective access"
        description="The gateway's own evaluation, per available tool, using the policies currently assigned to this agent. Deny overrides allow, and a disabled backend cannot be granted access by any policy."
      >
        <Card padding={4}>
          {access === undefined ? (
            <Text type="supporting" as="p">
              Effective access could not be evaluated: {accessError}
            </Text>
          ) : (
            <VStack gap={3}>
              <VStack gap={1}>
                <Text type="label" color="secondary">
                  Assigned policies
                </Text>
                {access.policies.length === 0 ? (
                  <Text type="supporting" as="p">
                    No policies assigned. With none, every tool is denied — this is the default-deny baseline, not a
                    missing screen.{' '}
                    <Link href="/dashboard/policies" className="underline">
                      Manage access policies
                    </Link>
                  </Text>
                ) : (
                  access.policies.map((policy) => (
                    <DetailRow
                      key={policy.id}
                      label={policy.name}
                      value={<Text type="supporting">priority {policy.priority}</Text>}
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
                    No tools are in the catalog, so there is nothing to grant. Connect a backend and run discovery
                    first.
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
            </VStack>
          )}
        </Card>
      </SectionBlock>
    </VStack>
  );
}
