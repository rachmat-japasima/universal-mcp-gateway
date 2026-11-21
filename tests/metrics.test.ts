import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { runWithCorrelation } from '../src/monitoring/context.js';
import { createGatewayMetrics, Metrics } from '../src/monitoring/metrics.js';
import { createLogger } from '../src/monitoring/logger.js';
import { bearer, createTestAgent, testKeys, type TestAgent } from './fixtures/auth.js';
import { createTestOperator, type TestOperatorSession } from './fixtures/operator.js';

/**
 * Metrics (Phase 11). Two layers, deliberately separate:
 *
 *   * the registry — its own counting rules (closed labels, series caps,
 *     never-throws) proven on fresh instances, where an assertion can be exact;
 *   * the endpoints — access control and export format through the real
 *     gateway. The registry is a process singleton, so endpoint assertions
 *     check deltas and presence, never absolute values.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent', ALLOW_PRIVATE_NETWORK: 'true' });
const logger = createLogger(config);

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };

let directory: string;
let store: Database;
let gateway: Gateway;
let session: TestOperatorSession;
let agent: TestAgent;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-metrics-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  const keys = testKeys();
  // Order matters: `/metrics` is mounted only when an operator is configured
  // at assembly time (the same semantics as a restart after
  // `pnpm operator:create`), so the operator row must exist first.
  session = createTestOperator(store, keys);
  gateway = createGateway({ config, logger, store, credentialKeys: keys });
  agent = createTestAgent(store, keys, { allowTools: ['*'] });
});

afterEach(async () => {
  await gateway.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('registry', () => {
  it('counts, sets and adjusts counters and gauges', () => {
    const m = createGatewayMetrics();

    m.increment('umg_tool_calls_total', { outcome: 'success' });
    m.increment('umg_tool_calls_total', { outcome: 'success' });
    m.increment('umg_tool_calls_total', { outcome: 'failure' }, 5);
    m.set('umg_http_requests_inflight', {}, 3);
    m.adjust('umg_http_requests_inflight', {}, -1);

    const text = m.prometheus();
    expect(text).toContain('umg_tool_calls_total{outcome="success"} 2');
    expect(text).toContain('umg_tool_calls_total{outcome="failure"} 5');
    expect(text).toContain('umg_http_requests_inflight 2');
  });

  it('drops out-of-enum and unknown label values, and counts the drops', () => {
    const m = createGatewayMetrics();
    const droppedBefore = m.dropped();

    m.increment('umg_tool_calls_total', { outcome: 'exploded' });
    m.increment('umg_tool_calls_total', { outcome: 'success', toolName: 'echo' });
    m.increment('umg_mcp_method_total', { method: 'prompts/get', outcome: 'success' });

    expect(m.dropped()).toBe(droppedBefore + 3);
    expect(m.prometheus()).toContain(`umg_metrics_dropped_total ${droppedBefore + 3}`);
    // The one valid observation must still have landed.
    expect(m.prometheus()).not.toContain('outcome="exploded"');
  });

  it('caps the series a metric keeps and reports the overflow as dropped', () => {
    const m = new Metrics();
    m.define({
      name: 'umg_test_capped_total',
      help: 'Two series maximum.',
      type: 'counter',
      labels: { code: { pattern: /^[A-Z]$/ } },
      maxSeries: 2,
    });

    m.increment('umg_test_capped_total', { code: 'A' });
    m.increment('umg_test_capped_total', { code: 'B' });
    m.increment('umg_test_capped_total', { code: 'C' });
    m.increment('umg_test_capped_total', { code: 'A' });

    const text = m.prometheus();
    expect(text).toContain('umg_test_capped_total{code="A"} 2');
    expect(text).toContain('umg_test_capped_total{code="B"} 1');
    expect(text).not.toContain('code="C"');
    expect(m.dropped()).toBe(1);
  });

  it('never throws, whatever a call site passes', () => {
    const m = createGatewayMetrics();

    expect(() => m.increment('umg_not_defined', {})).not.toThrow();
    expect(() => m.increment('umg_tool_calls_total', { outcome: 42 as unknown as string })).not.toThrow();
    expect(() => m.observe('umg_tool_call_duration_ms', {}, Number.NaN)).not.toThrow();
    expect(() => m.increment('umg_tool_calls_total')).not.toThrow();
    expect(m.dropped()).toBeGreaterThanOrEqual(2);
  });

  it('survives concurrent increments without losing any', async () => {
    const m = createGatewayMetrics();

    await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve().then(() => m.increment('umg_tool_calls_total', { outcome: 'denied' }))),
    );

    expect(m.prometheus()).toContain('umg_tool_calls_total{outcome="denied"} 50');
  });

  it('exports histograms with cumulative buckets, +Inf, sum and count', () => {
    const m = createGatewayMetrics();

    m.observe('umg_tool_call_duration_ms', {}, 3);
    m.observe('umg_tool_call_duration_ms', {}, 7);

    const text = m.prometheus();
    expect(text).toContain('# TYPE umg_tool_call_duration_ms histogram');
    expect(text).toContain('umg_tool_call_duration_ms_bucket{le="1"} 0');
    expect(text).toContain('umg_tool_call_duration_ms_bucket{le="5"} 1');
    expect(text).toContain('umg_tool_call_duration_ms_bucket{le="10"} 2');
    expect(text).toContain('umg_tool_call_duration_ms_bucket{le="+Inf"} 2');
    expect(text).toContain('umg_tool_call_duration_ms_sum 10');
    expect(text).toContain('umg_tool_call_duration_ms_count 2');
  });

  it('exports collector gauges and omits values that do not exist yet', () => {
    const m = createGatewayMetrics();
    m.collect('test', () => [
      { name: 'umg_test_collector', help: 'A collector gauge.', value: 7 },
      { name: 'umg_test_nan', help: 'No sample yet.', value: Number.NaN },
    ]);

    const text = m.prometheus();
    expect(text).toContain('# HELP umg_test_collector A collector gauge.');
    expect(text).toContain('umg_test_collector 7');
    expect(text).not.toContain('umg_test_nan');
  });

  it('replaces a keyed collector instead of accumulating one per assembly', () => {
    const m = new Metrics();
    m.collect('key', () => [{ name: 'umg_test_first', help: 'First.', value: 1 }]);
    m.collect('key', () => [{ name: 'umg_test_second', help: 'Second.', value: 2 }]);

    const text = m.prometheus();
    expect(text).toContain('umg_test_second 2');
    expect(text).not.toContain('umg_test_first');
  });

  it('serializes the snapshot as valid JSON, NaN values becoming null', () => {
    const m = createGatewayMetrics();
    m.set('umg_http_requests_inflight', {}, Number.NaN);
    m.observe('umg_tool_call_duration_ms', {}, 4);

    const parsed = JSON.parse(JSON.stringify(m.snapshot())) as {
      series: number;
      dropped: number;
      metrics: Array<{ name: string; samples: Array<Record<string, unknown>> }>;
      recentErrors: unknown[];
    };

    expect(parsed.series).toBeGreaterThan(0);
    expect(parsed.dropped).toBe(0);
    expect(parsed.recentErrors).toEqual([]);

    const gauge = parsed.metrics.find((metric) => metric.name === 'umg_http_requests_inflight');
    expect(gauge?.samples[0]).toMatchObject({ labels: {}, value: null });

    const histogram = parsed.metrics.find((metric) => metric.name === 'umg_tool_call_duration_ms');
    expect(histogram?.samples[0]).toMatchObject({ count: 1, sum: 4 });
  });

  it('records error classes with the request id from the live correlation context', async () => {
    const m = createGatewayMetrics();

    await runWithCorrelation({ requestId: 'ring-req-1', correlationId: 'ring-c-1' }, async () => {
      m.recordError('DATABASE_ERROR', 'api');
    });
    m.recordError('BACKEND_TIMEOUT', 'lifecycle');

    const errors = m.recentErrorList();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ code: 'DATABASE_ERROR', component: 'api', requestId: 'ring-req-1' });
    expect(errors[1]).toMatchObject({ code: 'BACKEND_TIMEOUT', component: 'lifecycle' });
    expect(errors[1]).not.toHaveProperty('requestId');
    // Messages are the leak vector; they are not in the shape at all.
    expect(JSON.stringify(errors)).not.toContain('message');
    expect(m.prometheus()).toContain('umg_errors_total{code="DATABASE_ERROR",component="api"} 1');
  });

  it('bounds the recent-error ring at 20 entries', () => {
    const m = new Metrics();
    for (let index = 0; index < 30; index += 1) m.recordError('BACKEND_TIMEOUT', 'lifecycle');

    const errors = m.recentErrorList();
    expect(errors).toHaveLength(20);
    expect(errors[0]).toMatchObject({ code: 'BACKEND_TIMEOUT' });
    expect(errors.at(-1)).toMatchObject({ code: 'BACKEND_TIMEOUT' });
  });

  it('samples event-loop delay only while started', async () => {
    const m = new Metrics();
    expect(m.eventLoopDelay()).toBeUndefined();

    m.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(m.eventLoopDelay()).toMatchObject({ mean: expect.any(Number), p99: expect.any(Number) });

    m.stop();
    expect(m.eventLoopDelay()).toBeUndefined();
  });
});

describe('GET /metrics (Prometheus export)', () => {
  it('requires an operator session', async () => {
    const response = await gateway.app.request('/metrics', { headers: HOST });
    expect(response.status).toBe(401);
  });

  it('exports valid Prometheus text to an operator, counting its own scrape', async () => {
    const first = await gateway.app.request('/metrics', { headers: { ...HOST, ...session.headers } });
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/plain');
    expect(first.headers.get('content-type')).toContain('version=0.0.4');

    const text = await first.text();
    expect(text).toContain('# HELP umg_http_requests_total ');
    expect(text).toContain('# TYPE umg_http_requests_total counter');
    // The scrape itself is counted after the body is rendered, so the second
    // scrape must show its predecessor.
    const second = await gateway.app.request('/metrics', { headers: { ...HOST, ...session.headers } });
    const secondText = await second.text();
    expect(secondText).toMatch(/umg_http_requests_total\{method="GET",route="metrics",status="200"\} [1-9]\d*/);
    expect(secondText).toContain('# HELP umg_process_uptime_seconds ');
  });

  it('is not mounted when no operator is configured', async () => {
    const separate = mkdtempSync(join(tmpdir(), 'gw-metrics-noop-'));
    const separateStore = openStore({ path: join(separate, 'gateway.db') });
    const bare = createGateway({ config, logger, store: separateStore, credentialKeys: testKeys() });

    // A fresh database has no operator row, so there is no session to require
    // and the route must not exist — 404, not a permanent 401.
    const response = await bare.app.request('/metrics', { headers: HOST });
    expect(response.status).toBe(404);

    await bare.close();
    separateStore.close();
    rmSync(separate, { recursive: true, force: true });
  });
});

