import { randomUUID } from 'node:crypto';

import type {
  CreateOperatorInput,
  OperatorRepository,
} from '../../../domain/repositories.js';
import type { Operator, OperatorSession, OperatorSessionRevocationReason } from '../../../domain/operator.js';
import { operatorSchema, operatorSessionSchema } from '../../../domain/operator.js';
import type { SqliteDatabase } from '../connection.js';
import { parseStored, wrapDatabaseError } from './helpers.js';

/**
 * SQLite operator identity and dashboard sessions.
 *
 * Two rules this file keeps, both from ADR-045:
 *
 *  * **Every state change is one conditional statement.** "Still live" lives in
 *    the `WHERE`, so a read-then-write race cannot resurrect a session or
 *    overwrite a logout. `better-sqlite3` is synchronous on one handle, so this
 *    is sufficient without a mutex.
 *  * **Only digests are stored or queried.** `token_hash` is the lookup key, so
 *    a raw token never reaches this layer at all.
 */

interface OperatorRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  role: string;
  enabled: number;
  password_changed_at: string | null;
  last_login_at: string | null;
  failed_login_attempts: number;
  locked_until: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  operator_id: string;
  token_hash: string;
  hash_key_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  user_agent: string | null;
  ip_address: string | null;
}

function toOperator(row: OperatorRow): Operator {
  return parseStored(
    () =>
      operatorSchema.parse({
        id: row.id,
        username: row.username,
        ...(row.display_name === null ? {} : { displayName: row.display_name }),
        passwordHash: row.password_hash,
        role: row.role,
        enabled: row.enabled === 1,
        ...(row.password_changed_at === null ? {} : { passwordChangedAt: row.password_changed_at }),
        ...(row.last_login_at === null ? {} : { lastLoginAt: row.last_login_at }),
        failedLoginAttempts: row.failed_login_attempts,
        ...(row.locked_until === null ? {} : { lockedUntil: row.locked_until }),
        ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    { operation: 'admin_users.parse', id: row.id },
  );
}

function toSession(row: SessionRow): OperatorSession {
  return parseStored(
    () =>
      operatorSessionSchema.parse({
        id: row.id,
        operatorId: row.operator_id,
        tokenHash: row.token_hash,
        hashKeyId: row.hash_key_id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
        ...(row.revocation_reason === null ? {} : { revocationReason: row.revocation_reason }),
        ...(row.user_agent === null ? {} : { userAgent: row.user_agent }),
        ...(row.ip_address === null ? {} : { ipAddress: row.ip_address }),
      }),
    { operation: 'operator_sessions.parse', id: row.id },
  );
}

export class SqliteOperatorRepository implements OperatorRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(input: CreateOperatorInput, now: string): Operator {
    const row: OperatorRow = {
      id: randomUUID(),
      username: input.username,
      display_name: input.displayName ?? null,
      password_hash: input.passwordHash,
      role: input.role ?? 'owner',
      enabled: 1,
      password_changed_at: now,
      last_login_at: null,
      failed_login_attempts: 0,
      locked_until: null,
      disabled_at: null,
      created_at: now,
      updated_at: now,
    };

    try {
      this.database
        .prepare(
          `INSERT INTO admin_users (id, username, display_name, password_hash, role, enabled,
             password_changed_at, last_login_at, failed_login_attempts, locked_until, disabled_at,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.username,
          row.display_name,
          row.password_hash,
          row.role,
          row.enabled,
          row.password_changed_at,
          row.last_login_at,
          row.failed_login_attempts,
          row.locked_until,
          row.disabled_at,
          row.created_at,
          row.updated_at,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'admin_users.create', username: input.username });
    }

    return toOperator(row);
  }

  findById(id: string): Operator | undefined {
    const row = this.database.prepare('SELECT * FROM admin_users WHERE id = ?').get(id) as
      | OperatorRow
      | undefined;
    return row === undefined ? undefined : toOperator(row);
  }

  /**
   * Case-insensitive match. `COLLATE NOCASE` applies to the comparison, while the
   * stored value keeps the operator's own capitalisation, so display is
   * unaffected. The UNIQUE index on `username` is case-*sensitive* by default,
   * which means `Alice` and `alice` could both be inserted; the count check in
   * `OperatorService.createOperator` closes that by asking this same lookup.
   */
  findByUsername(username: string): Operator | undefined {
    const row = this.database
      .prepare('SELECT * FROM admin_users WHERE username = ? COLLATE NOCASE')
      .get(username) as OperatorRow | undefined;
    return row === undefined ? undefined : toOperator(row);
  }

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM admin_users').get() as {
      count: number;
    };
    return row.count;
  }

  list(): Operator[] {
    const rows = this.database
      .prepare('SELECT * FROM admin_users ORDER BY created_at ASC')
      .all() as OperatorRow[];
    return rows.map(toOperator);
  }

  setPassword(id: string, passwordHash: string, now: string): Operator {
    this.database
      .prepare(
        `UPDATE admin_users
            SET password_hash = ?, password_changed_at = ?, failed_login_attempts = 0,
                locked_until = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(passwordHash, now, now, id);

    return this.requireById(id);
  }

  recordLoginSuccess(id: string, now: string): Operator {
    this.database
      .prepare(
        `UPDATE admin_users
            SET last_login_at = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, now, id);

    return this.requireById(id);
  }

  recordLoginFailure(id: string, now: string, lockUntil: string | undefined): Operator {
    this.database
      .prepare(
        `UPDATE admin_users
            SET failed_login_attempts = failed_login_attempts + 1,
                locked_until = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(lockUntil ?? null, now, id);

    return this.requireById(id);
  }

  disable(id: string, now: string): Operator {
    this.database
      .prepare(
        `UPDATE admin_users
            SET enabled = 0, disabled_at = COALESCE(disabled_at, ?), updated_at = ?
          WHERE id = ?`,
      )
      .run(now, now, id);

    return this.requireById(id);
  }

  createSession(session: OperatorSession): OperatorSession {
    try {
      this.database
        .prepare(
          `INSERT INTO operator_sessions (id, operator_id, token_hash, hash_key_id, created_at,
             last_seen_at, expires_at, revoked_at, revocation_reason, user_agent, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.id,
          session.operatorId,
          session.tokenHash,
          session.hashKeyId,
          session.createdAt,
          session.lastSeenAt,
          session.expiresAt,
          session.revokedAt ?? null,
          session.revocationReason ?? null,
          session.userAgent ?? null,
          session.ipAddress ?? null,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'operator_sessions.create' });
    }

    return session;
  }

  findSessionById(id: string): OperatorSession | undefined {
    const row = this.database.prepare('SELECT * FROM operator_sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  findSessionByTokenHash(tokenHash: string): OperatorSession | undefined {
    const row = this.database
      .prepare('SELECT * FROM operator_sessions WHERE token_hash = ?')
      .get(tokenHash) as SessionRow | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  /** Only a live row is touched: a logged-out session must not have its clock moved. */
  touchSession(id: string, now: string): void {
    this.database
      .prepare('UPDATE operator_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now, id);
  }

  revokeSession(id: string, now: string, reason: OperatorSessionRevocationReason): OperatorSession {
    this.database
      .prepare(
        `UPDATE operator_sessions
            SET revoked_at = ?, revocation_reason = ?
          WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(now, reason, id);

    const row = this.database.prepare('SELECT * FROM operator_sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;

    if (row === undefined) {
      throw new Error(`operator session ${id} does not exist`);
    }

    return toSession(row);
  }

  revokeSessionsForOperator(
    operatorId: string,
    now: string,
    reason: OperatorSessionRevocationReason,
  ): OperatorSession[] {
    const ids = (
      this.database
        .prepare('SELECT id FROM operator_sessions WHERE operator_id = ? AND revoked_at IS NULL')
        .all(operatorId) as Array<{ id: string }>
    ).map((row) => row.id);

    if (ids.length === 0) return [];

    this.database
      .prepare(
        `UPDATE operator_sessions
            SET revoked_at = ?, revocation_reason = ?
          WHERE operator_id = ? AND revoked_at IS NULL`,
      )
      .run(now, reason, operatorId);

    return ids
      .map((id) => this.findSessionById(id))
      .filter((session): session is OperatorSession => session !== undefined);
  }

  /**
   * Marks usable sessions that have passed either deadline. Status is derived,
   * but the row is written so the audit trail says *when* access ended rather
   * than leaving a row that looks live forever.
   */
  expireSessions(now: string, idleCutoff: string): OperatorSession[] {
    const ids = (
      this.database
        .prepare(
          `SELECT id FROM operator_sessions
            WHERE revoked_at IS NULL AND (expires_at <= ? OR last_seen_at <= ?)`,
        )
        .all(now, idleCutoff) as Array<{ id: string }>
    ).map((row) => row.id);

    if (ids.length === 0) return [];

    this.database
      .prepare(
        `UPDATE operator_sessions
            SET revoked_at = ?, revocation_reason = 'cleanup'
          WHERE revoked_at IS NULL AND (expires_at <= ? OR last_seen_at <= ?)`,
      )
      .run(now, now, idleCutoff);

    return ids
      .map((id) => this.findSessionById(id))
      .filter((session): session is OperatorSession => session !== undefined);
  }

  countActiveSessions(operatorId: string, now: string, idleCutoff: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM operator_sessions
          WHERE operator_id = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?`,
      )
      .get(operatorId, now, idleCutoff) as { count: number };
    return row.count;
  }

  private requireById(id: string): Operator {
    const operator = this.findById(id);
    if (operator === undefined) throw new Error(`operator ${id} does not exist`);
    return operator;
  }
}
