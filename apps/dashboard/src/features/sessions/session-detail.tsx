import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { PageHeader, SectionBlock } from '@/components/layout/page-container';
import { DetailRow } from '@/components/ui/metric-card';
import { getAgent, listCredentials } from '@/lib/api/agents';
import type { Agent, AgentCredential, Session } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import { SessionStatusBadge, TerminationReason } from './session-status';
import { SessionTerminateAction } from './session-terminate-action';

/**
 * One MCP session: identity, binding, timing, and the termination control.
 *
 * The session comes from the page, which already handled the `404`. Two
 * secondary reads are deliberately independent and both optional:
 *
 *  * the agent name, from `GET /agents/:id` — a failure leaves the id, which is
 *    still the authoritative reference;
 *  * the credential *metadata*, from `GET /agents/:agentId/credentials`. That
 *    endpoint returns no token (the token exists once, at issue time), so this
 *    page can name the credential that opened the session but can never reveal
 *    what it authenticated with.
 *
 * What is never rendered, because it does not exist in the payload: a bearer
 * token, a credential hash, a cookie, or transport state. `mcpSessionId` is shown
 * with an explicit note that it is a routing handle, not a secret — an operator
 * needs it to correlate a client report, and treating it as sensitive would
 * discourage the one diagnostic use it has.
 */

export async function SessionDetail({ session }: { session: Session }): Promise<React.ReactElement> {
  const agent = await getAgent(session.agentId).catch((): Agent | undefined => undefined);

  const credentials =
    session.credentialId === undefined
      ? undefined
      : await listCredentials(session.agentId).catch((): AgentCredential[] | undefined => undefined);

  const credential =
    session.credentialId === undefined || credentials === undefined
      ? undefined
      : credentials.find((entry) => entry.id === session.credentialId);

  return (
    <VStack gap={6}>
      <PageHeader
        title="Session"
        description={agent === undefined ? `Agent ${session.agentId}` : `Opened by ${agent.name}`}
        actions={<SessionTerminateAction session={session} layout="page" />}
      />

      <SectionBlock title="Identity">
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Session id" value={<Text type="code">{session.id}</Text>} />
            <DetailRow label="Status" value={<SessionStatusBadge status={session.status} />} />
            <DetailRow
              label="Protocol session id"
              value={
                session.mcpSessionId === undefined ? (
                  'Not recorded'
                ) : (
                  <Text type="code">{session.mcpSessionId}</Text>
                )
              }
            />
            {session.mcpSessionId === undefined ? null : (
              <Text type="supporting" as="p">
                The protocol session id is the value the client echoes in <Text type="code">mcp-session-id</Text>. It is a
                routing handle: on its own it authenticates nothing, because every request also carries a credential and
                must belong to this session&apos;s owner.
              </Text>
            )}
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock
        title="Binding"
        description="A session is bound to one agent and one credential at initialization, and that binding cannot be reassigned."
      >
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow
              label="Agent"
              value={
                agent === undefined ? (
                  <Text type="code">{session.agentId}</Text>
                ) : (
                  <Link href={`/dashboard/agents/${agent.id}`} className="underline">
                    {agent.name}
                  </Link>
                )
              }
            />
            <DetailRow
              label="Agent id"
              value={
                <Text type="code">
                  <Link href={`/dashboard/agents/${session.agentId}`} className="underline">
                    {session.agentId}
                  </Link>
                </Text>
              }
            />
            <DetailRow
              label="Credential"
              value={
                session.credentialId === undefined ? (
                  'Not recorded'
                ) : (
                  <Text type="code">{session.credentialId}</Text>
                )
              }
            />
            {credential === undefined ? null : (
              <VStack gap={1}>
                <Text type="supporting" color="secondary">
                  Credential metadata
                </Text>
                <DetailRow label="Label" value={credential.name ?? 'Unnamed'} />
                <DetailRow label="Token prefix" value={<Text type="code">{credential.tokenPrefix ?? '—'}</Text>} />
                <DetailRow label="Credential status" value={credential.status} />
                <DetailRow label="Issued" value={formatTimestamp(credential.createdAt)} />
                <DetailRow
                  label="Expires"
                  value={credential.expiresAt === undefined ? 'No expiry' : formatTimestamp(credential.expiresAt)}
                />
              </VStack>
            )}
            {session.credentialId !== undefined && credentials !== undefined && credential === undefined ? (
              <Text type="supporting" as="p">
                The credential that opened this session is no longer in the agent&apos;s list — it was revoked or rotated
                since. The id above is the historical reference.
              </Text>
            ) : null}
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock
        title="Timing"
        description="Both lifetimes are evaluated on every request, so a missed sweep cannot extend access."
      >
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Started" value={formatTimestamp(session.createdAt)} />
            <DetailRow label="Last activity" value={formatTimestamp(session.lastActivityAt)} />
            <DetailRow
              label="Hard cap"
              value={session.expiresAt === undefined ? 'No cap recorded' : formatTimestamp(session.expiresAt)}
            />
            {session.terminatedAt === undefined ? null : (
              <>
                <DetailRow label="Ended" value={formatTimestamp(session.terminatedAt)} />
                {session.terminationReason === undefined ? null : (
                  <DetailRow label="Reason" value={<TerminationReason reason={session.terminationReason} />} />
                )}
              </>
            )}
          </VStack>
        </Card>
      </SectionBlock>

      {session.metadata === undefined ? null : (
        <SectionBlock
          title="Client"
          description="Recorded at initialization, as the client reported it. Display metadata only; it is not an authorization input."
        >
          <Card padding={4}>
            <VStack gap={2}>
              <DetailRow label="Client type" value={session.metadata.clientType ?? 'Not recorded'} />
              <DetailRow label="Client version" value={session.metadata.clientVersion ?? 'Not recorded'} />
              <DetailRow label="Protocol version" value={session.metadata.protocolVersion ?? 'Not recorded'} />
              <DetailRow label="Remote address" value={session.metadata.remoteAddress ?? 'Not recorded'} />
            </VStack>
          </Card>
        </SectionBlock>
      )}

      <HStack gap={3} wrap="wrap" align="center">
        <Text type="supporting">
          <Link href="/dashboard/sessions" className="underline">
            Back to sessions
          </Link>
        </Text>
        <Text type="supporting">
          <Link href={`/dashboard/activity?agentId=${session.agentId}`} className="underline">
            Activity for this agent
          </Link>
        </Text>
      </HStack>
    </VStack>
  );
}
