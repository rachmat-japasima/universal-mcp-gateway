import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeBody, revokeCredential, startHarness, type Harness } from './harness.js';

/**
 * Scenario D — session isolation, from a client's chair.
 *
 * A session is a routing handle owned by one agent. Two agents never share
 * one, one agent may hold several concurrently, and nobody can borrow another
 * agent's handle even with a working credential of their own. Death by
 * revocation, expiry, or idle timeout is enforced per request, not by a sweep.
 */

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const list = { jsonrpc: '2.0' as const, id: 2, method: 'tools/list' };

describe('session isolation', () => {
  it('gives two agents two independent sessions, each bound to its owner', async () => {
    const one = h.agent({ name: 'one', allowTools: ['*'] });
    const two = h.agent({ name: 'two', allowTools: ['*'] });

    const first = await h.rpc({ Authorization: one.authorization }, initializeBody);
    const second = await h.rpc({ Authorization: two.authorization }, initializeBody);
    expect(first.sessionId).toBeTruthy();
    expect(second.sessionId).toBeTruthy();
    expect(first.sessionId).not.toBe(second.sessionId);

    const rowOne = h.store.sessions.findByMcpSessionId(first.sessionId!)!;
    const rowTwo = h.store.sessions.findByMcpSessionId(second.sessionId!)!;
    expect(rowOne.agentId).toBe(one.id);
    expect(rowTwo.agentId).toBe(two.id);

    for (const [session, identity] of [
      [first, one],
      [second, two],
    ] as const) {
      const answer = await h.rpc(
        { Authorization: identity.authorization, 'mcp-session-id': session.sessionId! },
        list,
      );
      expect(answer.status).toBe(200);
    }
  });

  it('serves concurrent sessions of one agent without takeover', async () => {
    const agent = h.agent({ allowTools: ['*'] });
    const first = await h.rpc({ Authorization: agent.authorization }, initializeBody);
    const second = await h.rpc({ Authorization: agent.authorization }, initializeBody);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(h.store.sessions.countByStatus('active')).toBe(2);

    for (const session of [first, second]) {
      const answer = await h.rpc(
        { Authorization: agent.authorization, 'mcp-session-id': session.sessionId! },
        list,
      );
      expect(answer.status).toBe(200);
    }
  });

  it('refuses a session id presented by another agent, even with a working credential', async () => {
    const owner = h.agent({ name: 'owner', allowTools: ['*'] });
    const intruder = h.agent({ name: 'intruder', allowTools: ['*'] });
    const initialized = await h.rpc({ Authorization: owner.authorization }, initializeBody);

    const stolen = await h.rpc(
      { Authorization: intruder.authorization, 'mcp-session-id': initialized.sessionId! },
      list,
    );
    expect(stolen.status).toBe(404);
    expect(stolen.text).toContain('Session not found');
  });

  it('stops serving a session whose credential was revoked', async () => {
    const agent = h.agent({ allowTools: ['*'] });
    const initialized = await h.rpc({ Authorization: agent.authorization }, initializeBody);
    const session = initialized.sessionId!;

    const before = await h.rpc({ Authorization: agent.authorization, 'mcp-session-id': session }, list);
    expect(before.status).toBe(200);

    revokeCredential(h, agent);

    // Authentication refuses first: the revoked credential never reaches
    // session validation.
    const refused = await h.rpc({ Authorization: agent.authorization, 'mcp-session-id': session }, list);
    expect(refused.status).toBe(401);
  });

  it('refuses an idle-expired session on the next request, before any sweep', async () => {
    const agent = h.agent({ allowTools: ['*'] });
    const initialized = await h.rpc({ Authorization: agent.authorization }, initializeBody);
    const session = initialized.sessionId!;
    expect(initialized.status).toBe(200);

    // The config floor is 60 s, so the activity clock is moved back instead of
    // waiting — the same idiom as the Phase 7 suite. The session row stays
    // `active`: only the request-time check can refuse it.
    h.store.handle
      .prepare('UPDATE sessions SET last_activity_at = ? WHERE mcp_session_id = ?')
      .run(new Date(Date.now() - 120_000).toISOString(), session);

    const refused = await h.rpc({ Authorization: agent.authorization, 'mcp-session-id': session }, list);
    expect(refused.status).toBe(404);
    expect(refused.text).toContain('Session not found');
    expect(h.store.sessions.findByMcpSessionId(session)!.status).toBe('active');
  });
});
