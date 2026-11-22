import type { ConnectorError, ConnectorResult } from '../connector.js';

/**
 * The Notion REST client (ADR-055). The only module in the gateway allowed to
 * open a connection to Notion — the pipeline, the router, and the service
 * never see a URL.
 *
 * Boundaries, all enforced here rather than by convention (the GitHub client
 * is the precedent, ADR-053):
 *
 *  * One origin, fixed at build time: `https://api.notion.com`. No
 *    operator-supplied base URL, redirects refused outright
 *    (`redirect: 'error'`) so no hop can carry the token anywhere else.
 *  * Every request carries `Authorization: Bearer` plus the pinned
 *    `Notion-Version` header — the current official version, and the only
 *    value Notion's OpenAPI accepts for it.
 *  * The token never appears in a URL, a query string, an error message, or a
 *    log line — this module has no logger precisely so there is nothing to
 *    accidentally log into.
 *  * Every response is reduced to the connector's five error kinds. Notion's
 *    `message` prose is untrusted text and is *not* copied into error
 *    messages; the gateway's own vocabulary is enough for an operator to act
 *    on. The stable `code`/status distinction is what the mapping reads.
 *  * `Retry-After` is honored with a strictly bounded retry: at most one, and
 *    only when the wait is short. `ponytail:` ceiling 5 s / 1 retry, same as
 *    GitHub; raise only if a real token's traffic ever justifies it.
 */

/** The one host a managed Notion connection may ever reach. */
const NOTION_ORIGIN = 'https://api.notion.com';
/** Current official API version; required on every request. */
const NOTION_VERSION = '2026-03-11';

/** Upper bound on a single rate-limit retry wait. */
const RETRY_CEILING_MS = 5_000;

export type FetchLike = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: 'error';
  },
) => Response | Promise<Response>;
export type SleepLike = (ms: number, signal: AbortSignal) => Promise<void>;

export interface NotionClientOptions {
  /** Internal integration token, resolved by the gateway per operation. Never cached. */
  token: string;
  /** The operation's cancellation signal, forwarded to every request. */
  signal: AbortSignal;
  /** Injectable for tests; the tests never touch the network. */
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
}

/** Query parameters; `undefined` entries are dropped. */
export type QueryParams = Record<string, string | number | undefined>;

export interface NotionClient {
  /** One authenticated GET. Returns parsed JSON or a normalized failure. */
  get(path: string, query?: QueryParams): Promise<ConnectorResult<unknown>>;
  /** One authenticated POST with a JSON body. */
  post(path: string, body: Record<string, unknown>): Promise<ConnectorResult<unknown>>;
}

export function createNotionClient(options: NotionClientOptions): NotionClient {
  const doFetch: FetchLike = options.fetchImpl ?? fetch;
  const sleep: SleepLike = options.sleep ?? defaultSleep;

  function headers(method: 'GET' | 'POST'): Record<string, string> {
    const base: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
      'Notion-Version': NOTION_VERSION,
      Accept: 'application/json',
    };
    // POST bodies are JSON per the official OpenAPI; the type is a fact of
    // the request, not a caller decision.
    return method === 'POST' ? { ...base, 'Content-Type': 'application/json' } : base;
  }

  async function request(
    method: 'GET' | 'POST',
    url: string,
    body?: string,
  ): Promise<ConnectorResult<unknown>> {
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        // `redirect: 'error'` makes the no-cross-host promise self-enforcing:
        // a boundary the code states is a boundary the code should hold.
        response = await doFetch(url, {
          method,
          headers: headers(method),
          ...(body === undefined ? {} : { body }),
          signal: options.signal,
          redirect: 'error',
        });
      } catch {
        // A rejected fetch is a network failure; an abort surfaces through
        // the gateway's own cancellation handling.
        return { ok: false, error: { kind: 'unreachable', message: 'Notion could not be reached.' } };
      }

      if (response.status === 200) return parseBody(response);

      if (response.status === 429) {
        const waitMs = parseRetryAfter(response);
        if (attempt === 1 && waitMs !== undefined && waitMs <= RETRY_CEILING_MS) {
          await sleep(waitMs, options.signal);
          continue;
        }
        return { ok: false, error: rateLimitError(waitMs) };
      }

      return { ok: false, error: statusError(response) };
    }
  }

  async function get(path: string, query?: QueryParams): Promise<ConnectorResult<unknown>> {
    return request('GET', buildUrl(path, query));
  }

  async function post(path: string, body: Record<string, unknown>): Promise<ConnectorResult<unknown>> {
    return request('POST', buildUrl(path), JSON.stringify(body));
  }

  return { get, post };
}

function buildUrl(path: string, query?: QueryParams): string {
  const url = new URL(path, NOTION_ORIGIN);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function parseBody(response: Response): Promise<ConnectorResult<unknown>> {
  const text = await response.text();
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      error: { kind: 'provider_error', message: 'Notion returned a response that was not valid JSON.' },
    };
  }
}

/** `Retry-After` in seconds → milliseconds, or `undefined` when absent/invalid. */
function parseRetryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1_000;
}

function rateLimitError(waitMs: number | undefined): ConnectorError {
  const wait = waitMs === undefined ? '' : ` Retry-After suggested ${Math.round(waitMs / 1_000)}s (too long to wait inside a call).`;
  return {
    kind: 'provider_error',
    message: `Notion is rate limiting this token.${wait}`,
  };
}

/**
 * Notion's error mapping onto the five kinds. 401 is the only status that
 * permanently stops a connection; 403 is a capability gap (the operator
 * configured the connection's capabilities in the Notion portal, not here);
 * 404 covers "absent" and "not shared with this connection" alike — Notion
 * does not distinguish them, so the message must not promise more than that.
 */
function statusError(response: Response): ConnectorError {
  switch (true) {
    case response.status === 401:
      return { kind: 'reauthorization_required', message: 'Notion rejected the stored token (401).' };
    case response.status === 400:
      return { kind: 'invalid_request', message: 'Notion rejected the request as invalid (400).' };
    case response.status === 403:
      return {
        kind: 'invalid_request',
        message: 'The token does not have the capability for this request (403).',
      };
    case response.status === 404:
      return {
        kind: 'invalid_request',
        message: 'The object does not exist or is not shared with this connection (404).',
      };
    case response.status >= 500:
      return { kind: 'provider_error', message: `Notion reported a server error (${response.status}).` };
    default:
      return { kind: 'invalid_request', message: `Notion refused the request (${response.status}).` };
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
