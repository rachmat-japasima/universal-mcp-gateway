/**
 * Stable machine-readable error codes. These are part of the API contract:
 * the dashboard and MCP clients may branch on them, so never rename a value
 * without a versioned API change.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'RESOURCE_NOT_FOUND'
  | 'RESOURCE_CONFLICT'
  | 'MCP_PROTOCOL_ERROR'
  | 'BACKEND_CONNECTION_ERROR'
  | 'BACKEND_TIMEOUT'
  | 'BACKEND_UNAVAILABLE'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_UNAVAILABLE'
  | 'TOOL_CANCELLED'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR';

/** Transport-neutral error families used to map to HTTP / JSON-RPC responses. */
export type ErrorCategory = 'client' | 'denied' | 'unavailable' | 'internal';

const DEFINITIONS: Record<ErrorCode, { category: ErrorCategory; httpStatus: number; jsonRpcCode: number }> = {
  VALIDATION_ERROR: { category: 'client', httpStatus: 400, jsonRpcCode: -32602 },
  CONFIGURATION_ERROR: { category: 'internal', httpStatus: 500, jsonRpcCode: -32603 },
  AUTHENTICATION_ERROR: { category: 'denied', httpStatus: 401, jsonRpcCode: -32001 },
  AUTHORIZATION_ERROR: { category: 'denied', httpStatus: 403, jsonRpcCode: -32002 },
  RESOURCE_NOT_FOUND: { category: 'client', httpStatus: 404, jsonRpcCode: -32602 },
  RESOURCE_CONFLICT: { category: 'client', httpStatus: 409, jsonRpcCode: -32602 },
  MCP_PROTOCOL_ERROR: { category: 'client', httpStatus: 400, jsonRpcCode: -32600 },
  BACKEND_CONNECTION_ERROR: { category: 'unavailable', httpStatus: 502, jsonRpcCode: -32603 },
  BACKEND_TIMEOUT: { category: 'unavailable', httpStatus: 504, jsonRpcCode: -32603 },
  BACKEND_UNAVAILABLE: { category: 'unavailable', httpStatus: 503, jsonRpcCode: -32603 },
  /** Unknown public tool name. A caller mistake, so `-32602` not a server fault. */
  TOOL_NOT_FOUND: { category: 'client', httpStatus: 404, jsonRpcCode: -32602 },
  /** The tool exists but its backend is not currently callable (stale/disconnected). */
  TOOL_UNAVAILABLE: { category: 'unavailable', httpStatus: 503, jsonRpcCode: -32603 },
  /** The caller cancelled. JSON-RPC `-32800` is the MCP cancellation code. */
  TOOL_CANCELLED: { category: 'unavailable', httpStatus: 408, jsonRpcCode: -32800 },
  DATABASE_ERROR: { category: 'internal', httpStatus: 500, jsonRpcCode: -32603 },
  INTERNAL_ERROR: { category: 'internal', httpStatus: 500, jsonRpcCode: -32603 },
};

export interface ErrorDefinition {
  category: ErrorCategory;
  httpStatus: number;
  jsonRpcCode: number;
}

export function errorDefinition(code: ErrorCode): ErrorDefinition {
  return DEFINITIONS[code];
}

/** Public-facing error envelope. This is what an API client receives. */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
  };
}

export interface AppErrorOptions {
  /** Internal cause, kept for logs only. Never serialized to a client. */
  cause?: unknown;
  /** Structured, non-secret context for logs (e.g. `{ backendId }`). */
  details?: Record<string, unknown>;
  requestId?: string;
}

