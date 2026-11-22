/**
 * Soak harness (Phase 18, Stage D).
 *
 * Deliberately NOT part of `pnpm verify` or `pnpm test`: a soak is a bounded
 * steady-load measurement against a real spawned gateway, not a pass/fail
 * unit suite. Mock providers only — the backend is `tests/fixtures/mcp-fixture.ts`
 * over stdio, never a real provider, and no real credentials exist anywhere in
 * this harness.
 *
 *   pnpm soak --profile=ci
 *
 * It reports what it measured and, just as deliberately, what it did not:
 * every NOT MEASURED line below is a true statement about this profile, not a
 * to-do. The pass gate is narrow and honest — more than 1% failed calls, a
 * crashed gateway, or an unclean shutdown fails the run; everything else is
 * reported as numbers.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { openStore } from '../../src/infrastructure/database/index.js';
import { BackendService } from '../../src/registry/backend-service.js';
import { createTestAgent, TEST_SECRET, testKeys } from '../fixtures/auth.js';
import { createTestOperator } from '../fixtures/operator.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/mcp-fixture.ts', import.meta.url));
const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

const PROFILES = {
  ci: { durationMs: 90_000, concurrency: 4, gapMs: 25 },
} as const;

/** More than this share of failed calls fails the run. */
const MAX_ERROR_RATE = 0.01;

