import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/infrastructure/database/connection.js';
import { loadMigrations, runMigrations, type Migration } from '../src/infrastructure/database/migration-runner.js';
import { openStore } from '../src/infrastructure/database/index.js';
import { AppError } from '../src/shared/errors.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-db-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const now = '2026-11-18T00:00:00.000Z';

describe('database initialization', () => {
  it('creates the file, its directory, and every expected table', () => {
    const path = join(directory, 'nested', 'gateway.db');
    const store = openStore({ path });

    const tables = store.handle
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'activity_events',
        'admin_users',
        'agent_credentials',
        'agent_policy_assignments',
        'agents',
        'audit_events',
        'backend_runtime',
        'backends',
        'policies',
        'schema_migrations',
        'sessions',
      ]),
    );

    store.close();
  });

  it('starts with an empty production registry', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });

    expect(store.backends.countActive()).toBe(0);
    expect(store.backends.list()).toEqual([]);
    expect(store.agents.list()).toEqual([]);
    expect(store.policies.list()).toEqual([]);
    expect(store.activity.count()).toBe(0);
    expect(store.audit.count()).toBe(0);
    expect(store.sessions.count()).toBe(0);

    store.close();
  });

  it('enables foreign key enforcement on the connection', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });
    expect(store.handle.pragma('foreign_keys', { simple: true })).toBe(1);
    store.close();
  });

  it('uses WAL and full synchronous for a file database', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });
    expect(store.handle.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(store.handle.pragma('synchronous', { simple: true })).toBe(2); // FULL
    store.close();
  });
});

describe('migrations', () => {
  it('ships at least one migration and records it', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });
    const applied = store.handle.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{
      version: string;
      checksum: string;
    }>;

    expect(applied.map((row) => row.version)).toEqual(['0001', '0002']);
    for (const row of applied) expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);

    store.close();
  });

  it('is idempotent: a second open applies nothing and keeps data', () => {
    const path = join(directory, 'gateway.db');

    const first = openStore({ path });
    first.agents.create({ name: 'kept' }, now);
    first.close();

    const second = openStore({ path });
    expect(second.agents.list().map((agent) => agent.name)).toEqual(['kept']);
    expect(second.agents.countActive()).toBe(1);

    const migrations = second.handle.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {
      count: number;
    };
    expect(migrations.count).toBe(loadMigrations().length);
    second.close();
  });

  it('preserves an existing database across an upgrade that adds a migration', () => {
    const path = join(directory, 'gateway.db');
    const baseline = loadMigrations();

    const first = openStore({ path, migrations: baseline });
    first.agents.create({ name: 'survivor' }, now);
    first.close();

    const upgrade: Migration[] = [
      ...baseline,
      {
        version: '0003',
        filename: '0003_add_note.sql',
        sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY); INSERT INTO notes (id) VALUES (\'kept\');',
      },
    ];

    const upgraded = openStore({ path, migrations: upgrade });
    expect(upgraded.agents.list().map((agent) => agent.name)).toEqual(['survivor']);
    expect(upgraded.handle.prepare('SELECT id FROM notes').get()).toEqual({ id: 'kept' });
    upgraded.close();

    // Third open with only the original set must not revert anything either.
    const reopened = openStore({ path, migrations: upgrade });
    expect(reopened.agents.list()).toHaveLength(1);
    reopened.close();
  });

  it('rolls back a failing migration without leaving a partial schema or ledger row', () => {
    const path = join(directory, 'gateway.db');
    const baseline = loadMigrations();

    const broken: Migration[] = [
      ...baseline,
      {
        version: '0003',
        filename: '0003_broken.sql',
        sql: 'CREATE TABLE half_done (id TEXT); INSERT INTO missing_table (id) VALUES (1);',
      },
    ];

    expect(() => openStore({ path, migrations: broken })).toThrow();

    // The database must be exactly where it was: no half_done table, no 0003 row.
    const reopened = openDatabase({ path });
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).not.toContain('half_done');
    expect(tables).toContain('agents');
    expect(reopened.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(
      loadMigrations().map((migration) => ({ version: migration.version })),
    );
    reopened.close();
  });

  it('refuses to start when an applied migration was edited', () => {
    const path = join(directory, 'gateway.db');
    const baseline = loadMigrations();
    const first = openStore({ path, migrations: baseline });
    first.close();

    const tampered: Migration[] = baseline.map((migration) =>
      migration.version === '0001' ? { ...migration, sql: `${migration.sql}\n-- edited\n` } : migration,
    );

    expect(() => openStore({ path, migrations: tampered })).toThrow(/immutable/);
  });

  it('rejects duplicate versions and malformed filenames', () => {
    const dangling = join(directory, 'migrations');
    mkdirSync(dangling, { recursive: true });
    writeFileSync(join(dangling, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dangling, '0001_b.sql'), 'SELECT 1;');

    expect(() => loadMigrations(new URL(`file://${dangling}/`))).toThrow(/Duplicate/);

    rmSync(join(dangling, '0001_b.sql'));
    writeFileSync(join(dangling, 'nope.sql'), 'SELECT 1;');
    expect(() => loadMigrations(new URL(`file://${dangling}/`))).toThrow(/4-digit/);
  });
});

describe('constraints', () => {
  it('rejects a credential whose agent does not exist (foreign key)', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });

    expect(() =>
      store.credentials.create(
        { agentId: '11111111-1111-4111-8111-111111111111', credentialHash: 'b'.repeat(64) },
        now,
      ),
    ).toThrowError(AppError);

    store.close();
  });

  it('cascades credential deletion when the agent is hard-deleted', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });
    const agent = store.agents.create({ name: 'cascade' }, now);
    store.credentials.create({ agentId: agent.id, credentialHash: 'c'.repeat(64) }, now);

    store.handle.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
    const remaining = store.handle.prepare('SELECT COUNT(*) AS count FROM agent_credentials').get() as {
      count: number;
    };

    expect(remaining.count).toBe(0);
    store.close();
  });

  it('enforces the limited-concurrency check constraint at the storage layer', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });

    expect(() =>
      store.handle
        .prepare(
          `INSERT INTO backends (id, name, transport, config_json, enabled, timeout_ms, concurrency_mode, created_at, updated_at)
           VALUES ('x', 'x', 'stdio', '{}', 1, 1000, 'limited', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/CHECK constraint/);

    store.close();
  });

  it('rejects duplicate active names but allows reuse after a tombstone', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });
    const connection = { type: 'stdio' as const, command: 'node' };

    const first = store.backends.create({ name: 'dup', connection }, now);
    expect(() => store.backends.create({ name: 'dup', connection }, now)).toThrowError(/already exists/);

    store.backends.softDelete(first.id, now);
    expect(() => store.backends.create({ name: 'dup', connection }, now)).not.toThrow();

    store.close();
  });
});

describe('transactions', () => {
  it('rolls back every write in a failed transaction', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });

    expect(() =>
      store.transaction(() => {
        store.agents.create({ name: 'ghost' }, now);
        throw new Error('abort');
      }),
    ).toThrow('abort');

    expect(store.agents.countActive()).toBe(0);
    store.close();
  });

  it('commits every write in a successful transaction', () => {
    const store = openStore({ path: join(directory, 'gateway.db') });

    store.transaction(() => {
      store.agents.create({ name: 'one' }, now);
      store.agents.create({ name: 'two' }, now);
    });

    expect(store.agents.countActive()).toBe(2);
    store.close();
  });
});
