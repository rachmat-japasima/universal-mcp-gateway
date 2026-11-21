import { Card } from '@astryxdesign/core/Card';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { PageHeader, SectionBlock } from '@/components/layout/page-container';
import { DetailRow } from '@/components/ui/metric-card';
import { getAgent } from '@/lib/api/agents';
import type { ActivityEvent, Agent } from '@/lib/api/types';
import { formatDuration, formatTimestamp } from '@/lib/utils/status';

import { ActivityOutcomeBadge, ActivityTypeLabel } from './event-status';

/**
 * One activity event.
 *
 * Everything shown is a stored field. Two secondary reads are optional and
 * independent: the agent's name (`GET /agents/:id`) and, only when the event
 * names a tool, whether that tool is currently visible — the latter would be a
 * second API question this payload cannot answer, so it is not attempted. A
 * failed name read falls back to the id.
 *
 * No tool arguments and no result payload exist in this record — `activityEventSchema`
 * has no field for them, and `docs/SECURITY.md` §9 forbids storing them. The page
 * says what was recorded, and the absence is a property of the schema rather than
 * a redaction here.
 */

export async function ActivityDetail({ event }: { event: ActivityEvent }): Promise<React.ReactElement> {
  const agent: Agent | undefined =
    event.agentId === undefined ? undefined : await getAgent(event.agentId).catch(() => undefined);

  return (
    <VStack gap={6}>
      <PageHeader
        title="Activity event"
        description={`${formatTimestamp(event.createdAt)} · ${event.type}`}
      />

      <SectionBlock title="Event">
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Id" value={<Text type="code">{event.id}</Text>} />
            <DetailRow label="Type" value={<ActivityTypeLabel type={event.type} />} />
            <DetailRow label="Outcome" value={<ActivityOutcomeBadge outcome={event.outcome} />} />
            <DetailRow label="Recorded" value={formatTimestamp(event.createdAt)} />
            <DetailRow
              label="Recorded duration"
              value={event.durationMs === undefined ? 'Not recorded' : formatDuration(event.durationMs)}
            />
            <DetailRow
              label="Error code"
              value={event.errorCode === undefined ? '—' : <Text type="code">{event.errorCode}</Text>}
            />
            <DetailRow
              label="Request id"
              value={event.requestId === undefined ? '—' : <Text type="code">{event.requestId}</Text>}
            />
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock title="Subject" description="What the event was about, as recorded at the time.">
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow
              label="Agent"
              value={
                event.agentId === undefined ? (
                  '—'
                ) : agent === undefined ? (
                  <Text type="code">{event.agentId}</Text>
                ) : (
                  <Link href={`/dashboard/agents/${agent.id}`} className="underline">
                    {agent.name}
                  </Link>
                )
              }
            />
            <DetailRow
              label="Backend"
              value={
                event.backendId === undefined ? (
                  '—'
                ) : (
                  <Link href={`/dashboard/backends/${event.backendId}`} className="underline">
                    <Text type="code">{event.backendId}</Text>
                  </Link>
                )
              }
            />
            <DetailRow
              label="Tool"
              value={event.toolName === undefined ? '—' : <Text type="code">{event.toolName}</Text>}
            />
          </VStack>
        </Card>
      </SectionBlock>

      <VStack gap={1}>
        <Text type="supporting" as="p">
          This record holds names, ids, an outcome, an error code and a duration. Tool arguments and results are never
          stored in activity, so there is nothing further to reveal or redact here.
        </Text>
        <Text type="supporting">
          <Link href="/dashboard/activity" className="underline">
            Back to activity
          </Link>
        </Text>
      </VStack>
    </VStack>
  );
}
