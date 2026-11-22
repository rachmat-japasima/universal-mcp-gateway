'use client';

import { Table, proportional, type TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';

import type { PolicyRule } from '@/lib/api/types';

import { EffectBadge, ResourceLabel, TargetLabel } from './policy-status';

/**
 * The policy's rules table as a client component.
 *
 * `Table`'s column descriptors carry `renderCell` functions, which React cannot
 * serialize — a Server Component building them crashes the page with
 * "Functions cannot be passed directly to Client Components". Props here are
 * plain data only; the columns are constructed on the client side. That is why
 * `backendNames` is an array of pairs rather than the `Map` the page holds.
 */

export type RuleRow = {
  resource: PolicyRule['resource'];
  target: string;
  effect: PolicyRule['effect'];
};

function ruleColumns(backendNames: Map<string, string>): TableColumn<RuleRow>[] {
  return [
    {
      key: 'effect',
      header: 'Effect',
      width: proportional(1, { minWidth: 100 }),
      renderCell: (row) => <EffectBadge effect={row.effect} />,
    },
    {
      key: 'resource',
      header: 'Applies to',
      width: proportional(1, { minWidth: 110 }),
      renderCell: (row) => <ResourceLabel resource={row.resource} />,
    },
    {
      key: 'target',
      header: 'Target',
      width: proportional(5, { minWidth: 260 }),
      renderCell: (row) =>
        row.target === '*' ? (
          <TargetLabel target={row.target} />
        ) : (
          <VStack gap={0}>
            <TargetLabel target={row.target} />
            {row.resource === 'backend' ? (
              <Text type="supporting">
                {backendNames.get(row.target) ?? 'Not in the current registry — rules survive a removed backend.'}
              </Text>
            ) : null}
          </VStack>
        ),
    },
  ];
}

export function RulesTable({
  rows,
  backendNames,
}: {
  rows: RuleRow[];
  backendNames: Array<[string, string]>;
}) {
  return (
    <Table<RuleRow>
      data={rows}
      columns={ruleColumns(new Map(backendNames))}
      idKey="target"
      density="compact"
      dividers="rows"
      textOverflow="truncate"
    />
  );
}
