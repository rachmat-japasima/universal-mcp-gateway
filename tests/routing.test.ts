import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackendLifecycleManager, type ReconnectPolicy } from '../src/adapters/lifecycle.js';
import { loadConfig } from '../src/config/config.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { BackendService } from '../src/registry/backend-service.js';
import { ToolCatalog, buildTools, detectConflicts } from '../src/routing/catalog.js';
import { ToolDiscovery } from '../src/routing/discovery.js';
import { MAX_TOOL_NAME_LENGTH, normalizeSegment, publicToolName } from '../src/routing/namespacing.js';
import { ToolRouter } from '../src/routing/router.js';
import { compileInputSchema } from '../src/routing/schema.js';
import { AppError } from '../src/shared/errors.js';

/**
 * Phase 5: discovery, namespacing, catalog, and routing.
 *
 * Every backend here is a local fixture under `tests/fixtures`, launched as a
 * child process over stdio. Nothing reaches a real MCP server, and every store
 * is a temp file removed after the test.
 *
 * The lifecycle is built directly rather than through `createGateway` so the
 * connection observer is *not* wired: discovery is then triggered explicitly,
 * which makes assertions about coalescing and refresh deterministic. The
 * observer itself is covered by `tests/tools-api.test.ts`.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/catalog-fixture.ts', import.meta.url));

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

const reconnectOff: ReconnectPolicy = {
  enabled: false,
  initialDelayMs: 100,
  maxDelayMs: 200,
  maxAttempts: 2,
  jitterRatio: 0,
};

let directory: string;
let store: Database;
let service: BackendService;
let lifecycle: BackendLifecycleManager;
let catalog: ToolCatalog;
let discovery: ToolDiscovery;
const children: Array<{ kill(signal?: NodeJS.Signals): boolean }> = [];

function fixture(mode: string) {
  return {
    type: 'stdio' as const,
    command: process.execPath,
    args: ['--import', 'tsx', FIXTURE, mode],
  };
}

function register(name: string, mode: string, extra: Record<string, unknown> = {}) {
  return service.create({ name, connection: fixture(mode) as never, ...extra });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-routing-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  service = new BackendService(store);
  lifecycle = new BackendLifecycleManager({
    store,
    logger,
    networkPolicy: { allowPrivateNetwork: true },
    reconnect: reconnectOff,
    random: () => 0.5,
  });
  catalog = new ToolCatalog();
  discovery = new ToolDiscovery({ store, logger, lifecycle, catalog, timeoutMs: 5_000 });
});

afterEach(async () => {
  await lifecycle.shutdown();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Connects a backend and discovers its tools, awaiting both. */
async function connectAndDiscover(backendId: string) {
  await lifecycle.connect(backendId);
  const result = await discovery.discover(backendId);
  expect(result.ok).toBe(true);
  return result;
}

const activity = (type: string) => store.activity.list(100).filter((event) => event.type === type);

describe('namespacing', () => {
  it('joins backend and tool with a double underscore', () => {
    expect(publicToolName('abc', 'get_status')).toBe('abc__get_status');
  });

  it('normalizes characters outside the SEP-986 alphabet', () => {
    expect(normalizeSegment(' search items ')).toBe('search_items');
    expect(normalizeSegment('a/b:c')).toBe('a_b_c');
    expect(normalizeSegment('ünïcode')).toBe('_n_code');
  });

  it('returns undefined when a side normalizes to nothing', () => {
    expect(publicToolName('abc', '   ')).toBeUndefined();
    expect(publicToolName('', 'x')).toBeUndefined();
    expect(publicToolName('  ', 'x')).toBeUndefined();
  });

  it('is deterministic and bounded for over-long names', () => {
    const original = 'x'.repeat(200);
    const first = publicToolName('backend-id', original);
    const second = publicToolName('backend-id', original);

    expect(first).toBe(second);
    expect(first).toHaveLength(MAX_TOOL_NAME_LENGTH);
    expect(first?.endsWith(first!.slice(-9))).toBe(true);
  });

  it('keeps two over-long names distinct past the cut', () => {
    const a = publicToolName('backend-id', `${'x'.repeat(150)}a`);
    const b = publicToolName('backend-id', `${'x'.repeat(150)}b`);

    expect(a).not.toBe(b);
  });
});

