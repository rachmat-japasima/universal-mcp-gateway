import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EmptyStateCard } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { ALL_NAV_ITEMS } from '@/lib/navigation';

/**
 * Placeholder for a module scheduled for Phase 10.
 *
 * Title and summary are read from the navigation table, so a module cannot
 * describe itself one way in the sidebar and another on its page.
 *
 * It states plainly that the screen is not built. It renders no sample rows, no
 * zeroed counters, and no disabled controls that look like a finished feature
 * waiting for data — a fake screen is worse than an honest gap, because it makes
 * "not implemented" indistinguishable from "empty".
 */
export function PlaceholderScreen({ href }: { href: string }): React.ReactElement {
  const item = ALL_NAV_ITEMS.find((candidate) => candidate.href === href);
  if (item === undefined) notFound();

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader title={item.label} description={item.summary} />
        <EmptyStateCard
          title={`${item.label} is not implemented yet`}
          description="This screen arrives in Phase 10. The management API it will read is already live; nothing here is stubbed with sample data."
        />
      </div>
    </PageContainer>
  );
}

/** Same lookup, for a placeholder page's `metadata`. */
export function placeholderMetadata(href: string): Metadata {
  const item = ALL_NAV_ITEMS.find((candidate) => candidate.href === href);
  return { title: item?.label ?? 'Dashboard' };
}
