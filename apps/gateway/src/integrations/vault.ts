import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { AppError } from '../shared/errors.js';

/**
 * Envelope encryption for integration credentials (ADR-051).
 *
 * Threat model: the database file is the asset most likely to be copied,
 * backed up, or exfiltrated. So no credential value ever touches SQLite —
 * only an envelope, and the envelope's payload key is itself encrypted:
 *
 *   * every record gets a fresh random 32-byte DEK;
 *   * the DEK is wrapped (encrypted) with the master key (KEK), which comes
 *     from the environment and never exists in the database, in `Config`,
 *     or in a log line;
 *   * the record is sealed with the DEK via AES-256-GCM: a random nonce, an
 *     authentication tag, and an AAD that binds the envelope format version
 *     and the key id, so an envelope cannot be replayed under a different
 *     key or format without failing the tag check.
 *
 * Key ids are derived from the key material itself (a truncated digest), not
 * from an operator-supplied label: two operators naming different keys "v1"
 * must never produce the same id, and rotation must be able to *tell* which
 * key sealed a record without trusting a hand-written label.
 *
 * Fail-closed on use, not on startup: integrations are optional, so a gateway
 * without a master key still boots and serves MCP traffic; the first attempt
 * to seal or unseal throws. There is deliberately no plaintext fallback and
 * no generated key — either would turn "key missing" into silently
 * unreadable or silently unprotected credentials.
 */

/** Envelope format version. Bump on any structural change to the fields below. */
export const ENVELOPE_VERSION = 1;

const ENVELOPE_SCHEMA = z
  .object({
    v: z.literal(ENVELOPE_VERSION),
    /** Digest-derived id of the KEK that wrapped the DEK. */
    keyId: z.string().regex(/^[a-f0-9]{16}$/),
    /** KEK-wrapped DEK, base64. */
    wrappedDek: z.base64(),
    /** Nonce used to wrap the DEK, base64 (12 bytes). */
    wrapNonce: z.base64(),
    /** GCM authentication tag over the wrapped DEK, base64 (16 bytes). */
    wrapTag: z.base64(),
    /** Nonce used to seal the payload, base64 (12 bytes). */
    nonce: z.base64(),
    /** Ciphertext, base64. */
    ct: z.base64(),
    /** GCM authentication tag over the payload, base64 (16 bytes). */
    tag: z.base64(),
  })
  .strict();

export type Envelope = z.infer<typeof ENVELOPE_SCHEMA>;

/** The envelope as it is stored: one JSON string per credential row. */
export type StoredEnvelope = string;

/** A usable master key: raw bytes plus its digest-derived id. */
interface MasterKey {
  id: string;
  bytes: Buffer;
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
/** AAD prefix: binds the format version into every authenticated operation. */
const AAD_PREFIX = `umg-vault-v${ENVELOPE_VERSION}`;

/** Deterministic key id: how the vault recognizes its own key without labels. */
export function keyIdFor(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** Which environment variable a unusable key came from — names only, never values. */
export type VaultKeyVariable = 'INTEGRATION_MASTER_KEY' | 'INTEGRATION_MASTER_KEY_PREVIOUS';

/**
 * Parses a base64 master key from the environment. `undefined` when absent;
 * `invalid` distinguishes a present-but-unusable value from an unset one, so
 * startup can warn about a misconfiguration instead of waiting for the first
 * seal/unseal to discover it.
 */
function parseMasterKey(value: string | undefined): { key: MasterKey | undefined; invalid: boolean } {
  if (value === undefined || value === '') return { key: undefined, invalid: false };
  const bytes = Buffer.from(value, 'base64');
  // `Buffer.from` never throws on bad base64; the length check catches it.
  if (bytes.length !== KEY_BYTES) return { key: undefined, invalid: true };
  return { key: { id: keyIdFor(bytes), bytes }, invalid: false };
}

/**
 * Loads vault keys from the environment (ADR-051).
 *
 * `INTEGRATION_MASTER_KEY` is the active key; `INTEGRATION_MASTER_KEY_PREVIOUS`
 * is optional and exists only so records sealed before a rotation can be
 * unwrapped while they are re-sealed under the new key. Separate from
 * `loadConfig()` for the same reason `CREDENTIAL_HASH_SECRET` is: this value
 * must never be reachable from `redactConfig`, an API response, or a log line.
 * `invalid` names variables that were set but unusable — variable names only.
 */
export function loadVaultKeys(env: NodeJS.ProcessEnv = process.env): {
  active: MasterKey | undefined;
  previous: MasterKey | undefined;
  invalid: ReadonlyArray<VaultKeyVariable>;
} {
  const active = parseMasterKey(env['INTEGRATION_MASTER_KEY']);
  const previous = parseMasterKey(env['INTEGRATION_MASTER_KEY_PREVIOUS']);
  return {
    active: active.key,
    previous: previous.key,
    invalid: [
      ...(active.invalid ? (['INTEGRATION_MASTER_KEY'] as const) : []),
      ...(previous.invalid ? (['INTEGRATION_MASTER_KEY_PREVIOUS'] as const) : []),
    ],
  };
}

export class EnvelopeVault {
  private readonly active: MasterKey | undefined;
  private readonly previous: MasterKey | undefined;

  constructor(keys: { active?: MasterKey; previous?: MasterKey } = loadVaultKeys()) {
    this.active = keys.active;
    this.previous = keys.previous;
  }

  /** True when a seal/unseal would work. Exposed for readiness checks, not for gating writes. */
  get configured(): boolean {
    return this.active !== undefined;
  }

  /** The active key's id, or `undefined` when unconfigured. */
  get activeKeyId(): string | undefined {
    return this.active?.id;
  }

  /**
   * Seals one credential value into a stored envelope.
   *
   * Throws (fails closed) when no key is configured — the caller surfaces
   * a configuration error; there is no plaintext or generated-key path.
   */
  seal(plaintext: string): StoredEnvelope {
    const key = this.requireKey();

    // Per-record DEK: one compromised envelope never widens to another.
    const dek = randomBytes(KEY_BYTES);
    const wrapNonce = randomBytes(NONCE_BYTES);
    const wrapAad = Buffer.from(`${AAD_PREFIX}:${key.id}`, 'utf8');

    const wrapper = createCipheriv('aes-256-gcm', key.bytes, wrapNonce);
    wrapper.setAAD(wrapAad);
    const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()]);
    const wrapTag = wrapper.getAuthTag();

    const nonce = randomBytes(NONCE_BYTES);
    const sealAad = Buffer.from(`${AAD_PREFIX}:${key.id}`, 'utf8');

    const cipher = createCipheriv('aes-256-gcm', dek, nonce);
    cipher.setAAD(sealAad);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: Envelope = {
      v: ENVELOPE_VERSION,
      keyId: key.id,
      wrappedDek: wrappedDek.toString('base64'),
      wrapNonce: wrapNonce.toString('base64'),
      wrapTag: wrapTag.toString('base64'),
      nonce: nonce.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
    };

    return JSON.stringify(envelope);
  }

