import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeBody, initializedNotification, JSON_HEADERS, startHarness, type Harness } from './harness.js';

/**
 * Scenario A — basic protocol, from a client's chair.
 *
 * The flow every MCP client in the matrix performs: initialize, the
 * initialized notification, list, call, unknown tool, disconnect. Two of
 * these have never had a test of their own — the explicit notification, and
 * the DELETE that a disconnected client sends — and both are behavior real
 * clients depend on.
 */

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe('basic protocol', () => {
  it('initializes, lists, calls an authorized tool, and receives a valid result', async () => {
    await h.backend('fixture-a', 'a');
    const agent = h.agent({ allowTools: ['*'] });
    const client = await h.client(agent);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(tools.nextCursor).toBeUndefined();

    const echo = tools.tools.find((tool) => tool.name.endsWith('__echo'));
    expect(echo).toBeDefined();

    const result = await client.callTool({ name: echo!.name, arguments: { text: 'compat' } });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('compat') }]);
  });

  it('serves the same flow on the modern per-request era', async () => {
    await h.backend('fixture-a', 'a');
    const client = await h.client(h.agent({ allowTools: ['*'] }), true);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
  });

  it('accepts an explicit initialized notification, and a duplicate of it, without disturbing the session', async () => {
    const agent = h.agent({ allowTools: ['*'] });

    const initialized = await h.rpc({ Authorization: agent.authorization }, initializeBody);
    expect(initialized.status).toBe(200);
    const sessionId = initialized.sessionId!;
    expect(sessionId).toBeTruthy();

    // The SDK client sends this once during connect; a client that sends it
    // again (or sends it raw, as older libraries do) must not break anything.
    const repeat = await h.rpc({ Authorization: agent.authorization, 'mcp-session-id': sessionId }, initializedNotification);
    expect(repeat.status).toBe(202);

    // The session is still the session: the next request through it works.
    const listed = await h.rpc({ Authorization: agent.authorization, 'mcp-session-id': sessionId }, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain('"tools"');
  });

  it('answers a tools/list that carries a cursor with the full list, and no nextCursor', async () => {
    await h.backend('fixture-a', 'a');
    const agent = h.agent({ allowTools: ['*'] });
    const client = await h.client(agent);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    // A client resuming a stale cursor (or one that invents one) gets the
    // bounded snapshot once, not a loop or an error. The stateless leg answers
    // in an SSE frame, like every successful exchange does.
    const resumed = await h.rpc({ Authorization: agent.authorization }, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: { cursor: 'stale-opaque-cursor' },
    });
    expect(resumed.status).toBe(200);
    const frame = JSON.parse(resumed.text.split('data: ').at(-1) ?? resumed.text);
    const body = frame.result as { tools: Array<{ name: string }>; nextCursor?: string };
    expect(body.tools.map((tool) => tool.name)).toEqual(names);
    expect(body.nextCursor).toBeUndefined();
  });

  it('answers an unknown tool with InvalidParams and no internal detail', async () => {
    await h.backend('fixture-a', 'a');
    const client = await h.client(h.agent({ allowTools: ['*'] }));

    const caught = (await client
      .callTool({ name: 'never_registered', arguments: {} })
      .catch((error: unknown) => error)) as { code?: number; message?: string };
    expect(caught.code).toBe(-32602);
    expect(caught.message).toBe('Unknown tool');
    expect(JSON.stringify(caught)).not.toContain('backend');
  });

  it('terminates the session on a client DELETE, and the dead id is refused afterwards', async () => {
    const agent = h.agent({ allowTools: ['*'] });
    const initialized = await h.rpc({ Authorization: agent.authorization }, initializeBody);
    const sessionId = initialized.sessionId!;
    const before = h.store.sessions.countByStatus('active');
    expect(before).toBeGreaterThan(0);

    // The Streamable HTTP shutdown a client performs when it goes away.
    const deleted = await fetch(h.url, {
      method: 'DELETE',
      headers: { ...JSON_HEADERS, Authorization: agent.authorization, 'mcp-session-id': sessionId },
    });
    expect([202, 200].includes(deleted.status)).toBe(true);

    await h.until(() => h.store.sessions.countByStatus('active') === 0, 'session termination');

    const after = await h.rpc(
      { Authorization: agent.authorization, 'mcp-session-id': sessionId },
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
    );
    expect(after.status).toBe(404);
    expect(after.text).toContain('Session not found');
  });

  it('disconnects cleanly through the SDK client', async () => {
    await h.backend('fixture-a', 'a');
    const client = await h.client(h.agent({ allowTools: ['*'] }));
    await client.listTools();
    await client.close();
  });
});
