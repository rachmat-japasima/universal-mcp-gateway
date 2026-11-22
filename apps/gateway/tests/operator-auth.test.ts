import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/auth/operator-password.js';
import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { bearer, createTestAgent, testKeys } from './fixtures/auth.js';
import { createTestOperator, TEST_OPERATOR_PASSWORD, TEST_OPERATOR_USERNAME } from './fixtures/operator.js';

/**
 * The operator authentication boundary, end to end.
 *
 * Everything here goes through `gateway.app` rather than a service instance, so
 * what is asserted is the behaviour a caller observes — status codes, cookie
 * attributes, and whether a request is allowed — not an internal method's return
 * value. That is the only way to catch the failure this phase exists to prevent:
 * a boundary that is present in the service but missing from the middleware
 * chain.
 *
 * The MCP surface is exercised at the bottom to prove the two boundaries stayed
 * independent. An operator cookie must not open `/mcp`, and an agent bearer must
 * not open `/api/v1`.
 */

const HOST = { host: '127.0.0.1:8787' };
const JSON_HEADERS = { ...HOST, 'content-type': 'application/json' };

let directory: string;
let store: Database;
let gateway: Gateway;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-operator-auth-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  gateway = createGateway({
    config: loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' }),
    logger: createLogger({ logLevel: 'silent', environment: 'test' }),
    store,
    credentialKeys: testKeys(),
  });
});

afterEach(async () => {
  await gateway.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function createOperator(username = TEST_OPERATOR_USERNAME, password = TEST_OPERATOR_PASSWORD): void {
  store.operators.create({ username, passwordHash: hashPassword(password) }, new Date().toISOString());
}

async function login(
  credentials: { username: string; password: string } = {
    username: TEST_OPERATOR_USERNAME,
    password: TEST_OPERATOR_PASSWORD,
  },
  headers: Record<string, string> = {},
): Promise<Response> {
  return gateway.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(credentials),
  });
}

/** Logs in and returns the pieces a browser would then hold. */
async function signedIn(): Promise<{ cookie: string; csrfToken: string; headers: Record<string, string> }> {
  const response = await login();
  expect(response.status).toBe(200);

  const body = (await response.json()) as { data: { csrfToken: string } };
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!;

  return { cookie, csrfToken: body.data.csrfToken, headers: { cookie, 'x-csrf-token': body.data.csrfToken } };
}

const get = async (path: string, cookie?: string): Promise<Response> =>
  gateway.app.request(`/api/v1${path}`, { headers: cookie === undefined ? HOST : { ...HOST, cookie } });

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

