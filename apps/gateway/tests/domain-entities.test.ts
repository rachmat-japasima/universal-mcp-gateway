import { describe, expect, it } from 'vitest';

import { createAgentSchema, updateAgentSchema } from '../src/domain/agent.js';
import { credentialStatus, isCredentialUsable, agentCredentialSchema } from '../src/domain/agent-credential.js';
import { createPolicySchema, comparePolicyRules } from '../src/domain/policy.js';
import { sessionStatus } from '../src/domain/session.js';
import { activityEventSchema } from '../src/domain/activity-event.js';
import { auditEventSchema } from '../src/domain/audit-event.js';

const AGENT_ID = '9b2f8b57-3f4d-4a2e-9c2e-0f3f2a1b2c3d';
const HASH = 'a'.repeat(64);
const NOW = '2026-11-18T00:00:00.000Z';

describe('agents', () => {
  it('accepts a minimal agent with defaults', () => {
    expect(createAgentSchema.parse({ name: 'claude-code' })).toEqual({ name: 'claude-code', enabled: true });
  });

  it('rejects an unknown client type and unknown fields', () => {
    expect(() => createAgentSchema.parse({ name: 'x', clientType: 'vscode' })).toThrow();
    expect(() => createAgentSchema.parse({ name: 'x', token: 'secret' })).toThrow();
  });

  it('lets an update clear clientType but not omit it silently', () => {
    expect(updateAgentSchema.parse({ clientType: null })).toEqual({ clientType: null });
    expect(updateAgentSchema.parse({})).toEqual({});
  });
});

describe('agent credentials', () => {
  const credential = agentCredentialSchema.parse({
    id: AGENT_ID,
    agentId: AGENT_ID,
    credentialHash: HASH,
    createdAt: NOW,
  });

  it('requires a lowercase hex sha-256 verifier, never a raw token', () => {
    expect(() =>
      agentCredentialSchema.parse({ ...credential, credentialHash: 'plain-token-value' }),
    ).toThrow();
    expect(() => agentCredentialSchema.parse({ ...credential, credentialHash: HASH.toUpperCase() })).toThrow();
  });

  it('derives active, expired and revoked status from timestamps', () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    expect(credentialStatus(credential, now)).toBe('active');
    expect(credentialStatus({ ...credential, expiresAt: '2026-11-18T11:00:00.000Z' }, now)).toBe('expired');
    expect(credentialStatus({ ...credential, revokedAt: '2026-11-18T13:00:00.000Z' }, now)).toBe('revoked');
  });

  it('treats revocation as winning over expiry, and blocks unusable credentials', () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    const revokedAndExpired = { ...credential, expiresAt: '2026-11-18T11:00:00.000Z', revokedAt: '2026-11-18T13:00:00.000Z' };

    expect(credentialStatus(revokedAndExpired, now)).toBe('revoked');
    expect(isCredentialUsable(revokedAndExpired, now)).toBe(false);
    expect(isCredentialUsable(credential, now)).toBe(true);
  });
});

describe('policies', () => {
  it('accepts allow and deny rules with defaults', () => {
    const policy = createPolicySchema.parse({
      name: 'default',
      rules: [
        { resource: 'backend', target: 'figcraft', effect: 'allow' },
        { resource: 'tool', target: '*', effect: 'deny' },
      ],
    });

    expect(policy.priority).toBe(0);
    expect(policy.rules).toHaveLength(2);
  });

  it('rejects an unknown resource or effect', () => {
    expect(createPolicySchema.parse({ name: 'p', rules: [] })).toMatchObject({ rules: [] });
    expect(() => createPolicySchema.parse({ name: 'p', rules: [{ resource: 'file', target: '*', effect: 'allow' }] })).toThrow();
    expect(() => createPolicySchema.parse({ name: 'p', rules: [{ resource: 'tool', target: '*', effect: 'maybe' }] })).toThrow();
  });

  it('resolves conflicts deterministically: priority first, then id', () => {
    const high = { priority: 10, id: 'zzz' };
    const low = { priority: 1, id: 'aaa' };
    expect(comparePolicyRules(high, low)).toBeLessThan(0);
    expect(comparePolicyRules(low, high)).toBeGreaterThan(0);

    // Equal priority: ordering by id, never by row order.
    expect(comparePolicyRules({ priority: 5, id: 'aaa' }, { priority: 5, id: 'bbb' })).toBeLessThan(0);
    expect(comparePolicyRules({ priority: 5, id: 'aaa' }, { priority: 5, id: 'aaa' })).toBe(0);
  });
});

describe('sessions', () => {
  const session = {
    id: AGENT_ID,
    agentId: AGENT_ID,
    status: 'active' as const,
    createdAt: NOW,
    lastActivityAt: NOW,
  };

  it('derives status from timestamps instead of trusting the stored field', () => {
    const now = new Date('2026-11-18T12:00:00.000Z');
    expect(sessionStatus(session, now)).toBe('active');
    expect(sessionStatus({ ...session, expiresAt: '2026-11-18T11:00:00.000Z' }, now)).toBe('expired');
    expect(sessionStatus({ ...session, status: 'invalidated' }, now)).toBe('invalidated');
    expect(sessionStatus({ ...session, status: 'terminated' }, now)).toBe('terminated');
  });
});

describe('events', () => {
  it('accepts an activity event without tool arguments or results', () => {
    const event = activityEventSchema.parse({
      id: AGENT_ID,
      type: 'tools.call',
      outcome: 'success',
      toolName: 'figcraft__create',
      durationMs: 12,
      createdAt: NOW,
    });

    expect(event).not.toHaveProperty('arguments');
    expect(() =>
      activityEventSchema.parse({ ...event, arguments: { secret: 'leak' } }),
    ).toThrow();
  });

  it('rejects an unknown activity type and outcome', () => {
    const base = { id: AGENT_ID, outcome: 'success' as const, createdAt: NOW };
    expect(() => activityEventSchema.parse({ ...base, type: 'tool.exploded' })).toThrow();
    expect(() => activityEventSchema.parse({ ...base, type: 'tools.call', outcome: 'maybe' })).toThrow();
  });

  it('accepts an audit event with bounded flat metadata', () => {
    const event = auditEventSchema.parse({
      id: AGENT_ID,
      actorType: 'admin',
      action: 'backend.created',
      targetType: 'backend',
      targetId: AGENT_ID,
      result: 'success',
      metadata: { name: 'example' },
      createdAt: NOW,
    });

    expect(event.metadata).toEqual({ name: 'example' });
  });

  it('rejects nested audit metadata and oversized metadata', () => {
    const base = { id: AGENT_ID, actorType: 'admin' as const, action: 'settings.updated' as const, result: 'success' as const, createdAt: NOW };
    expect(() => auditEventSchema.parse({ ...base, metadata: { nested: { a: 1 } } })).toThrow();

    const twentyOne = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect(() => auditEventSchema.parse({ ...base, metadata: twentyOne })).toThrow(/at most 20/);
  });

  it('rejects an unknown audit action or actor', () => {
    const base = { id: AGENT_ID, actorType: 'admin' as const, result: 'success' as const, createdAt: NOW };
    expect(() => auditEventSchema.parse({ ...base, action: 'database.dropped' })).toThrow();
    expect(() => auditEventSchema.parse({ ...base, action: 'auth.failed', actorType: 'intruder' })).toThrow();
  });
});
