'use client';

import { Button } from '@astryxdesign/core/Button';

import type { AuditQuery } from '@/lib/api/types';
import { auditExportHref } from '@/lib/events/query';

/**
 * CSV export for the audit trail.
 *
 * A plain link, not a fetch: the download is a route handler that re-reads with
 * the same filters this page is showing, so the file matches the screen. Using
 * the shared href builder means the export cannot carry a parameter the page's
 * own request did not.
 *
 * The route sets `content-disposition` (and `text/csv`), which is what makes the
 * browser save a file; `Button` has no `download` prop and does not need one.
 */
export function AuditExport({ query }: { query: AuditQuery }): React.ReactElement {
  return <Button label="Export CSV" href={auditExportHref(query)} variant="secondary" size="sm" />;
}
