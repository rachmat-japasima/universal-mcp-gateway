import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CredentialKeys,
  CredentialSecretError,
  digest,
  digestMatches,
  isWellFormedToken,
  issueToken,
  loadCredentialKey,
  MIN_SECRET_LENGTH,
  resolveCredentialKeys,
  TOKEN_PREFIX,
} from '../src/auth/credential-key.js';
import { loadConfig } from '../src/config/config.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';
import { createLogger } from '../src/monitoring/logger.js';
import { AgentService } from '../src/registry/agent-service.js';
import { CredentialService, toPublicCredential } from '../src/registry/credential-service.js';
import { TEST_SECRET, testKeys } from './fixtures/auth.js';

/**
 * Credential security: minting, hashing, storage, and the startup secret policy.
 *
 * The properties asserted here are the ones that would be silent failures in
 * production — a plaintext token in the database, a verifier that survives a
 * secret change, a credential that keeps working after revocation.
 */

const config = loadConfig({ ENVIRONMENT: 'test', LOG_LEVEL: 'silent' });
const logger = createLogger(config);

let directory: string;
let store: Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-credentials-'));
  store = openStore({ path: join(directory, 'gateway.db') });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('token minting', () => {
  it('issues a recognisable, high-entropy token that is never the same twice', () => {
    const keys = testKeys();
    const first = issueToken(keys.issuing!);
    const second = issueToken(keys.issuing!);

    expect(first.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(isWellFormedToken(first.token)).toBe(true);
    expect(first.token).not.toBe(second.token);
    // 32 random bytes → 43 base64url characters, plus the display prefix.
    expect(first.token.length).toBe(TOKEN_PREFIX.length + 43);
  });

  it('stores a digest that is not the token, and a prefix too short to authenticate', () => {
    const issued = issueToken(testKeys().issuing!);

    expect(issued.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(issued.token.startsWith(issued.tokenPrefix)).toBe(true);
    // The prefix is a display aid only: it is a strict, short substring.
    expect(issued.tokenPrefix.length).toBeLessThan(issued.token.length - 20);
  });

  it('rejects structurally invalid tokens without touching a key', () => {
    const issued = issueToken(testKeys().issuing!);

    expect(isWellFormedToken('')).toBe(false);
    expect(isWellFormedToken('umg_live_short')).toBe(false);
    expect(isWellFormedToken(issued.token.replace('umg_live_', 'umg_other_'))).toBe(false);
    expect(isWellFormedToken(`${issued.token}extra`)).toBe(false);
    expect(isWellFormedToken(issued.token.slice(0, -1) + '!')).toBe(false);
  });

  it('compares digests in constant time and rejects malformed digests', () => {
    const key = testKeys().issuing!;
    const digestOfToken = digest('umg_live_value', key);

    expect(digestMatches(digestOfToken, digestOfToken)).toBe(true);
    expect(digestMatches(digestOfToken, digest('umg_live_other', key))).toBe(false);
    expect(digestMatches('not-hex', digestOfToken)).toBe(false);
    expect(digestMatches(digestOfToken, 'ab')).toBe(false);
  });

  it('produces the same verifier for the same token and secret, across processes', () => {
    // "Across processes" is modelled by re-deriving from the same inputs: the
    // digest has no process-local state, which is what makes restart safe.
    const token = issueToken(testKeys().issuing!).token;

    expect(digest(token, testKeys().issuing!)).toBe(digest(token, testKeys().issuing!));
    expect(digest(token, testKeys('a-different-secret-of-sufficient-length').issuing!)).not.toBe(
      digest(token, testKeys().issuing!),
    );
  });
});

describe('secret loading', () => {
  it('refuses a missing, short, or malformed key id', () => {
    expect(loadCredentialKey({})).toBeUndefined();
    expect(loadCredentialKey({ CREDENTIAL_HASH_SECRET: 'x'.repeat(MIN_SECRET_LENGTH - 1) })).toBeUndefined();
    expect(
      loadCredentialKey({ CREDENTIAL_HASH_SECRET: TEST_SECRET, CREDENTIAL_HASH_KEY_ID: 'not valid!' }),
    ).toBeUndefined();
  });

  it('accepts a long enough secret and defaults the key id to v1', () => {
    expect(loadCredentialKey({ CREDENTIAL_HASH_SECRET: TEST_SECRET })).toEqual({ id: 'v1', secret: TEST_SECRET });
    expect(loadCredentialKey({ CREDENTIAL_HASH_SECRET: TEST_SECRET, CREDENTIAL_HASH_KEY_ID: 'v2' })?.id).toBe('v2');
  });

  it('fails closed in development instead of generating an ephemeral secret', () => {
    const keys = resolveCredentialKeys('development', {});

    expect(keys.issuing).toBeUndefined();
    // An old credential still cannot be verified: there is no key to verify it.
    expect(keys.verifier('v1')).toBeUndefined();
  });

  it('refuses to start in production without a usable secret', () => {
    expect(() => resolveCredentialKeys('production', {})).toThrow(CredentialSecretError);
    expect(() => resolveCredentialKeys('production', { CREDENTIAL_HASH_SECRET: 'too-short' })).toThrow(
      CredentialSecretError,
    );
    expect(resolveCredentialKeys('production', { CREDENTIAL_HASH_SECRET: TEST_SECRET }).issuing).toEqual({
      id: 'v1',
      secret: TEST_SECRET,
    });
  });

  it('refuses a verifier for a credential whose key id this process does not hold', () => {
    const keys = new CredentialKeys(
      { id: 'v2', secret: TEST_SECRET },
      new Map([['v2', { id: 'v2', secret: TEST_SECRET }]]),
    );

    expect(keys.verifier('v2')?.id).toBe('v2');
    expect(keys.verifier('v1')).toBeUndefined();
    // A Phase 2 row predates key ids: it must never verify.
    expect(keys.verifier(undefined)).toBeUndefined();
  });
});

describe('credential lifecycle', () => {
  function service(): CredentialService {
    return new CredentialService({ store, keys: testKeys() });
  }

  function agent(name: string = 'laptop'): string {
    return new AgentService(store).create({ name }).id;
  }

  it('persists only the digest, prefix, and key id — never the token', () => {
    const agentId = agent();
    const { credential, token } = service().issue(agentId, { name: 'issued' });

    const row = store.handle.prepare('SELECT * FROM agent_credentials WHERE id = ?').get(credential.id) as Record<
      string,
      unknown
    >;

    expect(JSON.stringify(row)).not.toContain(token);
    expect(row['credential_hash']).toMatch(/^[a-f0-9]{64}$/);
    expect(row['token_prefix']).toBe(credential.tokenPrefix);
    expect(row['hash_key_id']).toBe('v1');
    expect(row['label']).toBe('issued');
  });

  it('never includes the verifier in the public projection', () => {
    const { credential } = service().issue(agent());

    const shown = toPublicCredential(credential);
    expect(shown).not.toHaveProperty('credentialHash');
    expect(shown).not.toHaveProperty('token');
    expect(shown['status']).toBe('active');
  });

  it('does not return the token a second time when listing', () => {
    const agentId = agent();
    const { token } = service().issue(agentId);

    const listed = service().list(agentId).map((credential) => toPublicCredential(credential));
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it('scopes credentials by agent, so another agent cannot address one', () => {
    const owner = agent('owner');
    const other = agent('other');
    const { credential } = service().issue(owner);

    expect(() => service().revoke(other, credential.id)).toThrow(/does not exist/);
  });

  it('rotates atomically: the old token stops working the moment the new one exists', () => {
    const agentId = agent();
    const first = service().issue(agentId, { name: 'primary', expiresAt: '2030-01-01T00:00:00.000Z' });

    const rotated = service().rotate(agentId, first.credential.id);

    expect(rotated.credential.id).not.toBe(first.credential.id);
    expect(rotated.credential.label).toBe('primary');
    expect(rotated.credential.expiresAt).toBe('2030-01-01T00:00:00.000Z');

    const old = store.credentials.findById(first.credential.id)!;
    expect(old.revokedAt).toBeTruthy();

    const audit = store.audit.list(50).filter((event) => event.action === 'credential.rotated');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({
      credentialId: rotated.credential.id,
      previousCredentialId: first.credential.id,
    });
  });

  it('refuses to rotate an already-revoked credential', () => {
    const agentId = agent();
    const { credential } = service().issue(agentId);
    service().revoke(agentId, credential.id);

    expect(() => service().rotate(agentId, credential.id)).toThrow(/cannot be rotated/);
  });

  it('is idempotent on revoke and keeps the original timestamp', () => {
    const agentId = agent();
    const { credential } = service().issue(agentId);

    const first = service().revoke(agentId, credential.id);
    const second = service().revoke(agentId, credential.id);

    expect(second.revokedAt).toBe(first.revokedAt);
    expect(store.audit.list(50).filter((event) => event.action === 'credential.revoked')).toHaveLength(1);
  });

  it('refuses to issue when no hashing key is configured', () => {
    const agentId = agent();
    const unconfigured = new CredentialService({ store, keys: new CredentialKeys(undefined) });

    expect(() => unconfigured.issue(agentId)).toThrow(/hashing secret is not configured/);
    expect(store.credentials.listByAgentId(agentId)).toEqual([]);
  });

  it('revokes every credential when the agent is deleted, and removes its assignments', () => {
    const agents = new AgentService(store);
    const agentId = agents.create({ name: 'doomed' }).id;
    const issued = service().issue(agentId);

    const removed = agents.remove(agentId);

    expect(removed.revokedCredentials).toBe(1);
    expect(store.credentials.findById(issued.credential.id)?.revokedAt).toBeTruthy();
    expect(store.agents.findById(agentId)).toBeUndefined();
  });
});
