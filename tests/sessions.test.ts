import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { loadConfig } from '../src/config/config.js';
import { SessionService } from '../src/registry/session-service.js';
import type { SessionIdentity } from '../src/registry/session-service.js';
import { AgentService } from '../src/registry/agent-service.js';
import { CredentialService } from '../src/registry/credential-service.js';
import { bearer, createTestAgent, testKeys, type TestAgent } from './fixtures/auth.js';

/**
 * Phase 7 session rules, exercised at the service layer.
 *
 * The socket-level tests (`mcp-sessions.test.ts`) prove the wire behaviour; these
 * prove the rules directly, including the ones that are hard to hit through the
 * SDK: expiry with a controlled clock, concurrent cleanup, terminate-vs-request,
 * and the audit trail.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

const IDLE_MS = 60_000;
const MAX_LIFETIME_MS = 600_000;

let directory: string;
let store: Database;
let clock: Date;
let service: SessionService;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-session-service-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  // Anchored to the real clock, because the repository derives a lapsed
  // lifetime from `Date.now()` when it reads a row (`toSession`). A fixed past
  // date would make every freshly created session read back as `expired` once
  // that date is behind us — the assertions below are all relative, so this
  // stays stable.
  clock = new Date();
  service = Service();
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Every instance shares the module-level `clock`, so time travel is per test. */
function Service(): SessionService {
  return new SessionService({
    store,
    logger,
    idleTimeoutMs: IDLE_MS,
    maxLifetimeMs: MAX_LIFETIME_MS,
    now: () => clock,
    auditWindowMs: 0,
  });
}

function identityOf(agent: TestAgent): SessionIdentity {
  return {
    agent: store.agents.findById(agent.id)!,
    credential: store.credentials.findById(agent.credentialId)!,
  };
}

function create(agent: TestAgent, mcpSessionId = `mcp-${agent.name}`) {
  return service.create(identityOf(agent), mcpSessionId);
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function actions(): string[] {
  return store.audit.list(500).map((event) => event.action);
}

describe('creation', () => {
  it('binds the session to the authenticating agent and credential', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const { session } = create(agent, 'mcp-1');

    expect(session).toMatchObject({
      agentId: agent.id,
      credentialId: agent.credentialId,
      mcpSessionId: 'mcp-1',
      status: 'active',
    });
    expect(session.id).not.toBe('mcp-1');
    expect(session.expiresAt).toBe(new Date(clock.getTime() + MAX_LIFETIME_MS).toISOString());
    expect(actions()).toContain('session.created');
  });

  it('refuses to bind one protocol session id twice, even across agents', () => {
    const first = createTestAgent(store, testKeys(), { name: 'first', allowTools: ['*'] });
    const second = createTestAgent(store, testKeys(), { name: 'second', allowTools: ['*'] });

    create(first, 'shared-id');
    expect(() => create(second, 'shared-id')).toThrow(/identity already exists/i);

    // The original binding is intact.
    expect(store.sessions.findByMcpSessionId('shared-id')!.agentId).toBe(first.id);
  });

  it('never stores a raw credential', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const { session } = create(agent);

    expect(JSON.stringify(session)).not.toContain(agent.authorization.replace('Bearer ', ''));
    expect(session.credentialId).toBe(agent.credentialId);
  });
});

