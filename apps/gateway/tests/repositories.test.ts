import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { initialBackendRuntime } from '../src/domain/backend-runtime.js';

let directory: string;
let store: Database;

const NOW = '2026-11-18T00:00:00.000Z';
const LATER = '2026-11-18T01:00:00.000Z';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-repo-'));
  store = openStore({ path: join(directory, 'gateway.db') });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('backend repository', () => {
  it('round-trips a backend, preserving transport-specific config', () => {
    const created = store.backends.create(
      {
        name: 'local-tools',
        description: 'stdio backend',
        connection: { type: 'stdio', command: 'node', args: ['server.js'], cwd: '/srv/mcp' },
        timeoutMs: 5000,
        concurrencyMode: 'limited',
        concurrencyLimit: 3,
      },
      NOW,
    );

    const loaded = store.backends.findById(created.id);
    expect(loaded).toMatchObject({
      name: 'local-tools',
      description: 'stdio backend',
      connection: { type: 'stdio', command: 'node', args: ['server.js'], cwd: '/srv/mcp' },
      enabled: true,
      timeoutMs: 5000,
      concurrencyMode: 'limited',
      concurrencyLimit: 3,
      createdAt: NOW,
    });
  });

  it('does not leak transport into the stored config body', () => {
    const created = store.backends.create({ name: 'http', connection: { type: 'streamable-http', url: 'https://x.test/mcp' } }, NOW);
    const row = store.handle.prepare('SELECT transport, config_json FROM backends WHERE id = ?').get(created.id) as {
      transport: string;
      config_json: string;
    };

    expect(row.transport).toBe('streamable-http');
    expect(JSON.parse(row.config_json)).toEqual({ url: 'https://x.test/mcp', headers: {} });
  });

  it('updates only the fields supplied', () => {
    const created = store.backends.create({ name: 'partial', connection: { type: 'stdio', command: 'node' } }, NOW);
    const updated = store.backends.update(created.id, { enabled: false }, LATER);

    expect(updated.enabled).toBe(false);
    expect(updated.name).toBe('partial');
    expect(updated.connection).toEqual(created.connection);
    expect(updated.updatedAt).toBe(LATER);
  });

  it('clears a nullable field when null is supplied', () => {
    const created = store.backends.create(
      {
        name: 'clearable',
        description: 'remove me',
        connection: { type: 'stdio', command: 'node' },
        concurrencyMode: 'limited',
        concurrencyLimit: 2,
      },
      NOW,
    );

    const cleared = store.backends.update(created.id, { description: null, concurrencyMode: 'parallel', concurrencyLimit: null }, LATER);
    expect(cleared.description).toBeUndefined();
    expect(cleared.concurrencyLimit).toBeUndefined();
  });

  it('hides a soft-deleted backend from reads and lists but keeps the row', () => {
    const created = store.backends.create({ name: 'gone', connection: { type: 'stdio', command: 'node' } }, NOW);
    store.backends.softDelete(created.id, LATER);

    expect(store.backends.findById(created.id)).toBeUndefined();
    expect(store.backends.findByName('gone')).toBeUndefined();
    expect(store.backends.list()).toEqual([]);
    expect(store.backends.countActive()).toBe(0);

    const row = store.handle.prepare('SELECT deleted_at FROM backends WHERE id = ?').get(created.id) as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).toBe(LATER);
  });

  it('reports missing and duplicate resources with stable codes', () => {
    const missing = '11111111-1111-4111-8111-111111111111';

    expect(() => store.backends.update(missing, { name: 'x' }, NOW)).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }),
    );
    expect(() => store.backends.softDelete(missing, NOW)).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }),
    );

    store.backends.create({ name: 'uniq', connection: { type: 'stdio', command: 'node' } }, NOW);
    expect(() =>
      store.backends.create({ name: 'uniq', connection: { type: 'stdio', command: 'node' } }, NOW),
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_CONFLICT' }));
  });

  it('validates input before it reaches SQL', () => {
    expect(() =>
      store.backends.create({ name: '', connection: { type: 'stdio', command: 'node' } }, NOW),
    ).toThrow();
    expect(store.backends.countActive()).toBe(0);
  });
});

describe('backend runtime repository', () => {
  it('starts disconnected and upserts to connected', () => {
    const backend = store.backends.create({ name: 'runtime', connection: { type: 'stdio', command: 'node' } }, NOW);

    const initial = store.backendRuntime.upsert(initialBackendRuntime(backend.id, true, NOW));
    expect(initial.status).toBe('disconnected');

    const connected = store.backendRuntime.upsert({
      backendId: backend.id,
      status: 'connected',
      lastConnectedAt: LATER,
      reconnectAttempts: 1,
      updatedAt: LATER,
    });

    expect(connected).toMatchObject({ status: 'connected', lastConnectedAt: LATER, reconnectAttempts: 1 });
    expect(store.backendRuntime.findByBackendId(backend.id)).toEqual(connected);
  });

  it('cascades when the backend row is removed', () => {
    const backend = store.backends.create({ name: 'cascade-rt', connection: { type: 'stdio', command: 'node' } }, NOW);
    store.backendRuntime.upsert(initialBackendRuntime(backend.id, true, NOW));

    store.handle.prepare('DELETE FROM backends WHERE id = ?').run(backend.id);
    expect(store.backendRuntime.findByBackendId(backend.id)).toBeUndefined();
  });
});

