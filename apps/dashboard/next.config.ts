import type { NextConfig } from 'next';

/**
 * The dashboard never talks to the gateway from the browser: the gateway is
 * loopback-only and grants no CORS, so every request is made from the Next
 * server. `GATEWAY_ORIGIN` is server-only for that reason — it is deliberately
 * not `NEXT_PUBLIC_*`, which would put the internal address in the bundle.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,

  /** `/favicon.ico` is a reserved App Router metadata name as a file, so a route
   * handler there is not built. The conventional path redirects to the one icon
   * asset instead of keeping a second copy. */
  async redirects() {
    return [{ source: '/favicon.ico', destination: '/icon.svg', permanent: true }];
  },

  /**
   * Response headers for every route on this origin.
   *
   * The dashboard was shipping only `Cache-Control: no-store`, which left the
   * admin pages frameable from any site that can reach loopback (clickjacking)
   * and let a dashboard URL travel in a `Referer` header. These are the floor,
   * not a hardened CSP: Next's inline bootstrap and Astryx's injected styles
   * need `'unsafe-inline'`, and a nonce scheme would have to be threaded
   * through the whole render path. `frame-ancestors` is the part that matters
   * here and it is absolute.
   */
  async headers() {
    const isDev = process.env.NODE_ENV === 'development';
    const csp = [
      "default-src 'self'",
      // `'unsafe-eval'` is a dev-server (HMR) requirement, not a production one.
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          // Redundant with `frame-ancestors` for current browsers, and the only
          // signal for the ones that never implemented CSP Level 2.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Nothing here links out, so there is no referrer worth sending.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