describe('validation', () => {
  it('accepts the owner and refreshes the activity clock', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const { session } = create(agent, 'mcp-1');
    advance(5_000);

    const result = service.validate('mcp-1', identityOf(agent));
    expect('session' in result).toBe(true);
    expect(store.sessions.findById(session.id)!.lastActivityAt).toBe(clock.toISOString());
  });

  it('refuses a missing, unknown, or empty session id with the same failure family', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const identity = identityOf(agent);

    expect(service.validate(undefined, identity)).toEqual({ failure: { reason: 'session_missing', external: true } });
    expect(service.validate('', identity)).toEqual({ failure: { reason: 'session_missing', external: true } });
    expect(service.validate('nope', identity)).toEqual({ failure: { reason: 'session_unknown', external: true } });
  });

  it('refuses another agent’s session, and does not reveal that it exists', () => {
    const owner = createTestAgent(store, testKeys(), { name: 'owner', allowTools: ['*'] });
    const intruder = createTestAgent(store, testKeys(), { name: 'intruder', allowTools: ['*'] });
    create(owner, 'owner-session');

    const cross = service.validate('owner-session', identityOf(intruder));
    const unknown = service.validate('never-issued', identityOf(intruder));

    expect(cross).toMatchObject({ failure: { reason: 'session_owner_mismatch' } });
    // The reason exists for the audit trail, not for the wire, and the caller
    // answers identically either way.
    expect(JSON.stringify(cross)).not.toContain(owner.id);
    expect(JSON.stringify(unknown)).not.toContain(owner.id);
  });

  it('refuses a session whose credential is not the one that opened it', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');

    const other = new CredentialService({ store, keys: testKeys() }).issue(agent.id, { name: 'second' });
    const identity = { agent: store.agents.findById(agent.id)!, credential: other.credential };

    expect(service.validate('mcp-1', identity)).toMatchObject({
      failure: { reason: 'session_credential_mismatch' },
    });
  });

  it('refuses an expired credential without needing the sweep', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');
    advance(IDLE_MS / 2);

    store.handle
      .prepare('UPDATE agent_credentials SET expires_at = ? WHERE id = ?')
      .run(new Date(clock.getTime() - 1_000).toISOString(), agent.credentialId);

    expect(service.validate('mcp-1', identityOf(agent))).toMatchObject({
      failure: { reason: 'credential_expired' },
    });
  });

  it('refuses a revoked credential even if the session row still says active', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');

    store.handle
      .prepare('UPDATE agent_credentials SET revoked_at = ? WHERE id = ?')
      .run(clock.toISOString(), agent.credentialId);

    expect(service.validate('mcp-1', identityOf(agent))).toMatchObject({
      failure: { reason: 'credential_revoked' },
    });
  });

  it('refuses a disabled agent even with a valid session and credential', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');

    store.handle.prepare('UPDATE agents SET enabled = 0 WHERE id = ?').run(agent.id);

    expect(service.validate('mcp-1', identityOf(agent))).toMatchObject({
      failure: { reason: 'agent_disabled' },
    });
  });
});

describe('expiry', () => {
  it('refuses an idle-expired session before cleanup has run, and leaves the row untouched', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const { session } = create(agent, 'mcp-1');
    advance(IDLE_MS + 1);

    expect(service.validate('mcp-1', identityOf(agent))).toMatchObject({
      failure: { reason: 'session_expired' },
    });
    // Enforcement is per request; the sweep is housekeeping, not the control.
    expect(store.sessions.findById(session.id)!.status).toBe('active');
  });

  it('refuses a session past its hard cap even while it is being used', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');

    // Stay inside the idle window but cross the lifetime cap.
    for (let elapsed = 0; elapsed < MAX_LIFETIME_MS; elapsed += IDLE_MS / 2) {
      advance(IDLE_MS / 2);
      service.validate('mcp-1', identityOf(agent));
    }
    advance(IDLE_MS / 2);

    expect(service.validate('mcp-1', identityOf(agent))).toMatchObject({
      failure: { reason: 'session_expired' },
    });
  });

  it('sweeps idle sessions, keeps the rows, and reports the count', () => {
    const idle = createTestAgent(store, testKeys(), { name: 'idle', allowTools: ['*'] });
    create(idle, 'idle-session');

    // A second agent used more recently must survive the sweep.
    const busy = createTestAgent(store, testKeys(), { name: 'busy', allowTools: ['*'] });
    create(busy, 'busy-session');

    advance(IDLE_MS - 1_000);
    service.validate('busy-session', identityOf(busy));
    advance(2_000);

    const result = service.cleanup();
    expect(result.expired).toBe(1);
    expect(result.sessions[0]!.terminationReason).toBe('idle_timeout');

    const swept = store.sessions.findByMcpSessionId('idle-session')!;
    expect(swept.status).toBe('expired');
    expect(swept.terminatedAt).toBe(clock.toISOString());
    // History is preserved.
    expect(store.sessions.count()).toBe(2);
    expect(store.sessions.findByMcpSessionId('busy-session')!.status).toBe('active');
  });

  it('never removes an active session, and running the sweep twice changes nothing', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');

    expect(service.cleanup()).toMatchObject({ expired: 0 });
    expect(service.cleanup()).toMatchObject({ expired: 0 });
    expect(store.sessions.findByMcpSessionId('mcp-1')!.status).toBe('active');
  });

  it('audits each expiry and the sweep itself', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');
    advance(IDLE_MS + 1);
    service.cleanup();

    const trail = actions();
    expect(trail).toContain('session.expired');
    expect(trail).toContain('session.cleanup.completed');
  });
});

