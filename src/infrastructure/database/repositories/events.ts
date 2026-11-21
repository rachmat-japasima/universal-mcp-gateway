import type { ActivityEvent } from '../../../domain/activity-event.js';
import { activityEventSchema } from '../../../domain/activity-event.js';
import type { AuditEvent } from '../../../domain/audit-event.js';
import { auditEventSchema } from '../../../domain/audit-event.js';
import type {
  ActivityRepository,
  AuditListItem,
  AuditQuery,
  AuditRepository,
  EventPage,
  EventQuery,
  SessionPage,
  SessionQuery,
  SessionRepository,
} from '../../../domain/repositories.js';
import type { Session, SessionStatus, SessionTerminationReason } from '../../../domain/session.js';
import { sessionSchema, sessionStatusSchema, sessionTerminationReasonSchema } from '../../../domain/session.js';
import { AppError } from '../../../shared/errors.js';
import type { SqliteDatabase } from '../connection.js';
import { parseStored, wrapDatabaseError } from './helpers.js';

/**
 * Activity and audit are append-only from the application's perspective: no
 * update or delete path exists. Retention jobs (a later phase) are the only
 * sanctioned deleter, and they must be bounded and observable.
 */

interface ActivityRow {
  id: string;
  type: string;
  request_id: string | null;
  correlation_id: string | null;
  agent_id: string | null;
  backend_id: string | null;
  tool_name: string | null;
  outcome: string;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
}

function toActivity(row: ActivityRow): ActivityEvent {
  return parseStored(
    () =>
      activityEventSchema.parse({
        id: row.id,
        type: row.type,
        ...(row.request_id === null ? {} : { requestId: row.request_id }),
        ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
        ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
        ...(row.backend_id === null ? {} : { backendId: row.backend_id }),
        ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
        outcome: row.outcome,
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        createdAt: row.created_at,
      }),
    { activityId: row.id },
  );
}

export class SqliteActivityRepository implements ActivityRepository {
  constructor(private readonly database: SqliteDatabase) {}

