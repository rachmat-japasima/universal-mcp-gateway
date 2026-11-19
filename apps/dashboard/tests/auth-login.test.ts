import { describe, expect, it } from 'vitest';

import { dashboardCookie, maxAgeOf, safeNextPath } from '@/lib/auth/login';

/**
 * The two pieces of the dashboard's sign-in that are pure logic, and therefore
 * testable without a browser or a gateway: where a redirect may land, and what
 * attributes the re-issued cookie carries.
 *
 * Both are security-relevant. An unvalidated `next` is an open redirect; a
 * re-issued cookie that drops `HttpOnly` or `SameSite` would quietly undo the
 * gateway's protections on the origin the browser actually talks to.
 */

describe('safeNextPath', () => {
  it('accepts dashboard destinations', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard');
    expect(safeNextPath('/dashboard/audit?page=2')).toBe('/dashboard/audit?page=2');
    expect(safeNextPath('/dashboard/agents/abc')).toBe('/dashboard/agents/abc');
  });

  it('falls back to the overview for anything else', () => {
    for (const candidate of [
      undefined,
      null,
      '',
      '/',
      '/login',
      '/admin',
      'https://evil.test',
      '//evil.test',
      '/\\evil.test',
      '/dashboard/../../etc',
    ]) {
      expect(safeNextPath(candidate), String(candidate)).toBe('/dashboard');
    }
  });
});

describe('dashboardCookie', () => {
  it('keeps the gateway protections and moves the cookie to this origin', () => {
    const cookie = dashboardCookie('umg_operator=umgo_abc', 3600);

    expect(cookie).toMatchObject({
      name: 'umg_operator',
      value: 'umgo_abc',
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 3600,
    });
    // `Secure` is set by the route from the transport, not guessed here.
    expect(cookie).not.toHaveProperty('secure');
    expect(cookie).not.toHaveProperty('domain');
  });

  it('omits maxAge when the gateway did not set one', () => {
    expect(dashboardCookie('umg_operator=x', undefined)).not.toHaveProperty('maxAge');
  });
});

describe('maxAgeOf', () => {
  it('reads the attribute case-insensitively and ignores the rest', () => {
    expect(maxAgeOf('umg_operator=x; Path=/; HttpOnly; Max-Age=43200; SameSite=Strict')).toBe(43200);
    expect(maxAgeOf('umg_operator=x; max-age=60')).toBe(60);
    expect(maxAgeOf('umg_operator=x; Path=/; HttpOnly')).toBeUndefined();
    // Deletion uses Max-Age=0; parsing it as "no lifetime" keeps the caller from
    // minting a permanent cookie out of a cleared one.
    expect(maxAgeOf('umg_operator=; Max-Age=0')).toBe(0);
  });
});
