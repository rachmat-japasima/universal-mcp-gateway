/**
 * The browser's only way to reach the gateway: the dashboard's own write proxy.
 *
 * A client component cannot call `127.0.0.1:8787` — the gateway is loopback-only
 * and sends no CORS headers — and must not hold the operator cookie or the CSRF
 * token. `app/api/backends/[...path]/route.ts` carries both, so this module only
 * ever names a dashboard-local path.
 *
 * `message` is always safe to render: it is either the gateway's own documented
 * `error.message` or a fixed sentence. Nothing here reads a stack or a URL.
 */

export interface SendResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  /** Present when `ok` is false. */
  message?: string;
  /** True when the session is gone, so the caller can say "sign in again". */
  unauthorized?: boolean;
}

const NETWORK_MESSAGE = 'Cannot reach the gateway. Check that it is running, then retry.';

export async function send<T>(
  path: string,
  init: { method: 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<SendResult<T>> {
  let response: Response;

  try {
    response = await fetch(path, {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // Same-origin by construction, and `follow`/`error` both stay on this origin.
      credentials: 'same-origin',
      redirect: 'error',
    });
  } catch {
    return { ok: false, status: 0, message: NETWORK_MESSAGE };
  }

  const text = await response.text();
  const parsed: unknown = text === '' ? undefined : safeJson(text);

  if (response.ok) return { ok: true, status: response.status, data: dataOf<T>(parsed) };

  return {
    ok: false,
    status: response.status,
    unauthorized: response.status === 401,
    message: errorMessageOf(parsed) ?? `The gateway rejected the request (HTTP ${response.status}).`,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function dataOf<T>(body: unknown): T | undefined {
  if (typeof body === 'object' && body !== null && 'data' in body) return (body as { data: T }).data;
  return body as T | undefined;
}

function errorMessageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const envelope = (body as { error?: { message?: unknown } }).error;
  return typeof envelope?.message === 'string' ? envelope.message : undefined;
}
