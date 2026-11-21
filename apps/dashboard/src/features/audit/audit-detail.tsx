import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import Link from 'next/link';

import { PageHeader, SectionBlock } from '@/components/layout/page-container';
import { DetailRow } from '@/components/ui/metric-card';
import type { AuditEvent } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import { AuditActionLabel, AuditActorBadge, AuditResultBadge } from './audit-status';

/**
 * One audit event, including its metadata.
 *
 * This is the only screen where `metadata` is rendered, because the list
 * endpoint omits it on purpose (`toAuditListItem`): reading one record is an
 * explicit operator act, and the disclosure boundary lives in the API rather
 * than in a conditional here.
 *
 * Metadata is a flat map of bounded, non-secret values (`auditMetadataSchema`:
 * at most 20 entries, string|number|boolean, no nesting). It is printed as
 * key/value pairs, never as a JSON blob, so nothing can be hidden inside a
 * nested object.
 *
 * There is no edit control and no delete control. `AuditRepository` has no
 * update or delete method, so a button for either would be a lie; the page says
 * what immutability actually means.
 */

export function AuditDetail({ event }: { event: AuditEvent }): React.ReactElement {
  const metadata = event.metadata === undefined ? undefined : Object.entries(event.metadata);

  return (
    <VStack gap={6}>
      <PageHeader title="Audit event" description={`${formatTimestamp(event.createdAt)} · ${event.action}`} />

      <SectionBlock title="Event">
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Id" value={<Text type="code">{event.id}</Text>} />
            <DetailRow label="Action" value={<AuditActionLabel action={event.action} />} />
            <DetailRow label="Result" value={<AuditResultBadge result={event.result} />} />
            <DetailRow label="Recorded" value={formatTimestamp(event.createdAt)} />
            <DetailRow
              label="Request id"
              value={event.requestId === undefined ? '—' : <Text type="code">{event.requestId}</Text>}
            />
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock title="Actor" description="Who performed the action, as the gateway recorded it.">
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Type" value={<AuditActorBadge actorType={event.actorType} />} />
            <DetailRow
              label="Actor id"
              value={event.actorId === undefined ? 'Not recorded' : <Text type="code">{event.actorId}</Text>}
            />
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock title="Target" description="What the action was applied to.">
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Type" value={event.targetType ?? '—'} />
            <DetailRow
              label="Target id"
              value={event.targetId === undefined ? '—' : <Text type="code">{event.targetId}</Text>}
            />
            {event.targetType === 'agent' && event.targetId !== undefined ? (
              <Text type="supporting">
                <Link href={`/dashboard/agents/${event.targetId}`} className="underline">
                  Open the agent
                </Link>
              </Text>
            ) : null}
            {event.targetType === 'backend' && event.targetId !== undefined ? (
              <Text type="supporting">
                <Link href={`/dashboard/backends/${event.targetId}`} className="underline">
                  Open the backend
                </Link>
              </Text>
            ) : null}
            {event.targetType === 'policy' && event.targetId !== undefined ? (
              <Text type="supporting">
                <Link href={`/dashboard/policies/${event.targetId}`} className="underline">
                  Open the policy
                </Link>
              </Text>
            ) : null}
            {event.targetType === 'session' && event.targetId !== undefined ? (
              <Text type="supporting">
                <Link href={`/dashboard/sessions/${event.targetId}`} className="underline">
                  Open the session
                </Link>
              </Text>
            ) : null}
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock
        title="Metadata"
        description="Flat, bounded context recorded by the gateway. No credential, token, or secret is ever stored here."
      >
        <Card padding={4}>
          {metadata === undefined || metadata.length === 0 ? (
            <Text type="supporting">This event recorded no metadata.</Text>
          ) : (
            <VStack gap={2}>
              {metadata.map(([key, value]) => (
                <DetailRow key={key} label={key} value={<Text type="code">{String(value)}</Text>} />
              ))}
            </VStack>
          )}
        </Card>
      </SectionBlock>

      <VStack gap={1}>
        <Text type="supporting" as="p">
          Audit records are append-only. The gateway exposes no update or delete route and the repository has no method
          for either, so nothing on this page can alter this record.
        </Text>
        <HStack gap={3}>
          <Text type="supporting">
            <Link href="/dashboard/audit" className="underline">
              Back to audit trail
            </Link>
          </Text>
        </HStack>
      </VStack>
    </VStack>
  );
}