describe('agent and credential repositories', () => {
  it('creates, updates and tombstones an agent', () => {
    const agent = store.agents.create({ name: 'claude-code', clientType: 'claude-code' }, NOW);
    const updated = store.agents.update(agent.id, { enabled: false, description: 'paused' }, LATER);

    expect(updated).toMatchObject({ enabled: false, description: 'paused', clientType: 'claude-code' });

    store.agents.softDelete(agent.id, LATER);
    expect(store.agents.list()).toEqual([]);
    expect(store.agents.countActive()).toBe(0);
  });

  it('clears clientType with null', () => {
    const agent = store.agents.create({ name: 'x', clientType: 'codex-cli' }, NOW);
    expect(store.agents.update(agent.id, { clientType: null }, LATER).clientType).toBeUndefined();
  });

  it('stores only the verifier hash and finds credentials by it', () => {
    const agent = store.agents.create({ name: 'with-cred' }, NOW);
    const hash = 'd'.repeat(64);
    const credential = store.credentials.create({ agentId: agent.id, credentialHash: hash, label: 'laptop' }, NOW);

    expect(credential.credentialHash).toBe(hash);
    expect(store.credentials.findByHash(hash)?.id).toBe(credential.id);
    expect(store.credentials.listByAgentId(agent.id)).toHaveLength(1);
  });

  it('revokes once and keeps the first timestamp', () => {
    const agent = store.agents.create({ name: 'revocable' }, NOW);
    const credential = store.credentials.create({ agentId: agent.id, credentialHash: 'e'.repeat(64) }, NOW);

    const revoked = store.credentials.revoke(credential.id, LATER);
    expect(revoked.revokedAt).toBe(LATER);

    // A second revocation must not move the timestamp.
    expect(store.credentials.revoke(credential.id, '2026-11-19T00:00:00.000Z').revokedAt).toBe(LATER);
  });

  it('records last use without changing anything else', () => {
    const agent = store.agents.create({ name: 'used' }, NOW);
    const credential = store.credentials.create({ agentId: agent.id, credentialHash: 'f'.repeat(64) }, NOW);

    store.credentials.touch(credential.id, LATER);
    expect(store.credentials.findById(credential.id)?.lastUsedAt).toBe(LATER);
  });

  it('rejects duplicate verifier hashes', () => {
    const first = store.agents.create({ name: 'a' }, NOW);
    const second = store.agents.create({ name: 'b' }, NOW);
    const hash = '0'.repeat(64);

    store.credentials.create({ agentId: first.id, credentialHash: hash }, NOW);
    expect(() => store.credentials.create({ agentId: second.id, credentialHash: hash }, NOW)).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_CONFLICT' }),
    );
  });
});

describe('policy repository', () => {
  it('round-trips rules and priority', () => {
    const policy = store.policies.create(
      {
        name: 'read-only',
        priority: 5,
        rules: [{ resource: 'tool', target: '*', effect: 'deny' }],
      },
      NOW,
    );

    expect(store.policies.findById(policy.id)).toMatchObject({ priority: 5, rules: policy.rules });
  });

  it('replaces rules on update instead of appending', () => {
    const policy = store.policies.create({ name: 'p', rules: [{ resource: 'backend', target: 'a', effect: 'allow' }] }, NOW);
    const updated = store.policies.update(
      policy.id,
      { rules: [{ resource: 'backend', target: 'b', effect: 'deny' }] },
      LATER,
    );

    expect(updated.rules).toEqual([{ resource: 'backend', target: 'b', effect: 'deny' }]);
  });

  it('assigns, lists and unassigns without copying the policy', () => {
    const agent = store.agents.create({ name: 'assigned' }, NOW);
    const policy = store.policies.create({ name: 'shared' }, NOW);

    store.policies.assign(agent.id, policy.id, NOW);
    expect(store.policies.listPoliciesForAgent(agent.id).map((p) => p.id)).toEqual([policy.id]);

    expect(() => store.policies.assign(agent.id, policy.id, NOW)).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_CONFLICT' }),
    );

    store.policies.unassign(agent.id, policy.id);
    expect(store.policies.listPoliciesForAgent(agent.id)).toEqual([]);
  });

  it('cascades assignments when a policy is deleted', () => {
    const agent = store.agents.create({ name: 'cascade-policy' }, NOW);
    const policy = store.policies.create({ name: 'temporary' }, NOW);
    store.policies.assign(agent.id, policy.id, NOW);

    store.policies.delete(policy.id);

    const remaining = store.handle.prepare('SELECT COUNT(*) AS count FROM agent_policy_assignments').get() as {
      count: number;
    };
    expect(remaining.count).toBe(0);
  });

  it('keeps activity history when a backend is removed', () => {
    const backend = store.backends.create({ name: 'historic', connection: { type: 'stdio', command: 'node' } }, NOW);
    store.activity.append({
      id: '22222222-2222-4222-8222-222222222222',
      type: 'backend.connected',
      backendId: backend.id,
      outcome: 'success',
      createdAt: NOW,
    });

    store.backends.softDelete(backend.id, LATER);

    // Soft delete keeps the reference valid: history remains readable.
    expect(store.activity.list(10)[0]?.backendId).toBe(backend.id);
  });
});

