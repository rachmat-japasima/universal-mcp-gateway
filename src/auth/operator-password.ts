import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { PASSWORD_HASH_SCHEME } from '../domain/operator.js';

/**
 * Operator password hashing.
 *
 * `scrypt` from `node:crypto`: memory-hard, so a GPU cannot test guesses at
 * scale the way it can against a bare SHA-256. Argon2id is marginally better but
 * is not in the standard library, and this module is the only reason a native
 * dependency would exist.
 *
 * The stored string carries its own parameters:
 *
 *   scrypt$16384$8$1$<salt-b64>$<hash-b64>
 *
 * That is the difference between a cost increase being a config change and it
 * being a lockout: verification reads the parameters from the row, so old
 * hashes keep working while new ones are stronger. A hash with an unknown scheme
 * or malformed parameters fails closed rather than being compared loosely.
 */

/** 2^14 = 16384. ~16 MB per verification at r=8 — deliberately slow, not unusable. */
const DEFAULT_N = 16_384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

/** 32 bytes: scrypt's own recommendation for a strong output. */
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

/**
 * scrypt needs `128 * N * r` bytes. Node refuses above `maxmem` (32 MB by
 * default), so the limit is stated here rather than inherited — a future cost
 * bump should fail loudly in one place, not with an opaque OpenSSL error.
 */
const MAX_MEM = 64 * 1024 * 1024;

/** Bounds on the minimum accepted password length. Not a password policy engine. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function encodeHash(params: ScryptParams, salt: Buffer, hash: Buffer): string {
  return [
    PASSWORD_HASH_SCHEME,
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

function parseHash(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6) return undefined;
  if (parts[0] !== PASSWORD_HASH_SCHEME) return undefined;

  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);

  // Bounds, not just type checks: N=0 would throw, and N=2^30 would hang the
  // process on a row an attacker could plant.
  if (!Number.isInteger(N) || N < 1024 || N > 1_048_576) return undefined;
  if (!Number.isInteger(r) || r < 1 || r > 32) return undefined;
  if (!Number.isInteger(p) || p < 1 || p > 16) return undefined;

  try {
    const salt = Buffer.from(rawSalt ?? '', 'base64');
    const hash = Buffer.from(rawHash ?? '', 'base64');
    if (salt.length < 8 || hash.length !== KEY_LENGTH) return undefined;
    return { params: { N, r, p }, salt, hash };
  } catch {
    return undefined;
  }
}

/**
 * Hashes a password for storage. A fresh salt per call, so the same password
 * never produces the same row.
 */
export function hashPassword(password: string, params: ScryptParams = { N: DEFAULT_N, r: DEFAULT_R, p: DEFAULT_P }): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM,
  });

  return encodeHash(params, salt, hash);
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns `false` for a malformed row rather than throwing: a corrupt hash is a
 * refused login, not a 500 that distinguishes this account from any other.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseHash(stored);
  if (parsed === undefined) return false;

  try {
    const candidate = scryptSync(password, parsed.salt, KEY_LENGTH, {
      N: parsed.params.N,
      r: parsed.params.r,
      p: parsed.params.p,
      maxmem: MAX_MEM,
    });

    return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * A fixed hash verified when no operator matched.
 *
 * Without this, an unknown username returns in microseconds while a known one
 * takes ~50 ms, which is a username oracle. Running the same work on a dummy
 * value makes the two paths cost the same. The password is irrelevant — the
 * result is discarded.
 */
const DUMMY_HASH = hashPassword('dummy-password-for-timing-equalisation');

export function burnPasswordTime(password: string): void {
  verifyPassword(password, DUMMY_HASH);
}

/** Length only. Composition rules are the operator's business, not a gate. */
export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}
