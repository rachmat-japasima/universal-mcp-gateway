import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import type { ToolDefinition } from '../src/domain/tool.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import type { Connector, ConnectorContext, ConnectorResult } from '../src/integrations/connector.js';
import type { ProviderRegistration } from '../src/integrations/provider.js';
import { ProviderRegistry } from '../src/integrations/registry.js';
import { createLogger } from '../src/monitoring/logger.js';
import type { ErrorEnvelope } from '../src/shared/errors.js';
import { testKeys } from './fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';

/**
 * The integrations operator write API (ADR-053), exercised through the app.
 *
 * The provider is always a fixture connector wired through the real gateway —
 * no production provider is ever dialed from a test. The flow under test is
 * the one the dashboard drives: create → credential → enable, plus the
 * non-mutating `test`, and every refusal shape the operator can meet.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };
const PROVIDER = 'fixture-api';

let directory: string;
let store: Database;
let gateway: Gateway | undefined;
let session: TestOperatorSession;
let hadMasterKey: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-intapi-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  hadMasterKey = process.env['INTEGRATION_MASTER_KEY'];
  process.env['INTEGRATION_MASTER_KEY'] = randomBytes(32).toString('base64');
  session = createTestOperator(store, testKeys());
});

afterEach(async () => {
  if (hadMasterKey === undefined) delete process.env['INTEGRATION_MASTER_KEY'];
  else process.env['INTEGRATION_MASTER_KEY'] = hadMasterKey;
  await gateway?.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  gateway = undefined!;
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call({ method, path, body, headers }: Call): Promise<Response> {
  if (gateway === undefined) throw new Error('no gateway built');
  return gateway.app.request(`/api/v1${path}`, {
    method,
    headers:
      body === undefined ? { ...HOST, ...session.headers, ...headers } : { ...JSON_HEADERS, ...session.headers, ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

/** Unwraps the success envelope. */
async function data(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
}

type Discover = (context: ConnectorContext) => Promise<ConnectorResult<ToolDefinition[]>>;

/** A registry whose provider answers exactly what the test needs. */
function fixtureRegistry(discover: Discover): ProviderRegistry {
  const registration: ProviderRegistration = {
    id: PROVIDER,
    name: 'Fixture API Provider',
    description: 'Route tests only; never registered in production.',
    capabilities: ['discovery', 'execution'],
    metadata: {},
  };
  const connector: Connector = {
    discoverTools: discover,
    executeTool: async () => ({ ok: true, value: { content: [] } }),
  };
  const registry = new ProviderRegistry();
  registry.register(registration, connector);
  return registry;
}

const HANDSHAKE_OK: Discover = async () => ({
  ok: true,
  value: [{ name: 'get_status', inputSchema: { type: 'object' } }],
});

function happyGateway(): Gateway {
  return createGateway({
    config,
    logger,
    store,
    credentialKeys: testKeys(),
    providerRegistry: fixtureRegistry(HANDSHAKE_OK),
  });
}