describe('event repositories', () => {
  it('appends activity and returns newest first', () => {
    store.activity.append({
      id: '33333333-3333-4333-8333-333333333333',
      type: 'mcp.initialize',
      outcome: 'success',
      createdAt: NOW,
    });
    store.activity.append({
      id: '44444444-4444-4444-8444-444444444444',
      type: 'tools.list',
      outcome: 'success',
      createdAt: LATER,
    });

    expect(store.activity.list(10).map((event) => event.type)).toEqual(['tools.list', 'mcp.initialize']);
    expect(store.activity.list(1)).toHaveLength(1);
    expect(store.activity.count()).toBe(2);
  });

  it('appends audit events with metadata and never exposes an update path', () => {
    const event = store.audit.append({
      id: '55555555-5555-4555-8555-555555555555',
      actorType: 'admin',
      action: 'settings.updated',
      result: 'success',
      metadata: { setting: 'logLevel', from: 'info', to: 'debug' },
      createdAt: NOW,
    });

    expect(store.audit.list(10)).toEqual([event]);
    expect(store.audit).not.toHaveProperty('update');
    expect(store.audit).not.toHaveProperty('delete');
    expect(store.activity).not.toHaveProperty('delete');
  });

  it('nulls the agent reference on activity when an agent row is hard-deleted', () => {
    const agent = store.agents.create({ name: 'vanishing' }, NOW);
    store.activity.append({
      id: '66666666-6666-4666-8666-666666666666',
      type: 'tools.call',
      agentId: agent.id,
      outcome: 'success',
      createdAt: NOW,
    });

    store.handle.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);

    expect(store.activity.list(1)[0]?.agentId).toBeUndefined();
  });
});

describe('session repository', () => {
  it('creates, reads, lists and ends a session', () => {
    const agent = store.agents.create({ name: 'session-agent' }, NOW);
    const sessionId = '77777777-7777-4777-8777-777777777777';

    const created = store.sessions.create({
      id: sessionId,
      agentId: agent.id,
      status: 'active',
      createdAt: NOW,
      lastActivityAt: NOW,
      metadata: { clientType: 'claude-code', protocolVersion: '2026-07-28' },
    });

    expect(created.status).toBe('active');
    expect(store.sessions.listByAgentId(agent.id)).toHaveLength(1);

    const ended = store.sessions.end(sessionId, LATER, 'terminated', 'operator_terminated');
    expect(ended.status).toBe('terminated');
    expect(ended.terminatedAt).toBe(LATER);
    expect(ended.terminationReason).toBe('operator_terminated');
    expect(store.sessions.count()).toBe(1);
  });

  it('refuses to reactivate a finished session', () => {
    const agent = store.agents.create({ name: 'reactivate-agent' }, NOW);
    const sessionId = '99999999-9999-4999-8999-999999999999';

    store.sessions.create({
      id: sessionId,
      agentId: agent.id,
      status: 'active',
      createdAt: NOW,
      lastActivityAt: NOW,
    });
    store.sessions.end(sessionId, LATER, 'terminated', 'operator_terminated');

    expect(() =>
      store.handle.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(sessionId),
    ).toThrow(/cannot be reactivated/);
  });

  it('refuses to move a session to another agent', () => {
    const agent = store.agents.create({ name: 'owner-agent' }, NOW);
    const other = store.agents.create({ name: 'other-agent' }, NOW);
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    store.sessions.create({
      id: sessionId,
      agentId: agent.id,
      status: 'active',
      createdAt: NOW,
      lastActivityAt: NOW,
    });

    expect(() =>
      store.handle.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run(other.id, sessionId),
    ).toThrow(/identity is immutable/);
  });

  it('derives expired status from expiresAt', () => {
    const agent = store.agents.create({ name: 'expiring' }, NOW);
    store.sessions.create({
      id: '88888888-8888-4888-8888-888888888888',
      agentId: agent.id,
      status: 'active',
      createdAt: NOW,
      lastActivityAt: NOW,
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    expect(store.sessions.findById('88888888-8888-4888-8888-888888888888')?.status).toBe('expired');
  });
});
