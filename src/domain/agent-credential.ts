import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Agent credentials, kept out of the `Agent` entity on purpose so that listing
 * agents can never accidentally serialize a verifier.
 *
 * Only a verifier hash is ever persisted. The raw token exists once, in memory,
 * at issuance time (a later phase); nothing in this module can hold one.
 */

/** Lowercase hex SHA-256 of the presented token. */
export const credentialHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Credential hash must be a lowercase hex SHA-256 digest');

export const CREDENTIAL_STATUSES = ['active', 'expired', 'revoked'] as const;
export const credentialStatusSchema = z.enum(CREDENTIAL_STATUSES);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

export const createCredentialSchema = z
  .object({
    agentId: idSchema,
    credentialHash: credentialHashSchema,
    label: z.string().trim().min(1).max(120).optional(),
    expiresAt: timestampSchema.optional(),
  })
  .strict();

export const agentCredentialSchema = z
  .object({
    id: idSchema,
    agentId: idSchema,
    credentialHash: credentialHashSchema,
    label: z.string().trim().max(120).optional(),
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
