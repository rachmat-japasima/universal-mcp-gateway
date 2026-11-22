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

/**
 * Lifecycle tests run real child processes and a real loopback listener.
 *
 * Both fixtures are test-only files under `tests/fixtures`; nothing here is a
 * production backend, and every store is a temp file that is deleted after the
 * test. Defaults keep reconnect off and private-network destinations refused, so
 * a test must opt in explicitly to either.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-fixture.ts', import.meta.url));

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

let directory: string;
let store: Database;
let service: BackendService;
let manager: BackendLifecycleManager;

const reconnectOff: ReconnectPolicy = {
  enabled: false,
  initialDelayMs: 100,
  maxDelayMs: 200,
  maxAttempts: 2,
  jitterRatio: 0,
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-life-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  service = new BackendService(store);
  manager = new BackendLifecycleManager({
    store,
    logger,
    networkPolicy: { allowPrivateNetwork: true },
    reconnect: reconnectOff,
    random: () => 0.5,
  });
});

afterEach(async () => {
  await manager.shutdown();
  for (const child of fixtures.splice(0)) child.kill('SIGKILL');
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const stdioFixture = (mode: string) => ({
  type: 'stdio' as const,
  command: process.execPath,
  args: ['--import', 'tsx', FIXTURE, mode],
});

function register(name: string, connection: unknown, extra: Record<string, unknown> = {}) {
  return service.create({ name, connection: connection as never, ...extra });
}

describe('recover', () => {
  it('never trusts a persisted connected state and does not reconnect', () => {
    const backend = register('was-connected', stdioFixture('stdio'));

    store.backendRuntime.upsert({
      backendId: backend.id,
      status: 'connected',
      lastConnectedAt: '2026-11-18T00:00:00.000Z',
      reconnectAttempts: 3,
      updatedAt: '2026-11-18T00:00:00.000Z',
    });

    manager.recover();

    const runtime = store.backendRuntime.findByBackendId(backend.id);
    expect(runtime).toMatchObject({ status: 'disconnected', reconnectAttempts: 0 });
    // History is preserved: only the live-sounding claim is dropped.
    expect(runtime?.lastConnectedAt).toBe('2026-11-18T00:00:00.000Z');
    expect(manager.activeCount).toBe(0);
  });

  it('rewrites a persisted connected state to disabled when the config says so', () => {
    const backend = register('disabled', stdioFixture('stdio'), { enabled: false });
    store.backendRuntime.upsert({
      backendId: backend.id,
      status: 'connected',
      reconnectAttempts: 1,
      updatedAt: '2026-11-18T00:00:00.000Z',
    });

    expect(manager.recover()).toMatchObject({ disabled: 1 });
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disabled');
  });

  it('leaves a persisted error alone and reconciles a tombstoned row', () => {
    const failing = register('errored', stdioFixture('stdio'));
    store.backendRuntime.upsert({
      backendId: failing.id,
      status: 'error',
      lastErrorCode: 'BACKEND_CONNECTION_ERROR',
      lastErrorMessage: 'still broken',
      reconnectAttempts: 0,
      updatedAt: '2026-11-18T00:00:00.000Z',
    });

    const doomed = register('doomed', stdioFixture('stdio'));
    service.remove(doomed.id);

    manager.recover();

    expect(store.backendRuntime.findByBackendId(failing.id)).toMatchObject({ status: 'error' });
    expect(store.backendRuntime.findByBackendId(doomed.id)?.status).toBe('disconnected');
  });
});

describe('connect and disconnect', () => {
  it('connects over stdio, records the state, and tears the child down', async () => {
    const backend = register('stdio-ok', stdioFixture('stdio'));

    const view = await manager.connect(backend.id);
    expect(view).toMatchObject({ backendId: backend.id, status: 'connected', reconnectAttempts: 0 });
    expect(view.lastConnectedAt).toBeTypeOf('string');
    expect(view.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(manager.activeCount).toBe(1);

    const disconnected = await manager.disconnect(backend.id);
    expect(disconnected.status).toBe('disconnected');
    expect(manager.activeCount).toBe(0);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disconnected');
  });

  it('is idempotent: a second connect returns the live state, a second disconnect is a no-op', async () => {
    const backend = register('stdio-twice', stdioFixture('stdio'));

    const first = await manager.connect(backend.id);
    const second = await manager.connect(backend.id);
    expect(second.lastConnectedAt).toBe(first.lastConnectedAt);
    expect(manager.activeCount).toBe(1);

    await manager.disconnect(backend.id);
    expect((await manager.disconnect(backend.id)).status).toBe('disconnected');
  });

  it('serializes concurrent connects so only one process is spawned', async () => {
    const backend = register('stdio-race', stdioFixture('stdio'));

    const views = await Promise.all([manager.connect(backend.id), manager.connect(backend.id)]);
    expect(views.map((view) => view.status)).toEqual(['connected', 'connected']);
    expect(manager.activeCount).toBe(1);
  });

  it('records a permanent failure as error and leaves nothing running', async () => {
    const backend = register('missing-binary', { type: 'stdio', command: '/nonexistent/mcp-server', args: [] });

    await expect(manager.connect(backend.id)).rejects.toThrow(/executable could not be started/);

    const runtime = store.backendRuntime.findByBackendId(backend.id);
    expect(runtime).toMatchObject({ status: 'error', lastErrorCode: 'BACKEND_CONNECTION_ERROR' });
    expect(manager.activeCount).toBe(0);
    // Permanent failures are never retried, so no attempt is recorded.
    expect(runtime?.reconnectAttempts).toBe(0);
  });

  it('surfaces the child stderr tail on a failed handshake', async () => {
    const backend = register('crashing', stdioFixture('crash'));

    await expect(manager.connect(backend.id)).rejects.toThrow(/refusing to serve/);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('error');
    expect(manager.activeCount).toBe(0);
  });

  it('times out a backend that never completes the handshake', async () => {
    const backend = register('hanging', stdioFixture('hang'), { timeoutMs: 300 });

    await expect(manager.connect(backend.id)).rejects.toThrow();

    const runtime = store.backendRuntime.findByBackendId(backend.id);
    expect(runtime?.status).toBe('error');
    expect(['BACKEND_TIMEOUT', 'BACKEND_UNAVAILABLE']).toContain(runtime?.lastErrorCode);
    await manager.shutdown();
    expect(manager.activeCount).toBe(0);
  });

  it('refuses to connect a disabled backend', async () => {
    const backend = register('disabled-connect', stdioFixture('stdio'), { enabled: false });

    await expect(manager.connect(backend.id)).rejects.toThrow(/disabled/);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disabled');
  });

  it('reports a missing backend without creating runtime state', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(manager.connect(missing)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(() => manager.getRuntimeState(missing)).toThrow(/does not exist/);
  });

  it('reconnect resets the attempt counter and reopens the connection', async () => {
    const backend = register('stdio-reconnect', stdioFixture('stdio'));
    store.backendRuntime.upsert({
      backendId: backend.id,
      status: 'error',
      lastErrorCode: 'BACKEND_UNAVAILABLE',
      lastErrorMessage: 'previous failure',
      reconnectAttempts: 4,
      updatedAt: '2026-11-18T00:00:00.000Z',
    });

    const view = await manager.reconnect(backend.id);
    expect(view).toMatchObject({ status: 'connected', reconnectAttempts: 0 });
  });
});

describe('http transport', () => {
  it('connects over loopback Streamable HTTP when the policy allows it', async () => {
    const port = await startHttpFixture();
    const backend = register('http-ok', { type: 'streamable-http', url: `http://127.0.0.1:${port}/mcp` });

    const view = await manager.connect(backend.id);
    expect(view.status).toBe('connected');
    await manager.disconnect(backend.id);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disconnected');
  });

  it('refuses a loopback destination when the policy does not allow it', async () => {
    const strict = new BackendLifecycleManager({
      store,
      logger,
      networkPolicy: { allowPrivateNetwork: false },
      reconnect: reconnectOff,
    });

    try {
      const port = await startHttpFixture();
      const backend = register('http-blocked', { type: 'streamable-http', url: `http://127.0.0.1:${port}/mcp` });

      await expect(strict.connect(backend.id)).rejects.toThrow(/loopback|restricted/i);
      expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('error');
    } finally {
      await strict.shutdown();
    }
  });
});

describe('reconcile', () => {
  it('does not connect anything on create or enable', async () => {
    const backend = register('no-auto', stdioFixture('stdio'));
    await manager.reconcile(backend.id);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disconnected');

    service.setEnabled(backend.id, false);
    await manager.reconcile(backend.id);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disabled');

    service.setEnabled(backend.id, true);
    await manager.reconcile(backend.id);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disconnected');
    expect(manager.activeCount).toBe(0);
  });

  it('disconnects and cancels retries when the backend is disabled', async () => {
    const backend = register('disable-live', stdioFixture('stdio'));
    await manager.connect(backend.id);
    expect(manager.activeCount).toBe(1);

    service.setEnabled(backend.id, false);
    await manager.reconcile(backend.id);

    expect(manager.activeCount).toBe(0);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disabled');
  });

  it('tears down a live connection when its configuration changes', async () => {
    const backend = register('config-change', stdioFixture('stdio'));
    await manager.connect(backend.id);

    service.update(backend.id, { timeoutMs: 15_000 }, backend.version);
    await manager.reconcile(backend.id);

    expect(manager.activeCount).toBe(0);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disconnected');
  });

  it('tears down a live connection when the backend is deleted', async () => {
    const backend = register('deleted-live', stdioFixture('stdio'));
    await manager.connect(backend.id);

    service.remove(backend.id);
    await manager.reconcile(backend.id);

    expect(manager.activeCount).toBe(0);
    expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disconnected');
  });

  it('leaves an unchanged live connection alone', async () => {
    const backend = register('unchanged', stdioFixture('stdio'));
    await manager.connect(backend.id);

    // An unrelated field: the description is not part of the connection.
    service.update(backend.id, { description: 'still the same connection' }, backend.version);
    await manager.reconcile(backend.id);

    expect(manager.activeCount).toBe(1);
    expect(manager.getRuntimeState(backend.id).status).toBe('connected');
  });
});

describe('runtime reads', () => {
  it('lists every registered backend, including one never connected', async () => {
    const a = register('aaa', stdioFixture('stdio'));
    const b = register('bbb', stdioFixture('stdio'));

    const states = manager.getAllRuntimeStates();
    expect(states.map((state) => state.backendId)).toEqual([a.id, b.id].sort());
    expect(states.every((state) => state.status === 'disconnected')).toBe(true);
  });

  it('never exposes a pid or connection detail', async () => {
    const backend = register('view-shape', { type: 'stdio', command: process.execPath, args: [] });
    const view = manager.getRuntimeState(backend.id);

    expect(Object.keys(view).sort()).toEqual(['backendId', 'reconnectAttempts', 'status', 'updatedAt']);
  });
});

describe('reconnect policy', () => {
  it('retries a transient failure with bounded attempts, then stops', async () => {
    const retrying = new BackendLifecycleManager({
      store,
      logger,
      networkPolicy: { allowPrivateNetwork: true },
      reconnect: { ...reconnectOff, enabled: true, initialDelayMs: 50, maxDelayMs: 50, maxAttempts: 2 },
      random: () => 0.5,
    });

    try {
      // Nothing is listening on port 1: a transient, unreachable destination.
      const backend = register('unreachable', { type: 'streamable-http', url: 'http://127.0.0.1:45999/mcp' });

      await expect(retrying.connect(backend.id)).rejects.toThrow();
      expect(store.backendRuntime.findByBackendId(backend.id)?.reconnectAttempts).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 500));

      const runtime = store.backendRuntime.findByBackendId(backend.id);
      expect(runtime?.status).toBe('error');
      expect(runtime?.reconnectAttempts).toBe(2);
    } finally {
      await retrying.shutdown();
    }
  });

  it('cancels a pending retry when the backend is disabled', async () => {
    const retrying = new BackendLifecycleManager({
      store,
      logger,
      networkPolicy: { allowPrivateNetwork: true },
      reconnect: { ...reconnectOff, enabled: true, initialDelayMs: 5_000, maxDelayMs: 5_000, maxAttempts: 5 },
    });

    try {
      const backend = register('cancel-retry', { type: 'streamable-http', url: 'http://127.0.0.1:45999/mcp' });
      await expect(retrying.connect(backend.id)).rejects.toThrow();
      expect(store.backendRuntime.findByBackendId(backend.id)?.reconnectAttempts).toBe(1);

      service.setEnabled(backend.id, false);
      await retrying.reconcile(backend.id);

      // No new attempt can fire: the timer is gone and the state is settled.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(store.backendRuntime.findByBackendId(backend.id)?.status).toBe('disabled');
    } finally {
      await retrying.shutdown();
    }
  });
});

describe('shutdown', () => {
  it('stops every connection and refuses new ones', async () => {
    const a = register('shutdown-a', stdioFixture('stdio'));
    const b = register('shutdown-b', stdioFixture('stdio'));
    await manager.connect(a.id);
    await manager.connect(b.id);
    expect(manager.activeCount).toBe(2);

    await manager.shutdown();

    expect(manager.activeCount).toBe(0);
    expect(store.backendRuntime.findByBackendId(a.id)?.status).toBe('disconnected');
    await expect(manager.connect(a.id)).rejects.toThrow(/shutting down/);
  });

  it('is safe to call twice', async () => {
    await expect(manager.shutdown()).resolves.toBeUndefined();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});

/** Fixtures spawned by this file, killed in `afterEach` so no listener leaks. */
const fixtures: Array<import('node:child_process').ChildProcess> = [];

/** Starts the HTTP fixture and waits for its self-reported port. */
async function startHttpFixture(): Promise<number> {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, 'http'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  fixtures.push(child);

  return new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('the HTTP fixture did not start')), 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += String(chunk);
      const line = buffer.split('\n').find((part) => part.includes('port'));
      if (line === undefined) return;
      clearTimeout(timer);
      resolve((JSON.parse(line) as { port: number }).port);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the HTTP fixture exited with ${String(code)}`));
    });
  });
}
