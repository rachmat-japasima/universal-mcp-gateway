import { Client, type CallToolResult, type Implementation, type Transport } from '@modelcontextprotocol/client';

import { AppError } from '../shared/errors.js';

/**
 * MCP backend client.
 *
 * A thin, deliberate wrapper — not an abstraction layer over the SDK. It exists
 * for exactly three reasons, and nothing here should grow beyond them:
 *
 *   * one place that knows how to turn an SDK/transport failure into the
 *     gateway's `AppError` taxonomy, so callers and the runtime never branch on
 *     `SdkErrorCode`;
 *   * one place that applies the backend's configured per-call timeout;
 *   * one place that owns the client's lifecycle, so no caller can leave a
 *     connection open.
 *
 * Tool aggregation, namespacing, and routing are explicitly Phase 5+; the read
 * verbs are exposed because a health check and an operator inspection need
 * them, not because a routing table is being built.
 */

export const CLIENT_INFO: Implementation = { name: 'universal-mcp-gateway', version: '1.0.0' };

export interface McpBackendClientOptions {
  /** Per-call timeout in milliseconds, from the backend definition. */
  timeoutMs: number;
  clientInfo?: Implementation;
}

export class McpBackendClient {
  readonly client: Client;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(options: McpBackendClientOptions) {
    this.timeoutMs = options.timeoutMs;
    this.client = new Client(options.clientInfo ?? CLIENT_INFO, { capabilities: {} });
  }

  /**
   * Initializes the session over an already-constructed transport.
   *
   * `connect()` calls `transport.start()` itself; the timeout is enforced here
   * because a hung handshake would otherwise sit on a socket until the process
   * exits.
   */
  async connect(transport: Transport): Promise<void> {
    try {
      await withTimeout(() => this.client.connect(transport, { timeout: this.timeoutMs }), this.timeoutMs);
    } catch (error) {
      throw normalizeMcpError(error, 'MCP initialization failed');
    }
  }

  async ping(): Promise<void> {
    await this.run('MCP ping failed', () => this.client.ping({ timeout: this.timeoutMs }));
  }

  async listTools(): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
    const result = await this.run('Listing tools failed', () =>
      this.client.listTools(undefined, { timeout: this.timeoutMs, cacheMode: 'bypass' }),
    );
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return this.run(`Calling tool "${name}" failed`, () =>
      this.client.callTool({ name, arguments: args }, { timeout: this.timeoutMs }),
    );
  }

  async listResources(): Promise<Awaited<ReturnType<Client['listResources']>>['resources']> {
    const result = await this.run('Listing resources failed', () =>
      this.client.listResources(undefined, { timeout: this.timeoutMs, cacheMode: 'bypass' }),
    );
    return result.resources;
  }

  async readResource(uri: string): Promise<Awaited<ReturnType<Client['readResource']>>> {
    return this.run('Reading the resource failed', () =>
      this.client.readResource({ uri }, { timeout: this.timeoutMs, cacheMode: 'bypass' }),
    );
  }

  async listPrompts(): Promise<Awaited<ReturnType<Client['listPrompts']>>['prompts']> {
    const result = await this.run('Listing prompts failed', () =>
      this.client.listPrompts(undefined, { timeout: this.timeoutMs, cacheMode: 'bypass' }),
    );
    return result.prompts;
  }

  /** Idempotent: closing twice is safe, which the lifecycle manager relies on. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }

  private async run<T>(message: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new AppError('BACKEND_UNAVAILABLE', 'The backend connection is closed.');

    try {
      return await withTimeout(work, this.timeoutMs);
    } catch (error) {
      throw normalizeMcpError(error, message);
    }
  }
}

/**
 * Race a promise against a timer.
 *
 * The underlying work is not cancelled: `Client` requests accept a `signal`,
 * and the SDK's own `timeout` option does the cancelling. This guard only makes
 * sure a caller is never held longer than the configured budget if the transport
 * ignores its own deadline.
 */
async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutSignal()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class TimeoutSignal extends Error {
  constructor() {
    super('timed out');
    this.name = 'TimeoutSignal';
  }
}

/**
 * Maps anything thrown by the SDK, the transport, or the OS onto the gateway's
 * error taxonomy.
 *
 * The message is deliberately generic. An SDK error can carry a response body,
 * a URL, or a child-process command line, all of which can contain a credential.
 */
export function normalizeMcpError(error: unknown, context: string): AppError {
  if (error instanceof AppError) return error;

  // The SDK wraps whatever the transport threw, including our own policy
  // rejections. Prefer the inner AppError: its message is the useful one
  // ("destination is a loopback address") rather than "initialization failed".
  for (let current = causeOf(error), depth = 0; current !== undefined && depth < 5; depth += 1) {
    if (current instanceof AppError) return current;
    current = causeOf(current);
  }

  if (error instanceof TimeoutSignal) {
    return new AppError('BACKEND_TIMEOUT', `${context}: the operation timed out.`, { cause: error });
  }

  /**
   * The SDK often wraps the real fault: `fetch` rejects with a `TypeError`
   * whose `cause` carries `ECONNREFUSED`. Reading only the outer `code` would
   * classify every unreachable backend as a generic connection error and
   * wrongly mark it permanent.
   */
  const codes = codesOf(error);

  if (codes.has('REQUEST_TIMEOUT')) {
    return new AppError('BACKEND_TIMEOUT', `${context}: the backend did not respond in time.`, { cause: error });
  }

  if (codes.has('CONNECTION_CLOSED') || codes.has('NOT_CONNECTED') || codes.has('SEND_FAILED')) {
    return new AppError('BACKEND_UNAVAILABLE', `${context}: the connection was lost.`, { cause: error });
  }

  // The child process could not be started at all (ENOENT, EACCES, EISDIR).
  if (codes.has('ENOENT') || codes.has('EACCES') || codes.has('EISDIR') || codes.has('ENOTDIR')) {
    return new AppError('BACKEND_CONNECTION_ERROR', `${context}: the executable could not be started.`, {
      cause: error,
    });
  }

  if (codes.has('CLIENT_HTTP_AUTHENTICATION')) {
    return new AppError('BACKEND_CONNECTION_ERROR', `${context}: the backend rejected the credentials.`, {
      cause: error,
    });
  }

  if (codes.has('CLIENT_HTTP_FORBIDDEN')) {
    return new AppError('BACKEND_CONNECTION_ERROR', `${context}: the backend refused the request.`, { cause: error });
  }

  if ([...codes].some((code) => code.startsWith('CLIENT_HTTP_'))) {
    return new AppError('BACKEND_CONNECTION_ERROR', `${context}: the backend returned an error response.`, {
      cause: error,
    });
  }

  // Unreachable hosts are transient: the answer can change without an edit.
  if (codes.has('ECONNREFUSED') || codes.has('EHOSTUNREACH') || codes.has('ENETUNREACH') || codes.has('ENOTFOUND')) {
    return new AppError('BACKEND_UNAVAILABLE', `${context}: the backend is not reachable.`, { cause: error });
  }

  return new AppError('BACKEND_CONNECTION_ERROR', `${context}.`, { cause: error });
}

/** Every `code` in the error's cause chain, so a wrapped OS error is not missed. */
function codesOf(error: unknown): Set<string> {
  const codes = new Set<string>();

  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.add(code);
    current = (current as { cause?: unknown }).cause;
  }

  return codes;
}

function causeOf(error: unknown): unknown {
  return error !== null && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
}
