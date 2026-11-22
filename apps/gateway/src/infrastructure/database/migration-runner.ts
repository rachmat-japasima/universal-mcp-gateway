import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { SqliteDatabase } from './connection.js';

/**
 * Versioned SQL migrations.
 *
 * Execution model:
 *   * Every migration and its `schema_migrations` row commit in ONE transaction,
 *     so a failure leaves the database exactly as it was before that file ran
 *     (no half-applied schema, no missing ledger entry).
 *   * Applied migrations are immutable. The runner records a checksum and
 *     refuses to start if a previously applied file changed, because the ledger
 *     would then describe a schema nobody has.
 *   * Existing tables are never dropped and the file is never deleted; a
 *     migration that needs to change shape adds to the previous one.
 */

export interface Migration {
  version: string;
  filename: string;
  sql: string;
}

/**
 * Loaded from a sibling `.sql` directory at module load, not from `dist`, so the
 * set of migrations cannot drift between `tsx` and compiled runs. The build
 * copies the directory next to the compiled runner (see `package.json`).
 */
const utf8 = 'utf8';

export function loadMigrations(directory = new URL('./migrations/', import.meta.url)): Migration[] {
  const entries = readdirSyncSafe(directory).filter((name) => name.endsWith('.sql'));

  const migrations = entries.map((filename) => {
    const [version] = filename.split('_');
    if (!version || !/^\d{4}$/.test(version)) {
      throw new Error(`Migration filename must start with a 4-digit version: ${filename}`);
    }

    return { version, filename, sql: readFileSync(new URL(filename, directory), utf8) };
  });

  migrations.sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) throw new Error(`Duplicate migration version: ${migration.version}`);
    seen.add(migration.version);
  }

  return migrations;
}

function readdirSyncSafe(directory: URL): string[] {
  const directoryPath = fileURLToPath(directory);
  return readdirSync(directoryPath);
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending migrations. Idempotent: running it twice applies nothing the
 * second time.
 */
export function runMigrations(
  database: SqliteDatabase,
  migrations: Migration[] = loadMigrations(),
): MigrationResult {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Map(
    database
      .prepare('SELECT version, checksum FROM schema_migrations')
      .all()
      .map((row) => {
        const record = row as { version: string; checksum: string };
        return [record.version, record.checksum] as const;
      }),
  );

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    const previous = applied.get(migration.version);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${migration.filename} changed after it was applied. ` +
            'Applied migrations are immutable; add a new migration instead.',
        );
      }

      result.skipped.push(migration.version);
      continue;
    }

    // Table creation inside `exec` is transactional in SQLite DDL terms, and the
    // ledger insert joins the same transaction: all-or-nothing per migration.
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, checksum, new Date().toISOString());
    });

    apply();
    result.applied.push(migration.version);
  }

  return result;
}
