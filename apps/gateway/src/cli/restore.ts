import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { loadMigrations } from '../infrastructure/database/migration-runner.js';
import { verifyDatabaseFile } from './backup.js';

/**
 * Restore primitive (Phase 18, Stage B). The executable entry is
 * `restore-main.ts`; this file stays importable by tests.
 *
 * Safety properties, each a deliberate choice:
 *
 *  * **A local CLI, never an HTTP endpoint.** Anyone who could reach a restore
 *    endpoint could overwrite the database with one of their own; the shell is
 *    the trust boundary, the same one that already guards `operator:create`.
 *  * **`--confirm` is required.** Restore discards the current database state;
 *    a typo must not be able to do that.
 *  * **The source is validated before anything moves.** Integrity check, a
 *    readable migration ledger, and no versions this build does not know — a
 *    backup from a newer gateway is refused instead of half-restored.
 *  * **The previous database is never deleted.** It is renamed aside before the
 *    backup is copied in, and restored to its place if any step fails.
 *  * **A WAL file at the target is a hard refusal.** A cleanly stopped gateway
 *    checkpoints and removes `gateway.db-wal` on close; a present WAL means a
 *    running process (stop it first) or a crashed one (start and stop once, or
 *    remove the stale WAL by hand). Restoring over a live WAL is the one way
 *    this command could silently not take effect, so it cannot proceed.
 *  * **Sealed credentials stay sealed.** If the `INTEGRATION_MASTER_KEY` in the
 *    environment is not the one used when the backup was taken, restored
 *    credentials are inert ciphertext; nothing in this command can fix that
 *    (SECURITY §6.4).
 */

export interface RestoreResult {
  /** The database file that was replaced. */
  target: string;
  /** Where the previous database was preserved, or `null` when none existed. */
  previousPath: string | null;
}

/** A deliberate refusal (missing --confirm, live WAL, incompatible backup). */
export class RestoreRefused extends Error {}

/**
 * Replaces `target` with the verified contents of `source`.
 *
 * Order of operations, so a failure at any step leaves the target either
 * untouched or back in its original place: validate source → guard live WAL →
 * rename target aside → copy source with `VACUUM INTO` → verify the copy →
 * finalize. `now` is injectable so tests can pin the preservation name.
 * Synchronous by design: each step is one filesystem or SQLite operation.
 */
export function restoreBackup(options: {
  source: string;
  target: string;
  confirm: boolean;
  now?: Date;
}): RestoreResult {
  const source = isAbsolute(options.source) ? options.source : resolve(options.source);
  const target = isAbsolute(options.target) ? options.target : resolve(options.target);
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');

  if (!options.confirm) {
    throw new RestoreRefused(
      'Refusing to restore without --confirm: restore replaces the current database with the backup file.',
    );
  }
  if (source === target) {
    throw new RestoreRefused('The source and target are the same file; a restore must come from elsewhere.');
  }
  if (!existsSync(source)) {
    throw new RestoreRefused(`No such backup file: ${source}`);
  }

  const verification = verifyDatabaseFile(source);
  const known = new Set(loadMigrations().map((migration) => migration.version));
  const unknown = verification.migrationVersions.filter((version) => !known.has(version));
  if (unknown.length > 0) {
    throw new RestoreRefused(
      `The backup contains migration versions this build does not know (${unknown.join(', ')}); ` +
        'it came from a newer gateway. Restore with that version instead.',
    );
  }

  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${target}${suffix}`)) {
      throw new RestoreRefused(
        `${target}${suffix} exists: the gateway may still be running (stop it), or it crashed ` +
          '(start and stop it once, or remove the stale WAL files by hand), then run restore again.',
      );
    }
  }

  const previousPath = existsSync(target) ? `${target}.pre-restore-${stamp}` : null;
  if (previousPath !== null) {
    renameSync(target, previousPath);
  }

  // Same parity as `openDatabase`: a fresh deployment may not have the data
  // directory yet, and an impossible path still fails at the copy, below.
  mkdirSync(dirname(target), { recursive: true });

  const tempPath = `${target}.restore-tmp`;
  try {
    const database = new Database(source, { readonly: true });
    try {
      rmSync(tempPath, { force: true });
      database.prepare('VACUUM INTO ?').run(tempPath);
    } finally {
      database.close();
    }

    verifyDatabaseFile(tempPath);
    renameSync(tempPath, target);
  } catch (error) {
    // Leave the target exactly as it was: no temp litter, no half-copied file,
    // and the previous database back in its original place.
    for (const leftover of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) {
      rmSync(leftover, { force: true });
    }
    if (previousPath !== null && !existsSync(target)) {
      renameSync(previousPath, target);
    }
    throw error;
  }

  return { target, previousPath };
}

