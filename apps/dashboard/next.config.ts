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
};

export default nextConfig;