/**
 * The only error type allowed to cross a trust boundary.
 *
 * `message` is safe to show to a client. Anything captured in `cause` is for
 * logs: database/OS messages routinely contain absolute paths and schema
 * details, so they are redacted on the way out.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.details = options.details;
    this.requestId = options.requestId;
  }

  get category(): ErrorCategory {
    return errorDefinition(this.code).category;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.requestId ? { requestId: this.requestId } : {}),
      },
    };
  }

  toJSONRpcError(): { code: number; message: string } {
    return { code: errorDefinition(this.code).jsonRpcCode, message: this.message };
  }
}

/** Log-only view. Includes the cause chain but never leaves the process. */
export function describeErrorForLog(error: unknown): {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
  cause?: string;
} {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(error.cause instanceof Error ? { cause: error.cause.message } : {}),
    };
  }

  if (error instanceof Error) {
    return {
      code: 'INTERNAL_ERROR',
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  return { code: 'INTERNAL_ERROR', message: String(error) };
}

/**
 * Field names the gateway itself defines, and therefore the only path segments
 * safe to echo.
 *
 * A pattern cannot decide this: a pasted secret (`sk-live-ABCDEFGHIJKLMNOP`) is
 * indistinguishable from a plausible env-var name, and Zod puts record keys and
 * unrecognized key names into the error path/message. Echoing only names we
 * declared is the only rule that holds. A new schema field shows as
 * `(redacted)` in messages until it is added here — cosmetic, never a leak.
 */
const KNOWN_FIELDS = new Set([
  'id',
  'name',
  'description',
  'connection',
  'enabled',
  'timeoutMs',
  'concurrencyMode',
  'concurrencyLimit',
  'version',
  'createdAt',
  'updatedAt',
  'type',
  'command',
  'args',
  'cwd',
  'env',
  'url',
  'headers',
  'page',
  'limit',
  'search',
  'transport',
  'sort',
  'order',
  'backendId',
  'expectedVersion',
]);

const REDACTED = '(redacted)';

/** Redacts any path segment that is not a field the gateway defines. */
export function safeIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';

  return path.map((segment) => (KNOWN_FIELDS.has(String(segment)) ? String(segment) : REDACTED)).join('.');
}

/**
 * Message for one issue. `unrecognized_keys` is rewritten without the supplied
 * names, because Zod embeds them verbatim and they are caller-controlled.
 */
export function safeIssueMessage(issue: { code?: string; keys?: unknown; message: string }): string {
  if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
    return `Unrecognized field${issue.keys.length === 1 ? '' : 's'}: not allowed`;
  }

  return issue.message;
}

/**
 * Human-readable summary of a Zod failure: offending paths and messages only,
 * never a received value, which could be a secret.
 *
 * Returns `undefined` when the value is not a Zod error, so callers can branch
 * without importing Zod.
 */
export function formatZodIssues(error: unknown): string | undefined {
  const issues = (
    error as {
      issues?: Array<{ path: PropertyKey[]; message: string; code?: string; keys?: unknown }>;
    } | null
  )?.issues;
  if (!Array.isArray(issues)) return undefined;

  return issues
    .slice(0, 10)
    .map((issue) => `${safeIssuePath(issue.path)}: ${safeIssueMessage(issue)}`)
    .join('; ');
}

/**
 * Collapses anything thrown into a client-safe error.
 *
 * Non-`AppError` values become `INTERNAL_ERROR` with a generic message so that
 * database text, filesystem paths, and stack traces cannot leak. Callers that
 * want a specific code must throw an `AppError`.
 *
 * `ZodError` is the one exception: it is always the caller's malformed input, so
 * it maps to `VALIDATION_ERROR`.
 */
export function toAppError(
  error: unknown,
  fallback: { code: ErrorCode; message: string } = {
    code: 'INTERNAL_ERROR',
    message: 'An internal gateway error occurred.',
  },
): AppError {
  if (error instanceof AppError) return error;

  const issues = formatZodIssues(error);
  if (issues !== undefined) {
    return new AppError('VALIDATION_ERROR', issues === '' ? 'The request is invalid.' : issues, { cause: error });
  }

  return new AppError(fallback.code, fallback.message, { cause: error });
}

/** True when the error is the caller's fault and should not be logged as a gateway fault. */
export function isClientFault(error: unknown): boolean {
  return error instanceof AppError && errorDefinition(error.code).category === 'client';
}