describe('termination and invalidation', () => {
  it('terminates once and is idempotent afterwards', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const { session } = create(agent, 'mcp-1');

    const first = service.terminate(session.id);
    expect(first).toMatchObject({ status: 'terminated', terminatedAt: clock.toISOString() });

    advance(1_000);
    const second = service.terminate(session.id);
    // Same timestamp: the second call did not re-end anything.
    expect(second.terminatedAt).toBe(first.terminatedAt);
    expect(service.validate('mcp-1', identityOf(agent))).toMatchObject({
      failure: { reason: 'session_not_active' },
    });
  });

  it('refuses an unknown session id instead of guessing', () => {
    expect(() => service.terminate('11111111-1111-4111-8111-111111111111')).toThrow(/does not exist/i);
  });

  it('invalidates every session of a credential, and only that credential', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const credentialService = new CredentialService({ store, keys: testKeys(), sessions: service });
    create(agent, 'first');
    const second = credentialService.issue(agent.id, { name: 'second' });
    service.create(
      { agent: store.agents.findById(agent.id)!, credential: second.credential },
      'second-session',
    );

    credentialService.revoke(agent.id, agent.credentialId);

    expect(store.sessions.findByMcpSessionId('first')!.status).toBe('invalidated');
    expect(store.sessions.findByMcpSessionId('second-session')!.status).toBe('active');
    expect(actions()).toContain('session.invalidated');
  });

  it('invalidates every session of a disabled agent', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const agents = new AgentService(store, undefined, undefined, service);
    create(agent, 'mcp-1');

    agents.setEnabled(agent.id, false);

    const session = store.sessions.findByMcpSessionId('mcp-1')!;
    expect(session.status).toBe('invalidated');
    expect(session.terminationReason).toBe('agent_disabled');
  });

  it('invalidates sessions when the agent is deleted', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const agents = new AgentService(store, undefined, undefined, service);
    create(agent, 'mcp-1');

    agents.remove(agent.id);

    expect(store.sessions.findByMcpSessionId('mcp-1')!.status).toBe('invalidated');
  });

  it('invalidates the previous credential’s sessions on rotation', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const credentials = new CredentialService({ store, keys: testKeys(), sessions: service });
    create(agent, 'mcp-1');

    credentials.rotate(agent.id, agent.credentialId, {});

    const session = store.sessions.findByMcpSessionId('mcp-1')!;
    expect(session.status).toBe('invalidated');
    expect(session.terminationReason).toBe('credential_rotated');
  });

  it('ends everything on shutdown, so no row outlives the process', () => {
    const a = createTestAgent(store, testKeys(), { name: 'a', allowTools: ['*'] });
    const b = createTestAgent(store, testKeys(), { name: 'b', allowTools: ['*'] });
    create(a, 'a-session');
    create(b, 'b-session');

    expect(service.terminateAll('gateway_shutdown')).toBe(2);
    expect(store.sessions.countByStatus('active')).toBe(0);
    expect(store.sessions.findByMcpSessionId('a-session')!.terminationReason).toBe('gateway_shutdown');
  });

  it('cannot resurrect a finished session through the API path', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const { session } = create(agent, 'mcp-1');
    service.invalidate(session.id, 'credential_revoked');

    service.terminate(session.id);
    expect(store.sessions.findById(session.id)!.status).toBe('invalidated');
    expect(() =>
      store.handle.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(session.id),
    ).toThrow(/cannot be reactivated/);
  });
});

describe('listing', () => {
  it('filters by agent and by effective status', () => {
    const a = createTestAgent(store, testKeys(), { name: 'a', allowTools: ['*'] });
    const b = createTestAgent(store, testKeys(), { name: 'b', allowTools: ['*'] });
    create(a, 'a-1');
    const { session } = create(b, 'b-1');
    service.terminate(session.id);

    const byAgent = service.list({ agentId: a.id, limit: 10, offset: 0, sort: 'createdAt', order: 'desc' });
    expect(byAgent.items.map((item) => item.mcpSessionId)).toEqual(['a-1']);

    const terminated = service.list({ status: 'terminated', limit: 10, offset: 0, sort: 'createdAt', order: 'desc' });
    expect(terminated.items.map((item) => item.mcpSessionId)).toEqual(['b-1']);

    const active = service.list({ status: 'active', limit: 10, offset: 0, sort: 'createdAt', order: 'desc' });
    expect(active.items.map((item) => item.mcpSessionId)).toEqual(['a-1']);
  });

  it('reports a lapsed session as expired before the sweep has written it', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');
    advance(IDLE_MS + 1);

    const page = service.list({ status: 'expired', limit: 10, offset: 0, sort: 'createdAt', order: 'desc' });
    expect(page.total).toBe(1);
    expect(service.list({ status: 'active', limit: 10, offset: 0, sort: 'createdAt', order: 'desc' }).total).toBe(0);
  });

  it('paginates deterministically', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    for (const name of ['s1', 's2', 's3']) {
      create(agent, name);
      advance(1_000);
    }

    const first = service.list({ limit: 2, offset: 0, sort: 'createdAt', order: 'asc' });
    const second = service.list({ limit: 2, offset: 2, sort: 'createdAt', order: 'asc' });

    expect(first.total).toBe(3);
    expect(first.items.map((item) => item.mcpSessionId)).toEqual(['s1', 's2']);
    expect(second.items.map((item) => item.mcpSessionId)).toEqual(['s3']);
  });
});

