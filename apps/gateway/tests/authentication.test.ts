import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService, isAuthenticated } from '../src/auth/auth-service.js';
import { CredentialKeys } from '../src/auth/credential-key.js';
import { loadConfig } from '../src/config/config.js';
import { createGateway, type Gateway } from '../src/core/gateway.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { AgentService } from '../src/registry/agent-service.js';
import { CredentialService } from '../src/registry/credential-service.js';
import { bearer, createTestAgent, TEST_SECRET, testKeys, type TestAgent } from './fixtures/auth.js';

/**
 * Authentication itself, below the HTTP layer: what a header proves, what it
 * does not, and how uniformly a failure is answered.
 *
 * The HTTP-visible half (401 shape, per-request re-authentication, session
 * replay) lives in `tests/mcp-auth.test.ts`, because it needs a socket.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

let directory: string;
let store: Database;
let keys: CredentialKeys;
let auth: AuthService;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-auth-'));
  store = openStore({ path: join(directory, 'gateway.db') });
  keys = testKeys();
  auth = new AuthService({ store, keys, logger });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function agent(overrides: Parameters<typeof createTestAgent>[2] = {}): TestAgent {
  return createTestAgent(store, keys, overrides);
}

describe('credential verification', () => {
  it('accepts a valid credential and identifies its agent and credential', () => {
    const created = agent();
    const result = auth.authenticate(created.authorization);

    expect(isAuthenticated(result)).toBe(true);
    if (!isAuthenticated(result)) return;
    expect(result.agent.id).toBe(created.id);
    expect(result.credential.id).toBe(created.credentialId);
  });

  it('rejects a missing header', () => {
    expect(auth.authenticate(undefined)).toEqual({ reason: 'missing_header' });
    expect(auth.authenticate('')).toEqual({ reason: 'missing_header' });
    expect(auth.authenticate('   ')).toEqual({ reason: 'missing_header' });
  });

  it('rejects a malformed header', () => {
    const created = agent();
    const token = created.authorization.replace('Bearer ', '');

    expect(auth.authenticate(token)).toEqual({ reason: 'malformed_header' });
    expect(auth.authenticate(`Basic ${token}`)).toEqual({ reason: 'malformed_header' });
    expect(auth.authenticate('Bearer')).toEqual({ reason: 'malformed_header' });
    expect(auth.authenticate('Bearer a b')).toEqual({ reason: 'malformed_header' });
  });

  it('rejects a well-formed header carrying a structurally impossible token', () => {
    expect(auth.authenticate('Bearer umg_live_short')).toEqual({ reason: 'malformed_token' });
  });

  it('rejects an unknown token', () => {
    agent();
    expect(auth.authenticate(`Bearer umg_live_${'A'.repeat(43)}`)).toEqual({ reason: 'unknown_credential' });
  });

  it('rejects a token that is valid for another secret', () => {
    const created = agent();
    const otherProcess = new AuthService({ store, keys: testKeys('some-other-secret-of-adequate-length'), logger });

    expect(otherProcess.authenticate(created.authorization)).toEqual({ reason: 'unknown_credential' });
  });

  it('rejects a revoked credential', () => {
    const created = agent();
    new CredentialService({ store, keys }).revoke(created.id, created.credentialId);

    expect(auth.authenticate(created.authorization)).toEqual({ reason: 'revoked_credential' });
  });

  it('rejects an expired credential', () => {
    const created = agent();
    const issued = new CredentialService({ store, keys }).issue(created.id, {
      expiresAt: '2000-01-01T00:00:00.000Z',
    });

    expect(auth.authenticate(`Bearer ${issued.token}`)).toEqual({ reason: 'expired_credential' });
  });

  it('rejects a credential belonging to a disabled agent', () => {
    const created = agent();
    new AgentService(store).setEnabled(created.id, false);

    expect(auth.authenticate(created.authorization)).toEqual({ reason: 'agent_disabled' });
  });

  it('rejects everything when no secret is configured, and says so only in the log', () => {
    const created = agent();
    const unconfigured = new AuthService({ store, keys: new CredentialKeys(undefined), logger });

    expect(unconfigured.authenticate(created.authorization)).toEqual({
      reason: 'secret_missing',
      misconfigured: true,
    });
  });

  it('refuses a credential whose key id this process no longer holds', () => {
    const created = agent();
    // Simulate a rotated-out key: the row keeps `v1`, the process only knows `v2`.
    // The digest still matches (same secret), so this exercises the key-id gate
    // rather than the digest lookup.
    const rotatedKeys = new CredentialKeys(
      { id: 'v2', secret: TEST_SECRET },
      new Map([['v2', { id: 'v2', secret: TEST_SECRET }]]),
    );

    expect(new AuthService({ store, keys: rotatedKeys, logger }).authenticate(created.authorization)).toEqual({
      reason: 'unknown_key',
    });
  });
});

describe('authentication side effects', () => {
  it('records usage without touching the operator-visible update timestamp', () => {
    const created = agent();
    const before = store.agents.findById(created.id)!;

    auth.authenticate(created.authorization);

    const after = store.agents.findById(created.id)!;
    expect(after.lastAuthenticatedAt).toBeTruthy();
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(store.credentials.findById(created.credentialId)?.lastUsedAt).toBeTruthy();
  });

  it('writes one auth.succeeded row per agent per audit window, not one per request', () => {
    const created = agent();
    for (let index = 0; index < 5; index += 1) auth.authenticate(created.authorization);

    expect(store.audit.list(50).filter((event) => event.action === 'auth.succeeded')).toHaveLength(1);
  });

  it('collapses a failure flood into one row, preserving the reason', () => {
    for (let index = 0; index < 5; index += 1) auth.authenticate('Bearer nope');

    const failures = store.audit.list(50).filter((event) => event.action === 'auth.failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.metadata).toEqual({ reason: 'malformed_token' });
  });

  it('never writes a token, header, or agent-supplied text into the audit row', () => {
    const created = agent();
    const token = created.authorization.replace('Bearer ', '');

    auth.authenticate(created.authorization);
    auth.authenticate(`Bearer ${token.slice(0, -1)}X`);

    expect(JSON.stringify(store.audit.list(50))).not.toContain(token);
  });
});

describe('gateway posture without a secret', () => {
  it('keeps health working but rejects every MCP request', async () => {
    const unconfigured: Gateway = createGateway({
      config,
      logger,
      store,
      credentialKeys: new CredentialKeys(undefined),
    });

    const health = await unconfigured.app.request('/health', { headers: { host: '127.0.0.1:8787' } });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ mcp: { authentication: 'unavailable' } });

    const mcp = await unconfigured.app.request('/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        // Even a well-formed credential cannot help: no key can verify it.
        authorization: `Bearer umg_live_${'A'.repeat(43)}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(mcp.status).toBe(401);
    await unconfigured.close();
  });

  it('reports authentication as required when a secret is configured', async () => {
    const configured = createGateway({ config, logger, store, credentialKeys: keys });
    const health = await configured.app.request('/health', { headers: { host: '127.0.0.1:8787' } });

    expect(await health.json()).toMatchObject({ mcp: { authentication: 'required' } });
    await configured.close();
  });

  it('does not expose the secret through any API response', async () => {
    const configured = createGateway({ config, logger, store, credentialKeys: keys });
    const created = agent();

    for (const path of ['/health', '/api/v1/system']) {
      const response = await configured.app.request(path, {
        headers: { host: '127.0.0.1:8787', ...bearer(created) },
      });
      expect(await response.text()).not.toContain(TEST_SECRET);
    }

    await configured.close();
  });
});
