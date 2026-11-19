import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

/**
 * The metric tile used across the overview.
 *
 * `value` accepts `null` on purpose: a storage-backed count is `null` when the
 * read failed. It renders "Unavailable" rather than "0", and the tone makes that
 * visually distinct from a real zero.
 */
export function MetricCard({
  label,
  value,
  detail,
  unavailableLabel = 'Unavailable',
}: {
  label: string;
  value: number | string | null;
  detail?: React.ReactNode;
  unavailableLabel?: string;
}): React.ReactElement {
  return (
    <Card padding={4} elevation="none">
      <VStack gap={1}>
        <Text type="label" color="secondary">
          {label}
        </Text>
        {value === null ? (
          <Heading level={3} type="display-3" color="secondary">
            {unavailableLabel}
          </Heading>
        ) : (
          <Heading level={3} type="display-3">
            {typeof value === 'number' ? new Intl.NumberFormat('en-US').format(value) : value}
          </Heading>
        )}
        {detail === undefined ? null : <Text type="supporting">{detail}</Text>}
      </VStack>
    </Card>
  );
}

/** Label/value pair for payloads that are facts rather than counts. */
export function DetailRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <HStack gap={2} justify="between">
      <Text type="supporting" color="secondary">
        {label}
      </Text>
      <Text type="body">{value}</Text>
    </HStack>
  );
}