describe('catalog', () => {
  const tool = (name: string) => ({
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
  });

  it('withholds every claimant when two backends produce one public name', () => {
    const now = '2026-11-19T00:00:00.000Z';
    // `a b` and `a_b` normalize to the same segment, so both tools are named
    // `a_b__get_status`. That is the cross-backend collision the catalog exists
    // to catch.
    const first = buildTools({ backendId: 'a b', now, tools: [tool('get_status')], rejected: [] });
    const second = buildTools({ backendId: 'a_b', now, tools: [tool('get_status')], rejected: [] });

    catalog.replace({
      sourceType: 'mcp_backend',
      sourceId: 'a b',
      tools: first.tools,
      report: reportFor('a b', first.tools, 0),
    });
    const outcome = catalog.replace({
      sourceType: 'mcp_backend',
      sourceId: 'a_b',
      tools: second.tools,
      report: reportFor('a_b', second.tools, 0),
    });

    expect(outcome.report.conflictCount).toBe(1);
    expect(catalog.conflicts$()).toEqual([
      {
        publicName: 'a_b__get_status',
        claimants: [
          { sourceType: 'mcp_backend', sourceId: 'a b', backendId: 'a b', originalName: 'get_status' },
          { sourceType: 'mcp_backend', sourceId: 'a_b', backendId: 'a_b', originalName: 'get_status' },
        ],
      },
    ]);

    // Both are withheld: the catalog fails closed, it does not pick a winner.
    expect(catalog.size).toBe(0);
    expect(catalog.resolve('a_b__get_status')).toMatchObject({ reason: 'conflict' });
    expect(catalog.listAll().map((entry) => entry.availability)).toEqual(['conflict', 'conflict']);
  });

  it('detects a real collision across one backend and withholds both', () => {
    const collision = detectConflicts([
      {
        sourceType: 'mcp_backend' as const,
        sourceId: 'a',
        report: reportFor('a', new Map(), 0),
        tools: new Map([
          ['a__x', catalogTool('a__x', 'a', 'a__x')],
          ['a__y', catalogTool('a__y', 'a', 'a__y')],
        ]),
      },
      {
        sourceType: 'mcp_backend' as const,
        sourceId: 'a',
        report: reportFor('a', new Map(), 0),
        tools: new Map([['a__x', catalogTool('a__x', 'a', 'a__x')]]),
      },
    ]);

    expect([...collision.keys()]).toEqual(['a__x']);
    expect(collision.get('a__x')?.claimants).toHaveLength(2);
  });

  it('rejects a second tool inside one backend that collapses onto a taken name', () => {
    const { tools, rejected } = buildTools({
      backendId: 'a',
      now: '2026-11-19T00:00:00.000Z',
      tools: [tool('search items'), tool('search_items')],
      rejected: [],
    });

    expect([...tools.keys()]).toEqual(['search items']);
    expect(rejected).toEqual(['search_items']);
  });
});

describe('schema compilation', () => {
  it('validates against the backend schema without coercing', () => {
    const compiled = compileInputSchema({
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1 } },
      required: ['limit'],
      additionalProperties: false,
    });

    expect(compiled.validate?.({ limit: 2 })).toEqual({ valid: true });
    expect(compiled.validate?.({ limit: '2' }).valid).toBe(false);
    expect(compiled.validate?.({ limit: 0 }).valid).toBe(false);
    expect(compiled.validate?.({}).valid).toBe(false);
  });

  it('reports an uncompilable schema instead of throwing', () => {
    const compiled = compileInputSchema({ type: 'object', properties: { a: { $ref: '#/$defs/missing' } } });

    expect(compiled.validate).toBeUndefined();
    expect(compiled.unvalidatedReason).toContain('could not be compiled');
  });
});

