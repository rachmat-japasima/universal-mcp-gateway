import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { ErrorState } from '@/components/feedback/states';
import { DetailRow } from '@/components/ui/metric-card';
import { StatusBadge } from '@/components/ui/status-badge';
import type { MonitoringMetrics } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import type { Read } from './read';

/**
 * The telemetry card: aggregate counts from the gateway's own registry.
 *
 * This is the one card on the page that can answer "how many" without a
 * table scan, because the registry already counted. Two rules keep it honest:
 *
 *   * every number is read out of the snapshot by exact metric name and label
 *     set — nothing is summed, averaged, divided or charted here, and no
 *     percentile exists because none is stored;
 *   * a family with no samples reads 0, which is true for a counter that has
 *     never been incremented — a different claim from "unknown", which is
 *     what a failed read renders instead.
 *
 * The registry is in memory and resets on restart, so the card says so: these
 * are counts since process start, not history.
 */
export function TelemetryCard({ telemetry }: { telemetry: Read<MonitoringMetrics> }): React.ReactElement {
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack gap={2} align="center" justify="between" wrap="wrap">
          <Text type="label">Telemetry</Text>
          {telemetry.ok ? (
            <Text type="supporting">Since process start · {formatTimestamp(telemetry.value.generatedAt)}</Text>
          ) : null}
        </HStack>

        {!telemetry.ok ? (
          <>
            <StatusBadge status={{ label: 'Telemetry not read', tone: 'error' }} />
            <ErrorState error={telemetry.error} title="Telemetry could not be read" />
          </>
        ) : (
          <>
            <VStack gap={1}>
              <DetailRow
                label="Tool calls (success)"
                value={String(counterValue(telemetry.value, 'umg_tool_calls_total', { outcome: 'success' }))}
              />
              <DetailRow
                label="Tool calls (failure)"
                value={String(counterValue(telemetry.value, 'umg_tool_calls_total', { outcome: 'failure' }))}
              />
              <DetailRow
                label="Tool calls (denied)"
                value={String(counterValue(telemetry.value, 'umg_tool_calls_total', { outcome: 'denied' }))}
              />
              <DetailRow
                label="Agent authentication failures"
                value={String(counterValue(telemetry.value, 'umg_auth_total', { surface: 'agent', outcome: 'failure' }))}
              />
              <DetailRow
                label="Backend connections (failure)"
                value={String(counterValue(telemetry.value, 'umg_backend_connections_total', { outcome: 'failure' }))}
              />
              <DetailRow
                label="MCP session denials"
                value={String(counterValue(telemetry.value, 'umg_mcp_session_denied_total'))}
              />
            </VStack>

            <RecentErrors snapshot={telemetry.value} />

            <Text type="supporting">
              In-memory counters; they reset on restart, so these are current facts, not history. Series not yet
              incremented read 0. The full snapshot, including durations, is at{' '}
              <Text type="code">/api/v1/monitoring/metrics</Text>.
            </Text>
          </>
        )}
      </VStack>
    </Card>
  );
}

/** The most recent internal-category errors: codes and components, never messages. */
function RecentErrors({ snapshot }: { snapshot: MonitoringMetrics }): React.ReactElement {
  if (snapshot.recentErrors.length === 0) {
    return <Text type="supporting">No recent internal errors.</Text>;
  }

  return (
    <VStack gap={1}>
      <Text type="supporting">Recent internal errors (latest first):</Text>
      {snapshot.recentErrors.slice(0, 3).map((error, index) => (
        <DetailRow
          key={index}
          label={`${error.code} · ${error.component}`}
          value={formatTimestamp(error.at)}
        />
      ))}
    </VStack>
  );
}

/**
 * One series' counter value by exact name and label set. A family with no
 * sample for these labels is a counter nobody has incremented: 0 is the true
 * value, not a guess.
 */
function counterValue(
  snapshot: MonitoringMetrics,
  name: string,
  labels: Record<string, string> = {},
): number {
  const family = snapshot.metrics.find((metric) => metric.name === name);
  if (family === undefined) return 0;

  const keys = Object.keys(labels);
  const sample = family.samples.find((candidate) => {
    const present = (candidate.labels ?? {}) as Record<string, string>;
    return (
      Object.keys(present).length === keys.length &&
      keys.every((key) => present[key] === labels[key]) &&
      typeof candidate.value === 'number'
    );
  });

  // The find's predicate already established this; the re-check is for the
  // compiler, which cannot narrow through a predicate.
  if (sample === undefined || typeof sample.value !== 'number') return 0;
  return sample.value;
}
