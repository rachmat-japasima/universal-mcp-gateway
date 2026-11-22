import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { AppError } from '../../shared/errors.js';

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  /** File path, or `:memory:` for tests. */
  path: string;
  /** In-memory databases cannot use WAL; enable it only for files. Default `true`. */
  wal?: boolean;
}

/**
 * Opens the SQLite database with the durability and safety settings the schema
 * relies on.
 *
 * `foreign_keys` is per-connection in SQLite, not persisted in the file, so it
 * must be set on every open — forgetting it silently disables every FK.
 */
export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const { path, wal = path !== ':memory:' } = options;

  if (path !== ':memory:') {
    const directory = dirname(isAbsolute(path) ? path : resolve(path));
    try {
      mkdirSync(directory, { recursive: true });
    } catch (error) {
      throw new AppError('CONFIGURATION_ERROR', 'Cannot create the database directory.', {
        cause: error,
        details: { directory },
      });
    }

    if (existsSync(path) === false && !directoryWritable(directory)) {
      throw new AppError('CONFIGURATION_ERROR', 'Database directory is not writable.', { details: { directory } });
    }
  }

  const database = new Database(path);

  // `better-sqlite3` throws raw SQLite messages; wrap so a path or schema detail
  // never reaches a client.
  try {
    database.pragma('foreign_keys = ON');
    // WAL: readers never block the writer. FULL sync keeps durability at
    // commit, which matters because audit history must survive a crash.
    if (wal) database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('busy_timeout = 5000');
    // Fail instead of returning rows that break a CHECK constraint.
    database.pragma('trusted_schema = OFF');
  } catch (error) {
    database.close();
    throw new AppError('DATABASE_ERROR', 'Failed to configure the database connection.', { cause: error });
  }

  return database;
}

function directoryWritable(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Closes the database, tolerating an already-closed handle. */
export function closeDatabase(database: SqliteDatabase): void {
  if (database.open) database.close();
}