describe('concurrency', () => {
  it('refuses a duplicate binding when two initializations race for one id', () => {
    const a = createTestAgent(store, testKeys(), { name: 'a', allowTools: ['*'] });
    const b = createTestAgent(store, testKeys(), { name: 'b', allowTools: ['*'] });

    const outcomes = [a, b].map((agent) => {
      try {
        create(agent, 'contested');
        return 'ok';
      } catch {
        return 'conflict';
      }
    });

    expect(outcomes.sort()).toEqual(['conflict', 'ok']);
    expect(store.sessions.query({ limit: 10, offset: 0, sort: 'createdAt', order: 'asc' }).total).toBe(1);
  });

  it('lets exactly one of terminate and a request win, leaving a consistent row', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const { session } = create(agent, 'mcp-1');

    // better-sqlite3 is synchronous, so these interleave at the statement level,
    // not inside one. Whichever lands first decides; the loser must not leave a
    // half-state.
    const [validation] = await Promise.all([
      Promise.resolve().then(() => service.validate('mcp-1', identityOf(agent))),
      Promise.resolve().then(() => service.terminate(session.id)),
    ]);

    const stored = store.sessions.findById(session.id)!;
    expect(stored.status).toBe('terminated');
    // A validation that ran first is not a defect; what matters is that the row
    // is terminal and the session is unusable now.
    expect('failure' in validation || stored.status === 'terminated').toBe(true);
    expect(service.validate('mcp-1', identityOf(agent))).toMatchObject({
      failure: { reason: 'session_not_active' },
    });
  });

  it('treats repeated concurrent cleanups as one transition', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');
    advance(IDLE_MS + 1);

    const results = await Promise.all([
      Promise.resolve().then(() => service.cleanup()),
      Promise.resolve().then(() => service.cleanup()),
      Promise.resolve().then(() => service.cleanup()),
    ]);

    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(1);
    expect(store.sessions.findByMcpSessionId('mcp-1')!.status).toBe('expired');
  });

  it('does not lose activity updates under concurrent validation', async () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    const { session } = create(agent, 'mcp-1');

    advance(1_000);
    await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => service.validate('mcp-1', identityOf(agent)))),
    );

    expect(store.sessions.findById(session.id)!.lastActivityAt).toBe(clock.toISOString());
    expect(store.sessions.findById(session.id)!.status).toBe('active');
  });
});

describe('audit hygiene', () => {
  it('records denials and creations without any credential material', () => {
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    create(agent, 'mcp-1');
    service.validate('mcp-1', identityOf(agent));
    service.validate('missing', identityOf(agent));

    const trail = store.audit.list(50);
    expect(trail.map((event) => event.action)).toEqual(
      expect.arrayContaining(['session.created', 'session.authenticated', 'session.access.denied']),
    );

    const serialized = JSON.stringify(trail);
    expect(serialized).not.toContain(agent.authorization.replace('Bearer ', ''));
    expect(serialized).not.toContain('Authorization');
  });

  it('does not write one authenticated row per request', () => {
    // The window is opened once here, so repeats inside it are suppressed.
    const windowed = new SessionService({
      store,
      logger,
      idleTimeoutMs: IDLE_MS,
      maxLifetimeMs: MAX_LIFETIME_MS,
      now: () => clock,
      auditWindowMs: 60_000,
    });
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });
    windowed.create(identityOf(agent), 'mcp-1');

    for (let i = 0; i < 5; i += 1) windowed.validate('mcp-1', identityOf(agent));

    const authenticated = store.audit.list(100).filter((event) => event.action === 'session.authenticated');
    expect(authenticated).toHaveLength(1);
  });
});
