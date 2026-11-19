/**
 * Server-side configuration.
 *
 * `GATEWAY_ORIGIN` is intentionally **not** `NEXT_PUBLIC_*`: the gateway is
 * loopback-only and grants no CORS, so the browser never contacts it directly
 * and has no business knowing its address. Every call is made from the Next
 * server, which also means no gateway credential could ever be shipped to the
 * client.
 */

const DEFAULT_GATEWAY_ORIGIN = 'http://127.0.0.1:8787';

/** Slow reads get a short leash: the management API answers from SQLite. */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface DashboardConfig {
  gatewayOrigin: string;
  requestTimeoutMs: number;
}

/**
 * Validation happens once per server process, at import time. A misconfigured
 * origin fails loudly on the server instead of rendering an empty dashboard
 * that looks like "no data" — the exact confusion the API's `null`/`0`
 * distinction exists to prevent.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const raw = env.GATEWAY_ORIGIN?.trim();
  const origin = raw === undefined || raw === '' ? DEFAULT_GATEWAY_ORIGIN : raw;
  const timeout = Number(env.GATEWAY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`GATEWAY_ORIGIN must be an absolute URL (received ${JSON.stringify(origin)}).`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('GATEWAY_ORIGIN must use http: or https:.');
  }

  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('GATEWAY_TIMEOUT_MS must be a positive number.');
  }

  return { gatewayOrigin: parsed.origin, requestTimeoutMs: timeout };
}

export const config: DashboardConfig = resolveConfig();