describe('the management API boundary', () => {
  it('refuses every route without a session, not just the write routes', async () => {
    createOperator();

    // One route per router, so a router added later without the middleware shows
    // up as a failure here rather than as an unauthenticated surface.
    for (const path of [
      '/system',
      '/system/health',
      '/overview',
      '/monitoring',
      '/monitoring/backends',
      '/backends',
      '/agents',
      '/policies',
      '/sessions',
      '/audit',
      '/activity',
      '/settings',
      '/diagnostics',
      '/tools',
      '/openapi.json',
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(401);

      const body = await json<{ error: { code: string; message: string } }>(response);
      expect(body.error.code, path).toBe('AUTHENTICATION_ERROR');
      // One message for every reason, so the response is not an oracle.
      expect(body.error.message).toBe('An operator session is required.');
    }
  });

  it('refuses writes without a session before reading the body', async () => {
    createOperator();

    const response = await gateway.app.request('/api/v1/backends', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{ this is not json and must never be parsed',
    });

    // 401, not 400: the parse cost is never paid by an anonymous caller.
    expect(response.status).toBe(401);
    expect(store.audit.count()).toBe(0);
  });

  it('leaves the probes unauthenticated, because a probe that needs a session stops probing', async () => {
    expect((await gateway.app.request('/health', { headers: HOST })).status).toBe(200);
    expect((await gateway.app.request('/ready', { headers: HOST })).status).toBe(200);
  });

  it('is not bypassable by claiming an identity in a header or query', async () => {
    createOperator();
    const operator = store.operators.findByUsername(TEST_OPERATOR_USERNAME)!;

    for (const headers of [
      { ...HOST, 'x-operator-id': operator.id },
      { ...HOST, authorization: `Bearer ${operator.id}` },
      { ...HOST, 'x-forwarded-user': operator.username },
    ]) {
      const response = await gateway.app.request(`/api/v1/system?operatorId=${operator.id}`, { headers });
      expect(response.status).toBe(401);
    }
  });
});

describe('login', () => {
  it('mints a session and sets a cookie the browser cannot read from script', async () => {
    createOperator();

    const response = await login();
    expect(response.status).toBe(200);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^umg_operator=umgo_[A-Za-z0-9_-]+/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    // Off by default: the dashboard is served over plain HTTP on loopback, where
    // a `Secure` cookie is silently dropped and login appears to do nothing.
    expect(cookie).not.toContain('Secure');

    const body = await json<{
      data: {
        operator: Record<string, unknown>;
        session: { id: string; expiresAt: string; idleTimeoutMs: number };
        csrfToken: string;
      };
    }>(response);

    expect(body.data.operator['username']).toBe(TEST_OPERATOR_USERNAME);
    expect(body.data.operator['role']).toBe('owner');
    expect(body.data.session.expiresAt).toBeTruthy();
    expect(body.data.session.idleTimeoutMs).toBe(1_800_000);
    expect(body.data.csrfToken.length).toBeGreaterThan(20);

    // No hash, no cookie value, no secret anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('scrypt$');
    expect(raw).not.toContain(TEST_OPERATOR_PASSWORD);
    expect(raw).not.toContain(cookie.split('=')[1]!.split(';')[0]!);
  });

  it('answers identically for a wrong password, an unknown user, a disabled account and a lockout', async () => {
    createOperator();
    const other = store.operators.create(
      { username: 'disabled-operator', passwordHash: hashPassword('another-long-password') },
      new Date().toISOString(),
    );
    store.operators.disable(other.id, new Date().toISOString());

    const attempts = await Promise.all([
      login({ username: TEST_OPERATOR_USERNAME, password: 'wrong-password' }),
      login({ username: 'no-such-operator', password: 'wrong-password' }),
      login({ username: 'disabled-operator', password: 'another-long-password' }),
    ]);

    const bodies: Array<{ code: string; message: string }> = [];
    for (const response of attempts) {
      expect(response.status).toBe(401);
      // A distinct status or code for "unknown user" would undo the defence.
      bodies.push((await json<{ error: { code: string; message: string } }>(response)).error);
    }

    expect(new Set(bodies.map((body) => body.code))).toEqual(new Set(['AUTHENTICATION_ERROR']));
    expect(new Set(bodies.map((body) => body.message)).size).toBe(1);
    expect(bodies[0]!.message).toBe('The username or password is incorrect.');
  });

  it('names the bootstrap command when the instance has no operator, and nothing more', async () => {
    const response = await login({ username: 'anyone', password: 'anything' });

    expect(response.status).toBe(401);
    const body = await json<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('pnpm operator:create');
    // Deliberately no distinction between "no operator" and "wrong password"
    // once an operator exists: this branch is only reachable on a blank install.
    expect(body.error.message).not.toContain(TEST_OPERATOR_USERNAME);
  });

  it('rejects a body that is not exactly the two expected fields', async () => {
    createOperator();

    for (const body of [
      { username: TEST_OPERATOR_USERNAME },
      { username: '', password: 'x' },
      { username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD, role: 'owner' },
    ]) {
      const response = await gateway.app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  it('locks the account after five failures, and does not unlock on the right password', async () => {
    createOperator();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login({ username: TEST_OPERATOR_USERNAME, password: 'wrong' })).status).toBe(401);
    }

    const locked = store.operators.findByUsername(TEST_OPERATOR_USERNAME)!;
    expect(locked.failedLoginAttempts).toBe(5);
    expect(locked.lockedUntil).toBeTruthy();

    // The correct password is refused while the lockout stands: otherwise a
    // brute-force window would still admit the attacker who found it.
    const correct = await login();
    expect(correct.status).toBe(401);
    expect((await json<{ error: { message: string } }>(correct)).error.message).toBe(
      'The username or password is incorrect.',
    );

    // A later successful login is what clears the counter, so the lock must
    // expire first. Aged here rather than slept.
    store.handle
      .prepare('UPDATE admin_users SET locked_until = NULL WHERE username = ?')
      .run(TEST_OPERATOR_USERNAME);

    expect((await login()).status).toBe(200);
    expect(store.operators.findByUsername(TEST_OPERATOR_USERNAME)!.failedLoginAttempts).toBe(0);
  });

  it('rotates: a login carrying an existing session ends that session', async () => {
    createOperator();
    const first = await signedIn();
    expect((await get('/system', first.cookie)).status).toBe(200);

    const second = await login(
      { username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD },
      { cookie: first.cookie },
    );
    expect(second.status).toBe(200);

    // Session fixation is the classic failure: an id chosen before login must
    // not survive it.
    expect((await get('/system', first.cookie)).status).toBe(401);
    const rotated = (second.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(rotated).not.toBe(first.cookie);
    expect((await get('/system', rotated)).status).toBe(200);
  });

  it('does not reset the lockout counter with a wrong password after a success', async () => {
    createOperator();
    await login();
    await login({ username: TEST_OPERATOR_USERNAME, password: 'wrong' });

    expect(store.operators.findByUsername(TEST_OPERATOR_USERNAME)!.failedLoginAttempts).toBe(1);
  });
});

describe('session lifecycle', () => {
  it('serves the session probe and returns a CSRF token bound to the cookie', async () => {
    createOperator();
    const session = await signedIn();

    const response = await get('/auth/session', session.cookie);
    expect(response.status).toBe(200);

    const body = await json<{ data: { operator: { username: string }; csrfToken: string } }>(response);
    expect(body.data.operator.username).toBe(TEST_OPERATOR_USERNAME);

    // The token is derived from the cookie, so it must be reproducible from the
    // same session and must differ for a different one.
    expect(body.data.csrfToken).toBe(session.csrfToken);

    const other = await signedIn();
    expect(other.csrfToken).not.toBe(session.csrfToken);
  });

  it('ends access on logout and keeps the answer idempotent', async () => {
    createOperator();
    const session = await signedIn();

    const first = await gateway.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { ...HOST, ...session.headers },
    });
    expect(first.status).toBe(200);
    expect((await first.json() as { data: { loggedOut: boolean } }).data.loggedOut).toBe(true);
    expect(first.headers.get('set-cookie')).toContain('Max-Age=0');

    expect((await get('/system', session.cookie)).status).toBe(401);

    // Logout must work with a dead cookie, or a browser could never recover.
    const again = await gateway.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { ...HOST, cookie: session.cookie },
    });
    expect(again.status).toBe(200);
  });

  it('rejects an idle session and marks the row ended', async () => {
    createOperator();
    const session = await signedIn();

    // Aged past the 30-minute idle window instead of sleeping for it.
    const aged = new Date(Date.now() - 31 * 60_000).toISOString();
    store.handle.prepare('UPDATE operator_sessions SET last_seen_at = ?').run(aged);

    const response = await get('/system', session.cookie);
    expect(response.status).toBe(401);
    // The dead cookie is cleared, so the browser does not loop on it.
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');

    const row = store.handle.prepare('SELECT revoked_at FROM operator_sessions').get() as { revoked_at: string | null };
    expect(row.revoked_at).toBeTruthy();
  });

  it('rejects a session past its absolute lifetime even when recently used', async () => {
    createOperator();
    const session = await signedIn();

    store.handle
      .prepare('UPDATE operator_sessions SET expires_at = ?')
      .run(new Date(Date.now() - 1000).toISOString());

    expect((await get('/system', session.cookie)).status).toBe(401);
  });

  it('rejects a session whose operator was disabled, and ends all of them', async () => {
    createOperator();
    const first = await signedIn();
    const second = await signedIn();

    const operator = store.operators.findByUsername(TEST_OPERATOR_USERNAME)!;
    store.operators.disable(operator.id, new Date().toISOString());

    expect((await get('/system', first.cookie)).status).toBe(401);
    expect((await get('/system', second.cookie)).status).toBe(401);

    const rows = store.handle.prepare('SELECT revocation_reason FROM operator_sessions').all() as Array<{
      revocation_reason: string;
    }>;
    expect(rows.every((row) => row.revocation_reason === 'operator_disabled')).toBe(true);
  });

  it('rejects a revoked session immediately, not at the next sweep', async () => {
    createOperator();
    const session = await signedIn();

    const operator = store.operators.findByUsername(TEST_OPERATOR_USERNAME)!;
    expect(gateway.operators!.revokeAllFor(operator.id, 'operator_password_changed')).toBe(1);

    expect((await get('/system', session.cookie)).status).toBe(401);
  });

  it('rejects malformed, unknown, and truncated cookies without a database write', async () => {
    createOperator();

    for (const cookie of [
      'umg_operator=',
      'umg_operator=garbage',
      'umg_operator=umgo_short',
      `umg_operator=umgo_${'a'.repeat(43)}`,
    ]) {
      const response = await get('/system', cookie);
      expect(response.status).toBe(401);
    }

    // Nothing was minted by any of them.
    expect((store.handle.prepare('SELECT COUNT(*) AS count FROM operator_sessions').get() as { count: number }).count).toBe(
      0,
    );
  });

  it('stores only a keyed digest of the cookie value', async () => {
    createOperator();
    const session = await signedIn();
    const token = session.cookie.slice('umg_operator='.length);

    const rows = store.handle.prepare('SELECT token_hash, hash_key_id FROM operator_sessions').all() as Array<{
      token_hash: string;
      hash_key_id: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]!.token_hash).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.hash_key_id).toBe('v1');

    // The database cannot be used to replay: no plaintext exists to replay.
    const dump = JSON.stringify(store.handle.prepare('SELECT * FROM operator_sessions').all());
    expect(dump).not.toContain(token);
  });
});