describe('GET /api/v1/monitoring/metrics (JSON export)', () => {
  it('serves the same registry as JSON inside the operator boundary', async () => {
    const response = await gateway.app.request('/api/v1/monitoring/metrics', {
      headers: { ...HOST, ...session.headers },
    });
    expect(response.status).toBe(200);

    const { data } = (await response.json()) as { data: Record<string, unknown> };
    expect(data['generatedAt']).toEqual(expect.any(String));
    expect(data['series']).toEqual(expect.any(Number));
    expect(data['dropped']).toEqual(expect.any(Number));
    expect(Array.isArray(data['metrics'])).toBe(true);
  });

  it('counts requests by route class and status', async () => {
    const before = await gateway.app.request('/api/v1/monitoring/metrics', {
      headers: { ...HOST, ...session.headers },
    });
    const beforeData = (await before.json()) as { data: { metrics: Array<{ name: string; samples: Array<{ labels: Record<string, string>; value: number }> }> } };

    const countFor = (body: typeof beforeData) =>
      body.data.metrics
        .find((metric) => metric.name === 'umg_http_requests_total')
        ?.samples.find((sample) => sample.labels['route'] === 'api' && sample.labels['status'] === '200')?.value ?? 0;

    await gateway.app.request('/api/v1/overview', { headers: { ...HOST, ...session.headers } });

    const after = await gateway.app.request('/api/v1/monitoring/metrics', {
      headers: { ...HOST, ...session.headers },
    });
    const afterData = (await after.json()) as typeof beforeData;

    expect(countFor(afterData)).toBeGreaterThan(countFor(beforeData));
  });
});

