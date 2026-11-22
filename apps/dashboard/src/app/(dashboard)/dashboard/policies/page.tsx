import type { Metadata } from 'next';

import { LinkButton } from '@/components/ui/link-button';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { MetricCard } from '@/components/ui/metric-card';
import { listPolicies } from '@/lib/api/policies';
import type { Page as PolicyPage, Policy, PolicyEffect, PolicyQuery } from '@/lib/api/types';
import { PoliciesTable } from '@/features/policies/policies-table';

export const metadata: Metadata = { title: 'Access policies' };

export const dynamic = 'force-dynamic';

/**
 * The policy registry.
 *
 * One read. The tiles are computed from the *filtered* page and labelled that
 * way, because the API exposes no registry-wide policy counts — inventing a
 * number, or implying the visible rows are the whole registry, would be worse
 * than saying what the figures describe.
 *
 * A failed read is an error state, never "0 policies": an unavailable registry
 * and an empty one are different claims, and default-deny makes the difference
 * operationally important.
 */

function parseQuery(params: Record<string, string | string[] | undefined>): PolicyQuery {
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const search = single(params.search)?.trim();
  const effect = single(params.effect);
  const page = Number(single(params.page) ?? '1');

  return {
    ...(search === undefined || search === '' ? {} : { search }),
    ...(effect === 'allow' || effect === 'deny' ? { effect: effect as PolicyEffect } : {}),
    ...(Number.isInteger(page) && page > 1 ? { page } : {}),
  };
}

function summarise(policies: Policy[]): { allows: number; denies: number; wildcard: number } {
  let allows = 0;
  let denies = 0;
  let wildcard = 0;

  for (const policy of policies) {
    for (const rule of policy.rules) {
      if (rule.effect === 'allow') allows += 1;
      else denies += 1;
      if (rule.effect === 'allow' && rule.target === '*') wildcard += 1;
    }
  }

  return { allows, denies, wildcard };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const query = parseQuery(await searchParams);

  let list: PolicyPage<Policy> | undefined;
  let listError: unknown;

  try {
    list = await listPolicies(query);
  } catch (error) {
    listError = error;
  }

  const summary = list === undefined ? undefined : summarise(list.data);
  const scope = list === undefined ? '' : ` on this page of ${list.pagination.total}`;

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Access policies"
          description="Named groups of ALLOW and DENY rules. Agents are default-denied until an assigned policy allows a tool."
          actions={<LinkButton label="Create policy" href="/dashboard/policies/new" variant="primary" />}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MetricCard label={`Allow rules${scope}`} value={summary?.allows ?? null} />
          <MetricCard label={`Deny rules${scope}`} value={summary?.denies ?? null} />
          <MetricCard
            label={`Wildcard allows${scope}`}
            value={summary?.wildcard ?? null}
            detail={summary?.wildcard === undefined ? undefined : 'Rules granting everything at their level'}
          />
        </div>

        {list === undefined ? (
          <ErrorState error={listError} title="The policy registry could not be read" />
        ) : (
          <PoliciesTable policies={list.data} pagination={list.pagination} query={query} />
        )}
      </div>
    </PageContainer>
  );
}
