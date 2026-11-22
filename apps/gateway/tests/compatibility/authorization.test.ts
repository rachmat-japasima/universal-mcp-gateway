import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './harness.js';

/**
 * Scenario C — authorization, from a client's chair.
 *
 * The property that matters to a client: the catalog it sees and the calls it
 * can make are the same boundary. A tool it may not call is not in its list,
 * and asking for it by name is indistinguishable from asking for a tool that
 * never existed. Deny beats allow, and a refusal never touches routing.
 */

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe('authorization', () => {
  it('shows exactly the granted tool, and calls it', async () => {
    const id = await h.backend('fixture-a', 'a');
    const client = await h.client(h.agent({ name: 'scoped', allowTools: [`${id}__echo`] }));

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual([`${id}__echo`]);

    const result = await client.callTool({ name: `${id}__echo`, arguments: { text: 'granted' } });
    expect(result.isError).toBeFalsy();
  });

  it('default-deny: an ungranted agent sees nothing, and a real tool name answers exactly like a fabricated one', async () => {
    const id = await h.backend('fixture-a', 'a');
    const blind = await h.client(h.agent({ name: 'blind' }));
    expect((await blind.listTools()).tools).toEqual([]);

    // `Error` fields do not survive JSON.stringify, so the comparison is on
    // the observable properties a client reads: code and message.
    const denied = (await blind.callTool({ name: `${id}__echo`, arguments: {} }).catch((error: unknown) => error)) as {
      code?: number;
      message?: string;
    };
    const invented = (await blind.callTool({ name: 'nope__nope', arguments: {} }).catch((error: unknown) => error)) as {
      code?: number;
      message?: string;
    };

    expect(denied).toMatchObject({ code: -32602, message: 'Unknown tool' });
    expect({ code: denied.code, message: denied.message }).toEqual({
      code: invented.code,
      message: invented.message,
    });
  });

  it('deny overrides allow: the denied tool vanishes from the list and refuses calls', async () => {
    const id = await h.backend('fixture-a', 'a');
    const client = await h.client(h.agent({ allowTools: ['*'], denyTools: [`${id}__echo`] }));

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain(`${id}__echo`);
    expect(names.length).toBeGreaterThan(0);

    await expect(client.callTool({ name: `${id}__echo`, arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('authorizes before routing: a denied call leaves no tool activity, an allowed one leaves exactly one', async () => {
    const id = await h.backend('fixture-a', 'a');
    const blind = await h.client(h.agent({ name: 'blind' }));
    const allowed = await h.client(h.agent({ allowTools: ['*'] }));

    await blind.callTool({ name: `${id}__echo`, arguments: {} }).catch(() => undefined);
    expect(h.store.activity.list(50).filter((event) => event.type === 'tools.call')).toEqual([]);

    await allowed.callTool({ name: `${id}__echo`, arguments: { text: 'routed' } });
    expect(h.store.activity.list(50).filter((event) => event.type === 'tools.call').length).toBe(1);
  });
});
