import type { ConnectorError, ConnectorResult } from '../connector.js';

/**
 * The GitHub REST client (ADR-053). The only module in the gateway that is
 * allowed to open a connection to GitHub — the shared pipeline, the router,
 * and the service never see a URL.
 *
 * Boundaries, all enforced here rather than by convention:
 *
 *  * One origin, fixed at build time: `https://api.github.com`. No enterprise
 *    hosts, no operator-supplied base URL, no redirects followed to a
 *    different host (the path is always relative to this origin).
 *  * The token rides in the `Authorization` header only. It never appears in
 *    a URL, a query string, an error message, or a log line — this module has
 *    no logger precisely so there is nothing to accidentally log into.
 *  * Every response is reduced to the connector's five error kinds. GitHub's
 *    prose is *not* copied into error messages: it is untrusted text, and the
 *    gateway's own vocabulary is enough for an operator to act on.
 *  * `Retry-After` is honored with a strictly bounded retry: at most one, and
 *    only when the wait is short. A long wait fails the call with the reset
 *    time instead of pinning a tool call open — the caller retries on their
 *    own schedule. `ponytail:` ceiling 5 s / 1 retry; raise only if a real
 *    token's traffic ever justifies it.
 */

/** The one host a managed GitHub connection may ever reach. */
const GITHUB_ORIGIN = 'https://api.github.com';
/** Pinned REST API version; additive changes arrive without a new version. */
const GITHUB_API_VERSION = '2026-03-10';
/** GitHub rejects requests without a User-Agent; ours names the gateway. */
const USER_AGENT = 'universal-mcp-gateway';

/** Upper bound on a single rate-limit retry wait. */
const RETRY_CEILING_MS = 5_000;

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Response | Promise<Response>;
export type SleepLike = (ms: number, signal: AbortSignal) => Promise<void>;

export interface GitHubClientOptions {
  /** Fine-grained PAT, resolved by the gateway per operation. Never cached. */
  token: string;
  /** The operation's cancellation signal, forwarded to every request. */
  signal: AbortSignal;
  /** Injectable for tests; the tests never touch the network. */
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
}

/** Query parameters; `undefined` entries are dropped. */
export type QueryParams = Record<string, string | number | undefined>;

export interface GitHubClient {
  /** One authenticated GET. Returns parsed JSON or a normalized failure. */
  get(path: string, query?: QueryParams): Promise<ConnectorResult<unknown>>;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const doFetch: FetchLike = options.fetchImpl ?? fetch;
  const sleep: SleepLike = options.sleep ?? defaultSleep;

  async function get(path: string, query?: QueryParams): Promise<ConnectorResult<unknown>> {
    const url = buildUrl(path, query);
    const headers = {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': USER_AGENT,
    };

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await doFetch(url, { headers, signal: options.signal });
      } catch {
        // A rejected fetch is a network failure (an abort surfaces through the
        // gateway's own cancellation handling; nothing here can do better).
        return { ok: false, error: { kind: 'unreachable', message: 'GitHub could not be reached.' } };
      }

      if (response.status === 200) return parseBody(response);

      if (isRateLimited(response)) {
        const waitMs = parseRetryAfter(response);
        if (attempt === 1 && waitMs !== undefined && waitMs <= RETRY_CEILING_MS) {
          await sleep(waitMs, options.signal);
          continue;
        }
        return { ok: false, error: rateLimitError(response, waitMs) };
      }

      return { ok: false, error: statusError(response) };
    }
  }

  return { get };
}

function buildUrl(path: string, query?: QueryParams): string {
  const url = new URL(path, GITHUB_ORIGIN);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function parseBody(response: Response): Promise<ConnectorResult<unknown>> {
  const text = await response.text();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: { kind: 'provider_error', message: 'GitHub returned a response that was not valid JSON.' } };
  }
}

/**
 * Rate limiting arrives as 429, or as a 403 with the rate budget exhausted —
 * the same 403 that also means "permission denied", distinguished only by the
 * `X-RateLimit-Remaining` header.
 */
function isRateLimited(response: Response): boolean {
  return response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
}

/** `Retry-After` in seconds → milliseconds, or `undefined` when absent/invalid. */
function parseRetryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1_000;
}

function rateLimitError(response: Response, waitMs: number | undefined): ConnectorError {
  const reset = response.headers.get('x-ratelimit-reset');
  const wait = waitMs === undefined ? '' : ` Retry-After suggested ${Math.round(waitMs / 1_000)}s (too long to wait inside a call).`;
  const resetAt = reset === null ? '' : ` Budget resets at unix ${reset}.`;
  return {
    kind: 'provider_error',
    message: `GitHub is rate limiting this token.${wait}${resetAt}`,
  };
}

function statusError(response: Response): ConnectorError {
  switch (true) {
    case response.status === 401:
      return { kind: 'reauthorization_required', message: 'GitHub rejected the stored token (401).' };
    case response.status === 403:
      return { kind: 'invalid_request', message: 'The token does not have permission for this request (403).' };
    case response.status === 404:
      return { kind: 'invalid_request', message: 'The resource does not exist or is not visible to this token (404).' };
    case response.status === 422:
      return { kind: 'invalid_request', message: 'GitHub rejected the request as invalid (422).' };
    case response.status >= 500:
      return { kind: 'provider_error', message: `GitHub reported a server error (${response.status}).` };
    default:
      return { kind: 'invalid_request', message: `GitHub refused the request (${response.status}).` };
  }
}

/**
 * Sleep that a cancellation can break: resolving early is enough because the
 * retried fetch then rejects on the already-aborted signal.
 */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