  /**
   * Opens a stored envelope. Three distinct failures, all closed:
   *
   *  * no key configured — configuration error;
   *  * envelope names a key this process does not hold — a record sealed
   *    under an older key during rotation, an operator action away from
   *    working again;
   *  * tag verification fails — the envelope is corrupt or was modified;
   *    the payload is never returned, and the error message names no secret.
   */
  unseal(stored: StoredEnvelope): string {
    const parsed = (() => {
      try {
        return ENVELOPE_SCHEMA.safeParse(JSON.parse(stored));
      } catch {
        // Malformed JSON is a data-integrity failure, and the caller must see
        // it as one rather than as a raw SyntaxError.
        return { success: false as const };
      }
    })();
    if (!parsed.success) {
      throw new AppError('INTERNAL_ERROR', 'The stored credential envelope is malformed.');
    }

    const key = this.keyFor(parsed.data.keyId);
    const wrapNonce = Buffer.from(parsed.data.wrapNonce, 'base64');
    const wrappedDek = Buffer.from(parsed.data.wrappedDek, 'base64');

    const unwrapper = createDecipheriv('aes-256-gcm', key.bytes, wrapNonce);
    unwrapper.setAAD(Buffer.from(`${AAD_PREFIX}:${parsed.data.keyId}`, 'utf8'));
    unwrapper.setAuthTag(Buffer.from(parsed.data.wrapTag, 'base64'));

    let dek: Buffer;
    try {
      dek = Buffer.concat([unwrapper.update(wrappedDek), unwrapper.final()]);
    } catch {
      throw new AppError('INTERNAL_ERROR', 'The stored credential envelope could not be verified.');
    }

    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(parsed.data.nonce, 'base64'));
    decipher.setAAD(Buffer.from(`${AAD_PREFIX}:${parsed.data.keyId}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(parsed.data.tag, 'base64'));

    try {
      return Buffer.concat([decipher.update(Buffer.from(parsed.data.ct, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new AppError('INTERNAL_ERROR', 'The stored credential envelope could not be verified.');
    }
  }

  /** Structural check without opening: is the stored string a well-formed envelope? */
  isEnvelope(stored: string): boolean {
    try {
      return ENVELOPE_SCHEMA.safeParse(JSON.parse(stored)).success;
    } catch {
      return false;
    }
  }

  private requireKey(): MasterKey {
    if (this.active === undefined) {
      throw new AppError('CONFIGURATION_ERROR', 'INTEGRATION_MASTER_KEY is not configured; credentials cannot be stored.', {
        details: { hint: 'Set INTEGRATION_MASTER_KEY to 32 bytes of base64.' },
      });
    }
    return this.active;
  }

  /** Active key first, then the rotation-era previous key. A label mismatch never falls back. */
  private keyFor(keyId: string): MasterKey {
    for (const key of [this.active, this.previous]) {
      if (key !== undefined && key.id === keyId) return key;
    }
    throw new AppError(
      'CONFIGURATION_ERROR',
      'The credential was sealed under a master key this gateway does not hold.',
      { details: { envelopeKeyId: keyId, activeKeyId: this.active?.id } },
    );
  }
}
