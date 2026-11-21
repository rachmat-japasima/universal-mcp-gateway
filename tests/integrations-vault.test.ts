import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AppError } from '../src/shared/errors.js';
import { ENVELOPE_VERSION, EnvelopeVault, keyIdFor, loadVaultKeys } from '../src/integrations/vault.js';

/**
 * The credential vault (ADR-051), isolated from every other layer: no store, no
 * service — just envelope math. What these tests prove, in order:
 *
 *  * a value survives seal→unseal and never appears in the stored envelope;
 *  * every record is independently keyed (two envelopes of one value differ);
 *  * any modification of ciphertext, tag, or wrapped key fails the tag check;
 *  * a missing key fails closed — on use, not on construction — and there is
 *    no plaintext or generated-key fallback;
 *  * rotation works through the previous-key slot and nothing else.
 */

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

const vaultA = new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_A }));
const vaultB = new EnvelopeVault(loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_B }));

describe('key loading', () => {
  it('derives a deterministic id from key material, not from a label', () => {
    const bytes = randomBytes(32);

    expect(keyIdFor(bytes)).toBe(keyIdFor(bytes));
    expect(keyIdFor(bytes)).not.toBe(keyIdFor(randomBytes(32)));
    expect(keyIdFor(bytes)).toMatch(/^[a-f0-9]{16}$/);
  });

  it('accepts a 32-byte base64 key and rejects everything else, without throwing', () => {
    expect(loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_A }).active).toBeDefined();
    // `Buffer.from` never throws on bad base64; the length check catches it.
    expect(loadVaultKeys({ INTEGRATION_MASTER_KEY: 'not!!base64??' }).active).toBeUndefined();
    expect(loadVaultKeys({ INTEGRATION_MASTER_KEY: randomBytes(16).toString('base64') }).active).toBeUndefined();
    expect(loadVaultKeys({}).active).toBeUndefined();
    expect(loadVaultKeys({ INTEGRATION_MASTER_KEY: '' }).active).toBeUndefined();
  });

  it('loads an optional previous key independently of the active one', () => {
    const keys = loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_A, INTEGRATION_MASTER_KEY_PREVIOUS: KEY_B });

    expect(keys.active?.id).not.toBe(keys.previous?.id);
    expect(loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_A }).previous).toBeUndefined();
  });
});

describe('seal', () => {
  it('round-trips a value and stores no plaintext anywhere in the envelope', () => {
    const secret = 'sk-live-do-not-ship-me';
    const stored = vaultA.seal(secret);

    expect(vaultA.unseal(stored)).toBe(secret);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(Buffer.from(secret).toString('base64'));

    const envelope = JSON.parse(stored) as Record<string, string>;
    expect(Object.keys(envelope).sort()).toEqual([
      'ct',
      'keyId',
      'nonce',
      'tag',
      'v',
      'wrapNonce',
      'wrapTag',
      'wrappedDek',
    ]);
    expect(envelope['v']).toBe(ENVELOPE_VERSION);
    expect(envelope['keyId']).toBe(vaultA.activeKeyId);
  });

  it('keys every record independently: one value, two seals, two envelopes', () => {
    const first = vaultA.seal('same-value');
    const second = vaultA.seal('same-value');

    expect(first).not.toBe(second);
    expect(vaultA.unseal(first)).toBe('same-value');
    expect(vaultA.unseal(second)).toBe('same-value');
  });

  it('names the active key in every envelope', () => {
    const envelope = JSON.parse(vaultB.seal('x')) as { keyId: string };

    expect(envelope.keyId).toBe(vaultB.activeKeyId);
    expect(envelope.keyId).not.toBe(vaultA.activeKeyId);
  });
});

describe('unseal', () => {
  it('rejects any tampering with the payload', () => {
    const stored = JSON.parse(vaultA.seal('target')) as Record<string, string>;

    const flip = (value: string): string => {
      const bytes = Buffer.from(value, 'base64');
      bytes[0] ^= 0xff;
      return bytes.toString('base64');
    };

    for (const field of ['ct', 'tag', 'wrappedDek', 'wrapTag', 'nonce']) {
      const tampered = JSON.stringify({ ...stored, [field]: flip(stored[field]!) });
      expect(() => vaultA.unseal(tampered)).toThrow(AppError);
    }
  });

  it('rejects a malformed envelope as a data-integrity error, not a key problem', () => {
    expect(() => vaultA.unseal('not json')).toThrow(AppError);
    expect(() => vaultA.unseal(JSON.stringify({ v: 99, keyId: 'x'.repeat(16) }))).toThrow(AppError);

    const envelope = JSON.parse(vaultA.seal('x')) as Record<string, unknown>;
    delete envelope['tag'];
    expect(() => vaultA.unseal(JSON.stringify(envelope))).toThrow(AppError);
  });

  it('refuses an envelope it holds no key for, and says which key it wants', () => {
    const sealedByA = vaultA.seal('value');

    const thrown = (() => {
      try {
        vaultB.unseal(sealedByA);
        expect.unreachable('unseal must fail closed');
      } catch (error) {
        return error as AppError;
      }
    })();

    expect(thrown.code).toBe('CONFIGURATION_ERROR');
    expect(thrown.details).toMatchObject({ envelopeKeyId: vaultA.activeKeyId, activeKeyId: vaultB.activeKeyId });
  });
});

describe('rotation', () => {
  it('unwraps an old envelope through the previous-key slot only', () => {
    const sealedUnderA = vaultA.seal('rotate-me');

    const rotated = new EnvelopeVault({
      active: loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_B }).active,
      previous: loadVaultKeys({ INTEGRATION_MASTER_KEY: KEY_A }).active,
    });
    expect(rotated.unseal(sealedUnderA)).toBe('rotate-me');
    expect(rotated.seal('new').includes(`"keyId":"${rotated.activeKeyId}"`)).toBe(true);

    // Without the previous slot the same envelope is closed, which is what
    // makes "remove PREVIOUS after migration" an operator decision.
    expect(() => vaultB.unseal(sealedUnderA)).toThrow(AppError);
  });
});

describe('fail-closed without a key', () => {
  const unconfigured = new EnvelopeVault(loadVaultKeys({}));

  it('constructs (lazy) but reports itself unconfigured', () => {
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.activeKeyId).toBeUndefined();
  });

  it('refuses to seal — no plaintext fallback, no generated key', () => {
    try {
      unconfigured.seal('anything');
      expect.unreachable('seal must fail closed');
    } catch (error) {
      expect((error as AppError).code).toBe('CONFIGURATION_ERROR');
      expect((error as AppError).message).toContain('INTEGRATION_MASTER_KEY');
    }
  });

  it('refuses to unseal too, without revealing anything about the payload', () => {
    const someoneElses = vaultA.seal('value');
    expect(() => unconfigured.unseal(someoneElses)).toThrow(AppError);
  });

  it('recognizes envelope structure without opening it', () => {
    expect(unconfigured.isEnvelope(vaultA.seal('value'))).toBe(true);
    expect(unconfigured.isEnvelope('{"v":1}')).toBe(false);
    expect(unconfigured.isEnvelope('not json')).toBe(false);
  });
});
