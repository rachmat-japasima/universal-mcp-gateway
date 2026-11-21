import type { Metadata } from 'next';

import { ErrorState } from '@/components/feedback/states';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { getAudit } from '@/lib/api/endpoints';
import type { AuditEvent, Page as EventPage } from '@/lib/api/types';
import { parseAuditQuery, readerOf } from '@/lib/events/query';
import { AuditExport } from '@/features/audit/audit-export';
import { AuditTable } from '@/features/audit/audit-table';

export const metadata: Metadata = { title: 'Audit trail' };

export const dynamic = 'force-dynamic';

/**
 * The administrative and security record: who changed what.
 *
 * A different table from activity, with different filters and a different
 * audience — and deliberately its own page rather than a tab of one shared
 * "events" view. Activity volume must not dilute the security record, and an
 * operator looking for `session.access.denied` should not have to read past tool
 * calls to find it.
 *
 * **Read-only, structurally.** The gateway has no audit write route, and
 * `AuditRepository` has no update or delete method, so there is no mutation
 * control on this page and none to add. There is also no count tile built from a
 * second read: the row count under the table is the filtered total the API
 * returned, and inventing a "total events" figure would need an endpoint that
 * does not exist.
 *
 * `metadata` is not rendered in the table because the list payload omits it
 * (`toAuditListItem`); the detail page is the disclosure boundary.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const query = parseAuditQuery(readerOf(await searchParams));

  let list: EventPage<AuditEvent> | undefined;
  let listError: unknown;

  try {
    list = await getAudit(query);
  } catch (error) {
    listError = error;
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Audit trail"
          description="Who changed what: backends, agents, credentials, policies, settings, sessions, and operator sign-ins. Append-only; no record can be edited or deleted."
          actions={<AuditExport query={query} />}
        />

        {list === undefined ? (
          <ErrorState error={listError} title="The audit trail could not be read" />
        ) : (
          <AuditTable events={list.data} pagination={list.pagination} query={query} />
        )}
      </div>
    </PageContainer>
  );
}
