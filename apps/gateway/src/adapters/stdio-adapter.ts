import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';

import { AppError } from '../shared/errors.js';
import type { AdapterContext, BackendAdapter } from './adapter.js';
import { resolveFromProcessEnv, resolveSecretRefs } from './adapter.js';
import { McpBackendClient, normalizeMcpError } from './mcp-client.js';

/**
 * stdio transport.
 *
 * Process isolation is structural, not a policy check:
 *   * `command` is one executable token (the domain schema rejects whitespace,
 *     `;`, `|`, `$`, backticks, and friends), and arguments are a separate
 *     array. There is no shell, so there is nothing to interpolate into;
 *   * the SDK spawns with `shell: false` and `windowsHide`, and we never pass a
 *     string through a shell ourselves;
 *   * the child inherits only `getDefaultEnvironment()` (HOME, PATH, USER,
 *     SHELL, TERM, LOGNAME) plus explicitly referenced variables — never the
 *     gateway's whole environment, which is where tokens live;
 *   * `cwd` resolves against the gateway's working directory and must exist;
 *   * stderr is piped, bounded, and never logged verbatim (it may quote a
 *     token from an env var the child printed).
 *
 * Teardown is owned by the SDK's `close()`, which already implements
 * stdin-end → SIGTERM → grace → SIGKILL. Reimplementing it here would mean two
 * different kill policies to reason about.
 */

/** Only the tail is kept: an early crash explains itself, a chatty server does not. */
const STDERR_TAIL_BYTES = 2048;

export function createStdioAdapter(context: AdapterContext): BackendAdapter {
  const { backend, events, logger } = context;
  const connection = backend.connection;

  // Narrowing: the factory only calls this for stdio.
  if (connection.type !== 'stdio') throw new AppError('CONFIGURATION_ERROR', 'Wrong adapter for this transport.');

  let transport: StdioClientTransport | undefined;
  let client: McpBackendClient | undefined;
  let closedByPeer = false;
  let closing = false;
  let stderrTail = '';

  const target = connection.cwd === undefined ? connection.command : `${connection.command} (cwd ${connection.cwd})`;

  function attachStderr(): void {
    const stream = transport?.stderr;
    if (stream === null || stream === undefined) return;

    stream.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES);
    });
    // A broken stderr pipe must not become an unhandled 'error' event.
    stream.on('error', () => undefined);
  }

  return {
    transport: 'stdio',
    target,

    get closedByPeer() {
      return closedByPeer;
    },

    get pid() {
      return transport?.pid ?? undefined;
    },

    async connect() {
      const { command, args, cwd, env } = connection;

      let envValues: Record<string, string>;
      try {
        envValues = resolveSecretRefs(env, resolveFromProcessEnv);
      } catch (error) {
        throw new AppError('CONFIGURATION_ERROR', 'A configured secret reference could not be resolved.', {
          cause: error,
          details: { backendId: backend.id },
        });
      }

      transport = new StdioClientTransport({
        command,
        // An array, always. This is the whole reason the schema forbids a shell string.
        args: [...args],
        env: { ...getDefaultEnvironment(), ...envValues },
        ...(cwd === undefined ? {} : { cwd: resolve(cwd) }),
        // Piped so a crash's last words are available for diagnosis.
        stderr: 'pipe',
      });

      attachStderr();

      transport.onerror = (error) => {
        // Reported, not thrown: the SDK surfaces transport faults here and the
        // pending request rejects separately.
        logger.warn(
          { backendId: backend.id, transport: 'stdio', error: error.name },
          'stdio transport reported an error',
        );
      };

      transport.onclose = () => {
        // `close()` also fires this. Only an unrequested close is a peer event.
        if (closing) return;
        closedByPeer = true;
        const detail = stderrTail.trim();
        events.onUnexpectedClose(
          detail === '' ? 'the backend process exited' : `the backend process exited: ${lastLine(detail)}`,
        );
      };

      client = new McpBackendClient({ timeoutMs: backend.timeoutMs });

      try {
        await client.connect(transport);
      } catch (error) {
        // Capture before `close()` resets it: the child's last words are the
        // most useful thing a failed handshake produces.
        const tail = stderrTail;
        // A failed handshake must not leave a spawned child behind.
        await this.close();
        throw withStderr(normalizeMcpError(error, 'The backend process failed to start'), tail);
      }

      return client;
    },

    async close() {
      closing = true;

      try {
        await client?.close();
      } catch {
        // Closing an already-dead client is not an error worth surfacing.
      }

      try {
        await transport?.close();
      } catch {
        // Same: the process may already be gone.
      }

      client = undefined;
      transport = undefined;
      stderrTail = '';
    },
  };
}

/** Last non-empty stderr line, redacted of anything shaped like a credential. */
function lastLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).filter((part) => part !== '').at(-1) ?? '';
  return line.replace(/\b(?:sk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]').slice(0, 200);
}

function withStderr(error: AppError, stderr: string): AppError {
  const detail = stderr.trim();
  if (detail === '') return error;

  return new AppError(error.code, `${error.message} (${lastLine(detail)})`, {
    cause: error.cause,
    details: error.details,
  });
}
