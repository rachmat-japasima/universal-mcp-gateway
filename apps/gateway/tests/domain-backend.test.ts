import { describe, expect, it } from 'vitest';

import { backendConnectionSchema, backendSchema, createBackendSchema, updateBackendSchema } from '../src/domain/backend.js';
import {
  BACKEND_STATUSES,
  BACKEND_TRANSITIONS,
  backendRuntimeSchema,
  canTransition,
  initialBackendRuntime,
} from '../src/domain/backend-runtime.js';

const stdio = { type: 'stdio' as const, command: 'node', args: ['server.js'] };

const valid = {
  name: 'example',
  description: 'An example backend',
  connection: stdio,
  enabled: true,
  timeoutMs: 30_000,
  concurrencyMode: 'serialized' as const,
};

describe('backend connection config', () => {
  it('accepts stdio with executable and argument array', () => {
    const parsed = backendConnectionSchema.parse(stdio);
    expect(parsed).toEqual({ type: 'stdio', command: 'node', args: ['server.js'], env: {} });
  });

  it('accepts streamable-http with an http(s) url', () => {
    expect(backendConnectionSchema.parse({ type: 'streamable-http', url: 'https://backend.test/mcp' })).toEqual({
      type: 'streamable-http',
      url: 'https://backend.test/mcp',
      headers: {},
    });
  });

  it('rejects a non-http protocol', () => {
    expect(() => backendConnectionSchema.parse({ type: 'streamable-http', url: 'file:///etc/passwd' })).toThrow();
  });

  it('rejects a shell string where an argument array is expected', () => {
    // The whole point of the array: `command: 'node server.js && rm -rf /'` must be unrepresentable.
    expect(() => backendConnectionSchema.parse({ type: 'stdio', command: 'node server.js', args: 'server.js' })).toThrow();
  });

  it('rejects a literal secret in env, accepting only secret references', () => {
    expect(() =>
      backendConnectionSchema.parse({ ...stdio, env: { API_KEY: 'sk-live-abc123' } }),
    ).toThrow(/secret reference/i);
    expect(backendConnectionSchema.parse({ ...stdio, env: { API_KEY: 'secret:mcp/api-key' } })).toMatchObject({
      env: { API_KEY: 'secret:mcp/api-key' },
    });
    expect(backendConnectionSchema.parse({ ...stdio, env: { API_KEY: 'env:API_KEY' } })).toMatchObject({
      env: { API_KEY: 'env:API_KEY' },
    });
  });

  it('rejects unknown fields', () => {
    expect(() => createBackendSchema.parse({ ...valid, shell: true })).toThrow();
    expect(() => backendConnectionSchema.parse({ ...stdio, shell: true })).toThrow();
  });

  it('requires env keys to be POSIX names and header keys to be HTTP tokens', () => {
    // A secret pasted as a name cannot pass as a POSIX variable (hyphens are illegal).
    expect(() => backendConnectionSchema.parse({ ...stdio, env: { 'sk-live-XYZ': 'env:OK' } })).toThrow();
    expect(() => backendConnectionSchema.parse({ ...stdio, env: { '1BAD': 'env:OK' } })).toThrow();
    expect(backendConnectionSchema.parse({ ...stdio, env: { API_KEY: 'env:OK', _x: 'env:Y' } })).toMatchObject({
      env: { API_KEY: 'env:OK', _x: 'env:Y' },
    });

    // Header names follow RFC 7230, so a hyphenated secret is a legal *name*.
    // It is config text the caller supplied, not a credential value.
    expect(
      backendConnectionSchema.parse({
        type: 'streamable-http',
        url: 'https://backend.test/mcp',
        headers: { 'X-Api-Key': 'secret:mcp/key' },
      }),
    ).toMatchObject({ headers: { 'X-Api-Key': 'secret:mcp/key' } });
    expect(() =>
      backendConnectionSchema.parse({ type: 'streamable-http', url: 'https://x.test/mcp', headers: { 'bad name': 'env:X' } }),
    ).toThrow();
  });
});

describe('createBackendSchema', () => {
  it('applies documented defaults', () => {
    const parsed = createBackendSchema.parse({ name: 'minimal', connection: stdio });
    expect(parsed).toMatchObject({ enabled: true, timeoutMs: 30_000, concurrencyMode: 'serialized' });
  });

  it('requires a concurrency limit only for the limited mode', () => {
    expect(createBackendSchema.parse({ ...valid, concurrencyMode: 'limited', concurrencyLimit: 2 })).toMatchObject({
      concurrencyLimit: 2,
    });

    expect(() => createBackendSchema.parse({ ...valid, concurrencyMode: 'limited' })).toThrow(/concurrencyLimit/);
    expect(() => createBackendSchema.parse({ ...valid, concurrencyMode: 'parallel', concurrencyLimit: 2 })).toThrow();
  });

  it('rejects an empty name and an out-of-range timeout', () => {
    expect(() => createBackendSchema.parse({ ...valid, name: '   ' })).toThrow();
    expect(() => createBackendSchema.parse({ ...valid, timeoutMs: 10 })).toThrow();
  });
});

