import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { testKeys } from './fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';

/**
 * OpenAPI conformance.
 *
 * A hand-written specification rots the moment a route is added, so the test
 * does not trust it: it walks the live Hono route table and the document in both
 * directions. If they disagree, this fails.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);
const HOST = { host: '127.0.0.1:8787' };

let directory: string;
let store: Database;
let gateway: Gateway;
/** Operator session: the management API rejects anonymous callers (Phase 10.0). */
let session: TestOperatorSession;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-openapi-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  gateway = createGateway({ config, logger, store, credentialKeys: testKeys() });
  session = createTestOperator(store, testKeys());
});

afterEach(async () => {
  await gateway.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Real routes. Middleware (`ALL` on a wildcard) and the catch-all are excluded,
 * but an `ALL` route on a *concrete* path is a real endpoint that answers every
 * method — `/mcp` is one — so it is kept as a path-only entry.
 */
function liveRoutes(): Array<{ method: string | undefined; path: string }> {
  const routes = (gateway.app as unknown as { routes: Array<{ method: string; path: string }> }).routes;

  return routes
    .filter((route) => !route.path.endsWith('/*'))
    .map((route) => ({
      method: route.method === 'ALL' ? undefined : route.method.toLowerCase(),
      path: route.path,
    }));
}

/** Hono's `:param` → OpenAPI's `{param}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

async function document(): Promise<Record<string, any>> {
  const response = await gateway.app.request('/api/v1/openapi.json', { headers: { ...HOST, ...session.headers } });
  expect(response.status).toBe(200);

  const body = (await response.json()) as { data: Record<string, any> };
  return body.data;
}

describe('openapi document', () => {
  it('is served as OpenAPI 3.1 under the API prefix', async () => {
    const spec = await document();
    expect(spec['openapi']).toBe('3.1.0');
    expect(spec['info']).toMatchObject({ title: expect.stringContaining('universal-mcp-gateway') });
    expect(spec['paths']).toBeTypeOf('object');
  });

  it('documents every live route', async () => {
    const spec = await document();
    const documented = new Set(
      Object.entries(spec['paths'] as Record<string, Record<string, unknown>>).flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => `${method} ${path}`),
      ),
    );
    const documentedPaths = new Set(Object.keys(spec['paths'] as Record<string, unknown>));

    const undocumented = liveRoutes().filter((route) =>
      route.method === undefined
        ? !documentedPaths.has(toOpenApiPath(route.path))
        : !documented.has(`${route.method} ${toOpenApiPath(route.path)}`),
    );
    expect(undocumented).toEqual([]);
  });

  it('documents no route that does not exist', async () => {
    const spec = await document();
    /** `ALL`-method routes are documented once; everything else must match method + path. */
    const anyMethod = new Set(liveRoutes().filter((route) => route.method === undefined).map((route) => route.path));
    const live = new Set(
      liveRoutes().flatMap((route) =>
        route.method === undefined ? [] : [`${route.method} ${toOpenApiPath(route.path)}`],
      ),
    );

    const invented = Object.entries(spec['paths'] as Record<string, Record<string, unknown>>)
      .flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method} ${path}`))
      .filter((entry) => !live.has(entry) && !anyMethod.has(entry.split(' ')[1]!));

    expect(invented).toEqual([]);
  });

  it('keeps every $ref resolvable', async () => {
    const spec = await document();
    const refs: string[] = [];

    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;

      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.push(value);
        else walk(value);
      }
    };

    walk(spec);
    expect(refs.length).toBeGreaterThan(0);

    for (const reference of refs) {
      // Only local refs are used; `#/components/schemas/X` must resolve.
      const segments = reference.replace(/^#\//, '').split('/');
      let node: any = spec;
      for (const segment of segments) {
        node = node?.[segment];
        expect(node, `Unresolved $ref: ${reference}`).toBeDefined();
      }
    }
  });

  it('describes pagination the same way for every collection', async () => {
    const spec = await document();
    const pagination = spec['components']['schemas']['Pagination'];

    expect(pagination['properties']['limit']).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    expect(pagination['required']).toEqual(['page', 'limit', 'total', 'totalPages']);

    // Every list route references it rather than restating a different shape.
    for (const path of ['/api/v1/activity', '/api/v1/audit', '/api/v1/sessions', '/api/v1/backends']) {
      const schema = spec['paths'][path]['get']['responses']['200']['content']['application/json']['schema'];
      expect(schema['properties']['pagination']).toEqual({ $ref: '#/components/schemas/Pagination' });
    }
  });

  it('uses the real query enums rather than a free-form string', async () => {
    const spec = await document();
    const params = spec['paths']['/api/v1/activity']['get']['parameters'] as Array<Record<string, any>>;
    const byName = Object.fromEntries(params.map((parameter) => [parameter['name'], parameter]));

    expect(byName['type']!['schema']['enum']).toContain('tools.call');
    expect(byName['outcome']!['schema']['enum']).toEqual(['success', 'failure', 'denied']);
    expect(byName['limit']!['schema']).toMatchObject({ minimum: 1, maximum: 100 });
  });

  it('documents the error envelope once and reuses it', async () => {
    const spec = await document();
    const codes = spec['components']['schemas']['ErrorEnvelope']['properties']['error']['properties']['code']['enum'];

    expect(codes).toEqual(
      expect.arrayContaining(['VALIDATION_ERROR', 'RESOURCE_NOT_FOUND', 'RESOURCE_CONFLICT', 'INTERNAL_ERROR']),
    );
    expect(codes).not.toContain('UNAUTHENTICATED');
  });

  it('states the local-only trust boundary and keeps MCP auth documented separately', async () => {
    const spec = await document();
    expect(spec['info']['description']).toMatch(/loopback-only/i);
    expect(spec['x-gateway']).toMatchObject({ loopbackOnly: true, apiPrefix: '/api/v1' });

    // Two independent boundaries: REST needs an operator session, `/mcp` needs
    // an agent bearer. Neither is documented as satisfying the other.
    expect(spec['security']).toEqual([{ operatorSession: [] }]);
    expect(spec['paths']['/mcp']['post']['security']).toEqual([{ agentBearer: [] }]);
    expect(spec['paths']['/api/v1/auth/login']['post']['security']).toEqual([]);
    expect(spec['paths']['/health']['get']['security']).toEqual([]);
  });
});