  append(event: ActivityEvent): ActivityEvent {
    const parsed = activityEventSchema.parse(event);

    try {
      this.database
        .prepare(
          `INSERT INTO activity_events (id, type, request_id, correlation_id, agent_id, backend_id, tool_name, outcome,
             error_code, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.type,
          parsed.requestId ?? null,
          parsed.correlationId ?? null,
          parsed.agentId ?? null,
          parsed.backendId ?? null,
          parsed.toolName ?? null,
          parsed.outcome,
          parsed.errorCode ?? null,
          parsed.durationMs ?? null,
          parsed.createdAt,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'activity_events.append' });
    }

    return parsed;
  }

  list(limit: number): ActivityEvent[] {
    const rows = this.database
      .prepare('SELECT * FROM activity_events ORDER BY created_at DESC LIMIT ?')
      .all(limit) as ActivityRow[];

    return rows.map(toActivity);
  }

  findById(id: string): ActivityEvent | undefined {
    const row = this.database.prepare('SELECT * FROM activity_events WHERE id = ?').get(id) as
      | ActivityRow
      | undefined;

    return row === undefined ? undefined : toActivity(row);
  }

  query(criteria: EventQuery): EventPage<ActivityEvent> {
    const { where, params } = activityFilter(criteria);
    const direction = criteria.order === 'asc' ? 'ASC' : 'DESC';

    const total = (
      this.database.prepare(`SELECT COUNT(*) AS count FROM activity_events ${where}`).get(...params) as {
        count: number;
      }
    ).count;

    const rows = this.database
      .prepare(
        `SELECT * FROM activity_events ${where} ORDER BY created_at ${direction}, id ${direction} LIMIT ? OFFSET ?`,
      )
      .all(...params, criteria.limit, criteria.offset) as ActivityRow[];

    return { items: rows.map(toActivity), total };
  }

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM activity_events').get() as { count: number };
    return row.count;
  }

  countByType(): Record<string, number> {
    return groupedCounts(this.database, 'activity_events', 'type');
  }

  countByOutcome(): Record<string, number> {
    return groupedCounts(this.database, 'activity_events', 'outcome');
  }
}

/** Shared filter builder: every value is bound, no identifier comes from the caller. */
function activityFilter(criteria: EventQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (criteria.type !== undefined) {
    clauses.push('type = ?');
    params.push(criteria.type);
  }
  if (criteria.agentId !== undefined) {
    clauses.push('agent_id = ?');
    params.push(criteria.agentId);
  }
  if (criteria.backendId !== undefined) {
    clauses.push('backend_id = ?');
    params.push(criteria.backendId);
  }
  if (criteria.toolName !== undefined) {
    clauses.push('tool_name = ?');
    params.push(criteria.toolName);
  }
  if (criteria.outcome !== undefined) {
    clauses.push('outcome = ?');
    params.push(criteria.outcome);
  }
  if (criteria.after !== undefined) {
    clauses.push('created_at >= ?');
    params.push(criteria.after);
  }
  if (criteria.before !== undefined) {
    clauses.push('created_at <= ?');
    params.push(criteria.before);
  }
  if (criteria.search !== undefined) {
    const pattern = `%${escapeLike(criteria.search)}%`;
    clauses.push("(tool_name LIKE ? ESCAPE '\\' OR request_id LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }

  return { where: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, params };
}

function groupedCounts(database: SqliteDatabase, table: 'activity_events' | 'audit_events', column: 'type' | 'outcome' | 'result' | 'actor_type'): Record<string, number> {
  const rows = database.prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all() as Array<{
    key: string;
    count: number;
  }>;

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.key] = row.count;
  return counts;
}

/** `%`, `_`, and the escape character are literal in a search term, not wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

interface AuditRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  result: string;
  request_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

function toAudit(row: AuditRow): AuditEvent {
  const metadata: unknown = row.metadata_json === null ? undefined : JSON.parse(row.metadata_json);

  return parseStored(
    () =>
      auditEventSchema.parse({
        id: row.id,
        actorType: row.actor_type,
        ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
        action: row.action,
        ...(row.target_type === null ? {} : { targetType: row.target_type }),
        ...(row.target_id === null ? {} : { targetId: row.target_id }),
        result: row.result,
        ...(row.request_id === null ? {} : { requestId: row.request_id }),
        ...(metadata === undefined ? {} : { metadata }),
        createdAt: row.created_at,
      }),
    { auditId: row.id },
  );
}

/** The rendered list view: metadata stays out of collection responses. */
function toAuditListItem(row: AuditRow): AuditListItem {
  return {
    id: row.id,
    actorType: row.actor_type as AuditListItem['actorType'],
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    action: row.action as AuditListItem['action'],
    ...(row.target_type === null ? {} : { targetType: row.target_type as AuditListItem['targetType'] }),
    ...(row.target_id === null ? {} : { targetId: row.target_id }),
    result: row.result as AuditListItem['result'],
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    createdAt: row.created_at,
  };
}

export class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly database: SqliteDatabase) {}

  append(event: AuditEvent): AuditEvent {
    const parsed = auditEventSchema.parse(event);

    try {
      this.database
        .prepare(
          `INSERT INTO audit_events (id, actor_type, actor_id, action, target_type, target_id, result,
             request_id, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.actorType,
          parsed.actorId ?? null,
          parsed.action,
          parsed.targetType ?? null,
          parsed.targetId ?? null,
          parsed.result,
          parsed.requestId ?? null,
          parsed.metadata === undefined ? null : JSON.stringify(parsed.metadata),
          parsed.createdAt,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'audit_events.append' });
    }

    return parsed;
  }

  list(limit: number): AuditEvent[] {
    const rows = this.database
      .prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?')
      .all(limit) as AuditRow[];

    return rows.map(toAudit);
  }

