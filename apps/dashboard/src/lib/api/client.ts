import { operatorCookieHeader } from '@/lib/auth/guard';
import { config } from '@/lib/config';
import { ApiError, fromFetchError, parseErrorBody } from './errors';
import type { Page, Pagination, Readiness } from './types';

/**
 * The one place the dashboard speaks HTTP to the gateway.
 *
 * Two rules it enforces for every caller:
 *
 *   * **Server-side only.** The gateway is loopback-only and grants no CORS; a
 *     browser `fetch` to it would fail. Calls are made from server components
 *     and from the app's own same-origin proxy, never from client code.
 *   * **No silent defaults.** A body that does not carry `data` is a failure,
 *     not an empty result. Otherwise a proxy error page would render as "0
 *     backends", which is the one thing the API's design exists to prevent.
 */

export interface RequestOptions {
  /** Passed as `cache` on the underlying fetch. Defaults to no-store for live reads. */
  cache?: RequestCache;
  /** Per-request override, mainly for tests. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Set for `/ready`, whose documented shape has no `{data}` envelope and whose
   * `503` is a meaningful answer rather than a failure.
   */
  rawBody?: boolean;
  /** Treat these statuses as data instead of throwing. */
  acceptStatus?: readonly number[];
  /** Explicit cookie, for callers outside a request scope. Defaults to the browser's. */
  cookie?: string;
}

interface Envelope<T> {
  data: T;
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return typeof value === 'object' && value !== null && 'data' in value;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // An HTML error page from something in front of the gateway.
    return undefined;
  }
}

/**
 * Returns the parsed body (envelope-unwrapped unless `rawBody`), or throws an
 * `ApiError`. Query parameters are passed as a record and serialised here so no
 * caller hand-builds a URL.
 */
export async function request<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(path, config.gatewayOrigin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const timeout = AbortSignal.timeout(options.timeoutMs ?? config.requestTimeoutMs);
  const signals = options.signal === undefined ? [timeout] : [timeout, options.signal];
  const accepted = options.acceptStatus ?? [];

  /**
   * The gateway requires an operator session on every `/api/v1` read (Phase
   * 10.0). Server components have the browser's cookie available, so it is
   * forwarded; outside a request scope (tests, scripts) there is none and the
   * header is simply omitted.
   */
  const cookie = options.cookie ?? (await operatorCookieHeader());

  let response: Response;
  try {
    response = await fetch(url, {
      cache: options.cache ?? 'no-store',
      signal: AbortSignal.any(signals),
      headers: { Accept: 'application/json', ...(cookie === undefined ? {} : { Cookie: cookie }) },
      redirect: 'error',
    });
  } catch (error) {
    throw fromFetchError(error);
  }

  const body = await readBody(response);

  if (!response.ok && !accepted.includes(response.status)) {
    throw parseErrorBody(response.status, body);
  }

  if (options.rawBody === true) return body as T;

  if (!isEnvelope(body)) {
    throw new ApiError('invalid-response', 'Response did not contain a data envelope.');
  }

  return body.data as T;
}

/** Readiness answers `503` with its own documented body, so it is read raw. */
export async function fetchReadiness(options: RequestOptions = {}): Promise<Readiness> {
  return request<Readiness>('/ready', {}, { ...options, rawBody: true, acceptStatus: [200, 503] });
}

/**
 * Lists carry `pagination` beside `data`, which `request()` deliberately drops.
 * This variant keeps both, and refuses a page without pagination metadata rather
 * than defaulting it — a made-up `total` is exactly the kind of number the API
 * refuses to invent.
 */
export async function requestPage<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  options: RequestOptions = {},
): Promise<Page<T>> {
  const body = await request<unknown>(path, params, { ...options, rawBody: true });
  const envelope = body as { data?: unknown; pagination?: unknown } | undefined;
  const pagination = envelope?.pagination as Pagination | undefined;

  if (envelope === undefined || !Array.isArray(envelope.data) || pagination === undefined) {
    throw new ApiError('invalid-response', 'List response did not match the documented envelope.');
  }

  return { data: envelope.data as T[], pagination };
}
