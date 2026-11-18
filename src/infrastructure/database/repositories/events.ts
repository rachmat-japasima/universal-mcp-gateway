import type { ActivityEvent } from '../../../domain/activity-event.js';
import { activityEventSchema } from '../../../domain/activity-event.js';
import type { AuditEvent } from '../../../domain/audit-event.js';
import { auditEventSchema } from '../../../domain/audit-event.js';
import type { ActivityRepository, AuditRepository } from '../../../domain/repositories.js';
import type { Session } from '../../../domain/session.js';
import { sessionSchema } from '../../../domain/session.js';
import type { SessionRepository } from '../../../domain/repositories.js';
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
          `INSERT INTO activity_events (id, type, request_id, agent_id, backend_id, tool_name, outcome,
             error_code, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.type,
          parsed.requestId ?? null,
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

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM activity_events').get() as { count: number };
    return row.count;
  }
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

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number };
    return row.count;
  }
}

interface SessionRow {
  id: string;
  agent_id: string;
  created_at: string;
  last_activity_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  metadata_json: string | null;
}

function toSession(row: SessionRow): Session {
  const metadata: unknown = row.metadata_json === null ? undefined : JSON.parse(row.metadata_json);

  return parseStored(
    () =>
      sessionSchema.parse({
        id: row.id,
        agentId: row.agent_id,
        status: sessionStatusFromRow(row),
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
        ...(metadata === undefined ? {} : { metadata }),
      }),
    { sessionId: row.id },
  );
}

/** Mirrors `sessionStatus()` in the domain module; timestamps are the source of truth. */
function sessionStatusFromRow(row: SessionRow): Session['status'] {
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) return 'expired';
  return 'active';
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(session: Session): Session {
    const parsed = sessionSchema.parse(session);

    try {
      this.database
        .prepare(
          `INSERT INTO sessions (id, agent_id, created_at, last_activity_at, expires_at, revoked_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.agentId,
          parsed.createdAt,
          parsed.lastActivityAt,
          parsed.expiresAt ?? null,
          parsed.revokedAt ?? null,
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
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  listByAgentId(agentId: string): Session[] {
    const rows = this.database
      .prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY created_at DESC')
      .all(agentId) as SessionRow[];

    return rows.map(toSession);
  }

  revoke(id: string, now: string): Session {
    this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);

    const session = this.findById(id);
    if (session === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested session does not exist.', {
        details: { sessionId: id },
      });
    }

    return session;
  }

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
    return row.count;
  }
}
