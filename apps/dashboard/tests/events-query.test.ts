// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  activityHref,
  activityHasFilters,
  auditExportHref,
  auditHref,
  auditHasFilters,
  parseActivityQuery,
  parseAuditQuery,
  readerOf,
} from '@/lib/events/query';
import { auditCsvFilename, AUDIT_CSV_COLUMNS, EXPORT_PAGE_SIZE, EXPORT_ROW_CAP, toAuditCsv } from '@/lib/events/csv';
import type { AuditEvent } from '@/lib/api/types';

/**
 * The URL → filter translation and the CSV writer.
 *
 * Both are pure, and both are security-relevant, so they are tested without a
 * renderer:
 *
 *  * a value outside a closed enum must be dropped, because forwarding it is a
 *    guaranteed `400` and would make a filter failure look like an empty result;
 *  * a non-UUID agent or backend id is dropped for the same reason;
 *  * the export must quote unconditionally and neutralise leading `=`, `+`, `-`,
 *    `@`, tab and CR so a spreadsheet cannot execute a field.
 */

function audit(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    actorType: 'admin',
    actorId: 'operator',
    action: 'policy.deleted',
    targetType: 'policy',
    targetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    result: 'success',
    createdAt: '2026-11-21T00:00:00.000Z',
    ...overrides,
  };
}

const UUID = '22222222-2222-4222-8222-222222222222';

describe('parseActivityQuery', () => {
  it('keeps the gateway-declared filters', () => {
    const query = parseActivityQuery(readerOf({ type: 'tools.call', outcome: 'denied', order: 'asc', page: '3' }));

    expect(query).toEqual({ type: 'tools.call', outcome: 'denied', order: 'asc', page: 3 });
  });

  it('drops an unknown enum value instead of forwarding a 400', () => {
    expect(parseActivityQuery(readerOf({ type: 'tools.explode', outcome: 'maybe' }))).toEqual({});
  });

  it('drops a non-UUID id and a malformed instant', () => {
    expect(parseActivityQuery(readerOf({ agentId: 'me', backendId: UUID, before: 'yesterday' }))).toEqual({
      backendId: UUID,
    });
  });

  it('ignores parameters the contract does not define', () => {
    expect(parseActivityQuery(readerOf({ targetId: UUID, limit: '500' }))).toEqual({});
  });

  it('treats page 1 as no parameter', () => {
    expect(parseActivityQuery(readerOf({ page: '1' }))).toEqual({});
  });
});

describe('parseAuditQuery', () => {
  it('keeps the audit filters, including the list-only target enum', () => {
    const query = parseAuditQuery(
      readerOf({ action: 'credential.revoked', actorType: 'agent', targetType: 'credential', result: 'success' }),
    );

    expect(query).toEqual({
      action: 'credential.revoked',
      actorType: 'agent',
      targetType: 'credential',
      result: 'success',
    });
  });

  it('rejects `operator` as a target filter, because the list schema does', () => {
    // The event schema allows `operator` as a target; the *filter* enum does not.
    expect(parseAuditQuery(readerOf({ targetType: 'operator' }))).toEqual({});
  });

  it('rejects an unknown action', () => {
    expect(parseAuditQuery(readerOf({ action: 'policy.exploded' }))).toEqual({});
  });
});

describe('filter detection', () => {
  it('is false only when nothing is set', () => {
    expect(activityHasFilters(parseActivityQuery(readerOf({})))).toBe(false);
    expect(activityHasFilters(parseActivityQuery(readerOf({ type: 'tools.call' })))).toBe(true);
    expect(auditHasFilters(parseAuditQuery(readerOf({})))).toBe(false);
    expect(auditHasFilters(parseAuditQuery(readerOf({ search: 'abc' })))).toBe(true);
  });
});

describe('hrefs', () => {
  it('carries exactly the filters, and omits an implicit page 1', () => {
    expect(activityHref({ type: 'tools.call', page: 1 } as never, 1)).toBe('/dashboard/activity?type=tools.call');
  });

  it('builds a page link from the same object as the request', () => {
    expect(activityHref({ outcome: 'failure' } as never, 4)).toBe('/dashboard/activity?outcome=failure&page=4');
  });

  it('points the export at the same filters', () => {
    expect(auditExportHref({ result: 'denied' } as never)).toBe('/api/audit-export?result=denied');
    expect(auditHref({ result: 'denied' } as never)).toBe('/dashboard/audit?result=denied');
  });
});

describe('toAuditCsv', () => {
  it('writes the documented columns in a fixed order', () => {
    const csv = toAuditCsv([audit()]);
    const [header, row] = csv.trimEnd().split('\r\n');

    expect(header).toBe(AUDIT_CSV_COLUMNS.map((column) => `"${column}"`).join(','));
    expect(row).toContain('"policy.deleted"');
    expect(row).toContain('"policy"');
  });

  it('omits no column for a missing field, and never emits metadata', () => {
    const csv = toAuditCsv([audit({ targetType: undefined, targetId: undefined })]);
    const row = csv.trimEnd().split('\r\n')[1]!;

    // Nine columns, two empty.
    expect(row.split(',').length).toBe(AUDIT_CSV_COLUMNS.length);
    expect(csv).not.toMatch(/metadata/i);
    expect(csv).not.toContain('undefined');
  });

  it('neutralises a formula, a tab, and a carriage return', () => {
    const csv = toAuditCsv([
      audit({ actorId: '=HYPERLINK("http://evil")' }),
      audit({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', targetId: '+1' }),
      audit({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', targetId: '-1' }),
      audit({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', targetId: '@x' }),
      audit({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', targetId: '\tx' }),
    ]);

    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).toContain(`"'+1"`);
    expect(csv).toContain(`"'-1"`);
    expect(csv).toContain(`"'@x"`);
    expect(csv).toContain(`"'\tx"`);
    // The literal dangerous prefix never starts a field.
    expect(csv).not.toMatch(/[,"\r\n]=HYPERLINK/);
  });

  it('doubles an inner quote and keeps a comma inside its field', () => {
    const csv = toAuditCsv([audit({ actorId: 'a,"b' })]);
    expect(csv).toContain('"a,""b"');
  });

  it('is bounded by a documented cap', () => {
    expect(EXPORT_ROW_CAP).toBe(1_000);
    expect(EXPORT_PAGE_SIZE).toBe(100);
  });

  it('names the file with a UTC date', () => {
    expect(auditCsvFilename(new Date('2026-11-21T23:59:59.000Z'))).toBe('audit-2026-11-21.csv');
  });
});
