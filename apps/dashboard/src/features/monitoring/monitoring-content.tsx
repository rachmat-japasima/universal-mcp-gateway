import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { ErrorState } from '@/components/feedback/states';
import { DetailRow, MetricCard } from '@/components/ui/metric-card';
import { StatusBadge } from '@/components/ui/status-badge';
import type {
  BackendCounts,
  GatewayHealth,
  Monitoring,
  MonitoringBackends,
  MonitoringHealth,
  MonitoringMetrics,
  MonitoringSessions,
  Readiness,
} from '@/lib/api/types';
import { BACKEND_RUNTIME_STATUSES } from '@/lib/api/types';
import { authenticationStatus, formatCount, formatDuration, formatTimestamp, runtimeStatus } from '@/lib/utils/status';

import { dependencyStatus, livenessStatus, readinessDetail, readinessStatus } from './monitoring-status';
import type { Read } from './read';
import { TelemetryCard } from './telemetry-card';

/**
 * The monitoring body.
 *
 * Five different questions, in five separate cards, because they are not
 * interchangeable:
 *
 *   * **liveness** — `/health`: is the process serving? It never consults
 *     storage, so it can pass while readiness fails.
 *   * **readiness** — `/ready`: can it serve? A `503` here is a real, parsed
 *     answer, not a transport error.
 *   * **dependency health** — `/monitoring/health`: storage plus the backend
 *     registry, which readiness deliberately ignores.
 *   * **backend runtime** — `/monitoring/backends`: what each connection is doing.
 *   * **telemetry** — `/monitoring/metrics`: the counters the gateway itself
 *     keeps, read by exact metric and label — no sums, no rates, no chart.
 *
 * Every value is a recorded field. The one thing deliberately absent is a
 * derived figure: no percentage, no request rate, no latency percentile and no
 * graph, because the registry keeps counts and bucketed durations since process
 * start — a rate or trend line invented from a single snapshot of it would be
 * the most convincing lie on the page.
 *
 * Each read is a `Read<T>`, so one failing endpoint degrades its own card. A
 * section whose read failed renders an error and an explicit "not read" note
 * instead of a zero, because "none" and "unknown" are different claims.
 */