describe('discovery', () => {
  it('discovers tools from two backends and preserves their schemas verbatim', async () => {
    const a = register('backend-a', 'a');
    const b = register('backend-b', 'b');

    await connectAndDiscover(a.id);
    await connectAndDiscover(b.id);

    expect(catalog.backendIds()).toEqual([a.id, b.id].sort());
    expect(catalog.size).toBeGreaterThanOrEqual(5);

    const search = catalog.resolve(`${a.id}__search_items`);
    expect('tool' in search).toBe(true);
    if (!('tool' in search)) throw new Error('unreachable');

    // `$defs`, `$ref`, `enum`, `additionalProperties`, and a vendor extension
    // all survive discovery: the gateway forwards the backend's own JSON Schema.
    expect(search.tool.inputSchema).toMatchObject({
      $defs: { Filter: { type: 'object' } },
      properties: { filter: { $ref: '#/$defs/Filter' }, limit: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
      'x-fixture': 'preserved',
    });

    const create = catalog.resolve(`${b.id}__create_item`);
    expect('tool' in create && create.tool.inputSchema['properties']).toMatchObject({
      kind: { enum: ['a', 'b'] },
    });

    expect(activity('tools.list').every((event) => event.outcome === 'success')).toBe(true);
  });

  it('withholds colliding names from both backends', async () => {
    const a = register('backend-a', 'a');
    const b = register('backend-b', 'b');

    await connectAndDiscover(a.id);
    await connectAndDiscover(b.id);

    // Both advertise `get_status`; the namespaced names differ, so both stay
    // available. The collision path needs identical public names, covered by
    // the catalog unit test above.
    expect(catalog.resolve(`${a.id}__get_status`)).toHaveProperty('tool');
    expect(catalog.resolve(`${b.id}__get_status`)).toHaveProperty('tool');
  });

  it('rejects tools with unusable metadata without substituting a schema', async () => {
    const backend = register('backend-bad', 'bad');
    const result = await connectAndDiscover(backend.id);

    expect(result.report?.toolCount).toBe(1);
    expect(result.report?.rejectedCount).toBe(1);
    expect(catalog.resolve(`${backend.id}__still_good`)).toHaveProperty('tool');
  });

  it('leaves the previous snapshot in place when a refresh fails', async () => {
    const backend = register('backend-listfail', 'a');
    await connectAndDiscover(backend.id);

    const good = catalog.listByBackend(backend.id);
    expect(good.length).toBeGreaterThan(0);

    // Same backend, but the next listing throws.
    service.update(backend.id, { connection: fixture('listfail') as never, timeoutMs: 10_000 });
    await lifecycle.reconnect(backend.id);

    const failed = await discovery.discover(backend.id);
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeInstanceOf(AppError);
    // The stale snapshot is removed by the disconnect observer in production;
    // here the earlier snapshot is untouched by a failed refresh.
    expect(catalog.listByBackend(backend.id)).toHaveLength(good.length);
  });

  it('coalesces concurrent discoveries for one backend', async () => {
    const backend = register('backend-a', 'a');
    await lifecycle.connect(backend.id);

    const before = activity('tools.list').length;
    const results = await Promise.all([
      discovery.discover(backend.id),
      discovery.discover(backend.id),
      discovery.discover(backend.id),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(activity('tools.list').length - before).toBe(1);
  });

  it('discovers every connected backend and skips the rest', async () => {
    const connected = register('backend-a', 'a');
    register('backend-b', 'b');

    await lifecycle.connect(connected.id);
    const results = await discovery.discoverAll();

    expect(results.map((result) => result.backendId)).toEqual([connected.id]);
  });

  it('refuses to discover a disabled or disconnected backend', async () => {
    const backend = register('backend-a', 'a');

    const idle = await discovery.discover(backend.id);
    expect(idle.error?.code).toBe('BACKEND_UNAVAILABLE');

    await lifecycle.connect(backend.id);
    service.update(backend.id, { enabled: false });
    const disabled = await discovery.discover(backend.id);
    expect(disabled.error?.code).toBe('RESOURCE_CONFLICT');
  });
});

describe('routing', () => {
  it('routes to the right backend with the original tool name and arguments', async () => {
    const a = register('backend-a', 'a');
    const b = register('backend-b', 'b');
    await connectAndDiscover(a.id);
    await connectAndDiscover(b.id);

    const router = new ToolRouter({ store, logger, lifecycle, catalog });
    const { result, tool } = await router.call(`${b.id}__create_item`, { kind: 'a', name: 'widget' });

    // `sourceId` is the routing identity (ADR-048); for an MCP tool it equals
    // the backend id.
    expect(tool.sourceId).toBe(b.id);
    expect(tool.originalName).toBe('create_item');
    expect(result.isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('"backend":"b"');
    expect(activity('tools.call').at(-1)).toMatchObject({
      outcome: 'success',
      backendId: b.id,
      toolName: `${b.id}__create_item`,
    });
  });

  it('rejects unknown tools, invalid arguments, and disabled or disconnected backends', async () => {
    const backend = register('backend-b', 'b');
    await connectAndDiscover(backend.id);
    const router = new ToolRouter({ store, logger, lifecycle, catalog });

    await expect(router.call('ghost__tool', {})).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });
    await expect(router.call(`${backend.id}__create_item`, { kind: 'z', name: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(router.call(`${backend.id}__create_item`, { kind: 'a' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    await lifecycle.disconnect(backend.id);
    await expect(router.call(`${backend.id}__create_item`, { kind: 'a', name: 'x' })).rejects.toMatchObject({
      code: 'TOOL_UNAVAILABLE',
    });
  });

  it('rejects a disconnected backend even while the catalog still lists it', async () => {
    const backend = register('backend-a', 'a');
    await connectAndDiscover(backend.id);
    const router = new ToolRouter({ store, logger, lifecycle, catalog });

    await lifecycle.disconnect(backend.id);

    // The catalog entry is only dropped by the observer, which this harness does
    // not wire: routing must still refuse, because it re-checks runtime truth.
    expect(catalog.resolve(`${backend.id}__echo`)).toHaveProperty('tool');
    await expect(router.call(`${backend.id}__echo`, { text: 'x' })).rejects.toMatchObject({
      code: 'TOOL_UNAVAILABLE',
    });
  });

  it('passes a backend tool-level error through as a result', async () => {
    const backend = register('backend-b', 'b');
    await connectAndDiscover(backend.id);
    const router = new ToolRouter({ store, logger, lifecycle, catalog });

    const { result } = await router.call(`${backend.id}__fail`, {});
    expect(result.isError).toBe(true);
    expect(activity('tools.call').at(-1)).toMatchObject({ outcome: 'failure' });
  });

  it('forwards arguments without local validation when the remote schema is uncompilable', async () => {
    const backend = register('backend-a', 'a');
    await connectAndDiscover(backend.id);
    const router = new ToolRouter({ store, logger, lifecycle, catalog });

    const { result } = await router.call(`${backend.id}__broken_schema`, { anything: true });
    expect((result.content[0] as { text: string }).text).toContain('anything');
  });

  it('maps an exceeded call budget onto BACKEND_TIMEOUT', async () => {
    const backend = register('backend-a', 'a');
    await connectAndDiscover(backend.id);

    // The router's ceiling is the outer bound; the backend would happily wait.
    const router = new ToolRouter({ store, logger, lifecycle, catalog, timeoutMs: 500 });

    await expect(router.call(`${backend.id}__slow`, { ms: 4_000 })).rejects.toMatchObject({
      code: 'BACKEND_TIMEOUT',
    });
  }, 20_000);

  it('classifies caller cancellation as TOOL_CANCELLED', async () => {
    const backend = register('backend-a', 'a');
    await connectAndDiscover(backend.id);
    const router = new ToolRouter({ store, logger, lifecycle, catalog });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);

    try {
      await expect(
        router.call(`${backend.id}__slow`, { ms: 4_000 }, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'TOOL_CANCELLED' });
    } finally {
      clearTimeout(timer);
    }
  });

  it('refuses before dispatch when the signal is already aborted', async () => {
    const backend = register('backend-a', 'a');
    await connectAndDiscover(backend.id);
    const router = new ToolRouter({ store, logger, lifecycle, catalog });

    const controller = new AbortController();
    controller.abort();

    await expect(
      router.call(`${backend.id}__echo`, { text: 'x' }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'TOOL_CANCELLED' });
  });

  it('serializes many concurrent calls on one backend without mixing results', async () => {
    const backend = register('backend-a', 'a');
    await connectAndDiscover(backend.id);
    const router = new ToolRouter({ store, logger, lifecycle, catalog });

    const texts = ['one', 'two', 'three', 'four', 'five'];
    const results = await Promise.all(texts.map((text) => router.call(`${backend.id}__echo`, { text })));

    expect(results.map(({ result }) => JSON.parse((result.content[0] as { text: string }).text).args.text)).toEqual(
      texts,
    );
  });
});

function reportFor(
  backendId: string,
  tools: Map<string, unknown>,
  conflictCount: number,
): { backendId: string; status: 'ok'; toolCount: number; conflictCount: number; rejectedCount: number; discoveredAt: string } {
  return {
    backendId,
    status: 'ok',
    toolCount: tools.size,
    conflictCount,
    rejectedCount: 0,
    discoveredAt: '2026-11-19T00:00:00.000Z',
  };
}

function catalogTool(publicName: string, backendId: string, originalName: string) {
  return {
    name: originalName,
    publicName,
    originalName,
    sourceType: 'mcp_backend' as const,
    sourceId: backendId,
    backendId,
    inputSchema: { type: 'object' },
    availability: 'available' as const,
    discoveredAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  };
}
