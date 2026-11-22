import type { ConnectorError, ConnectorResult } from '../connector.js';

/**
 * The Slack Web API client (ADR-056). The only module in the gateway allowed
 * to open a connection to Slack — the pipeline, the router, and the service
 * never see a URL.
 *
 * Boundaries, all enforced here rather than by convention (the GitHub client
 * is the precedent, ADR-053; the Notion client, ADR-055):
 *
 *  * One origin, fixed at build time: `https://slack.com/api`. No
 *    operator-supplied base URL, redirects refused outright
 *    (`redirect: 'error'`) so no hop can carry the token anywhere else.
 *  * The token never appears in a URL, a query string, a body, an error
 *    message, or a log line — it rides the `Authorization` header and now
 *    here else. This module has no logger precisely so there is nothing to
 *    accidentally log into.
 *  * Every response is reduced to the connector's five error kinds. Slack's
 *    twist on the vocabulary: application failures arrive as **HTTP 200
 *    with `{ok: false, error: "<code>"}`**. The transport status and the
 *    app-level `ok` are both inspected — a 200 is not a success until the
 *    body says so. The stable `error` code is the whole failure message
 *    (a closed vocabulary, not prose), so the gateway quotes the code and
 *    never copies anything else out of the body.
 *  * `Retry-After` is honored with a strictly bounded retry: at most one, and
 *    only when the wait is short. `ponytail:` ceiling 5 s / 1 retry, same as
 *    GitHub and Notion; raise only if a real workspace's traffic justifies it.
 */

/** The one host a managed Slack connection may ever reach. */
const SLACK_ORIGIN = 'https://slack.com/api';

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

export interface SlackClientOptions {
  /** Bot token (`xoxb-…`), resolved by the gateway per operation. Never cached. */
  token: string;
  /** The operation's cancellation signal, forwarded to every request. */
  signal: AbortSignal;
  /** Injectable for tests; the tests never touch the network. */
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
}

/** Query parameters; `undefined` entries are dropped. */
export type QueryParams = Record<string, string | number | undefined>;

export interface SlackClient {
  /** One authenticated GET. Returns parsed JSON or a normalized failure. */
  get(method: string, query?: QueryParams): Promise<ConnectorResult<unknown>>;
  /** One authenticated POST with an empty JSON body (`auth.test`). */
  post(method: string): Promise<ConnectorResult<unknown>>;
}

export function createSlackClient(options: SlackClientOptions): SlackClient {
  const doFetch: FetchLike = options.fetchImpl ?? fetch;
  const sleep: SleepLike = options.sleep ?? defaultSleep;

  function headers(method: 'GET' | 'POST'): Record<string, string> {
    const base: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json',
    };
    // POST bodies are JSON per the official method docs (`auth.test` accepts
    // `application/json`); the type is a fact of the request, not a caller
    // decision. Slack asks for no `User-Agent`, and none is sent.
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
        return { ok: false, error: { kind: 'unreachable', message: 'Slack could not be reached.' } };
      }

      // The transport status is only half the answer: a 200 still carries
      // an app-level verdict in `ok`, checked in parseBody.
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

  async function get(method: string, query?: QueryParams): Promise<ConnectorResult<unknown>> {
    return request('GET', buildUrl(method, query));
  }

  async function post(method: string): Promise<ConnectorResult<unknown>> {
    return request('POST', buildUrl(method), JSON.stringify({}));
  }

  return { get, post };
}

function buildUrl(method: string, query?: QueryParams): string {
  // The origin ends in a path segment (`/api`), so the method name is
  // appended, never resolved as a relative reference — `new URL` would
  // otherwise replace the segment and silently dial `https://slack.com/…`.
  const url = new URL(`${SLACK_ORIGIN}/${method}`);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The 200 half of Slack's envelope: transport success is not API success.
 * `{ok: true}` returns the whole body for the normalizers; `{ok: false}`
 * reduces the stable `error` code to the five kinds; anything else — wrong
 * shape, not JSON — is a provider failure, never a silent odd success.
 */
async function parseBody(response: Response): Promise<ConnectorResult<unknown>> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: { kind: 'provider_error', message: 'Slack returned a response that was not valid JSON.' },
    };
  }

  if (isRecord(body) && body.ok === true) return { ok: true, value: body };

  return {
    ok: false,
    error: appError(isRecord(body) && typeof body.error === 'string' ? body.error : undefined),
  };
}

/**
 * Slack's stable `error` codes onto the five kinds. The code is a closed
 * vocabulary, so it is quoted — it is the one piece of a failure body an
 * operator can act on. Credential-family codes stop the connection; request
 * and membership codes fail this call; everything unknown, Slack's own
 * internal errors included, is the provider's problem, not the caller's.
 */
function appError(code: string | undefined): ConnectorError {
  const name = code ?? 'ok_false';
  switch (name) {
    case 'not_authed':
    case 'invalid_auth':
    case 'account_inactive':
    case 'token_expired':
    case 'token_revoked':
    case 'missing_scope':
      return { kind: 'reauthorization_required', message: `Slack rejected the stored token (${name}).` };
    case 'channel_not_found':
    case 'user_not_found':
    case 'not_in_channel':
    case 'invalid_arguments':
    case 'invalid_cursor':
    case 'invalid_ts':
      return { kind: 'invalid_request', message: `Slack refused the request (${name}).` };
    case 'ratelimited':
      // Slack rate limits at the transport level (429), handled with the
      // bounded retry above; an app-level `ratelimited` still surfaces the
      // fact instead of sleeping through the caller's budget a second time.
      return { kind: 'provider_error', message: 'Slack is rate limiting this token (ratelimited).' };
    case 'internal_error':
    case 'fatal_error':
    default:
      // And future codes the gateway has never heard of.
      return { kind: 'provider_error', message: `Slack reported an application error (${name}).` };
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
    message: `Slack is rate limiting this token.${wait}`,
  };
}

/**
 * Transport-level failures (Slack usually speaks through `ok`, but a proxy or
 * Slack itself can still answer 4xx/5xx). Same policy as Notion: 401 is the
 * only status that permanently stops a connection.
 */
function statusError(response: Response): ConnectorError {
  switch (true) {
    case response.status === 401:
      return { kind: 'reauthorization_required', message: 'Slack rejected the stored token (401).' };
    case response.status === 400:
      return { kind: 'invalid_request', message: 'Slack rejected the request as invalid (400).' };
    case response.status === 403:
      return {
        kind: 'invalid_request',
        message: 'The token does not have the scope for this request (403).',
      };
    case response.status === 404:
      return {
        kind: 'invalid_request',
        message: 'Slack refused the request (404).',
      };
    case response.status >= 500:
      return { kind: 'provider_error', message: `Slack reported a server error (${response.status}).` };
    default:
      return { kind: 'invalid_request', message: `Slack refused the request (${response.status}).` };
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