export function MonitoringContent({
  monitoring,
  health,
  readiness,
  liveness,
  backends,
  sessions,
  telemetry,
  diagnostics,
}: {
  monitoring: Read<Monitoring>;
  health: Read<MonitoringHealth>;
  readiness: Read<Readiness>;
  liveness: Read<GatewayHealth>;
  backends: Read<MonitoringBackends>;
  sessions: Read<MonitoringSessions>;
  telemetry: Read<MonitoringMetrics>;
  /** Rendered by the page below, not by these cards. */
  diagnostics?: React.ReactNode;
}): React.ReactElement {
  const snapshot = monitoring.ok ? monitoring.value : undefined;

  return (
    <VStack gap={5}>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card padding={4}>
          <VStack gap={3}>
            <Text type="label">Liveness</Text>
            {liveness.ok ? (
              <>
                <StatusBadge status={livenessStatus(liveness.value.status === 'ok')} />
                <VStack gap={1}>
                  <DetailRow label="Endpoint" value={<Text type="code">{'/health'}</Text>} />
                  <DetailRow
                    label="Checked"
                    value={formatTimestamp(liveness.value.timestamp)}
                  />
                  <DetailRow label="Backends registered" value={String(liveness.value.mcp.backendCount)} />
                  <DetailRow label="Agent authentication" value={<StatusBadge status={authenticationStatus(liveness.value.mcp.authentication)} />} />
                </VStack>
                <Text type="supporting">
                  This probe answers without consulting storage, so it can pass while readiness fails.
                </Text>
              </>
            ) : (
              <>
                <StatusBadge status={livenessStatus(false)} />
                <ErrorState error={liveness.error} title="Liveness could not be read" />
              </>
            )}
          </VStack>
        </Card>

        <Card padding={4}>
          <VStack gap={3}>
            <Text type="label">Readiness</Text>
            {readiness.ok ? (
              <>
                <StatusBadge status={readinessStatus(readiness.value)} />
                <VStack gap={1}>
                  <DetailRow label="Checks" value={readinessDetail(readiness.value)} />
                  <DetailRow label="Checked" value={formatTimestamp(readiness.value.timestamp)} />
                </VStack>
                <Text type="supporting">
                  Readiness covers storage and the migration ledger. Optional backends are excluded: a gateway
                  with every backend disconnected is still ready to accept work.
                </Text>
              </>
            ) : (
              <>
                <StatusBadge status={{ label: 'Readiness not read', tone: 'error' }} />
                <ErrorState error={readiness.error} title="Readiness could not be read" />
              </>
            )}
          </VStack>
        </Card>

        <Card padding={4}>
          <VStack gap={3}>
            <Text type="label">Dependency health</Text>
            {health.ok ? (
              <>
                <StatusBadge status={dependencyStatus(health.value)} />
                <VStack gap={1}>
                  <DetailRow label="Storage" value={health.value.database === 'ok' ? 'Answering' : 'Unavailable'} />
                  <DetailRow label="Checked" value={formatTimestamp(health.value.timestamp)} />
                </VStack>
                <Text type="supporting">
                  The management view of the same storage, plus the backend registry. Backend connectivity is
                  reported as a count, never as a pass/fail for the gateway.
                </Text>
              </>
            ) : (
              <>
                <StatusBadge status={{ label: 'Dependency health not read', tone: 'error' }} />
                <ErrorState error={health.error} title="Dependency health could not be read" />
              </>
            )}
          </VStack>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Backends"
          value={snapshot?.backends === null || snapshot?.backends === undefined ? null : snapshot.backends.total}
          detail={snapshot === undefined ? 'The snapshot could not be read.' : 'Registered in the gateway'}
        />
        <MetricCard
          label="Tools available"
          value={snapshot?.tools === null || snapshot?.tools === undefined ? null : snapshot.tools.available}
          detail={snapshot === undefined ? 'The snapshot could not be read.' : 'Routable right now'}
        />
        <MetricCard
          label="Active sessions"
          value={sessions.ok ? (sessions.value.available ? (sessions.value.counts?.active ?? null) : null) : null}
          detail={
            sessions.ok
              ? sessions.value.available
                ? 'MCP protocol sessions, not dashboard sign-ins'
                : (sessions.value.reason ?? 'Session tracking is not enabled.')
              : 'Session counts could not be read.'
          }
          unavailableLabel={sessions.ok && !sessions.value.available ? 'Not enabled' : 'Unavailable'}
        />
        <MetricCard
          label="Runtime uptime"
          value={snapshot === undefined ? null : formatDuration(snapshot.runtime.uptimeMs)}
          detail={snapshot === undefined ? 'The snapshot could not be read.' : `Node ${snapshot.runtime.node} · ${snapshot.runtime.platform}`}
          unavailableLabel="Unavailable"
        />
      </div>

      <Card padding={4}>
        <VStack gap={3}>
          <HStack gap={2} align="center" justify="between" wrap="wrap">
            <Text type="label">Backend runtime</Text>
            {snapshot === undefined ? null : (
              <Text type="supporting">Snapshot {formatTimestamp(snapshot.timestamp)}</Text>
            )}
          </HStack>

          {!monitoring.ok ? (
            <ErrorState error={monitoring.error} title="The monitoring snapshot could not be read" />
          ) : monitoring.value.backends === null ? (
            <Text type="supporting">Unavailable — the registry could not be read.</Text>
          ) : (
            <BackendDistribution counts={monitoring.value.backends} />
          )}
        </VStack>
      </Card>

      <Card padding={4}>
        <VStack gap={3}>
          <Text type="label">Connected backends</Text>
          {backends.ok ? (
            backends.value.runtimes.length === 0 ? (
              <Text type="supporting">
                No backend has a runtime record. Register one in the Backends module and connect it.
              </Text>
            ) : (
              <VStack gap={2}>
                {backends.value.runtimes.map((runtime) => (
                  <Card key={runtime.backendId} padding={3}>
                    <VStack gap={1}>
                      <HStack gap={2} align="center" wrap="wrap">
                        <StatusBadge status={runtimeStatus(runtime.status)} />
                        <Text type="code">{runtime.backendId}</Text>
                      </HStack>
                      <DetailRow label="Reconnect attempts" value={String(runtime.reconnectAttempts)} />
                      {runtime.lastConnectedAt === undefined ? null : (
                        <DetailRow label="Last connected" value={formatTimestamp(runtime.lastConnectedAt)} />
                      )}
                      {runtime.lastErrorCode === undefined ? null : (
                        <DetailRow label="Last error" value={<Text type="code">{runtime.lastErrorCode}</Text>} />
                      )}
                      {runtime.lastErrorAt === undefined ? null : (
                        <DetailRow label="Error recorded" value={formatTimestamp(runtime.lastErrorAt)} />
                      )}
                      {runtime.updatedAt === undefined ? null : (
                        <DetailRow label="Updated" value={formatTimestamp(runtime.updatedAt)} />
                      )}
                    </VStack>
                  </Card>
                ))}
              </VStack>
            )
          ) : (
            <ErrorState error={backends.error} title="Backend runtime could not be read" />
          )}
        </VStack>
      </Card>

      <TelemetryCard telemetry={telemetry} />

      {diagnostics}
    </VStack>
  );
}

/**
 * The registry's status distribution, from one recorded count per state.
 *
 * An empty registry is a real zero and says so; it is not rendered as a chart of
 * nothing. `disabled` is included because it is a legitimate state, and omitting
 * it would make the rows sum to less than `total`.
 */
function BackendDistribution({ counts }: { counts: BackendCounts }): React.ReactElement {
  return (
    <VStack gap={1}>
      {BACKEND_RUNTIME_STATUSES.map((status) => (
        <DetailRow
          key={status}
          label={runtimeStatus(status).label}
          value={formatCount(counts.runtime[status]) ?? 'Unavailable'}
        />
      ))}
      <DetailRow label="Total" value={formatCount(counts.total) ?? 'Unavailable'} />
    </VStack>
  );
}
