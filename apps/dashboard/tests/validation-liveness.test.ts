import { describe, expect, it } from 'vitest';

import { isGatewayHealth } from '@/lib/validation/liveness';

/**
 * `/health` is read raw, so its shape is the only thing standing between a proxy
 * error page and a "Process alive" claim. Each case here is a payload that could
 * plausibly arrive instead of a liveness document.
 */

const valid = {
  status: 'ok',
  service: 'universal-mcp-gateway',
  version: '0.1.0',
  timestamp: '2026-11-21T00:00:00.000Z',
  mcp: {
    endpoint: '/mcp',
    backendCount: 0,
    status: 'empty',
    authentication: 'required',
  },
};

describe('isGatewayHealth', () => {
  it('accepts a liveness payload', () => {
    expect(isGatewayHealth(valid)).toBe(true);
  });

  it('rejects the proxy error envelope, which is also JSON', () => {
    expect(isGatewayHealth({ error: { code: 'BACKEND_UNAVAILABLE', message: 'Cannot reach the gateway.' } })).toBe(
      false,
    );
  });

  it('rejects a readiness document, which is a different probe', () => {
    expect(isGatewayHealth({ status: 'ready', checks: { database: 'ok' }, timestamp: 'x' })).toBe(false);
  });

  it('rejects a payload missing the fields the page renders', () => {
    expect(isGatewayHealth({ ...valid, mcp: { backendCount: 0 } })).toBe(false);
    expect(isGatewayHealth({ ...valid, timestamp: undefined })).toBe(false);
    expect(isGatewayHealth({ ...valid, status: 'degraded' })).toBe(false);
  });

  it('rejects a non-object entirely', () => {
    for (const value of [null, undefined, 'ok', 42, [], [valid]]) {
      expect(isGatewayHealth(value)).toBe(false);
    }
  });

  it('tolerates an extra field from a newer gateway', () => {
    expect(isGatewayHealth({ ...valid, addedLater: true })).toBe(true);
  });
});
