import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuditEvent } from '../src/domain/audit-event.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { BackendService, LOCAL_OPERATOR, toPublicBackend } from '../src/registry/backend-service.js';

let directory: string;
let store: Database;
let service: BackendService;

const stdio = { type: 'stdio' as const, command: 'node', args: ['server.js'] };
const http = { type: 'streamable-http' as const, url: 'https://backend.test/mcp' };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-svc-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  service = new BackendService(store);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const auditRows = (): AuditEvent[] => store.audit.list(100);
const actions = (): string[] => auditRows().map((event) => event.action);

function register(name: string, connection: typeof stdio | typeof http = stdio) {
  return service.create({ name, connection });
}

describe('create', () => {
  it('persists configuration and an initial runtime row, never a connected one', () => {
    const created = register('local-tools');

    expect(created).toMatchObject({ name: 'local-tools', enabled: true, version: 1 });
    expect(store.backends.countActive()).toBe(1);

    // Configuration alone must never imply a live connection.
    const runtime = store.backendRuntime.findByBackendId(created.id);
    expect(runtime?.status).toBe('disconnected');
    expect(runtime?.lastConnectedAt).toBeUndefined();
  });

  it('starts a disabled backend in the disabled runtime state', () => {
    const created = service.create({ name: 'off-by-default', connection: stdio, enabled: false });
    expect(store.backendRuntime.findByBackendId(created.id)?.status).toBe('disabled');
  });

  it('records a redacted audit event', () => {
    const created = service.create({
      name: 'with-secret-ref',
      connection: { type: 'stdio', command: 'node', args: [], env: { API_KEY: 'env:PROVIDER_KEY' } },
    });

    const [event] = auditRows();
    expect(event).toMatchObject({
      action: 'backend.created',
      actorType: LOCAL_OPERATOR.type,
      actorId: LOCAL_OPERATOR.id,
      targetType: 'backend',
      targetId: created.id,
      result: 'success',
    });
    // Metadata is a whitelist, never a config snapshot.
    expect(event?.metadata).toEqual({ transport: 'stdio', enabled: true });
    expect(JSON.stringify(event)).not.toContain('PROVIDER_KEY');
  });

  it('rejects a duplicate active name but allows reusing a deleted one', () => {
    const first = register('taken', http);

    expect(() => register('taken', http)).toThrow(/already exists/);

    service.remove(first.id);
    expect(() => register('taken', http)).not.toThrow();
  });

  it('rejects malformed configuration before touching the database', () => {
    expect(() => service.create({ name: 'bad', connection: { type: 'stdio', command: 'node server.js && rm -rf /', args: [] } as never })).toThrow();
    expect(() => service.create({ name: 'bad', connection: { type: 'streamable-http', url: 'file:///etc/passwd' } as never })).toThrow();
    expect(store.backends.countActive()).toBe(0);
  });

  it('rejects a literal secret in place of a reference', () => {
    expect(() =>
      service.create({
        name: 'leaky',
        connection: { type: 'streamable-http', url: 'https://backend.test/mcp', headers: { Authorization: 'sk-live-abc123' } },
      }),
    ).toThrow();
  });
});