describe('CSRF', () => {
  it('requires the header on every state-changing method and never on a read', async () => {
    createOperator();
    const { cookie, csrfToken } = await signedIn();

    // A read needs no CSRF token; it changes nothing.
    expect((await get('/backends', cookie)).status).toBe(200);

    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const without = await gateway.app.request('/api/v1/backends', {
        method,
        headers: { ...HOST, cookie, 'content-type': 'application/json' },
      });
      expect(without.status, `${method} without token`).toBe(403);
      expect((await json<{ error: { code: string } }>(without)).error.code).toBe('AUTHORIZATION_ERROR');

      const wrong = await gateway.app.request('/api/v1/backends', {
        method,
        headers: { ...HOST, cookie, 'content-type': 'application/json', 'x-csrf-token': 'not-the-token' },
      });
      expect(wrong.status, `${method} with wrong token`).toBe(403);
    }

    // The right token is accepted (a 404 here is the route's own answer for the
    // method, which proves the guard passed).
    const withToken = await gateway.app.request('/api/v1/backends', {
      method: 'DELETE',
      headers: { ...HOST, cookie, 'x-csrf-token': csrfToken },
    });
    expect(withToken.status).toBe(404);
  });

  it('rejects a token from another session', async () => {
    createOperator();
    const mine = await signedIn();
    const theirs = await signedIn();

    const response = await gateway.app.request('/api/v1/backends', {
      method: 'POST',
      headers: { ...HOST, cookie: mine.cookie, 'content-type': 'application/json', 'x-csrf-token': theirs.csrfToken },
      body: JSON.stringify({ name: 'x', connection: { type: 'stdio', command: 'node' } }),
    });

    expect(response.status).toBe(403);
    expect(store.backends.countActive()).toBe(0);
  });

  it('still refuses a write with no session at all, even carrying a valid-looking token', async () => {
    createOperator();
    const { csrfToken } = await signedIn();

    const response = await gateway.app.request('/api/v1/backends', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'x', connection: { type: 'stdio', command: 'node' } }),
    });

    // Session first, CSRF second: a token alone never authorizes.
    expect(response.status).toBe(401);
  });
});

