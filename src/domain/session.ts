import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Gateway client session contract (Phase 7).
 *
 * Phase 1 serving is stateless per HTTP exchange, so nothing here is written
 * yet: no session is created, and no `mcp-session-id` is trusted. This module
 * defines the shape a session will take once tracking is introduced, so the
 * schema and its constraints are settled before the engine depends on them.
 */

export const SESSION_STATUSES = ['active', 'expired', 'revoked'] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionMetadataSchema = z
  .object({
    clientType: z.string().trim().max(64).optional(),
    clientVersion: z.string().trim().max(64).optional(),
    protocolVersion: z.string().trim().max(32).optional(),
    remoteAddress: z.string().trim().max(64).optional(),
  })
  .strict();

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export const sessionSchema = z
  .object({
    id: idSchema,
    agentId: idSchema,
    status: sessionStatusSchema,
    createdAt: timestampSchema,
    lastActivityAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
    metadata: sessionMetadataSchema.optional(),
  })
  .strict();

export type Session = z.infer<typeof sessionSchema>;

/** Status is derived from the timestamps so it can never disagree with them. */
export function sessionStatus(session: Session, now: Date = new Date()): SessionStatus {
  if (session.revokedAt !== undefined) return 'revoked';
  if (session.expiresAt !== undefined && Date.parse(session.expiresAt) <= now.getTime()) return 'expired';
  return 'active';
}
