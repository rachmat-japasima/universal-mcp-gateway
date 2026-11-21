import type {
  ActivityOutcome,
  ActivityQuery,
  ActivityType,
  AuditAction,
  AuditActorType,
  AuditQuery,
  AuditResult,
  AuditTargetType,
} from '@/lib/api/types';
import {
  ACTIVITY_OUTCOMES,
  ACTIVITY_TYPES,
  AUDIT_ACTIONS,
  AUDIT_ACTORS,
  AUDIT_RESULTS,
  AUDIT_TARGET_TYPES,
} from '@/lib/api/types';

/**
 * The one place a URL becomes an activity or audit filter.
 *
 * Three callers need the same answer: the list page, its pagination links, and
 * the CSV export. Parsing in each of them would let the export honour a filter
 * the page dropped (or the reverse) — and both surfaces have to forward *only*
 * what the gateway accepts, because an unknown value is a `400`, not an empty
 * page. So the allowlist lives here once.
 *
 * A value outside a closed enum is dropped rather than forwarded: the gateway
 * would reject it, and the page would show an error where the operator expected
 * their filter. Dropping silently is visible — the control resets — and is the
 * behaviour the existing list pages already use.
 */

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Reads one search parameter; the caller decides how arrays collapse. */
export type ParamReader = (key: string) => string | undefined;

function text(get: ParamReader, key: string, max = 200): string | undefined {
  const value = get(key)?.trim();
  if (value === undefined || value === '') return undefined;
  return value.slice(0, max);
}

function oneOf<T extends string>(get: ParamReader, key: string, allowed: readonly T[]): T | undefined {
  const value = get(key);
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function uuid(get: ParamReader, key: string): string | undefined {
  const value = get(key)?.trim();
  return value !== undefined && UUID.test(value) ? value : undefined;
}

/** ISO instants only. A malformed value is dropped, not forwarded as a `400`. */
function instant(get: ParamReader, key: string): string | undefined {
  const value = get(key)?.trim();
  if (value === undefined || value === '' || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

function pageNumber(get: ParamReader): number | undefined {
  const page = Number(get('page') ?? '1');
  return Number.isInteger(page) && page > 1 ? page : undefined;
}

function order(get: ParamReader): 'asc' | 'desc' | undefined {
  return get('order') === 'asc' ? 'asc' : undefined;
}

export function parseActivityQuery(get: ParamReader): ActivityQuery {
  const query: ActivityQuery = {
    type: oneOf<ActivityType>(get, 'type', ACTIVITY_TYPES),
    outcome: oneOf<ActivityOutcome>(get, 'outcome', ACTIVITY_OUTCOMES),
    agentId: uuid(get, 'agentId'),
    backendId: uuid(get, 'backendId'),
    toolName: text(get, 'toolName'),
    search: text(get, 'search'),
    after: instant(get, 'after'),
    before: instant(get, 'before'),
    order: order(get),
    page: pageNumber(get),
  };

  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)) as ActivityQuery;
}

export function activityHasFilters(query: ActivityQuery): boolean {
  return [
    query.type,
    query.outcome,
    query.agentId,
    query.backendId,
    query.toolName,
    query.search,
    query.after,
    query.before,
    query.order,
  ].some((value) => value !== undefined);
}

export function parseAuditQuery(get: ParamReader): AuditQuery {
  const query: AuditQuery = {
    action: oneOf<AuditAction>(get, 'action', AUDIT_ACTIONS),
    actorType: oneOf<AuditActorType>(get, 'actorType', AUDIT_ACTORS),
    actorId: text(get, 'actorId'),
    targetType: oneOf<AuditTargetType>(get, 'targetType', AUDIT_TARGET_TYPES),
    targetId: text(get, 'targetId'),
    result: oneOf<AuditResult>(get, 'result', AUDIT_RESULTS),
    search: text(get, 'search'),
    after: instant(get, 'after'),
    before: instant(get, 'before'),
    order: order(get),
    page: pageNumber(get),
  };

  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)) as AuditQuery;
}

export function auditHasFilters(query: AuditQuery): boolean {
  return [
    query.action,
    query.actorType,
    query.actorId,
    query.targetType,
    query.targetId,
    query.result,
    query.search,
    query.after,
    query.before,
    query.order,
  ].some((value) => value !== undefined);
}

/** A parameter record from `searchParams`, collapsed to its first value. */
export function readerOf(params: Record<string, string | string[] | undefined>): ParamReader {
  return (key) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
}

/**
 * Builds a link from the same object the API call was built from, so a
 * pagination or export link cannot carry a parameter the request did not.
 */
function href(path: string, query: Record<string, unknown>, page?: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === 'page' || value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  if (page !== undefined && page > 1) params.set('page', String(page));

  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

export function activityHref(query: ActivityQuery, page?: number): string {
  return href('/dashboard/activity', query as Record<string, unknown>, page);
}

export function auditHref(query: AuditQuery, page?: number): string {
  return href('/dashboard/audit', query as Record<string, unknown>, page);
}

/** Same filters, different destination — the export and the page cannot diverge. */
export function auditExportHref(query: AuditQuery): string {
  return href('/api/audit-export', query as Record<string, unknown>);
}
