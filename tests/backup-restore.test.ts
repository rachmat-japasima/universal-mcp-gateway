import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup, defaultBackupDestination } from '../src/cli/backup.js';
import { restoreBackup, RestoreRefused } from '../src/cli/restore.js';
import { openDatabase, closeDatabase } from '../src/infrastructure/database/connection.js';
import { openStore, type Database as Store } from '../src/infrastructure/database/index.js';
import { loadMigrations } from '../src/infrastructure/database/migration-runner.js';
import { EnvelopeVault, loadVaultKeys } from '../src/integrations/vault.js';

/**
 * Backup and restore (Phase 18, Stage B).
 *
 * Every database here is disposable: a fresh temp directory per test. The real
 * `data/gateway.db` is never opened by this suite. The two properties that make
 * these commands trustworthy are pinned end to end:
 *
 *  * The backup captures content that is still sitting in the WAL of a live
 *    connection — the exact thing a naive file copy would lose.
 *  * The restore leaves the target either untouched or exactly as it was,
 *    and the previous database survives every path through it.
 */

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

/** Presence by username — `isOperatorUsernameTaken` cannot answer absence: it returns true whenever any operator exists. */
function hasUser(target: Store, username: string): boolean {
  return target.operators.findByUsername(username) !== undefined;
}

describe('backup', () => {
  let directory: string;
  let dbPath: string;
  let store: Store | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'umg-backup-'));
    dbPath = join(directory, 'gateway.db');
    store = openStore({ path: dbPath });
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  function seed(username: string): void {
    store!.operators.create({ username, passwordHash: `hash-${username}`, role: 'owner' }, new Date().toISOString());
  }

  it('captures a live WAL-active store, including rows still in the WAL', () => {
    // `seed` commits while the connection is open in WAL mode; nothing is
    // checkpointed. If the backup were a naive file copy, this row would be
    // sitting in gateway.db-wal and missing from the result.
    seed('wal-row');

    const destination = join(directory, 'snapshot.db');
    const { path, migrationVersions } = createBackup(store!, destination);

    expect(path).toBe(destination);
    expect(migrationVersions).toEqual(loadMigrations().map((migration) => migration.version));

    // Mode 0600, no journal litter beside the finished backup.
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(existsSync(`${destination}-wal`)).toBe(false);
    expect(existsSync(`${destination}.tmp-wal`)).toBe(false);

    // The row committed to the WAL is inside the backup.
    const backupStore = openStore({ path: destination });
    try {
      expect(hasUser(backupStore, 'wal-row')).toBe(true);
    } finally {
      backupStore.close();
    }

    // And the source keeps serving, undisturbed.
    expect(hasUser(store!, 'wal-row')).toBe(true);
  });

  it('produces collision-free default destinations beside the database', () => {
    const first = defaultBackupDestination(dbPath, new Date('2026-11-23T01:02:03.456Z'));
    const second = defaultBackupDestination(dbPath, new Date('2026-11-23T01:02:03.789Z'));

    expect(dirname(first)).toBe(join(dirname(dbPath), 'backups'));
    expect(basename(first)).toMatch(/^gateway-2026-11-23T01-02-03-456Z\.db$/);
    expect(first).not.toBe(second);
  });

  it('refuses to overwrite an existing destination and touches nothing', () => {
    const destination = join(directory, 'existing.db');
    writeFileSync(destination, 'precious');

    expect(() => createBackup(store!, destination)).toThrow(/already exists/);
    expect(readFileSync(destination, 'utf8')).toBe('precious');
    expect(existsSync(`${destination}.tmp`)).toBe(false);
  });

  it('fails cleanly on an impossible destination, leaving no partial file', () => {
    // A path *inside* a regular file: no directory can ever be created there.
    const blocked = join(directory, 'plain-file.db', 'nested.db');
    writeFileSync(join(directory, 'plain-file.db'), 'not a directory');

    expect(() => createBackup(store!, blocked)).toThrow();
    expect(existsSync(`${blocked}.tmp`)).toBe(false);
  });
});