describe('list', () => {
  const query = { limit: 20, offset: 0, sort: 'name' as const, order: 'asc' as const };

  it('returns an empty page for an empty registry', () => {
    expect(service.list(query)).toEqual({ items: [], total: 0 });
  });

  it('filters, searches, sorts, and paginates', () => {
    register('alpha');
    const beta = service.create({ name: 'beta', connection: http, description: 'http one' });
    service.create({ name: 'gamma', connection: stdio, enabled: false });

    expect(service.list(query).items.map((b) => b.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(service.list({ ...query, order: 'desc' }).items.map((b) => b.name)).toEqual(['gamma', 'beta', 'alpha']);
    expect(service.list({ ...query, transport: 'streamable-http' }).items.map((b) => b.id)).toEqual([beta.id]);
    expect(service.list({ ...query, enabled: false }).items.map((b) => b.name)).toEqual(['gamma']);
    expect(service.list({ ...query, search: 'HTTP' }).items.map((b) => b.name)).toEqual(['beta']);

    // `%` is a literal, not a wildcard: it must not match everything.
    expect(service.list({ ...query, search: '%' }).total).toBe(0);

    const page = service.list({ ...query, limit: 2, offset: 2 });
    expect(page.items.map((b) => b.name)).toEqual(['gamma']);
    expect(page.total).toBe(3);
  });

  it('includes runtime status when a runtime row exists', () => {
    const created = register('with-runtime');
    service.setEnabled(created.id, false);

    expect(service.list(query).items[0]?.runtime?.status).toBe('disabled');
    expect(service.get(created.id).runtime?.status).toBe('disabled');
  });
});

describe('update', () => {
  it('applies a partial update and preserves omitted fields', () => {
    const created = service.create({ name: 'before', connection: stdio, description: 'keep me', timeoutMs: 5000 });

    const updated = service.update(created.id, { name: 'after' }, created.version);

    expect(updated).toMatchObject({ name: 'after', description: 'keep me', timeoutMs: 5000, version: 2 });
    expect(updated.connection).toEqual(created.connection);
  });

  it('distinguishes clearing from omitting a nullable field', () => {
    const created = service.create({ name: 'described', connection: stdio, description: 'gone soon' });

    expect(service.update(created.id, { description: null }, created.version).description).toBeUndefined();
  });

  it('rejects a rename onto another active backend', () => {
    register('one');
    const two = register('two');

    expect(() => service.update(two.id, { name: 'one' })).toThrow(/already exists/);
  });

  it('rejects a stale write and keeps the winner', () => {
    const created = register('contended');
    const winner = service.update(created.id, { description: 'first writer' }, created.version);

    expect(() => service.update(created.id, { description: 'second writer' }, created.version)).toThrow(
      /modified by another request/,
    );
    expect(store.backends.findById(created.id)?.description).toBe('first writer');
    expect(winner.version).toBe(2);
  });

  it('reports a missing backend', () => {
    expect(() => service.update('00000000-0000-4000-8000-000000000000', { name: 'x' })).toThrow(/does not exist/);
  });

  it('records what changed, not the values', () => {
    const created = register('audited');
    service.update(created.id, { timeoutMs: 9000 }, created.version);

    const event = auditRows()[0];
    expect(event?.action).toBe('backend.updated');
    expect(event?.metadata).toEqual({ changed: 'timeoutMs' });
    expect(JSON.stringify(event)).not.toContain('9000');
  });
});

describe('enable and disable', () => {
  it('toggles configuration state and the disabled runtime status only', () => {
    const created = register('toggle');

    const disabled = service.setEnabled(created.id, false);
    expect(disabled.enabled).toBe(false);
    expect(store.backendRuntime.findByBackendId(created.id)?.status).toBe('disabled');

    // Re-enabling shows "disconnected", never "connected": nothing was dialled.
    const enabled = service.setEnabled(created.id, true);
    expect(enabled.enabled).toBe(true);
    expect(store.backendRuntime.findByBackendId(created.id)?.status).toBe('disconnected');
  });

  it('is idempotent and writes no audit row when nothing changes', () => {
    const created = register('idempotent');
    const before = auditRows().length;

    const again = service.setEnabled(created.id, true);
    expect(again.version).toBe(created.version);
    expect(auditRows()).toHaveLength(before);

    service.setEnabled(created.id, false);
    service.setEnabled(created.id, false);
    expect(actions().filter((action) => action === 'backend.disabled')).toHaveLength(1);
  });

  it('still refuses a stale expected version on a no-op', () => {
    const created = register('stale-noop');
    expect(() => service.setEnabled(created.id, true, created.version + 1)).toThrow(/modified by another request/);
  });

  it('records enable and disable separately', () => {
    const created = register('audited-toggle');
    service.setEnabled(created.id, false);
    service.setEnabled(created.id, true);

    // Timestamps can collide within a millisecond, so compare as a set.
    expect(actions().filter((action) => action !== 'backend.created').sort()).toEqual([
      'backend.disabled',
      'backend.enabled',
    ]);
  });
});

describe('delete', () => {
  it('tombstones the backend and keeps audit history', () => {
    const created = register('doomed');
    const removed = service.remove(created.id);

    expect(removed.id).toBe(created.id);
    expect(store.backends.findById(created.id)).toBeUndefined();
    expect(store.backends.countActive()).toBe(0);

    const events = auditRows().filter((event) => event.targetId === created.id);
    expect(events.map((event) => event.action).sort()).toEqual(['backend.created', 'backend.deleted']);
  });

  it('is not repeatable and does not delete anything else', () => {
    const kept = register('kept');
    const doomed = register('doomed');

    service.remove(doomed.id);
    expect(() => service.remove(doomed.id)).toThrow(/does not exist/);
    expect(store.backends.findById(kept.id)).toBeDefined();
  });
});

describe('validate', () => {
  it('accepts a valid config without persisting or connecting', () => {
    const result = service.validate({ name: 'proposed', connection: http, timeoutMs: 10_000 });

    expect(result.valid).toBe(true);
    expect(result.transport).toBe('streamable-http');
    expect(result.normalized).toMatchObject({ transport: 'streamable-http', timeoutMs: 10_000 });
    expect(store.backends.countActive()).toBe(0);
    expect(store.audit.count()).toBe(0);
  });

  it('reports per-field issues and audits the failure', () => {
    const result = service.validate({ name: '', connection: { type: 'stdio', command: '', args: [] } });

    expect(result.valid).toBe(false);
    expect(result.errors?.map((error) => error.path)).toEqual(expect.arrayContaining(['name', 'connection.command']));

    const [event] = auditRows();
    expect(event).toMatchObject({ action: 'backend.validation_failed', result: 'failure' });
    expect(event?.targetType).toBeUndefined();
  });

  it('never echoes a submitted secret in the result or the audit log', () => {
    const result = service.validate({
      name: 'leaky',
      connection: { type: 'streamable-http', url: 'https://backend.test/mcp', headers: { Authorization: 'sk-live-abc123' } },
    });

    expect(result.valid).toBe(false);
    const serialized = JSON.stringify(result) + JSON.stringify(auditRows());
    expect(serialized).not.toContain('sk-live-abc123');
  });

  it('does not echo a secret pasted as a key name', () => {
    // A pasted key, not a value. Env-var names are POSIX identifiers, so a
    // hyphenated secret cannot pass as one; an unknown top-level field is
    // rejected without naming it.
    const pasted = 'sk-live-ABCDEFGHIJKLMNOP';
    const asEnvKey = service.validate({
      name: 'leaky-key',
      connection: { type: 'stdio', command: 'node', args: [], env: { [pasted]: 'env:OK' } },
    });
    const asField = service.validate({ name: 'leaky-field', connection: stdio, [pasted]: 'x' });

    for (const result of [asEnvKey, asField]) expect(result.valid).toBe(false);

    // Neither the validation result nor the audit trail may contain it.
    const serialized = JSON.stringify([asEnvKey, asField]) + JSON.stringify(auditRows());
    expect(serialized).not.toContain(pasted);
  });
});

describe('public representation', () => {
  it('exposes configuration but never runtime handles or raw rows', () => {
    const created = service.create({
      name: 'public',
      connection: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'secret:provider-token' } },
    });

    const publicView = toPublicBackend(service.get(created.id));

    expect(publicView).toMatchObject({
      id: created.id,
      transport: 'stdio',
      connection: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'secret:provider-token' } },
      version: 1,
      runtime: { status: 'disconnected' },
    });
    // The reference is shown; no secret value exists to show.
    expect(Object.keys(publicView)).not.toContain('deletedAt');
  });
});