describe('audit', () => {
  it('records a login, a failure, and a logout without the password or the token', async () => {
    createOperator();

    await login({ username: TEST_OPERATOR_USERNAME, password: 'wrong' });
    const session = await signedIn();
    await gateway.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { ...HOST, ...session.headers },
    });

    const actions = store.audit.list(20).map((event) => event.action);
    expect(actions).toContain('operator.login.failed');
    expect(actions).toContain('operator.login.succeeded');
    expect(actions).toContain('operator.logout');

    const raw = JSON.stringify(store.audit.list(20));
    expect(raw).not.toContain('scrypt$');
    expect(raw).not.toContain(TEST_OPERATOR_PASSWORD);
    expect(raw).not.toContain(session.cookie.split('=')[1]!);
  });

  it('does not name the attempted username on a failed login', async () => {
    createOperator();
    await login({ username: 'no-such-operator', password: 'wrong' });

    const [failure] = store.audit.list(20).filter((event) => event.action === 'operator.login.failed');
    // Recording the guess would turn the audit trail into a list of attempts at
    // identities that may not exist.
    expect(JSON.stringify(failure)).not.toContain('no-such-operator');
    expect(failure?.actorId).toBeUndefined();
    expect(failure?.metadata?.['reason']).toBe('unknown_operator');
  });
});

describe('the two boundaries stay separate', () => {
  it('does not accept an operator cookie at /mcp', async () => {
    createOperator();
    const { cookie } = await signedIn();

    const response = await gateway.app.request('/mcp', {
      method: 'POST',
      headers: {
        ...HOST,
        cookie,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer /);
  });

  it('does not accept an agent bearer at /api/v1', async () => {
    createOperator();
    const agent = createTestAgent(store, testKeys(), { name: 'not-an-operator' });

    const response = await gateway.app.request('/api/v1/system', { headers: { ...HOST, ...bearer(agent) } });
    expect(response.status).toBe(401);
  });

  it('keeps MCP agent authentication working exactly as before', async () => {
    createOperator();
    const agent = createTestAgent(store, testKeys(), { allowTools: ['*'] });

    const response = await gateway.app.request('/mcp', {
      method: 'POST',
      headers: {
        ...HOST,
        ...bearer(agent),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(200);
    // No operator cookie was needed or consulted.
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('keeps the operator out of the agents table', async () => {
    createOperator();
    await signedIn();

    // Operators and agents are separate identities, not one table with a flag.
    expect(store.agents.countActive()).toBe(0);
    expect(store.operators.count()).toBe(1);
  });
});
