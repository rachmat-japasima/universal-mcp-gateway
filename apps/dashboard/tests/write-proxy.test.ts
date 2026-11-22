import { describe, expect, it } from 'vitest';

import { isAllowedWrite, writeTarget } from '@/lib/api/write-policy';

/**
 * The write proxy's perimeter.
 *
 * A `true` here is permission to forward an operator-authenticated mutation to
 * the management API, so the refusals matter more than the acceptances. The
 * traversal cases are the reason the expressions are anchored with `$`: without
 * that, `/api/v1/backends/<uuid>/../../agents` would still match the prefix and
 * the proxy would happily forward it to the gateway.
 */

const ID = '11111111-1111-4111-8111-111111111111';

describe('isAllowedWrite', () => {
  it('accepts creating and validating a backend', () => {
    expect(isAllowedWrite('POST', '/api/v1/backends')).toBe(true);
    expect(isAllowedWrite('POST', '/api/v1/backends/validate')).toBe(true);
  });

  it('accepts updating and deleting one backend', () => {
    expect(isAllowedWrite('PATCH', `/api/v1/backends/${ID}`)).toBe(true);
    expect(isAllowedWrite('DELETE', `/api/v1/backends/${ID}`)).toBe(true);
  });

  it('accepts the five lifecycle actions', () => {
    for (const action of ['enable', 'disable', 'connect', 'disconnect', 'reconnect']) {
      expect(isAllowedWrite('POST', `/api/v1/backends/${ID}/${action}`), action).toBe(true);
    }
  });

  it('refuses methods the read proxy or the gateway already handles', () => {
    expect(isAllowedWrite('GET', '/api/v1/backends')).toBe(false);
    expect(isAllowedWrite('PUT', `/api/v1/backends/${ID}`)).toBe(false);
    expect(isAllowedWrite('HEAD', '/api/v1/backends')).toBe(false);
  });

  it('refuses another module entirely', () => {
    for (const target of ['/api/v1/settings', '/api/v1/monitoring/backends', '/api/v1/audit', '/api/v1/sessions']) {
      expect(isAllowedWrite('POST', target), target).toBe(false);
    }
  });

  it('refuses path traversal out of the backend prefix', () => {
    for (const target of [
      `/api/v1/backends/${ID}/../../agents`,
      `/api/v1/backends/../../agents`,
      '/api/v1/backends/..%2F..%2Fagents',
      `/api/v1/backends/${ID}/connect/../..`,
    ]) {
      expect(isAllowedWrite('POST', target), target).toBe(false);
    }
  });

  it('refuses a non-UUID id, so an arbitrary segment cannot be forwarded', () => {
    for (const target of ['/api/v1/backends/not-a-uuid', '/api/v1/backends/1234', '/api/v1/backends/runtime']) {
      expect(isAllowedWrite('PATCH', target), target).toBe(false);
      expect(isAllowedWrite('DELETE', target), target).toBe(false);
    }
  });

  it('refuses a method/route pair the gateway does not define', () => {
    // PATCH and DELETE exist only on the item path.
    expect(isAllowedWrite('PATCH', '/api/v1/backends')).toBe(false);
    expect(isAllowedWrite('DELETE', '/api/v1/backends')).toBe(false);
    expect(isAllowedWrite('PATCH', '/api/v1/backends/validate')).toBe(false);
    // Lifecycle actions are POST-only.
    expect(isAllowedWrite('PATCH', `/api/v1/backends/${ID}/connect`)).toBe(false);
    // There is no arbitrary action.
    expect(isAllowedWrite('POST', `/api/v1/backends/${ID}/restart`)).toBe(false);
  });

  it('refuses a UUID with extra segments', () => {
    expect(isAllowedWrite('POST', `/api/v1/backends/${ID}/connect/extra`)).toBe(false);
    expect(isAllowedWrite('DELETE', `/api/v1/backends/${ID}/runtime`)).toBe(false);
  });

  it('accepts the two catalog refreshes and nothing else under /tools', () => {
    expect(isAllowedWrite('POST', '/api/v1/tools/refresh')).toBe(true);
    expect(isAllowedWrite('POST', `/api/v1/backends/${ID}/tools/refresh`)).toBe(true);

    // The catalog has no per-tool write and no invocation route, so neither may
    // be expressible here.
    expect(isAllowedWrite('POST', '/api/v1/tools/my_tool/call')).toBe(false);
    expect(isAllowedWrite('POST', '/api/v1/tools/my_tool')).toBe(false);
    expect(isAllowedWrite('PATCH', '/api/v1/tools/my_tool')).toBe(false);
    expect(isAllowedWrite('DELETE', '/api/v1/tools/my_tool')).toBe(false);
    expect(isAllowedWrite('POST', `/api/v1/backends/${ID}/tools/refresh/extra`)).toBe(false);
  });

  it('accepts agent writes, including credentials under their owner', () => {
    const AGENT = '22222222-2222-4222-8222-222222222222';
    const CREDENTIAL = '33333333-3333-4333-8333-333333333333';

    expect(isAllowedWrite('POST', '/api/v1/agents')).toBe(true);
    expect(isAllowedWrite('PATCH', `/api/v1/agents/${AGENT}`)).toBe(true);
    expect(isAllowedWrite('DELETE', `/api/v1/agents/${AGENT}`)).toBe(true);
    expect(isAllowedWrite('POST', `/api/v1/agents/${AGENT}/enable`)).toBe(true);
    expect(isAllowedWrite('POST', `/api/v1/agents/${AGENT}/disable`)).toBe(true);
    expect(isAllowedWrite('POST', `/api/v1/agents/${AGENT}/credentials`)).toBe(true);
    expect(isAllowedWrite('POST', `/api/v1/agents/${AGENT}/credentials/${CREDENTIAL}/rotate`)).toBe(true);
    expect(isAllowedWrite('POST', `/api/v1/agents/${AGENT}/credentials/${CREDENTIAL}/revoke`)).toBe(true);
  });

  it('refuses agent paths the gateway does not define', () => {
    const AGENT = '22222222-2222-4222-8222-222222222222';
    const CREDENTIAL = '33333333-3333-4333-8333-333333333333';

    // No global credential route exists, so no bare credential path may match.
    expect(isAllowedWrite('POST', `/api/v1/credentials/${CREDENTIAL}/revoke`)).toBe(false);
    expect(isAllowedWrite('POST', `/api/v1/agents/${AGENT}/credentials/${CREDENTIAL}`)).toBe(false);
    expect(isAllowedWrite('PATCH', `/api/v1/agents/${AGENT}/credentials`)).toBe(false);
    expect(isAllowedWrite('DELETE', `/api/v1/agents/${AGENT}/credentials/${CREDENTIAL}`)).toBe(false);
    expect(isAllowedWrite('POST', `/api/v1/agents/${AGENT}/credentials/${CREDENTIAL}/rotate/extra`)).toBe(false);
    // A non-UUID id cannot be expressed.
    expect(isAllowedWrite('PATCH', '/api/v1/agents/not-a-uuid')).toBe(false);
  });

  it('accepts policy writes, including assignment of one agent', () => {
    const POLICY = '77777777-7777-4777-8777-777777777777';
    const AGENT = '22222222-2222-4222-8222-222222222222';

    expect(isAllowedWrite('POST', '/api/v1/policies')).toBe(true);
    expect(isAllowedWrite('PATCH', `/api/v1/policies/${POLICY}`)).toBe(true);
    expect(isAllowedWrite('DELETE', `/api/v1/policies/${POLICY}`)).toBe(true);
    expect(isAllowedWrite('POST', `/api/v1/policies/${POLICY}/assignments`)).toBe(true);
    expect(isAllowedWrite('DELETE', `/api/v1/policies/${POLICY}/assignments/${AGENT}`)).toBe(true);
  });

  it('refuses policy paths the gateway does not define', () => {
    const POLICY = '77777777-7777-4777-8777-777777777777';
    const AGENT = '22222222-2222-4222-8222-222222222222';

    // Rules are a field of the policy, not a resource: there is nothing to POST.
    expect(isAllowedWrite('POST', `/api/v1/policies/${POLICY}/rules`)).toBe(false);
    expect(isAllowedWrite('PATCH', `/api/v1/policies/${POLICY}/rules`)).toBe(false);
    // Only DELETE applies to a single assignment pair here.
    expect(isAllowedWrite('PATCH', `/api/v1/policies/${POLICY}/assignments/${AGENT}`)).toBe(false);
    expect(isAllowedWrite('POST', `/api/v1/policies/${POLICY}/assignments/${AGENT}`)).toBe(false);
    expect(isAllowedWrite('PATCH', `/api/v1/policies/not-a-uuid`)).toBe(false);
    expect(isAllowedWrite('DELETE', `/api/v1/policies/${POLICY}/assignments`)).toBe(false);
  });

  it('accepts terminating one MCP session and nothing else under /sessions', () => {
    const SESSION = '99999999-9999-4999-8999-999999999999';

    expect(isAllowedWrite('POST', `/api/v1/sessions/${SESSION}/terminate`)).toBe(true);

    // The sweep exists on the gateway but no screen offers it, so the browser
    // must not be able to reach it.
    expect(isAllowedWrite('POST', '/api/v1/sessions/cleanup')).toBe(false);
    // Sessions are read-only otherwise: no create, no edit, no delete.
    expect(isAllowedWrite('POST', '/api/v1/sessions')).toBe(false);
    expect(isAllowedWrite('PATCH', `/api/v1/sessions/${SESSION}`)).toBe(false);
    expect(isAllowedWrite('DELETE', `/api/v1/sessions/${SESSION}`)).toBe(false);
    expect(isAllowedWrite('POST', `/api/v1/sessions/not-a-uuid/terminate`)).toBe(false);
    expect(isAllowedWrite('POST', `/api/v1/sessions/${SESSION}/terminate/extra`)).toBe(false);
    expect(isAllowedWrite('POST', `/api/v1/sessions/${SESSION}/invalidate`)).toBe(false);
  });

  it('does not reach a different resource through a traversal segment', () => {
    for (const target of [
      `/api/v1/backends/${ID}/../../agents`,
      '/api/v1/tools/refresh/../../agents',
      `/api/v1/backends/${ID}/tools/../../policies`,
    ]) {
      expect(isAllowedWrite('POST', target), target).toBe(false);
    }
  });

  it('accepts the managed-integration writes the screens make', () => {
    const CONNECTION = '44444444-4444-4444-8444-444444444444';

    // Create is the only collection write.
    expect(isAllowedWrite('POST', '/api/v1/integrations/connections')).toBe(true);

    // The five item actions, including the credential write itself.
    for (const action of ['credential', 'test', 'enable', 'disable', 'disconnect']) {
      expect(isAllowedWrite('POST', `/api/v1/integrations/connections/${CONNECTION}/${action}`), action).toBe(true);
    }

    expect(isAllowedWrite('DELETE', `/api/v1/integrations/connections/${CONNECTION}`)).toBe(true);
  });

  it('refuses every other managed-integration shape, especially the read-looking ones', () => {
    const CONNECTION = '44444444-4444-4444-8444-444444444444';

    // Reads are the read proxy's business, not the write proxy's.
    expect(isAllowedWrite('GET', '/api/v1/integrations/providers')).toBe(false);
    expect(isAllowedWrite('GET', `/api/v1/integrations/connections/${CONNECTION}/tools`)).toBe(false);
    // A GET-shaped verb on the credential path must not be expressible.
    expect(isAllowedWrite('GET', `/api/v1/integrations/connections/${CONNECTION}/credential`)).toBe(false);

    // The surface has no PATCH at all.
    expect(isAllowedWrite('PATCH', `/api/v1/integrations/connections/${CONNECTION}`)).toBe(false);

    // No arbitrary action, no provider writes, no collection delete.
    expect(isAllowedWrite('POST', `/api/v1/integrations/connections/${CONNECTION}/sync`)).toBe(false);
    expect(isAllowedWrite('POST', '/api/v1/integrations/providers')).toBe(false);
    expect(isAllowedWrite('DELETE', '/api/v1/integrations/connections')).toBe(false);

    // Traversal and non-UUID, same as every other module.
    expect(isAllowedWrite('POST', `/api/v1/integrations/connections/${CONNECTION}/../../agents`)).toBe(false);
    expect(isAllowedWrite('POST', `/api/v1/integrations/connections/not-a-uuid/enable`)).toBe(false);
    expect(isAllowedWrite('DELETE', '/api/v1/integrations/connections/not-a-uuid')).toBe(false);
  });
});

