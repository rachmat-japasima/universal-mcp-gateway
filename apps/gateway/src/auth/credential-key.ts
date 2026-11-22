import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Agent credential minting and verification.
 *
 * Threat model: the raw token is a bearer credential, so the only thing that is
 * ever stored is a keyed digest. Two properties follow from that choice:
 *
 *  * The digest is HMAC-SHA-256 with a server-held secret, not a bare SHA-256.
 *    A token carries 256 bits of entropy, so an unkeyed digest would not be
 *    brute-forceable either — but a keyed digest also stops a stolen database
 *    from being used to confirm a guessed token, and it makes the key id part of
 *    the contract so a key can be rotated.
 *  * Verification compares digests with `timingSafeEqual`, never `===`. The
 *    indexed lookup is by digest, so an attacker cannot learn anything from
 *    response timing about how many characters of a candidate were right.
 *
 * The secret never lives in `Config`: it must not be reachable from
 * `redactConfig`, from an API response, or from a log line. See
 * `docs/SECURITY.md` for generation, persistence, and rotation.
 */

/** Every issued token starts with this, so an operator can recognise one on sight. */
export const TOKEN_PREFIX = 'umg_live_';

/** Raw randomness. 32 bytes → 256 bits, base64url-encoded to 43 characters. */
const TOKEN_ENTROPY_BYTES = 32;

/** Characters kept for display. Long enough to tell two tokens apart, short enough to be useless. */
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 8;

/** Minimum secret length. Shorter secrets weaken the key, so they are refused rather than accepted. */
export const MIN_SECRET_LENGTH = 32;

export interface CredentialKey {
  /** Which key produced a digest. Stored per credential so rotation can keep both verifiable. */
  id: string;
  secret: string;
}

export interface IssuedToken {
  /** The only time this value exists. Never persisted, never logged. */
  token: string;
  /** Non-secret display prefix, safe to store and list. */
  tokenPrefix: string;
  /** Keyed digest, safe to store. */
  tokenHash: string;
  hashKeyId: string;
}

export class CredentialSecretError extends Error {
  readonly code = 'CONFIGURATION_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'CredentialSecretError';
  }
}

/**
 * Mints a token and its digest.
 *
 * The raw token is returned to the caller exactly once and is not held anywhere
 * else. Callers must send it in the creation response and then forget it.
 */
export function issueToken(key: CredentialKey): IssuedToken {
  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')}`;

  return {
    token,
    tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    tokenHash: digest(token, key),
    hashKeyId: key.id,
  };
}

/** Keyed digest of a presented token in the stored encoding (lowercase hex). */
export function digest(token: string, key: CredentialKey): string {
  return createHmac('sha256', key.secret).update(token, 'utf8').digest('hex');
}

/**
 * Timing-safe comparison of a presented token against a stored digest.
 *
 * The stored digest is looked up by the presented one (an index hit), so this
 * second comparison is a defence against a hash collision or a bug in the
 * lookup, not the primary defence.
 */
export function digestMatches(presentedDigest: string, storedDigest: string): boolean {
  const a = Buffer.from(presentedDigest, 'hex');
  const b = Buffer.from(storedDigest, 'hex');

  if (a.length !== b.length || a.length !== 32) return false;
  return timingSafeEqual(a, b);
}

/**
 * Structural check before any lookup.
 *
 * A token that cannot be one of ours is rejected without touching the database,
 * which keeps garbage traffic off the credential index and makes the failure
 * path identical for every kind of bad input.
 */
export function isWellFormedToken(value: string): boolean {
  if (value.length !== TOKEN_PREFIX.length + 43) return false;
  if (!value.startsWith(TOKEN_PREFIX)) return false;
  return /^[A-Za-z0-9_-]+$/.test(value.slice(TOKEN_PREFIX.length));
}

/**
 * Loads the hashing key from the environment.
 *
 * Deliberately separate from `loadConfig()`: this value must never be part of
 * the config object that is logged or served. Returns `undefined` when the
 * secret is missing or unusable; the caller decides what that means (fail
 * closed in development, refuse to start in production).
 */
export function loadCredentialKey(env: NodeJS.ProcessEnv = process.env): CredentialKey | undefined {
  const secret = env['CREDENTIAL_HASH_SECRET'];

  if (secret === undefined || secret.length < MIN_SECRET_LENGTH) return undefined;

  const id = env['CREDENTIAL_HASH_KEY_ID'] ?? 'v1';
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(id)) return undefined;

  return { id, secret };
}

/**
 * The key registry. One active key issues; any key in the map can verify, so a
 * rotation can keep old credentials working until they are reissued.
 *
 * Phase 6 ships a single key. The shape is the rotation seam, not an
 * implementation of rotation: a future `CREDENTIAL_HASH_KEYS` list only has to
 * populate `keys`.
 */
export class CredentialKeys {
  constructor(
    private readonly active: CredentialKey | undefined,
    private readonly keys: ReadonlyMap<string, CredentialKey> = new Map(
      active === undefined ? [] : [[active.id, active]],
    ),
  ) {}

  /** Undefined when no secret is configured: callers must fail closed, never generate one. */
  get issuing(): CredentialKey | undefined {
    return this.active;
  }

  /** The key that produced a digest, if this process still knows it. */
  verifier(hashKeyId: string | undefined): CredentialKey | undefined {
    if (hashKeyId === undefined) {
      // A credential issued before key ids existed can never be verified: it has
      // no key to verify against and guessing would be a silent downgrade.
      return undefined;
    }
    return this.keys.get(hashKeyId);
  }
}

/**
 * The startup policy for the hashing key, kept here so it is testable without
 * spawning a process.
 *
 * Production throws: starting with authentication permanently unavailable would
 * serve 401 to every MCP client while the liveness probe stayed green — a
 * silently dead gateway, which is worse than refusing to boot. Development
 * returns keys that issue nothing, so health checks and the management API stay
 * usable while the secret is provisioned; every MCP request then fails closed.
 *
 * An ephemeral secret is deliberately not generated: it would verify tokens
 * issued in this process and silently invalidate them on restart.
 */
export function resolveCredentialKeys(
  environment: string,
  env: NodeJS.ProcessEnv = process.env,
): CredentialKeys {
  const key = loadCredentialKey(env);

  if (key === undefined && environment === 'production') {
    throw new CredentialSecretError(
      `CREDENTIAL_HASH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters in production.`,
    );
  }

  return new CredentialKeys(key);
}
