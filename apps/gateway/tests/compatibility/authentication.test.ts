import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expiredCredential, initializeBody, revokeCredential, startHarness, type Harness } from './harness.js';

/**
 * Scenario B — authentication, from a client's chair.
 *
 * Every failure must be one indistinguishable 401: a probing client cannot
 * learn whether its token was almost right, whose token would have worked, or
 * whether an agent exists at all. The positive case must authenticate the
 * *right* agent, and one agent's session must never accept another agent's
 * credential.
 */

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe('authentication', () => {
  it('answers every authentication failure with one indistinguishable 401', async () => {
    const agent = h.agent({ allowTools: ['*'] });
    revokeCredential(h, agent);
    const expired = expiredCredential(h, agent.id);

    const missing = await h.rpc({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const invalid = await h.rpc({ Authorization: 'Bearer umg_not-a-real-token' }, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const malformed = await h.rpc({ Authorization: 'Basic anything' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const revoked = await h.rpc({ Authorization: agent.authorization }, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const expiredResponse = await h.rpc({ Authorization: `Bearer ${expired.token}` }, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    for (const answer of [invalid, malformed, revoked, expiredResponse]) {
      expect(answer.status, 'uniform status').toBe(401);
      expect(answer.text, 'uniform body').toBe(missing.text);
    }
  });

  it('authenticates the correct agent, and only that agent', async () => {
    await h.backend('fixture-a', 'a');
    const owner = h.agent({ name: 'owner', allowTools: ['*'] });
    const stranger = h.agent({ name: 'stranger' }); // no policy: default-deny

    const ownerClient = await h.client(owner);
    const ownerTools = (await ownerClient.listTools()).tools.map((tool) => tool.name);
    expect(ownerTools.length).toBeGreaterThan(0);

    const strangerClient = await h.client(stranger);
    const strangerTools = (await strangerClient.listTools()).tools;
    expect(strangerTools).toEqual([]);
  });

  it('rejects another agent presenting a live session id', async () => {
    const owner = h.agent({ allowTools: ['*'] });
    const thief = h.agent({ name: 'thief', allowTools: ['*'] });

    const initialized = await h.rpc({ Authorization: owner.authorization }, initializeBody);
    const sessionId = initialized.sessionId!;
    expect(sessionId).toBeTruthy();

    // A stolen routing handle plus a working credential of one's own still
    // fails: the session belongs to the agent that created it.
    const stolen = await h.rpc({ Authorization: thief.authorization, 'mcp-session-id': sessionId }, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(stolen.status).toBe(404);
    expect(stolen.text).toContain('Session not found');
  });
});
