import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config';

/**
 * The dashboard's response-header floor.
 *
 * Round-2 testing found the origin sent only `Cache-Control: no-store`, so the
 * admin pages could be framed from any site that can reach loopback. These
 * assertions pin the headers to the config: they are cheap to delete by
 * accident and invisible in the UI until something is exploited.
 */

async function headerMap(): Promise<Map<string, string>> {
  const groups = (await nextConfig.headers?.()) ?? [];
  return new Map(groups.flatMap((group) => group.headers.map((header) => [header.key, header.value])));
}

describe('security headers', () => {
  it('applies to every path', async () => {
    const groups = (await nextConfig.headers?.()) ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.source).toBe('/:path*');
  });

  it('refuses framing, MIME sniffing, and referrer leakage', async () => {
    const headers = await headerMap();

    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('does not leave the production policy open to eval', async () => {
    const policy = (await headerMap()).get('Content-Security-Policy') ?? '';
    // The suite does not run as `next dev`, so this is the production shape.
    expect(policy).not.toContain('unsafe-eval');
  });

  it('redirects the conventional favicon path at the single icon asset', async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects).toContainEqual({ source: '/favicon.ico', destination: '/icon.svg', permanent: true });
  });
});
