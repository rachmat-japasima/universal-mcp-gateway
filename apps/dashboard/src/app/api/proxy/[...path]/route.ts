import { NextResponse, type NextRequest } from 'next/server';

import { ApiError, isApiError } from '@/lib/api/errors';
import { OPERATOR_COOKIE } from '@/lib/auth/session';
import { config } from '@/lib/config';

/**
 * Same-origin read proxy.
 *
 * Why it exists: the gateway is loopback-only and sends no CORS headers, so the
 * browser cannot call it. Server components call the gateway directly; this route
 * covers client-side refresh, which needs a URL the browser may fetch.
 *
 * Why it is an allowlist rather than a passthrough: a proxy that forwarded any
 * path would turn the dashboard into an open door to the management API for
 * anything that can load a page. Only the read endpoints the dashboard renders are
 * reachable, only `GET`, and the query string is forwarded unchanged so the
 * gateway — the single source of truth for validation — still answers a bad
 * parameter with its own `400`.
 *
 * **The list is empty on purpose.** Every data page is a server component, so the
 * gateway is read from the Node process and never through this route; the one
 * client-side read in the dashboard is the readiness probe in
 * `components/feedback/gateway-status.tsx`, which is the `ready` path below. An
 * entry here is surface area with no caller, so overview/monitoring/settings/
 * diagnostics are deliberately not listed. Add one back only with a client that
 * actually fetches it.
 */

/**
 * The only path this route forwards: the readiness probe.
 *
 * `undefined` means "not proxied", and the handler answers its own `404`. Keeping
 * a list of regexes here while it holds one entry would be an extension point
 * nobody asked for — the comment above says what to do when a second client-side
 * read appears.
 */
const READY_PATH = '/ready';

function resolveTarget(segments: string[]): string | undefined {
  return segments.length === 1 && segments[0] === 'ready' ? READY_PATH : undefined;
}

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const target = resolveTarget(path);

  if (target === undefined) {
    return NextResponse.json(
      {
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'The requested resource does not exist.',
          requestId: 'dashboard-proxy',
        },
      },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const upstreamUrl = new URL(target, config.gatewayOrigin);
  upstreamUrl.search = url.search;

  /**
   * The gateway requires an operator session on every `/api/v1` read. Only that
   * one cookie is forwarded: passing the whole jar would hand the gateway
   * whatever else this origin happens to hold, which it has no business seeing.
   */
  const token = request.cookies.get(OPERATOR_COOKIE)?.value;

  try {
    const upstream = await fetch(upstreamUrl, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(token === undefined ? {} : { Cookie: `${OPERATOR_COOKIE}=${token}` }),
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      redirect: 'error',
    });

    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (error) {
    const apiError = isApiError(error) ? error : error instanceof ApiError ? error : undefined;
    const timedOut = apiError?.kind === 'timeout';

    return NextResponse.json(
      {
        error: {
          code: timedOut ? 'BACKEND_TIMEOUT' : 'BACKEND_UNAVAILABLE',
          message: timedOut
            ? 'The gateway did not answer in time.'
            : 'Cannot reach the gateway. Check that it is running, then retry.',
          requestId: 'dashboard-proxy',
        },
      },
      { status: timedOut ? 504 : 503 },
    );
  }
}
