import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { DetailRow } from '@/components/ui/metric-card';
import { StatusBadge } from '@/components/ui/status-badge';
import type { Settings } from '@/lib/api/types';
import { formatDuration } from '@/lib/utils/status';

/**
 * The effective gateway configuration, read-only.
 *
 * Every value here is **environment-managed**: the gateway reads it from its own
 * environment at startup and there is no supported way to change it from a
 * browser. `/settings` answers `readOnly: true` and `features.settingsMutation:
 * false`, and no mutation route exists, so the page shows the values and says
 * where they come from instead of offering dead inputs.
 *
 * A generic environment editor was rejected. It would turn the dashboard into a
 * remote control for the process's configuration, would need write access the
 * gateway does not expose, and would make the audit trail's `settings.updated`
 * action a lie. To change any of this: edit the gateway's environment, restart it,
 * and reload this page.
 *
 * The three categories are kept visibly separate because they are governed
 * differently — see the section notes below.
 */
export function SettingsContent({ settings }: { settings: Settings }): React.ReactElement {
  return (
    <VStack gap={5}>
      <Card padding={4}>
        <VStack gap={2}>
          <HStack gap={2} align="center" wrap="wrap">
            <StatusBadge status={{ label: 'Read-only', tone: 'neutral' }} />
            <Text type="supporting">Effective configuration, as the gateway resolved it at startup.</Text>
          </HStack>
          <Text type="supporting" as="p">
            Nothing on this page can be changed here, and there is no hidden editor: the gateway exposes no settings
            mutation route. To change a value, edit the gateway&rsquo;s environment, restart it, and reload this page.
          </Text>
        </VStack>
      </Card>

      <Section title="Where the gateway listens" note="Environment-managed. A change requires a restart.">
        <DetailRow label="Host" value={<Text type="code">{settings.host}</Text>} />
        <DetailRow label="Port" value={<Text type="code">{String(settings.port)}</Text>} />
        <DetailRow label="Environment" value={settings.environment} />
        <DetailRow label="MCP endpoint" value={<Text type="code">{settings.endpoints.mcp}</Text>} />
        <DetailRow label="Health endpoint" value={<Text type="code">{settings.endpoints.health}</Text>} />
        <DetailRow label="Management API" value={<Text type="code">{settings.endpoints.api}</Text>} />
      </Section>

      <Section title="Limits" note="Environment-managed. These bound one request; they are not per-agent quotas.">
        <DetailRow label="Request body limit" value={`${settings.limits.requestBodyLimitBytes.toLocaleString('en-US')} bytes`} />
        <DetailRow label="Request timeout" value={formatDuration(settings.limits.requestTimeoutMs)} />
        <DetailRow label="Tool discovery timeout" value={formatDuration(settings.limits.toolDiscoveryTimeoutMs)} />
        <DetailRow label="Tool call timeout" value={formatDuration(settings.limits.toolCallTimeoutMs)} />
      </Section>

      <Section title="Sessions" note="Environment-managed. These apply to MCP agent sessions, not dashboard sign-ins.">
        <DetailRow label="Idle timeout" value={formatDuration(settings.sessions.idleTimeoutMs)} />
        <DetailRow label="Maximum lifetime" value={formatDuration(settings.sessions.maxLifetimeMs)} />
      </Section>

      <Section
        title="Backend connections"
        note="Environment-managed. Reconnect and network reach are process-wide, not per backend."
      >
        <DetailRow
          label="Automatic reconnect"
          value={<StatusBadge status={settings.backendConnections.reconnect.enabled ? { label: 'Enabled', tone: 'success' } : { label: 'Disabled', tone: 'neutral' }} />}
        />
        <DetailRow label="Initial delay" value={formatDuration(settings.backendConnections.reconnect.initialDelayMs)} />
        <DetailRow label="Maximum delay" value={formatDuration(settings.backendConnections.reconnect.maxDelayMs)} />
        <DetailRow label="Maximum attempts" value={String(settings.backendConnections.reconnect.maxAttempts)} />
        <DetailRow label="Jitter ratio" value={String(settings.backendConnections.reconnect.jitterRatio)} />
        <DetailRow
          label="Allow private network"
          value={
            <HStack gap={2} align="center" wrap="wrap">
              <StatusBadge
                status={
                  settings.backendConnections.allowPrivateNetwork
                    ? { label: 'Allowed', tone: 'warning' }
                    : { label: 'Blocked', tone: 'success' }
                }
              />
              <Text type="supporting">Widens the SSRF surface; reported because it is a security-relevant flag.</Text>
            </HStack>
          }
        />
      </Section>

      <Section
        title="Capabilities"
        note="Reported as availability flags, not values. A flag says whether the gateway can do it, not how it is configured."
      >
        {CAPABILITIES.map(({ key, label, note }) => (
          <DetailRow
            key={key}
            label={label}
            value={
              <HStack gap={2} align="center" wrap="wrap">
                <StatusBadge
                  status={
                    settings.features[key]
                      ? { label: 'Available', tone: 'success' }
                      : { label: 'Not available', tone: 'neutral' }
                  }
                />
                {note === undefined ? null : <Text type="supporting">{note}</Text>}
              </HStack>
            }
          />
        ))}
      </Section>

      <Section title="Logging" note="Environment-managed.">
        <DetailRow label="Level" value={<Text type="code">{settings.logging.level}</Text>} />
      </Section>

      <Card padding={4}>
        <VStack gap={2}>
          <Text type="label">Operator account</Text>
          <Text type="supporting" as="p">
            This dashboard has one operator account, created once with <Text type="code">pnpm operator:create</Text>.
            There is no password-change API and no account-management screen, so neither is offered here — a form
            that posted nowhere would be worse than no form.
          </Text>
          <Text type="supporting" as="p">
            <Text type="body">To replace the operator&rsquo;s password:</Text> stop the gateway, delete the operator row
            from the database, then run <Text type="code">pnpm operator:create</Text> and restart. Deleting the row
            invalidates its sessions, so sign in again afterwards. Audit records are untouched by this.
          </Text>
        </VStack>
      </Card>
    </VStack>
  );
}

/** Every flag `/settings` reports, with the reason it might be off. */
const CAPABILITIES: Array<{ key: keyof Settings['features']; label: string; note?: string }> = [
  { key: 'authentication', label: 'Agent authentication' },
  { key: 'sessions', label: 'Session tracking' },
  { key: 'toolRouting', label: 'Tool routing' },
  { key: 'backendLifecycle', label: 'Backend lifecycle' },
  { key: 'auditTrail', label: 'Audit trail' },
  {
    key: 'settingsMutation',
    label: 'Settings mutation',
    note: 'No settings mutation route exists, which is why this page is read-only.',
  },
  {
    key: 'metrics',
    label: 'Metrics',
    note: 'In-memory counters and histograms, exported at /metrics. They reset on restart, so they are current facts, not history.',
  },
];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Card padding={4}>
      <VStack gap={2}>
        <Text type="label">{title}</Text>
        <Text type="supporting">{note}</Text>
        <VStack gap={1}>{children}</VStack>
      </VStack>
    </Card>
  );
}
