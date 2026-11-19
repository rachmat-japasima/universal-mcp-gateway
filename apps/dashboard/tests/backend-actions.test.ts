import { describe, expect, it } from 'vitest';

import type { Backend, BackendRuntimeStatus } from '@/lib/api/types';
import {
  actionAvailability,
  effectiveStatus,
  isFailureStatus,
  isTransientStatus,
} from '@/lib/backends/actions';

/**
 * Action availability has to match the gateway's own rules, not a convenient
 * approximation of them. Each expectation below is derived from
 * `BackendLifecycleManager`:
 *
 *   * `connect` returns early on `connected`/`connecting`;
 *   * `connect`/`reconnect` throw `409` on a disabled backend;
 *   * `disconnect` is a teardown towards rest.
 *
 * Getting this wrong is not cosmetic — an offered action that always fails
 * teaches an operator to distrust every button.
 */

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'filesystem',
    transport: 'stdio',
    connection: { type: 'stdio', command: 'npx', args: [], env: {} },
    enabled: true,
    timeoutMs: 30000,
    concurrencyMode: 'serialized',
    version: 1,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

function withStatus(status: BackendRuntimeStatus, enabled = true): Backend {
  return backend({ enabled, runtime: { status, updatedAt: '2026-11-19T00:00:00.000Z' } });
}

describe('actionAvailability', () => {
  it('offers connect on a resting, enabled backend', () => {
    const available = actionAvailability(withStatus('disconnected'));

    expect(available.connect).toBe(true);
    expect(available.disconnect).toBe(false);
    expect(available.enable).toBe(false);
    expect(available.disable).toBe(true);
  });

  it('does not offer connect while already connected', () => {
    // connect() returns the current view unchanged in this state.
    expect(actionAvailability(withStatus('connected')).connect).toBe(false);
  });

  it('does not offer connect or reconnect while a transition is in flight', () => {
    for (const status of ['connecting', 'disconnecting'] as const) {
      const available = actionAvailability(withStatus(status));
      expect(available.connect, status).toBe(false);
      expect(available.reconnect, status).toBe(false);
    }
  });

  it('never offers connect or reconnect on a disabled backend', () => {
    // Both answer 409 RESOURCE_CONFLICT there.
    for (const status of ['disabled', 'disconnected', 'error'] as const) {
      const available = actionAvailability(withStatus(status, false));
      expect(available.connect, status).toBe(false);
      expect(available.reconnect, status).toBe(false);
      expect(available.enable, status).toBe(true);
      expect(available.disable, status).toBe(false);
    }
  });

  it('offers disconnect only above a rest state', () => {
    expect(actionAvailability(withStatus('disconnected')).disconnect).toBe(false);
    expect(actionAvailability(withStatus('disabled', false)).disconnect).toBe(false);

    for (const status of ['connected', 'unhealthy', 'error'] as const) {
      expect(actionAvailability(withStatus(status)).disconnect, status).toBe(true);
    }
  });

  it('always offers delete', () => {
    for (const status of [
      'disconnected',
      'connecting',
      'connected',
      'unhealthy',
      'disconnecting',
      'error',
      'disabled',
    ] as const) {
      expect(actionAvailability(withStatus(status)).delete, status).toBe(true);
    }
  });

  it('falls back to the configuration fact when no runtime row exists', () => {
    expect(actionAvailability(backend({ enabled: true })).connect).toBe(true);
    expect(actionAvailability(backend({ enabled: false })).connect).toBe(false);
    expect(actionAvailability(backend({ enabled: false })).disable).toBe(false);
  });
});

describe('status helpers', () => {
  it('treats connecting and disconnecting as transient', () => {
    expect(isTransientStatus('connecting')).toBe(true);
    expect(isTransientStatus('disconnecting')).toBe(true);
    expect(isTransientStatus('connected')).toBe(false);
    expect(isTransientStatus('disconnected')).toBe(false);
  });

  it('treats error and unhealthy as failures', () => {
    expect(isFailureStatus('error')).toBe(true);
    expect(isFailureStatus('unhealthy')).toBe(true);
    expect(isFailureStatus('connected')).toBe(false);
    expect(isFailureStatus('disabled')).toBe(false);
  });

  it('prefers the live runtime read over the reduced list status', () => {
    const listed = withStatus('disconnected');
    expect(effectiveStatus(listed, { status: 'connected' })).toBe('connected');
    expect(effectiveStatus(listed)).toBe('disconnected');
  });

  it('derives a status from configuration when nothing was ever recorded', () => {
    expect(effectiveStatus(backend({ enabled: true }))).toBe('disconnected');
    expect(effectiveStatus(backend({ enabled: false }))).toBe('disabled');
  });
});
