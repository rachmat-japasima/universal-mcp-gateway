/**
 * The dashboard's single write proxy implementation.
 *
 * Server components call the gateway directly. Client components cannot: the
 * gateway is loopback-only and sends no CORS headers, so a browser `fetch` to
 * `127.0.0.1:8787` would be blocked and could not read the answer anyway.
 *
 * Whether a request may be forwarded at all is decided in
 * `lib/api/write-policy.ts`, next to a test that enumerates what it refuses.
 * This file only does the forwarding, so the three route handlers
 * (`/api/backends`, `/api/agents`, `/api/policies`) share one perimeter rather
 * than three near-copies that could drift apart.
 *
 * **This is not the security boundary.** It forwards the operator's own cookie
 * and the CSRF token derived from that same session, and the gateway re-checks
 * both. If they are absent it answers `401` without calling the gateway.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { isApiError } from '@/lib/api/errors';
import { operatorCredentials } from '@/lib/auth/guard';
import { config } from '@/lib/config';
import { isAllowedWrite, type WriteMethod } from '@/lib/api/write-policy';

/**
 * Writes are not reads. `POST /backends/:id/connect` dials the backend and
 * discovers its tools before it answers, bounded by the gateway's own
 * `TOOL_DISCOVERY_TIMEOUT_MS` (15 s by default). The client's 5 s read budget
 * would abort first and report a timeout for a connection that did succeed, so
 * writes get a ceiling above any documented lifecycle timeout instead.
 *
 * Ceiling: the gateway's full request budget (30 s default). If
 * `TOOL_DISCOVERY_TIMEOUT_MS` is raised above it on the gateway host, raise this
 * too — the gateway's answer, not this proxy's, is the one that matters.
 */
const WRITE_TIMEOUT_MS = 30_000;

function errorBody(code: string, message: string, status: number): Response {
  return NextResponse.json({ error: { code, message, requestId: 'dashboard-proxy' } }, { status });
}

export async function forwardWrite(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
  method: WriteMethod,
): Promise<Response> {
  const { path } = await context.params;
  const target = `/api/v1/${path.join('/')}`;

  if (!isAllowedWrite(method, target)) {
    return errorBody('RESOURCE_NOT_FOUND', 'The requested resource does not exist.', 404);
  }

  const credentials = await operatorCredentials();
  if (credentials.cookie === undefined || credentials.csrfToken === undefined) {
    return errorBody('AUTHENTICATION_ERROR', 'Your session has expired. Sign in again to make changes.', 401);
  }

  const upstream = new URL(target, config.gatewayOrigin);
  // `expectedVersion` lives in the query string, not the body, so it must survive.
  upstream.search = new URL(request.url).search;

  // The body is forwarded as text rather than re-serialised: re-encoding could
  // drop a field the gateway accepts, and passing bytes through keeps this a
  // proxy rather than a second schema.
  const body = method === 'DELETE' ? undefined : await request.text();

  try {
    const response = await fetch(upstream, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Cookie: credentials.cookie,
        'X-CSRF-Token': credentials.csrfToken,
        ...(body === undefined || body === '' ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined || body === '' ? {} : { body }),
      signal: AbortSignal.timeout(Math.max(WRITE_TIMEOUT_MS, config.requestTimeoutMs)),
      redirect: 'error',
    });

    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (error) {
    // `AbortSignal.timeout` rejects with a `TimeoutError` DOMException, not the
    // client's `ApiError` — checking only the latter would report every slow
    // write as "the gateway is down".
    const timedOut =
      (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
      (isApiError(error) && error.kind === 'timeout');

    return errorBody(
      timedOut ? 'BACKEND_TIMEOUT' : 'BACKEND_UNAVAILABLE',
      timedOut ? 'The gateway did not answer in time.' : 'Cannot reach the gateway. Check that it is running, then retry.',
      timedOut ? 504 : 503,
    );
  }
}
