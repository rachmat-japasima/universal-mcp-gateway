import { Card } from '@astryxdesign/core/Card';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { ErrorState } from '@/components/feedback/states';
import { DetailRow } from '@/components/ui/metric-card';
import { StatusBadge } from '@/components/ui/status-badge';
import type { Diagnostics } from '@/lib/api/types';
import { authenticationStatus, formatDuration, formatTimestamp } from '@/lib/utils/status';

import type { Read } from './read';

/**
 * Diagnostics: the safe facts for a bug report.
 *
 * The payload is rendered field by field, and nothing else is added. That is the
 * whole safety argument: `GET /diagnostics` returns a fixed, non-secret shape —
 * service and runtime identity, whether storage and the migration ledger answer,
 * environment and log level, counts, and two limits. It contains no environment
 * values, no secret or hash, no headers, no file paths, and no stack trace, so
 * there is nothing here to redact at render time.
 *
 * The page never falls back to reading configuration from its own process: the
 * dashboard's environment is not the gateway's, and guessing would produce a
 * plausible-looking lie. When the read fails, it says so.
 *
 * **Copying is deliberately not offered as a "download the whole thing" action.**
 * A copy button would encourage pasting this into a ticket along with whatever
 * else was on the clipboard, and the panel is four short lists that are easy to
 * read off the screen.
 */
export function DiagnosticsPanel({ diagnostics }: { diagnostics: Read<Diagnostics> }): React.ReactElement {
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Text type="label">Diagnostics</Text>
          <Text type="supporting">
            Safe facts for a bug report: identity, storage and migration state, environment, log level, and the two
            request limits. The gateway sends no secret, hash, header, path, or stack trace in this payload.
          </Text>
        </VStack>

        {diagnostics.ok ? (
          <DiagnosticsBody diagnostics={diagnostics.value} />
        ) : (
          <ErrorState error={diagnostics.error} title="Diagnostics could not be read" />
        )}
      </VStack>
    </Card>
  );
}

function DiagnosticsBody({ diagnostics }: { diagnostics: Diagnostics }): React.ReactElement {
  const storageUnavailable = diagnostics.database.status !== 'ok';

  return (
    <VStack gap={3}>
      <VStack gap={1}>
        <Text type="label">Service</Text>
        <DetailRow label="Name" value={diagnostics.service.name} />
        <DetailRow label="Version" value={diagnostics.service.version} />
        <DetailRow label="Reported" value={formatTimestamp(diagnostics.timestamp)} />
      </VStack>

      <VStack gap={1}>
        <Text type="label">Runtime</Text>
        {/* Node's version and platform are build facts, not configuration values. */}
        <DetailRow label="Node" value={<Text type="code">{diagnostics.runtime.node}</Text>} />
        <DetailRow label="Platform" value={<Text type="code">{diagnostics.runtime.platform}</Text>} />
        <DetailRow label="Uptime" value={formatDuration(diagnostics.runtime.uptimeMs)} />
      </VStack>

      <VStack gap={1}>
        <Text type="label">Storage</Text>
        <DetailRow
          label="Status"
          value={
            <StatusBadge
              status={
                storageUnavailable
                  ? { label: 'Unavailable', tone: 'error' }
                  : { label: 'Answering', tone: 'success' }
              }
            />
          }
        />
        <DetailRow
          label="Migration version"
          value={
            diagnostics.database.migrationVersion === null ? (
              'Not readable'
            ) : (
              <Text type="code">{diagnostics.database.migrationVersion}</Text>
            )
          }
        />
      </VStack>

      <VStack gap={1}>
        <Text type="label">Configuration</Text>
        <DetailRow label="Environment" value={diagnostics.configuration.environment} />
        <DetailRow label="Log level" value={diagnostics.configuration.logLevel} />
        <DetailRow label="Agent authentication" value={<StatusBadge status={authenticationStatus(diagnostics.authentication)} />} />
      </VStack>

      <VStack gap={1}>
        <Text type="label">Counts</Text>
        <DetailRow
          label="Backends registered"
          value={diagnostics.backends.registered === null ? 'Unavailable' : String(diagnostics.backends.registered)}
        />
        <DetailRow
          label="Sessions"
          value={diagnostics.sessions === null ? 'Session tracking is not enabled' : String(diagnostics.sessions.total)}
        />
        <DetailRow
          label="Tools available"
          value={diagnostics.tools.available === null ? 'Unavailable' : String(diagnostics.tools.available)}
        />
      </VStack>

      <VStack gap={1}>
        <Text type="label">Limits</Text>
        <DetailRow label="Request body limit (bytes)" value={String(diagnostics.limits.requestBodyLimitBytes)} />
        <DetailRow label="Request timeout (ms)" value={String(diagnostics.limits.requestTimeoutMs)} />
      </VStack>
    </VStack>
  );
}
