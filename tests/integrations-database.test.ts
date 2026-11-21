import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { activityEventSchema } from '../src/domain/activity-event.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { loadMigrations } from '../src/infrastructure/database/migration-runner.js';
import { BackendService } from '../src/registry/backend-service.js';
import { AgentService } from '../src/registry/agent-service.js';
import { integrationConnectionSchema, type IntegrationConnection } from '../src/integrations/connection.js';
import { AppError } from '../src/shared/errors.js';

/**
 * Migrations 0008/0009 and their repositories (ADR-048..053).
 *
 * The critical tests are the upgrade paths: a database written by the Phase 11
 * schema (migrations 0001–0007) must open cleanly under Phase 12, and one
 * written by Phase 12 (0001–0008) must open cleanly under Phase 13 — every
 * row surviving, the schema growing additively. Additive-only is a promise
 * the tests enforce on real bytes, not on a diagram.
 */

const NOW = '2026-11-22T00:00:00.000Z';

let directory: string;
let store: Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-intdb-'));
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function connectionRow(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return integrationConnectionSchema.parse({
    id: randomUUID(),
    providerId: 'fixture-db',
    name: 'fixture-connection',
    status: 'pending',
    credentialId: null,
    metadata: { org: 'fixture' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('migration 0008', () => {
  it('creates the integration tables and the activity connection column on a fresh database', () => {
    store = openStore({ path: join(directory, 'gateway.db') });

    const tables = store.handle
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(['integration_connections', 'integration_credentials']),
    );

    const columns = store.handle
      .prepare('PRAGMA table_info(activity_events)')
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain('connection_id');

    // Production stays empty: no provider exists, so no row can exist.
    expect(store.integrationConnections.list()).toEqual([]);
    expect(store.integrationCredentials.findById(randomUUID())).toBeUndefined();
  });

  it('upgrades a Phase 11 database in place: every row survives, the schema grows', () => {
    const path = join(directory, 'gateway.db');

    // Phase 11: only migrations 0001–0007 exist. Rows are written the way the
    // Phase 11 process wrote them — raw Phase 11 SQL for activity, because the
    // Phase 12 repository writes a column the old schema does not have yet.
    const phase11 = openStore({ path, migrations: loadMigrations().slice(0, 7) });
    const backends = new BackendService(phase11);
    const backend = backends.create({ name: 'legacy-backend', connection: { type: 'stdio', command: 'node' } });
    new AgentService(phase11).create({ name: 'legacy-agent' });
    const legacyActivityId = randomUUID();
    phase11.handle
      .prepare(
        `INSERT INTO activity_events (id, type, request_id, correlation_id, agent_id, backend_id, tool_name, outcome,
           error_code, duration_ms, created_at)
         VALUES (?, 'tools.list', NULL, NULL, NULL, ?, NULL, 'success', NULL, NULL, ?)`,
      )
      .run(legacyActivityId, backend.id, NOW);
    phase11.close();

    // Phase 12 opens the same file: 0008 applies additively.
    store = openStore({ path });
    const applied = store.handle.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
    expect(applied.map((row) => row.version)).toContain('0008');

    expect(store.backends.list().map((row) => row.id)).toEqual([backend.id]);
    expect(store.agents.list().map((row) => row.name)).toEqual(['legacy-agent']);
    expect(store.activity.count()).toBe(1);

    // The new tables exist and are empty; the old rows are untouched.
    expect(store.integrationConnections.list()).toEqual([]);

    // Reopening is idempotent.
    store.close();
    store = openStore({ path });
    expect(
      (store.handle.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?').get('0008') as { n: number })
        .n,
    ).toBe(1);
  });

  it('enforces the credential cleanup cascade when a connection row is deleted', () => {
    store = openStore({ path: join(directory, 'gateway.db') });
    const connection = store.integrationConnections.create(connectionRow());
    const credentialId = randomUUID();

    store.integrationCredentials.create({
      id: credentialId,
      connectionId: connection.id,
      envelope: '{"v":1,"keyId":"0000000000000000"}',
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(store.integrationConnections.remove(connection.id)).toBe(true);
    // The secret cannot outlive its connection (migration 0008 FK CASCADE).
    expect(store.integrationCredentials.findById(credentialId)).toBeUndefined();
  });

  it('keeps foreign keys on: an orphan credential write fails at the boundary', () => {
    store = openStore({ path: join(directory, 'gateway.db') });

    expect(() =>
      store.integrationCredentials.create({
        id: randomUUID(),
        connectionId: randomUUID(),
        envelope: '{"v":1}',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).toThrow(AppError);
  });
});

describe('migration 0009', () => {
  it('upgrades a Phase 12 database in place: rows survive, `validatedAt` starts honestly null', () => {
    const path = join(directory, 'gateway.db');

    // Phase 12: migrations 0001–0008 only — no `validated_at` column yet. The
    // row is written the way the Phase 12 process wrote it: raw SQL against
    // the 0008 column set, because the Phase 13 repository writes a column
    // the old schema does not have yet.
    const phase12 = openStore({ path, migrations: loadMigrations().slice(0, 8) });
    const connectionId = randomUUID();
    phase12.handle
      .prepare(
        `INSERT INTO integration_connections (id, provider_id, name, status, credential_id, metadata_json,
           created_at, updated_at)
         VALUES (?, 'github', 'legacy-connection', 'connected', NULL, '{}', ?, ?)`,
      )
      .run(connectionId, NOW, NOW);
    phase12.close();

    // Phase 13 opens the same file: 0009 applies additively.
    store = openStore({ path });
    const upgraded = store.integrationConnections.findById(connectionId)!;
    expect(upgraded.providerId).toBe('github');
    // Null by meaning: the row never validated anything under the old
    // schema, and the upgrade does not invent a fact.
    expect(upgraded.validatedAt).toBeNull();

    // The new write path stamps it.
    const stamped = store.integrationConnections.updateStatus(connectionId, 'connected', NOW, NOW)!;
    expect(stamped.validatedAt).toBe(NOW);

    // Reopening is idempotent, and the ledger still says 0009 exactly once.
    store.close();
    store = openStore({ path });
    expect(store.integrationConnections.findById(connectionId)?.validatedAt).toBe(NOW);
    expect(
      (store.handle.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?').get('0009') as { n: number })
        .n,
    ).toBe(1);
  });
});

describe('integration repositories', () => {
  beforeEach(() => {
    store = openStore({ path: join(directory, 'gateway.db') });
  });

  it('round-trips a connection through every write path', () => {
    const created = store.integrationConnections.create(connectionRow({ name: 'ops' }));

    expect(store.integrationConnections.findById(created.id)).toEqual(created);

    const renamed = store.integrationConnections.update(created.id, { name: 'ops-renamed' }, NOW);
    expect(renamed?.name).toBe('ops-renamed');

    const reconfigured = store.integrationConnections.update(
      created.id,
      { metadata: { org: 'other' } },
      NOW,
    );
    expect(reconfigured?.metadata).toEqual({ org: 'other' });

    const flipped = store.integrationConnections.updateStatus(created.id, 'disabled', NOW);
    expect(flipped?.status).toBe('disabled');

    const linked = store.integrationConnections.updateCredential(created.id, randomUUID(), NOW);
    expect(linked?.credentialId).toBeTruthy();

    // A write against a missing row is a no-op that stays a no-op.
    expect(store.integrationConnections.updateStatus(randomUUID(), 'disabled', NOW)).toBeUndefined();
    expect(store.integrationConnections.remove(randomUUID())).toBe(false);
  });

  it('validates rows on the way out: a hand-edited database fails closed at the read boundary', () => {
    const connection = store.integrationConnections.create(connectionRow());

    // Someone edited the file. The status CHECK blocks impossible statuses at
    // the write itself, so corrupt the metadata instead: the read boundary is
    // the layer that must still refuse to hand out a poisoned row.
    store.handle
      .prepare('UPDATE integration_connections SET metadata_json = ? WHERE id = ?')
      .run('this is not the json it was', connection.id);

    expect(() => store.integrationConnections.findById(connection.id)).toThrow(AppError);
  });

  it('records a managed call with its connection id and never a backend id', () => {
    const connectionId = randomUUID();

    store.activity.append(
      activityEventSchema.parse({
        id: randomUUID(),
        type: 'tools.call',
        outcome: 'success',
        connectionId,
        toolName: `${connectionId}__get_status`,
        createdAt: NOW,
      }),
    );

    const row = store.activity.list(10).find((event) => event.type === 'tools.call');
    expect(row).toMatchObject({ connectionId, toolName: `${connectionId}__get_status` });
    expect(row?.backendId).toBeUndefined();
  });

  it('rejects an activity row that would mislabel a connection as a backend', () => {
    const connectionId = randomUUID();

    // The schema is the guard: one row cannot name both identities.
    expect(() =>
      activityEventSchema.parse({
        id: randomUUID(),
        type: 'tools.call',
        outcome: 'success',
        backendId: connectionId,
        connectionId,
        createdAt: NOW,
      }),
    ).toThrow();
  });
});
