import type { AuditEvent } from '@/lib/api/types';

/**
 * Audit CSV export.
 *
 * Scope decisions, each one a reason this is safe rather than a reason it is
 * convenient:
 *
 *  * **The export is the list shape.** `GET /audit` omits `metadata`
 *    (`toAuditListItem`), so a CSV built from it *cannot* contain an audit
 *    metadata blob — the disclosure boundary is the endpoint's, not this file's.
 *    There is no "export everything" path that would need a separate review.
 *  * **Filters are the caller's.** The route re-reads with the same parsed query
 *    the page used, so an export never silently covers more than what was on
 *    screen.
 *  * **It is bounded.** `EXPORT_ROW_CAP` rows at most, across at most
 *    `EXPORT_PAGE_CAP` pages. An unbounded export of a growing security table is
 *    a way to turn one click into a memory problem.
 *  * **Formulas are neutralised.** A quoted CSV field is still evaluated by a
 *    spreadsheet if it begins with `=`, `+`, `-`, `@`, tab or CR. Audit fields
 *    are ids and enum members today, but `actorId`/`targetId` are free-form
 *    strings on the gateway, so the escape is applied unconditionally rather than
 *    trusting today's callers.
 *  * **Quoting is unconditional.** Every field is quoted and inner quotes are
 *    doubled, so a comma, newline or quote in an id can never shift a column.
 */

export const EXPORT_ROW_CAP = 1_000;
export const EXPORT_PAGE_SIZE = 100;

/** Columns in a fixed order, so a consumer can rely on the shape. */
export const AUDIT_CSV_COLUMNS = [
  'id',
  'createdAt',
  'actorType',
  'actorId',
  'action',
  'targetType',
  'targetId',
  'result',
  'requestId',
] as const;

type Column = (typeof AUDIT_CSV_COLUMNS)[number];

function valueOf(event: AuditEvent, column: Column): string {
  const value = event[column];
  return value === undefined ? '' : String(value);
}

/**
 * Prefixes a dangerous leading character with an apostrophe, which spreadsheets
 * treat as "literal text". Applied before quoting so the apostrophe stays inside
 * the field.
 */
function neutralise(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return `"${neutralise(value).replace(/"/g, '""')}"`;
}

/** Header row, then one row per event. `\r\n` per RFC 4180. */
export function toAuditCsv(events: readonly AuditEvent[]): string {
  const lines = [AUDIT_CSV_COLUMNS.map((column) => quote(column)).join(',')];

  for (const event of events) {
    lines.push(AUDIT_CSV_COLUMNS.map((column) => quote(valueOf(event, column))).join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}

/** `audit-2026-11-21.csv` — UTC date, so the filename is stable and sortable. */
export function auditCsvFilename(now: Date = new Date()): string {
  return `audit-${now.toISOString().slice(0, 10)}.csv`;
}