interface Frame {
  result?: unknown;
  error?: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** MCP streamable responses may be plain JSON or a `data:`-framed SSE body. */
function parseFrame(text: string): Frame {
  const body = text.trimStart().startsWith('{') ? text : (text.split('data: ').at(-1) ?? '');
  return JSON.parse(body) as Frame;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function main(): Promise<number> {
  const requested = process.argv.slice(2).find((arg) => arg.startsWith('--profile='));
  const name = requested?.slice('--profile='.length) ?? '';
  const profile = PROFILES[name as keyof typeof PROFILES];
  if (profile === undefined) {
    process.stderr.write(`Usage: pnpm soak --profile=<${Object.keys(PROFILES).join('|')}>\n`);
    return 2;
  }

  const directory = mkdtempSync(join(tmpdir(), 'umg-soak-'));
  const dbPath = join(directory, 'gateway.db');

  // Seed everything before the gateway exists: the operator session cookie and
  // the agent credential are minted by the real services, and the agent policy
  // needs the backend id, so the backend row is created by the real
  // `BackendService` — raw SQL here would be a fixture that keeps passing after
  // the service breaks.
  const store = openStore({ path: dbPath });
  const backend = new BackendService(store).create({
    name: 'soak-backend',
    connection: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', FIXTURE] },
  });
  const tool = `${backend.id}__echo`;
  const agent = createTestAgent(store, testKeys(), { name: 'soak-agent', allowTools: [tool] });
  const operator = createTestOperator(store, testKeys());
  const activityBefore = store.activity.count();
  store.close();

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
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

  let childStdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    childStdout += String(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    childStdout += String(chunk);
  });

  const killChild = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the gateway did not report its port')), 20_000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (String(chunk).includes('Universal MCP Gateway started')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the gateway exited during startup with ${String(code)}`));
      });
    });

    const base = `http://127.0.0.1:${port}`;
    const operatorHeaders = { 'content-type': 'application/json', ...operator.headers };
    const agentHeaders = {
      'content-type': 'application/json',
      // The streamable MCP endpoint refuses clients that cannot accept SSE.
      accept: 'application/json, text/event-stream',
      authorization: agent.authorization,
    };

    const health = await fetch(`${base}/health`);
    if (!health.ok) throw new Error(`/health answered ${String(health.status)}`);

    // The gateway never auto-connects at boot (docs/BACKEND_SPEC.md); the soak
    // does it exactly the way an operator would.
    const connect = await fetch(`${base}/api/v1/backends/${backend.id}/connect`, {
      method: 'POST',
      headers: operatorHeaders,
    });
    if (!connect.ok) {
      throw new Error(`backend connect answered ${String(connect.status)}: ${await connect.text()}`);
    }

    // Discovery follows the connection; wait for the catalog to name the tool.
    let lastListed = '<no response>';
    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 400) {
        const runtime = await fetch(`${base}/api/v1/backends/${backend.id}/runtime`, {
          headers: operatorHeaders,
        });
        throw new Error(
          `the backend tool never appeared in tools/list after ${String(attempt)} polls; ` +
            `runtime=${await runtime.text()} last tools/list=${lastListed}`,
        );
      }
      const listed = await fetch(base + '/mcp', {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      lastListed = await listed.text();
      const frame = parseFrame(lastListed);
      const tools = Array.isArray(frame.result)
        ? (frame.result as Array<{ name: string }>)
        : ((frame.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []);
      if (tools.some((candidate) => candidate.name === tool)) break;
      await sleep(25);
    }

    async function callEcho(): Promise<'ok' | 'non-200' | 'rpc-error'> {
      const response = await fetch(base + '/mcp', {
        method: 'POST',
        headers: agentHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: { text: `soak-${Math.random()}` } },
        }),
      });
      const frame = parseFrame(await response.text());
      if (response.status !== 200) return 'non-200';
      return frame.error === undefined && frame.result !== undefined ? 'ok' : 'rpc-error';
    }

    for (let warmup = 0; warmup < 5; warmup += 1) {
      if ((await callEcho()) !== 'ok') throw new Error('warmup call failed; the harness is miswired');
    }

    const startedAt = Date.now();
    const deadline = startedAt + profile.durationMs;
    const latencies: number[] = [];
    let non200 = 0;
    let rpcErrors = 0;
    let networkErrors = 0;

    const rssSamples: number[] = [];
    const rssTimer = setInterval(() => {
      // /proc is Linux; absent elsewhere the memory lines report honestly as
      // NOT MEASURED rather than being approximated.
      const status = child.pid === undefined ? undefined : `/proc/${child.pid}/status`;
      if (status === undefined || !existsSync(status)) return;
      const match = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(status, 'utf8'));
      if (match !== null) rssSamples.push(Number(match[1]));
    }, 5_000);

    await Promise.all(
      Array.from({ length: profile.concurrency }, async () => {
        while (Date.now() < deadline) {
          const callStarted = Date.now();
          try {
            const outcome = await callEcho();
            if (outcome === 'ok') latencies.push(Date.now() - callStarted);
            else if (outcome === 'non-200') non200 += 1;
            else rpcErrors += 1;
          } catch {
            networkErrors += 1;
          }
          await sleep(profile.gapMs);
        }
      }),
    );
    clearInterval(rssTimer);

    // One idle sample after load stops: if the growth is V8's lazy GC, RSS
    // drops back at idle; if it survives idle, it is a leak suspect. Five
    // seconds is short — the report says so instead of overclaiming.
    await sleep(5_000);
    const postIdle = existsSync(`/proc/${child.pid}/status`)
      ? Number(/^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))?.[1] ?? 0)
      : undefined;

    const drained = new Promise<{ code: number | null }>((resolve) => {
      child.once('exit', (code) => resolve({ code }));
    });
    child.kill('SIGTERM');
    const exit = await Promise.race([drained, sleep(15_000).then(() => ({ code: 'timeout' as const }))]);
    const cleanExit =
      typeof exit.code === 'number' && exit.code === 0 && childStdout.includes('Gateway stopped');

    const total = latencies.length + non200 + rpcErrors + networkErrors;
    const errorRate = total === 0 ? 1 : (non200 + rpcErrors + networkErrors) / total;
    const sorted = [...latencies].sort((a, b) => a - b);
    const after = openStore({ path: dbPath });
    const activityAfter = after.activity.count();
    after.close();

    console.log(`=== soak profile=${name} ===`);
    console.log(
      `requests: ${String(total)} ok: ${String(latencies.length)} non-200: ${String(non200)} ` +
        `rpc-error: ${String(rpcErrors)} network: ${String(networkErrors)} ` +
        `(${(total / ((Date.now() - startedAt) / 1_000)).toFixed(1)}/s)`,
    );
    console.log(
      `latency ms — mean ${sorted.length === 0 ? 'n/a' : (sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(0)} ` +
        `p50 ${String(percentile(sorted, 0.5))} p95 ${String(percentile(sorted, 0.95))} ` +
        `max ${String(sorted.at(-1) ?? 0)}`,
    );
    if (rssSamples.length > 1) {
      const last = rssSamples.at(-1) ?? 0;
      console.log(
        `gateway RSS kB — first ${String(rssSamples[0])} last-under-load ${String(last)} ` +
          `delta ${String(last - rssSamples[0])}` +
          (postIdle === undefined || postIdle === 0
            ? ''
            : ` after-5s-idle ${String(postIdle)} (${postIdle < last ? 'reclaimed at idle' : 'NOT reclaimed — leak suspect at this window'})`),
      );
    } else {
      console.log('gateway RSS kB — NOT MEASURED (no /proc samples)');
    }
    console.log(
      `database bytes — main ${String(statSync(dbPath).size)} wal ${String(existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0)} ` +
        `activity rows +${String(activityAfter - activityBefore)}`,
    );
    console.log(`shutdown — ${cleanExit ? 'clean (exit 0, ordered teardown logged)' : 'UNCLEAN'}`);
    console.log('');
    console.log('NOT MEASURED (true of this profile, not a to-do list):');
    console.log(`- multi-hour stability: this profile runs ${String(profile.durationMs / 1_000)}s`);
    console.log('- saturation load: steady traffic (4 workers, 25ms gaps), not peak load');
    console.log('- backend crash / reconnect churn: the mock backend never fails');
    console.log('- CPU profile and event-loop delay: not instrumented');

    const failed = !cleanExit || errorRate > MAX_ERROR_RATE;
    if (failed) {
      console.log('');
      console.log(`FAIL: error rate ${(errorRate * 100).toFixed(2)}% (max ${MAX_ERROR_RATE * 100}%) or unclean shutdown`);
    }
    return failed ? 1 : 0;
  } finally {
    killChild();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    console.error(`soak harness error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