describe('updateBackendSchema', () => {
  it('accepts a partial update', () => {
    expect(updateBackendSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('distinguishes clearing from omitting', () => {
    expect(updateBackendSchema.parse({})).not.toHaveProperty('description');
    expect(updateBackendSchema.parse({ description: 'kept' })).toHaveProperty('description', 'kept');
  });
});

describe('backend stable shape', () => {
  it('requires an id and timestamps', () => {
    expect(() =>
      backendSchema.parse({
        ...valid,
        id: 'not-a-uuid',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow();

    expect(
      backendSchema.parse({
        ...valid,
        id: '9b2f8b57-3f4d-4a2e-9c2e-0f3f2a1b2c3d',
        version: 1,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
      }),
    ).toMatchObject({ name: 'example' });
  });
});

describe('backend runtime state', () => {
  const backendId = '9b2f8b57-3f4d-4a2e-9c2e-0f3f2a1b2c3d';

  it('starts disconnected when enabled and disabled when not', () => {
    expect(initialBackendRuntime(backendId, true, '2026-11-18T00:00:00.000Z').status).toBe('disconnected');
    expect(initialBackendRuntime(backendId, false, '2026-11-18T00:00:00.000Z').status).toBe('disabled');
  });

  it('never implies a connection from configuration alone', () => {
    const runtime = initialBackendRuntime(backendId, true, '2026-11-18T00:00:00.000Z');
    expect(runtime).not.toHaveProperty('lastConnectedAt');
    expect(runtime.reconnectAttempts).toBe(0);
  });

  it('rejects an unknown status and a negative reconnect count', () => {
    const base = { backendId, updatedAt: '2026-11-18T00:00:00.000Z', reconnectAttempts: 0 };
    // `connected` is a valid status even with no timestamps yet: the state and its
    // metadata are written separately so a connect can be recorded before a clock read.
    expect(backendRuntimeSchema.parse({ ...base, status: 'connected' })).toMatchObject({ status: 'connected' });
    expect(() => backendRuntimeSchema.parse({ ...base, status: 'teleported' })).toThrow();
    expect(() => backendRuntimeSchema.parse({ ...base, status: 'error', reconnectAttempts: -1 })).toThrow();
  });

  it('bounds the sanitized error message', () => {
    const base = {
      backendId,
      status: 'error' as const,
      reconnectAttempts: 0,
      updatedAt: '2026-11-18T00:00:00.000Z',
    };
    expect(backendRuntimeSchema.parse({ ...base, lastErrorMessage: 'connection refused' })).toMatchObject({
      lastErrorMessage: 'connection refused',
    });
    expect(() => backendRuntimeSchema.parse({ ...base, lastErrorMessage: 'x'.repeat(501) })).toThrow();
  });
});

describe('runtime state machine', () => {
  it('declares an edge set for every status, and every target is a real status', () => {
    expect(Object.keys(BACKEND_TRANSITIONS).sort()).toEqual([...BACKEND_STATUSES].sort());

    for (const [from, targets] of Object.entries(BACKEND_TRANSITIONS)) {
      for (const to of targets) {
        expect(BACKEND_STATUSES, `${from} -> ${to}`).toContain(to);
      }
    }
  });

  it('has no self-transition and no unreachable state', () => {
    for (const status of BACKEND_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }

    // Every status is reachable from `disconnected`, directly or transitively.
    const seen = new Set(['disconnected']);
    const queue = ['disconnected'];
    while (queue.length > 0) {
      const current = queue.shift() as (typeof BACKEND_STATUSES)[number];
      for (const next of BACKEND_TRANSITIONS[current]) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    expect([...seen].sort()).toEqual([...BACKEND_STATUSES].sort());
  });

  it('allows exactly the transitions the lifecycle manager performs', () => {
    expect(canTransition('disconnected', 'connecting')).toBe(true);
    expect(canTransition('connecting', 'connected')).toBe(true);
    expect(canTransition('connected', 'disconnecting')).toBe(true);
    expect(canTransition('disconnecting', 'disconnected')).toBe(true);
    expect(canTransition('connected', 'unhealthy')).toBe(true);
    expect(canTransition('unhealthy', 'connecting')).toBe(true);
    expect(canTransition('error', 'connecting')).toBe(true);

    // Illegal on purpose: a live state cannot appear without an attempt, and
    // `disabled` is a configuration fact, not a connection outcome.
    expect(canTransition('disconnected', 'connected')).toBe(false);
    expect(canTransition('connecting', 'disconnecting')).toBe(false);
    expect(canTransition('disabled', 'connected')).toBe(false);
    expect(canTransition('connected', 'disabled')).toBe(false);
  });
});
