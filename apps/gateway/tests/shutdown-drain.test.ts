import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { openStore } from '../src/infrastructure/database/index.js';
import { createTestAgent, TEST_SECRET, testKeys } from './fixtures/auth.js';

/**
 * Bounded shutdown drain (Phase 18, Stage C).
 *
 * The entry file cannot be imported by a test — importing it starts the
 * gateway — so this suite spawns the real `src/index.ts` as a child, exactly
 * like the lifecycle HTTP fixtures. The regression it pins: a client whose
 * request can never finish used to hang `server.close()` forever, because the
 * handler waits for a declared body that never arrives. The drain deadline
 * must force the exit while the ordered teardown still runs.
 */

/** Must mirror `SHUTDOWN_DRAIN_LIMIT_MS` in `src/index.ts`. */
const DRAIN_LIMIT_MS = 5_000;
/** Budget for the whole forced path: drain limit plus teardown slack. */
const FORCED_EXIT_BUDGET_MS = DRAIN_LIMIT_MS + 5_000;

interface Spawned {
  child: ChildProcess;
  port: number;
  stdout: string;
  directory: string;
  /** Present when `stallable` seeded an authenticated agent for the stall fixture. */
  authorization?: string;
}

let spawned: Spawned | undefined;
let sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets) socket.destroy();
  sockets = [];
  const child = spawned?.child;
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  if (spawned !== undefined) rmSync(spawned.directory, { recursive: true, force: true });
  spawned = undefined;
});

/**
 * Spawns the real entry on a disposable database and waits for its port.
 *
 * With `stallable: true` the database is pre-seeded with an authenticated
 * agent, so a raw socket can keep a request in flight forever: complete
 * headers with a declared body that never arrives. Auth-less requests are
 * answered (401) without reading the body, and Node closes those connections,
 * so only a genuine handler wait holds the drain open.
 */
async function startGateway(stallable: boolean): Promise<Spawned> {
  const directory = mkdtempSync(join(tmpdir(), 'umg-drain-'));
  const dbPath = join(directory, 'gateway.db');

  let authorization: string | undefined;
  if (stallable) {
    const store = openStore({ path: dbPath });
    try {
      authorization = createTestAgent(store, testKeys()).authorization;
    } finally {
      store.close();
    }
  }

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ENVIRONMENT: 'development',
      DATABASE_PATH: dbPath,
      PORT: String(port),
      LOG_LEVEL: 'info',
      CREDENTIAL_HASH_SECRET: TEST_SECRET,
    },
  });

  let stdout = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the gateway did not report its port')), 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
      if (stdout.includes('Universal MCP Gateway started')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the gateway exited during startup with ${String(code)}`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return { child, port, stdout, directory, ...(authorization === undefined ? {} : { authorization }) };
}

/** Resolves when the child exits, gathering everything it printed. */
function awaitExit(child: ChildProcess, limitMs: number): Promise<{ code: number | null; stdout: string }> {
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += String(chunk);
  });

  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the gateway did not exit within ${limitMs}ms`)), limitMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

/** One authenticated request whose declared body never arrives: the handler waits forever. */
async function openStalledRequest(port: number, authorization: string): Promise<void> {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', (error) => reject(error));
  });
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${authorization}\r\n` +
      'Content-Type: application/json\r\nContent-Length: 128\r\n\r\n',
  );
}

describe('shutdown drain', () => {
  it(
    'forces the exit when a stalled request holds the drain open',
    async () => {
      const gateway = await startGateway(true);
      spawned = gateway;
      await openStalledRequest(gateway.port, gateway.authorization!);
      // Let the headers reach the server and become an in-flight request
      // before the signal. A SIGTERM that beats the parser races the idle
      // reaping instead of pinning the drain; 500ms on loopback is far more
      // than the parse needs.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const exited = awaitExit(gateway.child, FORCED_EXIT_BUDGET_MS);
      gateway.child.kill('SIGTERM');
      const { code, stdout } = await exited;

      // The bound held: the process exited, and the diagnostic names the forced path.
      expect(stdout).toContain('deadline reached');
      // The ordered teardown still ran to completion, so the exit is clean.
      expect(code).toBe(0);
    },
    30_000,
  );

  it(
    'exits promptly with no stalled request and no forced diagnostic',
    async () => {
      const gateway = await startGateway(false);
      spawned = gateway;

      const exited = awaitExit(gateway.child, 15_000);
      gateway.child.kill('SIGTERM');
      const { code, stdout } = await exited;

      expect(stdout).not.toContain('deadline reached');
      expect(stdout).toContain('Gateway stopped');
      expect(code).toBe(0);
    },
    30_000,
  );
});