describe('integrations operator API', () => {
  it('walks the documented flow: create → credential → enable → tools → disable → re-enable → disconnect → delete', async () => {
    gateway = happyGateway();

    const createResponse = await call({
      method: 'POST',
      path: '/integrations/connections',
      body: { providerId: PROVIDER, name: 'fixture-connection', metadata: { org: 'fixture' } },
    });
    expect(createResponse.status).toBe(201);
    const created = await data(createResponse);
    // `pending`: the row exists, nothing is verified, nothing is callable.
    expect(created['status']).toBe('pending');
    expect(created['credentialId']).toBeNull();
    expect(created['validatedAt']).toBeNull();
    expect(created['metadata']).toEqual({ org: 'fixture' });
    const connectionId = created['id'] as string;

    // The credential is write-only: the answer is the row, never the value.
    const token = `fixture-live-token-${randomUUID()}`;
    const storedResponse = await call({
      method: 'POST',
      path: `/integrations/connections/${connectionId}/credential`,
      body: { token },
    });
    expect(storedResponse.status).toBe(200);
    const stored = await data(storedResponse);
    expect(typeof stored['credentialId']).toBe('string');
    // Nothing is proved yet: storing a token validates nothing.
    expect(stored['status']).toBe('pending');
    expect(stored['validatedAt']).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(token);

    const enabledResponse = await call({ method: 'POST', path: `/integrations/connections/${connectionId}/enable` });
    expect(enabledResponse.status).toBe(200);
    const enabled = await data(enabledResponse);
    expect(enabled['connection']).toMatchObject({ status: 'connected', validatedAt: expect.any(String) });
    expect(enabled['tools']).toMatchObject({ added: ['get_status'] });

    const toolsResponse = await call({ method: 'GET', path: `/integrations/connections/${connectionId}/tools` });
    const tools = (await toolsResponse.json())['data'] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool['publicName'])).toEqual([`${connectionId}__get_status`]);
    expect(tools[0]).toMatchObject({ sourceType: 'managed_integration', availability: 'available' });

    const disabled = await data(await call({ method: 'POST', path: `/integrations/connections/${connectionId}/disable` }));
    expect(disabled['status']).toBe('disabled');
    // Dark means dark: the tools route answers the truth, an empty list.
    expect((await (await call({ method: 'GET', path: `/integrations/connections/${connectionId}/tools` })).json())['data']).toEqual([]);

    // The explicit re-enable: the only exit from `disabled`.
    const reenabled = await data(await call({ method: 'POST', path: `/integrations/connections/${connectionId}/enable` }));
    expect(reenabled['connection']).toMatchObject({ status: 'connected' });

    const disconnected = await data(
      await call({ method: 'POST', path: `/integrations/connections/${connectionId}/disconnect` }),
    );
    expect(disconnected['status']).toBe('disconnected');
    // The row survives at rest, credential intact.
    expect(disconnected['credentialId']).toBe(stored['credentialId']);

    const deleted = await data(await call({ method: 'DELETE', path: `/integrations/connections/${connectionId}` }));
    expect(deleted['id']).toBe(connectionId);
    expect((await call({ method: 'GET', path: `/integrations/connections/${connectionId}` })).status).toBe(404);
    expect((await call({ method: 'GET', path: '/integrations/connections' })).status).toBe(200);
  });

  it('refuses a create whose provider is not registered, and validates the body', async () => {
    gateway = happyGateway();

    const unknown = await call({
      method: 'POST',
      path: '/integrations/connections',
      body: { providerId: 'ghost-provider', name: 'x' },
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as ErrorEnvelope).error.code).toBe('RESOURCE_NOT_FOUND');

    const extraKey = await call({
      method: 'POST',
      path: '/integrations/connections',
      body: { providerId: PROVIDER, name: 'x', credentialId: 'pasted-by-mistake' },
    });
    expect(extraKey.status).toBe(400);

    const emptyName = await call({ method: 'POST', path: '/integrations/connections', body: { providerId: PROVIDER, name: '  ' } });
    expect(emptyName.status).toBe(400);
  });

  it('replaces a credential in place: the old envelope dies, the value never surfaces', async () => {
    gateway = happyGateway();

    const connectionId = (await data(
      await call({ method: 'POST', path: '/integrations/connections', body: { providerId: PROVIDER, name: 'x' } }),
    ))['id'] as string;

    const firstToken = `fixture-live-token-${randomUUID()}`;
    const first = await data(
      await call({ method: 'POST', path: `/integrations/connections/${connectionId}/credential`, body: { token: firstToken } }),
    );
    const secondToken = `fixture-live-token-${randomUUID()}`;
    const second = await data(
      await call({ method: 'POST', path: `/integrations/connections/${connectionId}/credential`, body: { token: secondToken } }),
    );

    expect(second['credentialId']).not.toBe(first['credentialId']);
    for (const payload of [JSON.stringify(first), JSON.stringify(second)]) {
      expect(payload).not.toContain(firstToken);
      expect(payload).not.toContain(secondToken);
    }

    // The replacement deleted the previous envelope: the old reference fails closed.
    const connection = gateway.integrations!.list()[0]!;
    await expect(gateway.integrations!.resolveCredentialFor(connection)(first['credentialId'] as string)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(
      gateway.integrations!.resolveCredentialFor(connection)(second['credentialId'] as string),
    ).resolves.toBe(secondToken);
  });

  it('answers `test` as data and moves nothing: success and refusal both leave the row `pending`', async () => {
    gateway = createGateway({
      config,
      logger,
      store,
      credentialKeys: testKeys(),
      providerRegistry: fixtureRegistry(async () => ({
        ok: false,
        error: { kind: 'reauthorization_required', message: 'fixture: token rejected' },
      })),
    });

    const connectionId = (await data(
      await call({ method: 'POST', path: '/integrations/connections', body: { providerId: PROVIDER, name: 'x' } }),
    ))['id'] as string;
    await call({
      method: 'POST',
      path: `/integrations/connections/${connectionId}/credential`,
      body: { token: `fixture-live-token-${randomUUID()}` },
    });

    const testResponse = await call({ method: 'POST', path: `/integrations/connections/${connectionId}/test` });
    expect(testResponse.status).toBe(200);
    expect(await data(testResponse)).toEqual({
      ok: false,
      kind: 'reauthorization_required',
      message: 'fixture: token rejected',
    });

    // `test` answered the question without pretending to be `enable`.
    const row = await data(await call({ method: 'GET', path: `/integrations/connections/${connectionId}` }));
    expect(row['status']).toBe('pending');
    expect(row['validatedAt']).toBeNull();
    expect((await (await call({ method: 'GET', path: `/integrations/connections/${connectionId}/tools` })).json())['data']).toEqual([]);
  });

  it('maps a refused enable to 502 with the row saying `reauthorization_required`, never `error`', async () => {
    gateway = createGateway({
      config,
      logger,
      store,
      credentialKeys: testKeys(),
      providerRegistry: fixtureRegistry(async () => ({
        ok: false,
        error: { kind: 'reauthorization_required', message: 'fixture: token rejected' },
      })),
    });

    const connectionId = (await data(
      await call({ method: 'POST', path: '/integrations/connections', body: { providerId: PROVIDER, name: 'x' } }),
    ))['id'] as string;
    const token = `fixture-live-token-${randomUUID()}`;
    await call({ method: 'POST', path: `/integrations/connections/${connectionId}/credential`, body: { token } });

    const enableResponse = await call({ method: 'POST', path: `/integrations/connections/${connectionId}/enable` });
    expect(enableResponse.status).toBe(502);
    const envelope = (await enableResponse.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe('BACKEND_CONNECTION_ERROR');
    expect(JSON.stringify(envelope)).not.toContain(token);

    const row = gateway.integrations!.list()[0]!;
    expect(row.status).toBe('reauthorization_required');
    expect(row.validatedAt).toBeNull();
  });

  it('keeps the new writes behind the operator session and the CSRF check', async () => {
    gateway = happyGateway();

    const connectionId = (await data(
      await call({ method: 'POST', path: '/integrations/connections', body: { providerId: PROVIDER, name: 'x' } }),
    ))['id'] as string;
    const target = `/api/v1/integrations/connections/${connectionId}/enable`;

    // No session: the middleware answers before any handler runs.
    const anonymous = await gateway.app.request(target, { method: 'POST', headers: HOST });
    expect(anonymous.status).toBe(401);

    // A session without the derived token is a browser that did not intend
    // this write; the check covers bodyless POSTs, so `enable` cannot slip by.
    const noCsrf = await gateway.app.request(target, { method: 'POST', headers: { ...HOST, cookie: session.cookie } });
    expect(noCsrf.status).toBe(403);
  });

  it('answers 404 honestly on every per-connection route for a stranger id', async () => {
    gateway = happyGateway();
    const stranger = randomUUID();

    for (const [method, path] of [
      ['GET', `/integrations/connections/${stranger}`],
      ['DELETE', `/integrations/connections/${stranger}`],
      ['POST', `/integrations/connections/${stranger}/credential`],
      ['POST', `/integrations/connections/${stranger}/test`],
      ['POST', `/integrations/connections/${stranger}/enable`],
      ['POST', `/integrations/connections/${stranger}/disable`],
      ['POST', `/integrations/connections/${stranger}/disconnect`],
      ['GET', `/integrations/connections/${stranger}/tools`],
    ] as Array<[string, string]>) {
      const response = await call({
        method,
        path,
        ...(method === 'POST' && path.endsWith('/credential') ? { body: { token: 'x' } } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it('lists the production registry through the API: GitHub, registered read-only', async () => {
    // The default registry is production wiring; listing it touches no network.
    gateway = createGateway({ config, logger, store, credentialKeys: testKeys() });

    const providers = (await (await call({ method: 'GET', path: '/integrations/providers' })).json())['data'] as Array<
      Record<string, unknown>
    >;
    expect(providers.map((provider) => provider['id'])).toEqual(['github']);
    expect(providers[0]).toMatchObject({
      name: 'GitHub',
      capabilities: ['discovery', 'execution'],
      metadata: { authMethod: 'fine-grained personal access token' },
    });
  });
});
