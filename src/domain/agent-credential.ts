import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Agent credentials, kept out of the `Agent` entity on purpose so that listing
 * agents can never accidentally serialize a verifier.
 *
 * Only a keyed verifier digest is ever persisted. The raw token exists once, in
 * memory, at issuance time; nothing in this module can hold one.
 */

/**
 * Lowercase hex HMAC-SHA-256 of the presented token.
 *
 * A keyed digest, not a bare SHA-256: an unkeyed digest of a 256-bit random
 * token would be fine, but keying it means a leaked database alone cannot even
 * be used to confirm a guessed token, and it makes offline brute force require
 * the server-held secret as well.
 */
export const credentialHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Credential hash must be a lowercase hex HMAC-SHA-256 digest');

/** Recognisable, non-secret prefix, so an operator can tell two tokens apart. */
export const tokenPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^umg_live_[A-Za-z0-9_-]{1,20}$/);

/** Which server-held HMAC key produced the digest. Rotation keeps both verifiable. */
export const hashKeyIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/);

export const CREDENTIAL_STATUSES = ['active', 'expired', 'revoked'] as const;
export const credentialStatusSchema = z.enum(CREDENTIAL_STATUSES);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

export const createCredentialSchema = z
  .object({
    agentId: idSchema,
    credentialHash: credentialHashSchema,
    /** Display name. Stored in the `label` column (Phase 2 name). */
    label: z.string().trim().min(1).max(120).optional(),
    tokenPrefix: tokenPrefixSchema.optional(),
    hashKeyId: hashKeyIdSchema.optional(),
    expiresAt: timestampSchema.optional(),
  })
  .strict();

export const agentCredentialSchema = z
  .object({
    id: idSchema,
    agentId: idSchema,
    credentialHash: credentialHashSchema,
    label: z.string().trim().max(120).optional(),
    tokenPrefix: tokenPrefixSchema.optional(),
    hashKeyId: hashKeyIdSchema.optional(),
    createdAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    lastUsedAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
  })
  .strict();

export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;
export type AgentCredential = z.infer<typeof agentCredentialSchema>;

/**
 * Status is derived, never stored: a stored status column can disagree with
 * `revoked_at`/`expires_at` after a partial update. Revocation wins over expiry.
 */
export function credentialStatus(credential: AgentCredential, now: Date = new Date()): CredentialStatus {
  if (credential.revokedAt !== undefined) return 'revoked';
  if (credential.expiresAt !== undefined && Date.parse(credential.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}

/** Whether a credential may authenticate a request right now. */
export function isCredentialUsable(credential: AgentCredential, now: Date = new Date()): boolean {
  return credentialStatus(credential, now) === 'active';
}