  findById(id: string): AuditEvent | undefined {
    const row = this.database.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) as AuditRow | undefined;
    return row === undefined ? undefined : toAudit(row);
  }

  query(criteria: AuditQuery): EventPage<AuditListItem> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (criteria.action !== undefined) {
      clauses.push('action = ?');
      params.push(criteria.action);
    }
    if (criteria.actorType !== undefined) {
      clauses.push('actor_type = ?');
      params.push(criteria.actorType);
    }
    if (criteria.actorId !== undefined) {
      clauses.push('actor_id = ?');
      params.push(criteria.actorId);
    }
    if (criteria.targetType !== undefined) {
      clauses.push('target_type = ?');
      params.push(criteria.targetType);
    }
    if (criteria.targetId !== undefined) {
      clauses.push('target_id = ?');
      params.push(criteria.targetId);
    }
    if (criteria.result !== undefined) {
      clauses.push('result = ?');
      params.push(criteria.result);
    }
    if (criteria.after !== undefined) {
      clauses.push('created_at >= ?');
      params.push(criteria.after);
    }
    if (criteria.before !== undefined) {
      clauses.push('created_at <= ?');
      params.push(criteria.before);
    }
    if (criteria.search !== undefined) {
      const pattern = `%${escapeLike(criteria.search)}%`;
      clauses.push("(target_id LIKE ? ESCAPE '\\' OR request_id LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }

    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const direction = criteria.order === 'asc' ? 'ASC' : 'DESC';

    const total = (
      this.database.prepare(`SELECT COUNT(*) AS count FROM audit_events ${where}`).get(...params) as { count: number }
    ).count;

    const rows = this.database
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY created_at ${direction}, id ${direction} LIMIT ? OFFSET ?`)
      .all(...params, criteria.limit, criteria.offset) as AuditRow[];

    return { items: rows.map(toAuditListItem), total };
  }

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number };
    return row.count;
  }

  countByResult(): Record<string, number> {
    return groupedCounts(this.database, 'audit_events', 'result');
  }

  countByActorType(): Record<string, number> {
    return groupedCounts(this.database, 'audit_events', 'actor_type');
  }
}

interface SessionRow {
  id: string;
  mcp_session_id: string | null;
  agent_id: string;
  credential_id: string | null;
  status: string;
  created_at: string;
  last_activity_at: string;
  expires_at: string | null;
  terminated_at: string | null;
  termination_reason: string | null;
  metadata_json: string | null;
}

/**
 * Effective status for a stored row: a terminal status wins, otherwise a lapsed
 * hard cap reads as expired. Same precedence as the domain's `sessionStatus()`,
 * expressed on columns so it can also be used inside a query.
 */
function sessionStatus(stored: SessionStatus, expiresAt: string | null, nowMs: number): SessionStatus {
  if (stored !== 'active') return stored;
  if (expiresAt !== null && Date.parse(expiresAt) <= nowMs) return 'expired';
  return 'active';
}

function toSession(row: SessionRow): Session {
  const metadata: unknown = row.metadata_json === null ? undefined : JSON.parse(row.metadata_json);

  return parseStored(
    () =>
      sessionSchema.parse({
        id: row.id,
        ...(row.mcp_session_id === null ? {} : { mcpSessionId: row.mcp_session_id }),
        agentId: row.agent_id,
        ...(row.credential_id === null ? {} : { credentialId: row.credential_id }),
        // A finished status is authoritative (a revocation or an operator's
        // decision cannot be undone by a clock), while a lapsed lifetime is
        // reported as expired even before the sweep has written it back.
        status: sessionStatus(sessionStatusSchema.parse(row.status), row.expires_at, Date.now()),
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        ...(row.terminated_at === null ? {} : { terminatedAt: row.terminated_at }),
        ...(row.termination_reason === null
          ? {}
          : { terminationReason: sessionTerminationReasonSchema.parse(row.termination_reason) }),
        ...(metadata === undefined ? {} : { metadata }),
      }),
    { sessionId: row.id },
  );
}

/** Column list shared by every session read, in one place so it cannot drift. */
const SESSION_COLUMNS =
  'id, mcp_session_id, agent_id, credential_id, status, created_at, last_activity_at, expires_at, terminated_at, termination_reason, metadata_json';

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(session: Session): Session {
    const parsed = sessionSchema.parse(session);

    try {
      this.database
        .prepare(
          `INSERT INTO sessions (id, mcp_session_id, agent_id, credential_id, status, created_at, last_activity_at,
             expires_at, terminated_at, termination_reason, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.mcpSessionId ?? null,
          parsed.agentId,
          parsed.credentialId ?? null,
          parsed.status,
          parsed.createdAt,
          parsed.lastActivityAt,
          parsed.expiresAt ?? null,
          parsed.terminatedAt ?? null,
          parsed.terminationReason ?? null,
          parsed.metadata === undefined ? null : JSON.stringify(parsed.metadata),
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'sessions.create' });
    }

    const created = this.findById(parsed.id);
    if (created === undefined) {
      throw new AppError('DATABASE_ERROR', 'The session was written but could not be read back.', {
        details: { sessionId: parsed.id },
      });
    }

    return created;
  }

  findById(id: string): Session | undefined {
    const row = this.database
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  findByMcpSessionId(mcpSessionId: string): Session | undefined {
    const row = this.database
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE mcp_session_id = ?`)
      .get(mcpSessionId) as SessionRow | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  listByAgentId(agentId: string): Session[] {
    const rows = this.database
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE agent_id = ? ORDER BY created_at DESC`)
      .all(agentId) as SessionRow[];

    return rows.map(toSession);
  }

  query(criteria: SessionQuery): SessionPage {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (criteria.agentId !== undefined) {
      clauses.push('agent_id = ?');
      params.push(criteria.agentId);
    }
    if (criteria.status !== undefined) {
      // Filter on the effective status, so an operator searching for expired
      // sessions sees the ones whose lifetime lapsed but which the sweep has not
      // written back yet. Two lifetimes, both derived: the stored hard cap and
      // the idle deadline (which is why `idleCutoff` is supplied rather than
      // stored).
      const now = criteria.now ?? new Date().toISOString();
      const lapsed = "(expires_at IS NOT NULL AND expires_at <= ?)";
      const idle = criteria.idleCutoff === undefined ? '0' : '(last_activity_at <= ?)';

      if (criteria.status === 'expired') {
        clauses.push(`(status = 'expired' OR (status = 'active' AND (${lapsed} OR ${idle})))`);
        params.push(now, ...(criteria.idleCutoff === undefined ? [] : [criteria.idleCutoff]));
      } else if (criteria.status === 'active') {
        clauses.push(`(status = 'active' AND NOT ${lapsed} AND NOT ${idle})`);
        params.push(now, ...(criteria.idleCutoff === undefined ? [] : [criteria.idleCutoff]));
      } else {
        clauses.push('status = ?');
        params.push(criteria.status);
      }
    }
    if (criteria.createdAfter !== undefined) {
      clauses.push('created_at >= ?');
      params.push(criteria.createdAfter);
    }
    if (criteria.createdBefore !== undefined) {
      clauses.push('created_at <= ?');
      params.push(criteria.createdBefore);
    }
    if (criteria.lastActivityAfter !== undefined) {
      clauses.push('last_activity_at >= ?');
      params.push(criteria.lastActivityAfter);
    }

    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const sortColumn = criteria.sort === 'createdAt' ? 'created_at' : 'last_activity_at';
    const direction = criteria.order === 'asc' ? 'ASC' : 'DESC';

    const totalRow = this.database
      .prepare(`SELECT COUNT(*) AS count FROM sessions ${where}`)
      .get(...params) as { count: number };

    const rows = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions ${where} ORDER BY ${sortColumn} ${direction}, id ${direction} LIMIT ? OFFSET ?`,
      )
      .all(...params, criteria.limit, criteria.offset) as SessionRow[];

    return { items: rows.map(toSession), total: totalRow.count };
  }

  touch(id: string, now: string): void {
    // Only an active session moves its clock. Touching a finished one would be a
    // write that changes nothing usable, and the guard keeps the row honest.
    this.database.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ? AND status = 'active'").run(now, id);
  }

  end(
    id: string,
    now: string,
    status: 'expired' | 'terminated' | 'invalidated',
    reason: SessionTerminationReason,
  ): Session {
    // Conditional on the current state, so a concurrent end cannot overwrite the
    // first reason (and a repeated termination is a no-op, which is the
    // idempotency the API promises).
    this.database
      .prepare(
        "UPDATE sessions SET status = ?, terminated_at = ?, termination_reason = ? WHERE id = ? AND status = 'active'",
      )
      .run(status, now, reason, id);

    const session = this.findById(id);
    if (session === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested session does not exist.', {
        details: { sessionId: id },
      });
    }

    return session;
  }

  endWhere(
    filter: { agentId?: string; credentialId?: string; ids?: string[] },
    now: string,
    status: 'expired' | 'terminated' | 'invalidated',
    reason: SessionTerminationReason,
  ): Session[] {
    const clauses = ["status = 'active'"];
    const params: unknown[] = [];

    if (filter.agentId !== undefined) {
      clauses.push('agent_id = ?');
      params.push(filter.agentId);
    }
    if (filter.credentialId !== undefined) {
      clauses.push('credential_id = ?');
      params.push(filter.credentialId);
    }
    if (filter.ids !== undefined) {
      if (filter.ids.length === 0) return [];
      clauses.push(`id IN (${filter.ids.map(() => '?').join(', ')})`);
      params.push(...filter.ids);
    }

    // An empty filter would end every session in the database; refuse instead of
    // turning a caller's bug into a mass logout.
    if (params.length === 0) return [];

    // RETURNING so the caller knows exactly which sessions it ended — needed to
    // release their transports and to audit each one.
    const rows = this.database
      .prepare(
        `UPDATE sessions SET status = ?, terminated_at = ?, termination_reason = ? WHERE ${clauses.join(' AND ')}
         RETURNING ${SESSION_COLUMNS}`,
      )
      .all(status, now, reason, ...params) as SessionRow[];

    return rows.map(toSession);
  }

  expire(now: string, idleCutoff: string): Session[] {
    // Two independent lifetime rules, one statement each, so a row is ended by
    // whichever fired and never by both. `terminated_at` is written once because
    // the second statement only sees rows that are still active.
    const idle = this.database
      .prepare(
        `UPDATE sessions SET status = 'expired', terminated_at = ?, termination_reason = 'idle_timeout'
          WHERE status = 'active' AND last_activity_at <= ?
          RETURNING ${SESSION_COLUMNS}`,
      )
      .all(now, idleCutoff) as SessionRow[];

    const lifetime = this.database
      .prepare(
        `UPDATE sessions SET status = 'expired', terminated_at = ?, termination_reason = 'max_lifetime'
          WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
          RETURNING ${SESSION_COLUMNS}`,
      )
      .all(now, now) as SessionRow[];

    return [...idle, ...lifetime].map(toSession);
  }

  countByStatus(status: SessionStatus): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE status = ?').get(status) as {
      count: number;
    };
    return row.count;
  }

  counts(now: string, idleCutoff: string): Record<SessionStatus, number> {
    // One scan, not four. Both derived lifetimes are evaluated here so the
    // breakdown can never contradict `query()`'s effective-status filter.
    const row = this.database
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'terminated' THEN 1 ELSE 0 END) AS terminated,
           SUM(CASE WHEN status = 'invalidated' THEN 1 ELSE 0 END) AS invalidated,
           SUM(CASE WHEN status = 'expired'
                     OR (status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?)
                     OR (status = 'active' AND last_activity_at <= ?) THEN 1 ELSE 0 END) AS expired,
           SUM(CASE WHEN status = 'active' AND (expires_at IS NULL OR expires_at > ?)
                     AND last_activity_at > ? THEN 1 ELSE 0 END) AS active
         FROM sessions`,
      )
      .get(now, idleCutoff, now, idleCutoff) as Record<string, number | null>;

    return {
      active: row['active'] ?? 0,
      expired: row['expired'] ?? 0,
      terminated: row['terminated'] ?? 0,
      invalidated: row['invalidated'] ?? 0,
    };
  }

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
    return row.count;
  }
}
