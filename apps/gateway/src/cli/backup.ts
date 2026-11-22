import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import type { Database as Store } from '../infrastructure/database/index.js';

/**
 * Backup and restore primitives (Phase 18, Stage B).
 *
 * Importable library: the executable entry points are `backup-main.ts` and
 * `restore-main.ts`, which own config loading and exit codes. The same split as
 * `operator-bootstrap.ts` (importable) versus `operator-create.ts`
 * (executable) keeps test imports from ever running a CLI `main()`.
 *
 * Every property here is a deliberate choice, mirroring `operator:create`:
 *
 *  * **`VACUUM INTO`, never a file copy.** A live WAL database keeps committed
 *    content in `gateway.db-wal`; copying `gateway.db` alone loses it, and
 *    copying while writing can produce a torn page. `VACUUM INTO` takes a
 *    consistent snapshot through the connection instead, and writes it as a
 *    compacted single file in rollback-journal mode (docs/DATABASE.md §9 names
 *    `.backup` and `VACUUM INTO` as the two SQLite-safe mechanisms).
 *  * **Verified before it is called a backup.** The destination is reopened
 *    read-only and integrity-checked; an unreadable result is deleted, not
 *    left behind pretending to be a backup.
 *  * **Atomic finalize.** The snapshot lands in a temp file and is renamed into
 *    place only after verification, so no half-written file ever bears the
 *    final name.
 *  * **No overwrite, mode 0600.** `VACUUM INTO` itself refuses an existing
 *    output; an explicit destination that already exists is refused up front.
 *
 * The backup contains sealed integration credentials as inert ciphertext: a
 * backup without `INTEGRATION_MASTER_KEY` cannot leak them, and cannot restore
 * them either (SECURITY §6.4).
 */

/** What a verified database file looks like from the outside. */
export interface DatabaseVerification {
  /** Every version row in the migration ledger, in applied order. */
  migrationVersions: string[];
}

/**
 * Opens a database file read-only and proves it is a sound gateway database:
 * SQLite's own integrity check passes and the migration ledger is readable.
 *
 * Throws (does not return a failure object) because every caller treats an
 * unverifiable database as an error path. Never writes, never checkpoints.
 */
export function verifyDatabaseFile(path: string): DatabaseVerification {
  const database = new Database(path, { readonly: true });
  try {
    const check = database.pragma('quick_check') as Array<{ quick_check: string }>;
    if (check.length !== 1 || check[0].quick_check !== 'ok') {
      throw new Error(`Integrity check failed for ${path}.`);
    }

    const ledger = database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => (row as { version: string }).version);

    return { migrationVersions: ledger };
  } finally {
    database.close();
  }
}

/** Collision-safe default: next to the live database, one directory deeper. */
export function defaultBackupDestination(databasePath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(dirname(databasePath), 'backups', `gateway-${stamp}.db`);
}

export interface BackupResult {
  /** The finalized backup file. */
  path: string;
  /** Ledger versions captured in the backup, reported so the operator can see them. */
  migrationVersions: string[];
}

/**
 * Creates a verified backup of an open store at `destination`.
 *
 * The store stays usable throughout; `VACUUM INTO` reads a consistent snapshot
 * under the connection, WAL content included. Synchronous by design: the
 * snapshot is one SQLite statement, and a CLI has nothing to do while it runs.
 * Fails without side effects besides a deleted temp file.
 */
export function createBackup(store: Store, destination: string): BackupResult {
  const finalPath = isAbsolute(destination) ? destination : resolve(destination);
  if (existsSync(finalPath)) {
    throw new Error(`Refusing to overwrite: ${finalPath} already exists.`);
  }

  mkdirSync(dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.tmp`;
  let verified: DatabaseVerification;
  try {
    // A leftover temp from a crashed run must not make the next run fail on
    // `VACUUM INTO`'s no-overwrite rule.
    rmSync(tempPath, { force: true });
    store.handle.prepare('VACUUM INTO ?').run(tempPath);
    verified = verifyDatabaseFile(tempPath);
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, finalPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }

  return { path: finalPath, migrationVersions: verified.migrationVersions };
}