describe('restore', () => {
  let directory: string;
  let dbPath: string;
  let store: Store | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'umg-restore-'));
    dbPath = join(directory, 'gateway.db');
    store = openStore({ path: dbPath });
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  function seed(username: string): void {
    store!.operators.create({ username, passwordHash: `hash-${username}`, role: 'owner' }, new Date().toISOString());
  }

  /** A verified backup of the current state, with the store still open. */
  function makeBackup(name = 'backup.db'): string {
    const path = join(directory, name);
    createBackup(store!, path);
    return path;
  }

  it('refuses without --confirm and changes nothing', () => {
    seed('operator-a');
    const source = makeBackup();
    store!.close();
    store = undefined;

    expect(() => restoreBackup({ source, target: dbPath, confirm: false })).toThrow(RestoreRefused);

    // A closed store checkpoints away its WAL, so an exact listing is possible.
    expect(readdirSync(directory).sort()).toEqual(['backup.db', 'gateway.db']);

    const untouched = openStore({ path: dbPath });
    store = untouched;
    expect(hasUser(untouched, 'operator-a')).toBe(true);
  });

  it('refuses a corrupt backup before touching the target', () => {
    seed('operator-a');
    const source = makeBackup('corrupt.db');
    store!.close();
    store = undefined;

    // Clobber the page-count header and truncate the tail: no way to read it.
    const bytes = readFileSync(source);
    bytes.fill(0xff, 16, 24);
    writeFileSync(source, bytes.subarray(0, Math.max(0, bytes.length - 4096)));

    expect(() => restoreBackup({ source, target: dbPath, confirm: true })).toThrow();

    // The live database is untouched, and nothing was renamed aside.
    expect(readdirSync(directory).sort()).toEqual(['corrupt.db', 'gateway.db']);
    const untouched = openStore({ path: dbPath });
    store = untouched;
    expect(hasUser(untouched, 'operator-a')).toBe(true);
  });

  it('refuses a backup containing an unknown, newer migration version', () => {
    seed('operator-a');
    const source = makeBackup('future.db');

    const handle = openDatabase({ path: source });
    try {
      const version = loadMigrations()[0]!.version;
      handle.prepare('UPDATE schema_migrations SET version = ? WHERE version = ?').run('9999', version);
    } finally {
      closeDatabase(handle);
    }

    expect(() => restoreBackup({ source, target: dbPath, confirm: true })).toThrow(/newer gateway/);
    expect(hasUser(store!, 'operator-a')).toBe(true);
  });

  it('refuses while a WAL file sits at the target, whatever left it there', () => {
    const source = makeBackup();
    store!.close();
    store = undefined;
    // After a clean close this file can only mean a crashed or still-running
    // process — both must stop the restore.
    writeFileSync(`${dbPath}-wal`, 'leftover WAL, maybe a live process');

    expect(() => restoreBackup({ source, target: dbPath, confirm: true })).toThrow(
      /may still be running/,
    );
    expect(
      readdirSync(directory).some((name) => name.startsWith('gateway.db.pre-restore-')),
    ).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('replaces the target, preserves the previous database, and the result boots', () => {
    const now = new Date('2026-11-23T12:00:00.000Z');
    seed('before-user');
    const source = makeBackup();

    // State after the backup: a second operator the backup must not contain.
    seed('after-user');
    store!.close();
    store = undefined;

    const { previousPath } = restoreBackup({ source, target: dbPath, confirm: true, now });
    expect(previousPath).toBe(`${dbPath}.pre-restore-2026-11-23T12-00-00-000Z`);
    expect(existsSync(previousPath!)).toBe(true);

    // No journal litter: a stray WAL here would brick the *next* restore.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}.restore-tmp`)).toBe(false);

    // The restored target boots through the normal startup path — migrations
    // re-verify checksums — and contains the backup's state, not the newer one.
    const restored = openStore({ path: dbPath });
    store = restored;
    expect(hasUser(restored, 'before-user')).toBe(true);
    expect(hasUser(restored, 'after-user')).toBe(false);

    // The preserved previous database still holds the post-backup state.
    const previous = openStore({ path: previousPath! });
    try {
      expect(hasUser(previous, 'after-user')).toBe(true);
    } finally {
      previous.close();
    }
  });

  it('restores into an empty deployment where no database existed', () => {
    seed('only-user');
    const source = makeBackup();
    store!.close();
    store = undefined;

    const fresh = join(directory, 'fresh-deployment', 'gateway.db');
    const { previousPath } = restoreBackup({ source, target: fresh, confirm: true });

    expect(previousPath).toBeNull();
    const restored = openStore({ path: fresh });
    store = restored;
    expect(hasUser(restored, 'only-user')).toBe(true);
  });

  it('carries sealed credentials as ciphertext only the original key can open', () => {
    const vaultA = new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_A }));
    const envelope = JSON.stringify(vaultA.seal('provider-secret-token'));
    const credentialId = randomUUID();
    const now = new Date().toISOString();
    store!.integrationCredentials.create({
      id: credentialId,
      connectionId: null,
      envelope,
      createdAt: now,
      updatedAt: now,
    });

    const source = makeBackup();
    store!.close();
    store = undefined;
    restoreBackup({ source, target: dbPath, confirm: true });

    const restored = openStore({ path: dbPath });
    store = restored;
    const stored = restored.integrationCredentials.findById(credentialId);
    expect(stored?.envelope).toBe(envelope);

    // The envelope survives byte-for-byte and remains readable ciphertext with
    // the active key — and inert, refusing ciphertext with any other key.
    expect(new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_A })).unseal(JSON.parse(envelope))).toBe(
      'provider-secret-token',
    );
    expect(() =>
      new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_B })).unseal(JSON.parse(envelope)),
    ).toThrow();
  });
});
