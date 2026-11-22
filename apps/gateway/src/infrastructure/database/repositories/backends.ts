import { randomUUID } from 'node:crypto';

import type { Backend, CreateBackendInput, UpdateBackendInput } from '../../../domain/backend.js';
import { backendSchema, createBackendSchema, updateBackendSchema } from '../../../domain/backend.js';
import type { BackendRuntime } from '../../../domain/backend-runtime.js';
import { backendRuntimeSchema } from '../../../domain/backend-runtime.js';
import type { BackendPage, BackendQuery, BackendRepository, BackendRuntimeRepository } from '../../../domain/repositories.js';
import { AppError } from '../../../shared/errors.js';
import type { SqliteDatabase } from '../connection.js';
import { parseStored, wrapDatabaseError } from './helpers.js';

/** Deletion is a tombstone so activity/audit rows keep a valid reference. */
const ACTIVE_BACKEND = 'deleted_at IS NULL';

/** Whitelist: a sort field is interpolated into SQL, so it must never come from a client verbatim. */
const SORT_COLUMNS = {
  name: 'name',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

interface BackendRow {
  id: string;
  name: string;
  description: string | null;
  transport: string;
  config_json: string;
  enabled: number;
  timeout_ms: number;
  concurrency_mode: string;
  concurrency_limit: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Transport-specific config lives in `config_json`; the transport itself has a column. */
function splitConnection(connection: Backend['connection']): { transport: string; config: Record<string, unknown> } {
  const { type, ...rest } = connection;
  return { transport: type, config: rest };
}

function toBackend(row: BackendRow): Backend {
  const connection: unknown = JSON.parse(row.config_json);

  return parseStored(
    () =>
      backendSchema.parse({
        id: row.id,
        name: row.name,
        ...(row.description === null ? {} : { description: row.description }),
        connection: { ...(connection as Record<string, unknown>), type: row.transport },
        enabled: row.enabled === 1,
        timeoutMs: row.timeout_ms,
        concurrencyMode: row.concurrency_mode,
        ...(row.concurrency_limit === null ? {} : { concurrencyLimit: row.concurrency_limit }),
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    { backendId: row.id },
  );
}

export class SqliteBackendRepository implements BackendRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(input: CreateBackendInput, now: string): Backend {
    const parsed = createBackendSchema.parse(input);
    const { transport, config } = splitConnection(parsed.connection);
    const id = randomUUID();

    try {
      this.database
        .prepare(
          `INSERT INTO backends (id, name, description, transport, config_json, enabled, timeout_ms,
             concurrency_mode, concurrency_limit, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parsed.name,
          parsed.description ?? null,
          transport,
          JSON.stringify(config),
          parsed.enabled ? 1 : 0,
          parsed.timeoutMs,
          parsed.concurrencyMode,
          parsed.concurrencyLimit ?? null,
          now,
          now,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'backends.create' });
    }

    return this.requireById(id, 'The backend was written but could not be read back.');
  }

  findById(id: string): Backend | undefined {
    const row = this.database
      .prepare(`SELECT * FROM backends WHERE id = ? AND ${ACTIVE_BACKEND}`)
      .get(id) as BackendRow | undefined;

    return row === undefined ? undefined : toBackend(row);
  }

  findByName(name: string): Backend | undefined {
    const row = this.database
      .prepare(`SELECT * FROM backends WHERE name = ? AND ${ACTIVE_BACKEND}`)
      .get(name) as BackendRow | undefined;

    return row === undefined ? undefined : toBackend(row);
  }

  list(): Backend[] {
    const rows = this.database
      .prepare(`SELECT * FROM backends WHERE ${ACTIVE_BACKEND} ORDER BY name`)
      .all() as BackendRow[];

    return rows.map(toBackend);
  }

  /**
   * Filtered, sorted, paginated listing.
   *
   * Every value is bound; only the sort column and direction are interpolated,
   * from a fixed whitelist, because SQLite cannot parameterise identifiers.
   * `total` counts all matches before LIMIT so the client can page safely.
   */
  query(criteria: BackendQuery): BackendPage {
    const conditions: string[] = [ACTIVE_BACKEND];
    const parameters: Array<string | number> = [];

    if (criteria.search !== undefined) {
      // `instr` is a plain substring match; `LIKE` would make user-supplied `%`
      // and `_` act as wildcards. Names and descriptions are already trimmed.
      conditions.push('(instr(lower(name), lower(?)) > 0 OR instr(lower(coalesce(description, \'\')), lower(?)) > 0)');
      parameters.push(criteria.search, criteria.search);
    }

    if (criteria.transport !== undefined) {
      conditions.push('transport = ?');
      parameters.push(criteria.transport);
    }

    if (criteria.enabled !== undefined) {
      conditions.push('enabled = ?');
      parameters.push(criteria.enabled ? 1 : 0);
    }

    const where = conditions.join(' AND ');
    const direction = criteria.order === 'asc' ? 'ASC' : 'DESC';
    // Tie-break on id so equal names/timestamps never produce unstable pages.
    const orderBy = `ORDER BY ${SORT_COLUMNS[criteria.sort]} ${direction}, id ${direction}`;

    const totalRow = this.database
      .prepare(`SELECT COUNT(*) AS count FROM backends WHERE ${where}`)
      .get(...parameters) as { count: number };

    const rows = this.database
      .prepare(`SELECT * FROM backends WHERE ${where} ${orderBy} LIMIT ? OFFSET ?`)
      .all(...parameters, criteria.limit, criteria.offset) as BackendRow[];

    return { items: rows.map(toBackend), total: totalRow.count };
  }

  update(id: string, input: UpdateBackendInput, now: string, expectedVersion?: number): Backend {
    const parsed = updateBackendSchema.parse(input);
    const existing = this.findById(id);
    if (existing === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested backend does not exist.', {
        details: { backendId: id },
      });
    }

    const { transport, config } = splitConnection(parsed.connection ?? existing.connection);

    // `undefined` leaves a field untouched; `null` clears it.
    const description = parsed.description === undefined ? existing.description : parsed.description;
    const concurrencyMode = parsed.concurrencyMode ?? existing.concurrencyMode;
    const concurrencyLimit =
      parsed.concurrencyLimit === undefined ? existing.concurrencyLimit : (parsed.concurrencyLimit ?? undefined);

    // Compare-and-set in the WHERE clause: the check and the write are one
    // statement, so no other writer can slip between them.
    const guard = expectedVersion === undefined ? '' : ' AND version = ?';
    const parameters: Array<string | number | null> = [
      parsed.name ?? existing.name,
      description ?? null,
      transport,
      JSON.stringify(config),
      (parsed.enabled ?? existing.enabled) ? 1 : 0,
      parsed.timeoutMs ?? existing.timeoutMs,
      concurrencyMode,
      concurrencyLimit ?? null,
      now,
      id,
    ];
    if (expectedVersion !== undefined) parameters.push(expectedVersion);

    let changes: number;
    try {
      changes = this.database
        .prepare(
          `UPDATE backends
              SET name = ?, description = ?, transport = ?, config_json = ?, enabled = ?,
                  timeout_ms = ?, concurrency_mode = ?, concurrency_limit = ?, updated_at = ?,
                  version = version + 1
            WHERE id = ? AND ${ACTIVE_BACKEND}${guard}`,
        )
        .run(...parameters).changes;
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'backends.update', backendId: id });
    }

    if (changes === 0) {
      // The row exists (checked above), so the only way to reach here is a
      // version mismatch: another writer committed first.
      throw new AppError('RESOURCE_CONFLICT', 'The backend was modified by another request. Reload and retry.', {
        details: { backendId: id, expectedVersion: expectedVersion ?? null },
      });
    }

    return this.requireById(id, 'The backend was updated but could not be read back.');
  }

  softDelete(id: string, now: string): void {
    const result = this.database
      .prepare(`UPDATE backends SET deleted_at = ?, updated_at = ? WHERE id = ? AND ${ACTIVE_BACKEND}`)
      .run(now, now, id);

    if (result.changes === 0) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested backend does not exist.', { details: { backendId: id } });
    }
  }

  countActive(): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM backends WHERE ${ACTIVE_BACKEND}`).get() as {
      count: number;
    };
    return row.count;
  }

  /** Enabled/disabled split for the overview. One statement; tombstones excluded. */
  counts(): { total: number; enabled: number; disabled: number } {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled,
                COALESCE(SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END), 0) AS disabled
           FROM backends WHERE ${ACTIVE_BACKEND}`,
      )
      .get() as { total: number; enabled: number; disabled: number };
    return row;
  }

  private requireById(id: string, message: string): Backend {
    const backend = this.findById(id);
    if (backend === undefined) {
      throw new AppError('DATABASE_ERROR', message, { details: { backendId: id } });
    }
    return backend;
  }
}

interface RuntimeRow {
  backend_id: string;
  status: string;
  last_connected_at: string | null;
  last_health_check_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
  reconnect_attempts: number;
  updated_at: string;
}

export class SqliteBackendRuntimeRepository implements BackendRuntimeRepository {
  constructor(private readonly database: SqliteDatabase) {}

  upsert(runtime: BackendRuntime): BackendRuntime {
    const parsed = backendRuntimeSchema.parse(runtime);

    try {
      this.database
        .prepare(
          `INSERT INTO backend_runtime (backend_id, status, last_connected_at, last_health_check_at,
             last_error_code, last_error_at, last_error_message, reconnect_attempts, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (backend_id) DO UPDATE SET
             status = excluded.status,
             last_connected_at = excluded.last_connected_at,
             last_health_check_at = excluded.last_health_check_at,
             last_error_code = excluded.last_error_code,
             last_error_at = excluded.last_error_at,
             last_error_message = excluded.last_error_message,
             reconnect_attempts = excluded.reconnect_attempts,
             updated_at = excluded.updated_at`,
        )
        .run(
          parsed.backendId,
          parsed.status,
          parsed.lastConnectedAt ?? null,
          parsed.lastHealthCheckAt ?? null,
          parsed.lastErrorCode ?? null,
          parsed.lastErrorAt ?? null,
          parsed.lastErrorMessage ?? null,
          parsed.reconnectAttempts,
          parsed.updatedAt,
        );
    } catch (error) {
      throw wrapDatabaseError(error, { operation: 'backend_runtime.upsert', backendId: parsed.backendId });
    }

    const stored = this.findByBackendId(parsed.backendId);
    if (stored === undefined) {
      throw new AppError('DATABASE_ERROR', 'The runtime state was written but could not be read back.', {
        details: { backendId: parsed.backendId },
      });
    }

    return stored;
  }

  findByBackendId(backendId: string): BackendRuntime | undefined {
    const row = this.database.prepare('SELECT * FROM backend_runtime WHERE backend_id = ?').get(backendId) as
      | RuntimeRow
      | undefined;

    if (row === undefined) return undefined;

    return parseStored(() => toRuntime(row), { backendId });
  }

  list(): BackendRuntime[] {
    const rows = this.database.prepare('SELECT * FROM backend_runtime ORDER BY backend_id').all() as RuntimeRow[];
    return rows.map((row) => parseStored(() => toRuntime(row), { backendId: row.backend_id }));
  }
}

function toRuntime(row: RuntimeRow): BackendRuntime {
  return backendRuntimeSchema.parse({
    backendId: row.backend_id,
    status: row.status,
    ...(row.last_connected_at === null ? {} : { lastConnectedAt: row.last_connected_at }),
    ...(row.last_health_check_at === null ? {} : { lastHealthCheckAt: row.last_health_check_at }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.last_error_at === null ? {} : { lastErrorAt: row.last_error_at }),
    ...(row.last_error_message === null ? {} : { lastErrorMessage: row.last_error_message }),
    reconnectAttempts: row.reconnect_attempts,
    updatedAt: row.updated_at,
  });
}