/**
 * The route-to-gateway seam. `forwardWrite` used to build the target from the
 * catch-all tail alone, producing `/api/v1/validate` from `/api/backends/
 * validate`; the allowlist then refused every write with a 404 envelope. These
 * cases use the exact dashboard-local URLs the browser sends, so the seam
 * cannot regress silently again.
 */
describe('writeTarget', () => {
  it('restores the collection segment the catch-all route strips', () => {
    expect(writeTarget('backends', ['validate'])).toBe('/api/v1/backends/validate');
    expect(writeTarget('backends')).toBe('/api/v1/backends');
    expect(writeTarget('agents', [ID, 'credentials'])).toBe(`/api/v1/agents/${ID}/credentials`);
    expect(writeTarget('sessions', [ID, 'terminate'])).toBe(`/api/v1/sessions/${ID}/terminate`);
    expect(writeTarget('integrations', ['connections'])).toBe('/api/v1/integrations/connections');
  });

  it('maps every browser write URL the screens use to an allowed target', () => {
    const cases: Array<[string, string[], string, string]> = [
      ['backends', [], 'POST', '/api/backends'],
      ['backends', ['validate'], 'POST', '/api/backends/validate'],
      ['backends', [ID], 'PATCH', `/api/backends/${ID}`],
      ['backends', [ID], 'DELETE', `/api/backends/${ID}`],
      ['backends', [ID, 'disable'], 'POST', `/api/backends/${ID}/disable`],
      ['backends', [ID, 'reconnect'], 'POST', `/api/backends/${ID}/reconnect`],
      ['agents', [], 'POST', '/api/agents'],
      ['agents', [ID], 'PATCH', `/api/agents/${ID}`],
      ['agents', [ID, 'credentials'], 'POST', `/api/agents/${ID}/credentials`],
      ['agents', [ID, 'credentials', ID, 'rotate'], 'POST', `/api/agents/${ID}/credentials/${ID}/rotate`],
      ['policies', [], 'POST', '/api/policies'],
      ['policies', [ID], 'PATCH', `/api/policies/${ID}`],
      ['policies', [ID, 'assignments'], 'POST', `/api/policies/${ID}/assignments`],
      ['sessions', [ID, 'terminate'], 'POST', `/api/sessions/${ID}/terminate`],
      ['integrations', ['connections'], 'POST', '/api/integrations/connections'],
      ['integrations', ['connections', ID, 'enable'], 'POST', `/api/integrations/connections/${ID}/enable`],
    ];

    for (const [collection, path, method, browserURL] of cases) {
      const target = writeTarget(collection, path);
      expect(isAllowedWrite(method, target), `${method} ${browserURL} → ${target}`).toBe(true);
    }
  });
});