describe('diagnostics', () => {
  it('reports the metrics registry state and a bounded error ring', async () => {
    const response = await gateway.app.request('/api/v1/diagnostics', {
      headers: { ...HOST, ...session.headers },
    });
    expect(response.status).toBe(200);

    const { data } = (await response.json()) as { data: Record<string, any> };
    expect(data.metrics).toMatchObject({ status: 'ok', series: expect.any(Number), dropped: expect.any(Number) });
    expect(Array.isArray(data.recentErrors)).toBe(true);
  });

  it('adds a client-rejected request to the error counter but not the ring', async () => {
    const before = await gateway.app.request('/api/v1/diagnostics', { headers: { ...HOST, ...session.headers } });
    const beforeData = (await before.json()) as { data: { recentErrors: unknown[] } };

    const rejected = await gateway.app.request('/api/v1/activity?limit=not-a-number', {
      headers: { ...HOST, ...session.headers },
    });
    expect(rejected.status).toBe(400);

    const after = await gateway.app.request('/api/v1/diagnostics', { headers: { ...HOST, ...session.headers } });
    const afterData = (await after.json()) as {
      data: { recentErrors: unknown[]; metrics: { dropped: number } };
    };

    // A bad query parameter is noise, not an incident: counter, not ring.
    expect(afterData.data.recentErrors).toHaveLength(beforeData.data.recentErrors.length);

    const snapshot = await gateway.app.request('/api/v1/monitoring/metrics', {
      headers: { ...HOST, ...session.headers },
    });
    const snapshotData = (await snapshot.json()) as { data: { metrics: Array<{ name: string; samples: Array<{ labels: Record<string, string>; value: number }> }> } };
    const validationErrors = snapshotData.data.metrics
      .find((metric) => metric.name === 'umg_errors_total')
      ?.samples.find((sample) => sample.labels['code'] === 'VALIDATION_ERROR');
    expect(validationErrors?.value).toBeGreaterThan(0);
  });

  it('adds an internal failure to the error ring with its request id', async () => {
    const { metrics: registry } = await import('../src/monitoring/metrics.js');

    // A closed store fails the request inside the operator boundary — the
    // session lookup itself throws — and the raw throw is mapped by the error
    // handler to INTERNAL_ERROR, the class this test asserts. Which boundary
    // threw is out of scope; the ring mechanism is what is under test. The
    // ring is read directly: with the store closed the JSON endpoint cannot
    // be reached ("a closed store closes the operator session lookup").
    store.close();
    store = openStore({ path: join(directory, 'gateway.db') });

    const failed = await gateway.app.request('/api/v1/activity', {
      headers: { ...HOST, ...session.headers, 'X-Request-Id': 'db-failure-1' },
    });
    expect(failed.status).toBe(500);

    const entry = registry.recentErrorList().find((row) => row.requestId === 'db-failure-1');
    expect(entry).toMatchObject({ code: 'INTERNAL_ERROR', component: 'api' });
    // The ring carries the class of the error, never its message.
    expect(JSON.stringify(entry)).not.toContain('database connection is not open');
  });
});
