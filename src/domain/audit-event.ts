import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Administrative and security-sensitive history. Answers "who changed what?".
 *
 * Append-only: the repository interface exposes no update or delete. Any future
 * retention job must be bounded, observable, and separately authorised.
 * Metadata must never contain secrets or full credentials.
 */

export const AUDIT_ACTIONS = [
  'backend.created',
  'backend.updated',
  'backend.deleted',
  'backend.enabled',
  'backend.disabled',
  'backend.validation_failed',
  'agent.created',
  'agent.updated',
  'agent.deleted',
  'credential.created',
  'credential.rotated',
  'credential.revoked',
  'policy.created',
  'policy.updated',
  'policy.deleted',
  'policy.assigned',
  'policy.unassigned',
  'session.revoked',
  'settings.updated',
  'auth.failed',
  'access.denied',
] as const;

export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const AUDIT_ACTORS = ['admin', 'agent', 'system'] as const;
export const auditActorTypeSchema = z.enum(AUDIT_ACTORS);
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;

export const AUDIT_RESULTS = ['success', 'failure', 'denied'] as const;
export const auditResultSchema = z.enum(AUDIT_RESULTS);
export type AuditResult = z.infer<typeof auditResultSchema>;

/** Flat, bounded, non-secret context. Not free-form nested JSON. */
export const auditMetadataSchema = z
  .record(z.string().trim().min(1).max(64), z.union([z.string().max(500), z.number(), z.boolean()]))
  .refine((metadata) => Object.keys(metadata).length <= 20, {
    message: 'Audit metadata may have at most 20 entries',
  });

export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

export const auditEventSchema = z
  .object({
    id: idSchema,
    actorType: auditActorTypeSchema,
    actorId: z.string().trim().max(200).optional(),
    action: auditActionSchema,
    targetType: z.enum(['backend', 'agent', 'credential', 'policy', 'session', 'settings']).optional(),
    targetId: z.string().trim().max(200).optional(),
    result: auditResultSchema,
    requestId: z.string().trim().max(64).optional(),
    metadata: auditMetadataSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;
