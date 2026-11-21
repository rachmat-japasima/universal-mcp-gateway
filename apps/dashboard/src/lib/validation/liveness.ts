import type { GatewayHealth } from '@/lib/api/types';

/**
 * Runtime validation for `/health`, the liveness probe.
 *
 * It lives outside `/api/v1`, so the read is raw — no `{data}` envelope. Without
 * a shape check, a proxy error page that happens to parse as JSON would become a
 * live-looking gateway whose fields are all `undefined`, and the monitoring page
 * would report "Process alive" for a process that is not there.
 *
 * The shape mirrors the probe in `src/core/gateway.ts`. Every field the dashboard
 * renders is required; an unknown extra field is ignored rather than rejected, so
 * a gateway that adds one does not break the page.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGatewayHealth(value: unknown): value is GatewayHealth {
  if (!isRecord(value)) return false;
  if (value.status !== 'ok') return false;
  if (typeof value.service !== 'string' || typeof value.version !== 'string') return false;
  if (typeof value.timestamp !== 'string') return false;

  const { mcp } = value;
  if (!isRecord(mcp)) return false;
  if (typeof mcp.endpoint !== 'string') return false;
  if (typeof mcp.backendCount !== 'number') return false;
  if (mcp.status !== 'empty' && mcp.status !== 'ready') return false;
  if (mcp.authentication !== 'required' && mcp.authentication !== 'unavailable') return false;

  return true;
}
