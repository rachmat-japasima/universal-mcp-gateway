import { describe, expect, it } from 'vitest';

import { isReadiness } from '@/lib/validation/readiness';

/**
 * The validator is the only thing standing between a `503` error envelope and a
 * header that claims a gateway is present but "not ready". Each case here is a
 * payload that could plausibly arrive from the proxy or a misconfigured origin.
 */

const valid = {
  status: 'ready',
  checks: { database: 'ok', migrations: 'ok' },
  migrationVersion: '0005',
  timestamp: '2026-11-18T22:59:32.753Z',
};

describe('isReadiness', () => {
  it('accepts a ready payload', () => {
    expect(isReadiness(valid)).toBe(true);
  });

  it('accepts not_ready without migrationVersion, which the gateway omits', () => {
    const notReady = {
      status: 'not_ready',
      checks: { database: 'unavailable', migrations: 'unavailable' },
      timestamp: '2026-11-18T22:59:32.753Z',
    };

    // `readyHandler` spread-omits the field when migrations are unreadable, so
    // requiring it would reject a legitimate answer.
    expect(isReadiness(notReady)).toBe(true);
  });

  it('rejects the proxy error envelope returned for an unreachable gateway', () => {
    expect(
      isReadiness({
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: 'Cannot reach the gateway. Check that it is running, then retry.',
          requestId: 'dashboard-proxy',
        },
      }),
    ).toBe(false);
  });

  it('rejects primitives, null, and arrays', () => {
    for (const value of [null, undefined, 'ready', 200, true, [valid]]) {
      expect(isReadiness(value), `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
    }
  });

  it('rejects an unknown status', () => {
    expect(isReadiness({ ...valid, status: 'degraded' })).toBe(false);
  });

  it('rejects a missing checks block', () => {
    const { checks: _checks, ...withoutChecks } = valid;
    expect(isReadiness(withoutChecks)).toBe(false);
  });

  it('rejects an invalid check member', () => {
    expect(isReadiness({ ...valid, checks: { database: 'down', migrations: 'ok' } })).toBe(false);
    expect(isReadiness({ ...valid, checks: { database: 'ok' } })).toBe(false);
  });

  it('rejects a missing or non-string timestamp', () => {
    const { timestamp: _timestamp, ...withoutTimestamp } = valid;
    expect(isReadiness(withoutTimestamp)).toBe(false);
    expect(isReadiness({ ...valid, timestamp: 1_700_000_000 })).toBe(false);
  });

  it('rejects a wrongly typed migrationVersion', () => {
    expect(isReadiness({ ...valid, migrationVersion: 5 })).toBe(false);
  });
});
