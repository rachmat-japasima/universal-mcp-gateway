import type { ApiErrorBody, ErrorCode } from '@/lib/api/types';
import { ERROR_CODES } from '@/lib/api/types';

/**
 * One error type for the whole client, so every surface (server component,
 * route handler, client component) can branch on `kind` instead of inspecting
 * `fetch` internals.
 *
 * Nothing here forwards a raw driver message, SQL text, or stack trace: the
 * gateway already guarantees a safe `message`, and anything we cannot parse is
 * replaced with a fixed sentence.
 */
export type ApiFailureKind =
  /** Could not establish a connection — the gateway is probably not running. */
  | 'unavailable'
  /** The gateway accepted the connection and never answered. */
  | 'timeout'
  /** A non-2xx response. `code` is set when the envelope parsed. */
  | 'http'
  /** 2xx, but the body was not the documented shape. */
  | 'invalid-response';

export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status?: number;
  readonly code?: ErrorCode;
  readonly requestId?: string;

  constructor(kind: ApiFailureKind, message: string, extra: { status?: number; code?: ErrorCode; requestId?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = extra.status;
    this.code = extra.code;
    this.requestId = extra.requestId;
  }

  /** Safe to render. Never contains a response body, URL, or stack. */
  get userMessage(): string {
    switch (this.kind) {
      case 'unavailable':
        return 'Cannot reach the gateway. Check that it is running, then retry.';
      case 'timeout':
        return 'The gateway did not answer in time. It may be busy; retry in a moment.';
      case 'invalid-response':
        return 'The gateway returned an unexpected response. Check that the dashboard and gateway versions match.';
      case 'http':
        return this.message;
    }
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Reads the documented error envelope. Anything else — an HTML error page from
 * a proxy, a truncated body — becomes an opaque HTTP failure rather than a
 * message we would be guessing at.
 */
export function parseErrorBody(status: number, body: unknown): ApiError {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const envelope = (body as ApiErrorBody).error;
    if (
      typeof envelope === 'object' &&
      envelope !== null &&
      typeof envelope.message === 'string' &&
      isErrorCode(envelope.code)
    ) {
      return new ApiError('http', envelope.message, {
        status,
        code: envelope.code,
        requestId: typeof envelope.requestId === 'string' ? envelope.requestId : undefined,
      });
    }
  }

  return new ApiError('http', `The gateway rejected the request (HTTP ${status}).`, { status });
}

/**
 * `fetch` rejects with a `TypeError` for connection-level failures. Re-thrown as
 * our own kind so no caller has to know that detail.
 */
export function fromFetchError(error: unknown): ApiError {
  if (isApiError(error)) return error;

  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new ApiError('timeout', 'The request timed out.');
  }

  if (error instanceof TypeError) {
    return new ApiError('unavailable', 'The gateway is not reachable.');
  }

  return new ApiError('invalid-response', 'The gateway request failed.');
}
