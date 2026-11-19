import { describe, expect, it } from 'vitest';

import { isAllowedWrite } from '@/lib/backends/proxy-policy';

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
    for (const target of ['/api/v1/agents', '/api/v1/settings', '/api/v1/monitoring/backends', '/api/v1/audit']) {
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
});
