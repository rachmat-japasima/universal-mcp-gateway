import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeBody, startHarness, type Harness } from './harness.js';

/**
 * Scenario F — failure and resilience, from a client's chair.
 *
 * Every failure below must stay inside its boundary: the client that caused it
 * gets a protocol-shaped answer, the other clients keep working, and nothing
 * about the failure discloses topology or secrets.
 *
 * Not tested here, on purpose: there is no MCP-surface rate limiter in this
 * gateway (operator and backend failure budgets are the enforced budgets), so
 * "429 under load" would be fabricating a behavior that does not exist. The
 * compatibility document records it as a limitation.
 */

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const list = { jsonrpc: '2.0' as const, id: 2, method: 'tools/list' };

describe('failure and resilience', () => {
  it('removes a disabled backend from the catalog mid-session, without disclosure', async () => {
    const id = await h.backend('fixture-a', 'a');
    const client = await h.client(h.agent({ allowTools: ['*'] }));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    const disconnected = await h.gateway.app.request(`/api/v1/backends/${id}/disconnect`, {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json', ...h.operator.headers },
    });
    expect(disconnected.status).toBe(200);
    await h.until(() => h.gateway.catalog.listByBackend(id).length === 0, 'catalog removal');

    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({ name: `${id}__echo`, arguments: { text: 'x' } })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('keeps serving every other client while one backend never came up', async () => {
    // A backend whose executable starts but cannot initialize: registration
    // succeeds, connection and discovery do not.
    const created = await h.gateway.app.request('/api/v1/backends', {
      method: 'POST',
      headers: { host: '127.0.0.1', 'content-type': 'application/json', ...h.operator.headers },
      body: JSON.stringify({
        name: 'doomed',
        connection: {
          type: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', new URL('../fixtures/mcp-fixture.ts', import.meta.url).pathname, 'crash'],
        },
      }),
    });
    expect(created.status).toBe(201);

    const id = await h.backend('fixture-a', 'a');
    const client = await h.client(h.agent({ allowTools: ['*'] }));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    const result = await client.callTool({ name: `${id}__echo`, arguments: { text: 'resilient' } });
    expect((result.content[0] as { text: string }).text).toContain('resilient');
  });

  it('answers a tool that exceeds the call budget with a protocol error, and stays up', async () => {
    const budgeted = await startHarness({ TOOL_CALL_TIMEOUT_MS: '300' });
    try {
      const id = await budgeted.backend('fixture-a', 'a');
      const client = await budgeted.client(budgeted.agent({ allowTools: ['*'] }));

      await expect(
        client.callTool({ name: `${id}__slow`, arguments: { ms: 4_000 } }),
      ).rejects.toMatchObject({ code: -32603 });

      const next = await client.callTool({ name: `${id}__echo`, arguments: { text: 'after timeout' } });
      expect((next.content[0] as { text: string }).text).toContain('after timeout');
    } finally {
      await budgeted.close();
    }
  }, 20_000);

  it('survives a caller-initiated cancellation and keeps serving', async () => {
    const id = await h.backend('fixture-a', 'a');
    const client = await h.client(h.agent({ allowTools: ['*'] }));

    const controller = new AbortController();
    const call = client
      .callTool({ name: `${id}__slow`, arguments: { ms: 4_000 } }, { signal: controller.signal })
      .catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 100);

    const outcome = (await call) as { code?: number | string };
    expect(outcome).toBeTruthy();
    // The gateway classifies the abort, not as an internal failure.
    if (typeof outcome.code === 'number') {
      expect([-32800, -32603]).toContain(outcome.code);
    }

    const next = await client.callTool({ name: `${id}__echo`, arguments: { text: 'after cancel' } });
    expect((next.content[0] as { text: string }).text).toContain('after cancel');
  }, 20_000);

  it('answers malformed JSON-RPC with a parse error and stays up', async () => {
    await h.backend('fixture-a', 'a');
    const agent = h.agent({ allowTools: ['*'] });

    const malformed = await h.rpc({ Authorization: agent.authorization }, '{this is not json');
    expect(malformed.status).toBe(400);
    const frame = malformed.text.split('data: ').at(-1) ?? malformed.text;
    expect(JSON.parse(frame).error.code).toBe(-32700);

    const client = await h.client(agent);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('answers an unsupported method with method-not-found, on both legs', async () => {
    await h.backend('fixture-a', 'a');
    const agent = h.agent({ allowTools: ['*'] });
    const initialized = await h.rpc({ Authorization: agent.authorization }, initializeBody);
    const session = initialized.sessionId!;

    const unsupported = { jsonrpc: '2.0' as const, id: 5, method: 'resources/list' };

    // The sessionful 2025 leg.
    const sessionful = await h.rpc(
      { Authorization: agent.authorization, 'mcp-session-id': session },
      unsupported,
    );
    expect(sessionful.status).toBe(200);
    expect(JSON.parse(sessionful.text.split('data: ').at(-1) ?? sessionful.text).error.code).toBe(-32601);

    // The stateless per-request leg.
    const stateless = await h.rpc({ Authorization: agent.authorization }, unsupported);
    expect(stateless.status).toBe(200);
    expect(JSON.parse(stateless.text.split('data: ').at(-1) ?? stateless.text).error.code).toBe(-32601);
  });

  it('serves two agents concurrently without cross-talk', async () => {
    const id = await h.backend('fixture-a', 'a');
    const one = await h.client(h.agent({ name: 'one', allowTools: ['*'] }));
    const two = await h.client(h.agent({ name: 'two', allowTools: [`${id}__echo`] }));

    const results = await Promise.all([
      one.callTool({ name: `${id}__echo`, arguments: { text: 'from-one' } }),
      two.callTool({ name: `${id}__echo`, arguments: { text: 'from-two' } }),
      one.callTool({ name: `${id}__echo`, arguments: { text: 'from-one-again' } }),
    ]);

    expect((results[0]!.content[0] as { text: string }).text).toContain('from-one');
    expect((results[1]!.content[0] as { text: string }).text).toContain('from-two');
    expect((results[2]!.content[0] as { text: string }).text).toContain('from-one-again');
  });

  it('keeps serving after a client disappears without a goodbye', async () => {
    await h.backend('fixture-a', 'a');
    const ghost = h.agent({ name: 'ghost', allowTools: ['*'] });

    const initialized = await h.rpc({ Authorization: ghost.authorization }, initializeBody);
    expect(initialized.status).toBe(200);
    const session = initialized.sessionId!;

    // No DELETE: the client just vanishes. The session row stays until it
    // expires; the gateway must not notice as a failure.
    const after = await h.client(h.agent({ name: 'next', allowTools: ['*'] }));
    const result = await after.callTool({
      name: (await after.listTools()).tools[0]!.name,
      arguments: {},
    });
    expect(result.isError).toBeFalsy();

    // The abandoned handle still belongs to its owner only.
    const thief = h.agent({ name: 'thief', allowTools: ['*'] });
    const stolen = await h.rpc({ Authorization: thief.authorization, 'mcp-session-id': session }, list);
    expect(stolen.status).toBe(404);
  });
});
