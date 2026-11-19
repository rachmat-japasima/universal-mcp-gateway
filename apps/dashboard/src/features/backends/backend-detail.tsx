import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import { PageHeader, SectionBlock } from '@/components/layout/page-container';
import { DetailRow } from '@/components/ui/metric-card';
import type { Backend, BackendRuntimeView } from '@/lib/api/types';
import { formatTimestamp } from '@/lib/utils/status';

import { BackendActions } from './backend-actions';
import { EnabledBadge, RuntimeStatus, TransportLabel } from './backend-status';

/**
 * Backend detail: overview, configuration, runtime.
 *
 * The configuration section renders what the API returns and nothing more. That
 * is safe by construction rather than by redaction: `env` and `headers` values
 * are *references* (`secret:<path>` / `env:<VAR>`), so a stored secret has no
 * representation the gateway could send. There is no value to mask, and no
 * placeholder that could quietly become one.
 *
 * The runtime section shows only fields the runtime view defines. When the
 * per-backend runtime read failed the section says so instead of falling back to
 * the reduced status from the configuration read and calling it complete.
 */
export function BackendDetail({
  backend,
  runtime,
  runtimeError,
}: {
  backend: Backend;
  runtime: BackendRuntimeView | undefined;
  /** Non-undefined when the runtime read failed; the configuration read still succeeded. */
  runtimeError?: string;
}): React.ReactElement {
  return (
    <VStack gap={5}>
      <PageHeader
        title={backend.name}
        description={backend.description ?? 'No description.'}
        actions={
          <HStack gap={2} wrap="wrap">
            <BackendActions backend={backend} layout="page" />
          </HStack>
        }
      />

      <SectionBlock title="Overview">
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Backend ID" value={<Text type="code">{backend.id}</Text>} />
            <DetailRow label="Transport" value={<TransportLabel transport={backend.transport} />} />
            <DetailRow label="Enabled" value={<EnabledBadge enabled={backend.enabled} />} />
            <DetailRow
              label="Runtime"
              value={
                runtimeError === undefined ? (
                  <RuntimeStatus
                    status={runtime?.status ?? backend.runtime?.status ?? (backend.enabled ? 'disconnected' : 'disabled')}
                    showRaw={runtime !== undefined}
                  />
                ) : (
                  // The live read failed. The reduced status from the item read is
                  // a real value, but it is not current, and showing it here as
                  // "Runtime" would be the same stale-state claim the runtime
                  // section below refuses to make.
                  <Text type="supporting">Unavailable — see Runtime</Text>
                )
              }
            />
            <DetailRow label="Created" value={formatTimestamp(backend.createdAt)} />
            <DetailRow label="Updated" value={formatTimestamp(backend.updatedAt)} />
            <DetailRow
              label="Version"
              value={
                <Text type="code">{backend.version}</Text>
              }
            />
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock
        title="Configuration"
        description="Saved values only. Secret references are shown as references; no secret value is ever stored or returned."
        actions={<a href={`/dashboard/backends/${backend.id}/edit`} className="text-sm underline">Edit configuration</a>}
      >
        <Card padding={4}>
          <VStack gap={2}>
            <DetailRow label="Timeout" value={`${backend.timeoutMs} ms`} />
            <DetailRow label="Concurrency" value={backend.concurrencyMode} />
            {backend.concurrencyLimit === undefined ? null : (
              <DetailRow label="Concurrency limit" value={String(backend.concurrencyLimit)} />
            )}

            {backend.connection.type === 'stdio' ? (
              <>
                <DetailRow label="Executable" value={<Text type="code">{backend.connection.command}</Text>} />
                <DetailRow
                  label="Arguments"
                  value={
                    backend.connection.args.length === 0 ? (
                      <Text type="supporting">None</Text>
                    ) : (
                      <VStack gap={1}>
                        {backend.connection.args.map((arg, index) => (
                          <Text key={`${index}-${arg}`} type="code">
                            {arg}
                          </Text>
                        ))}
                      </VStack>
                    )
                  }
                />
                {backend.connection.cwd === undefined ? null : (
                  <DetailRow label="Working directory" value={<Text type="code">{backend.connection.cwd}</Text>} />
                )}
                <ReferenceList title="Environment" entries={backend.connection.env} />
              </>
            ) : (
              <>
                <DetailRow label="Endpoint" value={<Text type="code">{backend.connection.url}</Text>} />
                <ReferenceList title="Request headers" entries={backend.connection.headers} />
              </>
            )}
          </VStack>
        </Card>
      </SectionBlock>

      <SectionBlock
        title="Runtime"
        description="What the lifecycle manager recorded. Live connection state, not configuration."
      >
        <Card padding={4}>
          {runtimeError === undefined ? (
            runtime === undefined ? (
              <Text type="supporting" as="p">
                No runtime state has been recorded for this backend yet.
              </Text>
            ) : (
              <VStack gap={2}>
                <DetailRow label="Status" value={<RuntimeStatus status={runtime.status} showRaw />} />
                <DetailRow label="Reconnect attempts" value={String(runtime.reconnectAttempts)} />
                <DetailRow
                  label="Last connected"
                  value={runtime.lastConnectedAt === undefined ? 'Never' : formatTimestamp(runtime.lastConnectedAt)}
                />
                <DetailRow
                  label="Last health check"
                  value={
                    runtime.lastHealthCheckAt === undefined ? 'None' : formatTimestamp(runtime.lastHealthCheckAt)
                  }
                />
                {runtime.updatedAt === undefined ? null : (
                  <DetailRow label="Runtime updated" value={formatTimestamp(runtime.updatedAt)} />
                )}
                {runtime.lastErrorCode === undefined ? null : (
                  <>
                    <DetailRow label="Last error code" value={<Text type="code">{runtime.lastErrorCode}</Text>} />
                    {runtime.lastErrorAt === undefined ? null : (
                      <DetailRow label="Last error at" value={formatTimestamp(runtime.lastErrorAt)} />
                    )}
                    {runtime.lastErrorMessage === undefined ? null : (
                      <DetailRow label="Last error" value={runtime.lastErrorMessage} />
                    )}
                  </>
                )}
              </VStack>
            )
          ) : (
            <VStack gap={1}>
              <Text type="supporting" as="p">
                {runtimeError}
              </Text>
              <Text type="supporting" as="p">
                The configuration above is still current; only the live state could not be read.
              </Text>
            </VStack>
          )}
        </Card>
      </SectionBlock>
    </VStack>
  );
}

/**
 * A secret-reference map.
 *
 * Both halves are shown because both are useful and neither is a secret: the key
 * says what the backend receives, and the reference says where the value comes
 * from. The value itself lives in the gateway's secret store or environment and
 * is resolved at call time — this page could not display it if it wanted to.
 */
function ReferenceList({ title, entries }: { title: string; entries: Record<string, string> }): React.ReactElement {
  const pairs = Object.entries(entries);

  return (
    <div>
      <Text type="label" color="secondary">
        {title}
      </Text>
      {pairs.length === 0 ? (
        <Text type="supporting" as="p">
          None
        </Text>
      ) : (
        <VStack gap={1}>
          {pairs.map(([key, reference]) => (
            <HStack key={key} gap={2} justify="between" wrap="wrap">
              <Text type="code">{key}</Text>
              <Text type="code">{reference}</Text>
            </HStack>
          ))}
        </VStack>
      )}
    </div>
  );
}
