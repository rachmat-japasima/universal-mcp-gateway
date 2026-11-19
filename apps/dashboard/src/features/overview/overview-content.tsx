import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { getOverview } from '@/lib/api/endpoints';
import { BACKEND_RUNTIME_STATUSES, type Overview } from '@/lib/api/types';
import {
  authenticationStatus,
  formatCount,
  formatDuration,
  gatewayStatus,
  runtimeStatus,
} from '@/lib/utils/status';

import { DetailRow, MetricCard } from '@/components/ui/metric-card';
import { StatusBadge } from '@/components/ui/status-badge';

/**
 * The overview body.
 *
 * Every number comes from `GET /api/v1/overview`. Nothing is derived from a
 * config guess, a hardcoded sample, or a default: when the registry is empty the
 * page says so, and when a field is `null` the tile says "Unavailable".
 *
 * Kept as a pure component rather than reading the API itself, so the empty,
 * unavailable, and populated states are testable without a gateway.
 */
export function OverviewContent({ overview }: { overview: Overview }): React.ReactElement {
  const gateway = gatewayStatus(overview);
  const auth = authenticationStatus(overview.authentication);
  const registryEmpty = overview.backends !== null && overview.backends.total === 0;

  return (
    <VStack gap={5}>
      <Card padding={4}>
        <VStack gap={3}>
          <HStack gap={2} align="center" justify="between">
            <HStack gap={2} align="center">
              <StatusBadge status={gateway} />
              <Text type="supporting">
                {overview.service.name} {overview.service.version} · {overview.environment}
              </Text>
            </HStack>
            <Text type="supporting">Uptime {formatDuration(overview.uptimeMs)}</Text>
          </HStack>
          <VStack gap={1}>
            <DetailRow label="Storage" value={overview.database === 'ok' ? 'Answering' : 'Unavailable'} />
            <DetailRow label="Authentication" value={<StatusBadge status={auth} />} />
          </VStack>
        </VStack>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Backends"
          value={overview.backends === null ? null : overview.backends.total}
          detail={
            overview.backends === null
              ? 'The registry could not be read.'
              : `${formatCount(overview.backends.enabled) ?? '—'} enabled · ${formatCount(overview.backends.disabled) ?? '—'} disabled`
          }
        />
        <MetricCard
          label="Tools in catalog"
          value={overview.tools === null ? null : overview.tools.total}
          detail={
            overview.tools === null
              ? 'The catalog could not be read.'
              : `${formatCount(overview.tools.available) ?? '—'} available · ${formatCount(overview.tools.conflict) ?? '—'} in conflict`
          }
        />
        <MetricCard
          label="Agents"
          value={overview.agents === null ? null : overview.agents.total}
          detail={
            overview.agents === null
              ? 'Agents could not be read.'
              : `${formatCount(overview.agents.enabled) ?? '—'} enabled · ${formatCount(overview.agents.disabled) ?? '—'} disabled`
          }
        />
        <MetricCard
          label="Sessions"
          value={overview.sessions === null ? null : overview.sessions.active}
          detail={
            overview.sessions === null
              ? 'Session tracking is unavailable.'
              : `${formatCount(overview.sessions.expired) ?? '—'} expired · ${formatCount(overview.sessions.terminated) ?? '—'} terminated`
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card padding={4}>
          <VStack gap={3}>
            <Text type="label">Backend runtime</Text>
            {overview.backends === null ? (
              <Text type="supporting">Unavailable — the registry could not be read.</Text>
            ) : registryEmpty ? (
              <Text type="supporting">
                No backends are registered. Start one from the Backends module once it lands.
              </Text>
            ) : (
              <VStack gap={1}>
                {BACKEND_RUNTIME_STATUSES.map((status) => (
                  <DetailRow
                    key={status}
                    label={runtimeStatus(status).label}
                    value={formatCount(overview.backends?.runtime[status] ?? null) ?? 'Unavailable'}
                  />
                ))}
              </VStack>
            )}
          </VStack>
        </Card>

        <Card padding={4}>
          <VStack gap={3}>
            <Text type="label">Tool catalog</Text>
            {overview.tools === null ? (
              <Text type="supporting">Unavailable — the catalog could not be read.</Text>
            ) : overview.tools.total === 0 ? (
              <Text type="supporting">
                The catalog is empty. It fills when a connected backend reports its tools.
              </Text>
            ) : (
              <VStack gap={1}>
                <DetailRow label="Available" value={formatCount(overview.tools.available) ?? '—'} />
                <DetailRow label="Unavailable" value={formatCount(overview.tools.unavailable) ?? '—'} />
                <DetailRow label="In conflict" value={formatCount(overview.tools.conflict) ?? '—'} />
                <DetailRow
                  label="Backends with a catalog"
                  value={formatCount(overview.tools.backendsWithCatalog) ?? '—'}
                />
                <DetailRow
                  label="Discovery failures"
                  value={formatCount(overview.tools.discoveryFailures) ?? '—'}
                />
              </VStack>
            )}
          </VStack>
        </Card>

        <Card padding={4}>
          <VStack gap={3}>
            <Text type="label">Recorded activity</Text>
            {overview.activity === null ? (
              <Text type="supporting">Unavailable — activity history could not be read.</Text>
            ) : overview.activity.total === 0 ? (
              <Text type="supporting">
                Nothing recorded yet. Activity appears once a client initializes a session or a call is
                made.
              </Text>
            ) : (
              <VStack gap={1}>
                <DetailRow label="Events" value={formatCount(overview.activity.total) ?? '—'} />
                {Object.entries(overview.activity.byOutcome).map(([outcome, count]) => (
                  <DetailRow
                    key={outcome}
                    label={outcome.charAt(0).toUpperCase() + outcome.slice(1)}
                    value={formatCount(count) ?? '—'}
                  />
                ))}
              </VStack>
            )}
          </VStack>
        </Card>
      </div>
    </VStack>
  );
}

/** Server entry: reads `/overview` once and hands the payload to the component. */
export async function OverviewPanel(): Promise<React.ReactElement> {
  const overview = await getOverview();
  return <OverviewContent overview={overview} />;
}
