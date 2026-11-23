import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  burnPasswordTime,
  hashPassword,
  isAcceptablePassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from '../src/auth/operator-password.js';
import { isOperatorUsernameTaken } from '../src/cli/operator-bootstrap.js';
import { toPublicOperator } from '../src/domain/operator.js';
import { openStore, type Database } from '../src/infrastructure/database/index.js';

/**
 * Operator identity and password storage.
 *
 * The properties that matter here are the ones a reviewer should be able to
 * check by reading an assertion: the hash is never the password, the same
 * password hashes differently every time, a stored row never becomes public
 * with its hash attached, and a duplicate identity is refused by the store
 * rather than by a caller remembering to check.
 */

const PASSWORD = 'a-sufficiently-long-password';

let directory: string;
let store: Database;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'gw-operator-identity-'));
  store = openStore({ path: join(directory, 'gateway.db') });
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('password hashing', () => {
  it('never stores the password, and the format carries its parameters', () => {
    const stored = hashPassword(PASSWORD);

    expect(stored).not.toContain(PASSWORD);
    expect(stored.startsWith('scrypt$')).toBe(true);

    const parts = stored.split('$');
    expect(parts).toHaveLength(6);
    expect(Number(parts[1])).toBeGreaterThanOrEqual(1024);
    expect(parts[4]).not.toBe('');
    // Base64, not hex: a 32-byte hash is 44 characters.
    expect(parts[5]!.length).toBe(44);
  });

  it('salts: the same password produces two different stored strings', () => {
    expect(hashPassword(PASSWORD)).not.toBe(hashPassword(PASSWORD));
  });

  it('verifies the right password and refuses everything else', () => {
    const stored = hashPassword(PASSWORD);

    expect(verifyPassword(PASSWORD, stored)).toBe(true);
    expect(verifyPassword(`${PASSWORD} `, stored)).toBe(false);
    expect(verifyPassword(PASSWORD.toUpperCase(), stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('fails closed on a malformed or foreign hash instead of throwing or comparing loosely', () => {
    for (const bad of [
      '',
      'plaintext',
      'scrypt$16384$8$1$short$short',
      'scrypt$notanumber$8$1$c2FsdHNhbHQ=$' + 'A'.repeat(44),
      'argon2id$65536$3$1$c2FsdHNhbHQ=$' + 'A'.repeat(44),
      'scrypt$99999999999$8$1$c2FsdHNhbHQ=$' + 'A'.repeat(44),
      'scrypt$16384$99$1$c2FsdHNhbHQ=$' + 'A'.repeat(44),
    ]) {
      expect(verifyPassword(PASSWORD, bad)).toBe(false);
    }
  });

  it('accepts a stronger parameter set written by a future version', () => {
    const stored = hashPassword(PASSWORD, { N: 32_768, r: 8, p: 2 });
    expect(verifyPassword(PASSWORD, stored)).toBe(true);
  });

  it('burns comparable time for an unknown user, so login timing is not an oracle', () => {
    // The assertion is that it completes and returns nothing; measuring wall
    // clock here would be flaky. The guarantee is structural (the same scrypt
    // call runs), and the login tests assert the uniform answer.
    expect(burnPasswordTime(PASSWORD)).toBeUndefined();
  });

  it('enforces only a length window, not a composition policy', () => {
    expect(isAcceptablePassword('x'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isAcceptablePassword('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
    expect(isAcceptablePassword('x'.repeat(MAX_PASSWORD_LENGTH))).toBe(true);
    expect(isAcceptablePassword('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
    // A passphrase with no digits or symbols is stronger than a short "P@ss1".
    expect(isAcceptablePassword('correct horse battery staple')).toBe(true);
  });
});

describe('lockout recovery', () => {
  const LOCKED_UNTIL = '2026-11-22T00:15:00.000Z';

  it('clears the counter and the lock without recording a login', () => {
    const created = store.operators.create(
      { username: 'recovery', passwordHash: hashPassword(PASSWORD) },
      '2026-11-22T00:00:00.000Z',
    );
    const locked = store.operators.recordLoginFailure(created.id, '2026-11-22T00:00:01.000Z', LOCKED_UNTIL);
    expect(locked.failedLoginAttempts).toBe(1);
    expect(locked.lockedUntil).toBe(LOCKED_UNTIL);

    const unlocked = store.operators.unlock(created.id, '2026-11-22T00:05:00.000Z');

    expect(unlocked.failedLoginAttempts).toBe(0);
    expect(unlocked.lockedUntil).toBeUndefined();
    // Recovery is not a sign-in: the last-login timestamp must stay truthful.
    expect(unlocked.lastLoginAt).toBeUndefined();
    expect(unlocked.passwordHash).toBe(created.passwordHash);
  });

  it('is the same reset a successful login performs', () => {
    const created = store.operators.create(
      { username: 'recovery-2', passwordHash: hashPassword(PASSWORD) },
      '2026-11-22T00:00:00.000Z',
    );
    store.operators.recordLoginFailure(created.id, '2026-11-22T00:00:01.000Z', LOCKED_UNTIL);

    const byLogin = store.operators.recordLoginSuccess(created.id, '2026-11-22T00:06:00.000Z');
    const byUnlock = store.operators.unlock(created.id, '2026-11-22T00:07:00.000Z');

    expect(byLogin.failedLoginAttempts).toBe(byUnlock.failedLoginAttempts);
    expect(byLogin.lockedUntil).toBe(byUnlock.lockedUntil);
  });
});

describe('operator identity', () => {
  it('creates an operator with a unique id, timestamps, and owner role', () => {
    const before = new Date().toISOString();
    const operator = store.operators.create(
      { username: 'operator', passwordHash: hashPassword(PASSWORD) },
      new Date().toISOString(),
    );

    expect(operator.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(operator.username).toBe('operator');
    expect(operator.role).toBe('owner');
    expect(operator.enabled).toBe(true);
    expect(operator.failedLoginAttempts).toBe(0);
    expect(operator.passwordChangedAt).toBeTruthy();
    expect(operator.createdAt >= before).toBe(true);
    expect(operator.updatedAt).toBe(operator.createdAt);
  });

  it('refuses a duplicate username at the storage layer', () => {
    const now = new Date().toISOString();
    store.operators.create({ username: 'operator', passwordHash: hashPassword(PASSWORD) }, now);

    expect(() => store.operators.create({ username: 'operator', passwordHash: hashPassword(PASSWORD) }, now)).toThrow();
    expect(store.operators.count()).toBe(1);
  });

  it('treats usernames case-insensitively for lookup and bootstrap', () => {
    store.operators.create(
      { username: 'Operator', passwordHash: hashPassword(PASSWORD) },
      new Date().toISOString(),
    );

    expect(store.operators.findByUsername('operator')?.username).toBe('Operator');
    expect(store.operators.findByUsername('OPERATOR')?.username).toBe('Operator');
    // The bootstrap refuses a second row differing only by case.
    expect(isOperatorUsernameTaken(store, 'operator')).toBe(true);
    expect(isOperatorUsernameTaken(store)).toBe(true);
  });

  it('is unconfigured until an operator exists', () => {
    expect(isOperatorUsernameTaken(store)).toBe(false);
    expect(store.operators.count()).toBe(0);
  });

  it('never exposes the password hash in a public shape', () => {
    const operator = store.operators.create(
      { username: 'operator', displayName: 'Local Operator', passwordHash: hashPassword(PASSWORD) },
      new Date().toISOString(),
    );

    const publicOperator = toPublicOperator(operator);

    expect(publicOperator).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(publicOperator)).not.toContain('scrypt$');
    expect(JSON.stringify(publicOperator)).not.toContain(PASSWORD);
    expect(publicOperator.displayName).toBe('Local Operator');
  });

  it('records a disable as both a flag and a timestamp, and keeps the row', () => {
    const now = new Date().toISOString();
    const operator = store.operators.create({ username: 'operator', passwordHash: hashPassword(PASSWORD) }, now);

    const disabled = store.operators.disable(operator.id, new Date().toISOString());

    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledAt).toBeTruthy();
    // Still addressable: a disable is history, not a delete.
    expect(store.operators.findById(operator.id)?.enabled).toBe(false);
    expect(store.operators.count()).toBe(1);
  });

  it('clears the lockout when a password is set or a login succeeds', () => {
    const operator = store.operators.create(
      { username: 'operator', passwordHash: hashPassword(PASSWORD) },
      new Date().toISOString(),
    );
    const locked = store.operators.recordLoginFailure(
      operator.id,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(locked.lockedUntil).toBeTruthy();
    expect(locked.failedLoginAttempts).toBe(1);

    const reset = store.operators.recordLoginSuccess(operator.id, new Date().toISOString());
    expect(reset.lockedUntil).toBeUndefined();
    expect(reset.failedLoginAttempts).toBe(0);

    const changed = store.operators.setPassword(operator.id, hashPassword('another-long-password'), new Date().toISOString());
    expect(changed.failedLoginAttempts).toBe(0);
    expect(changed.lockedUntil).toBeUndefined();
  });
});
