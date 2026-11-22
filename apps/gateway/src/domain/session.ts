import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Persistent MCP session contract (Phase 7).
 *
 * Two identifiers, deliberately distinct:
 *
 *   * `id` — the gateway's internal session id. Never sent to an MCP client; it
 *     is the handle the management API and the audit trail use.
 *   * `mcpSessionId` — the protocol session id the SDK issued during
 *     initialization and the client echoes in `mcp-session-id`. It is a routing
 *     handle, not a credential: on its own it proves nothing, because every
 *     request is authenticated and the session's owner must match.
 *
 * Identity (`agentId`, `credentialId`, `mcpSessionId`) is immutable. The DB
 * enforces that with a trigger (migration 0005), so a future code path cannot
 * reassign a session by accident.
 */

export const SESSION_STATUSES = ['active', 'expired', 'terminated', 'invalidated'] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** Statuses that have finished; none of them can authorize a request. */
export const TERMINAL_SESSION_STATUSES = ['expired', 'terminated', 'invalidated'] as const;

export const SESSION_TERMINATION_REASONS = [
  'operator_terminated',
  'client_deleted',
  'idle_timeout',
  'max_lifetime',
  'agent_disabled',
  'agent_deleted',
  'credential_revoked',
  'credential_rotated',
  'gateway_shutdown',
  'transport_lost',
  'cleanup',
] as const;
export const sessionTerminationReasonSchema = z.enum(SESSION_TERMINATION_REASONS);
export type SessionTerminationReason = z.infer<typeof sessionTerminationReasonSchema>;

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
    /** Protocol session id. Absent only for a row created before this phase. */
    mcpSessionId: z.string().trim().min(1).max(200).optional(),
    agentId: idSchema,
    /** The credential that authenticated initialization. Never a token. */
    credentialId: idSchema.optional(),
    status: sessionStatusSchema,
    createdAt: timestampSchema,
    lastActivityAt: timestampSchema,
    /** Hard cap: `createdAt` + maximum lifetime. */
    expiresAt: timestampSchema.optional(),
    terminatedAt: timestampSchema.optional(),
    terminationReason: sessionTerminationReasonSchema.optional(),
    metadata: sessionMetadataSchema.optional(),
  })
  .strict();

export type Session = z.infer<typeof sessionSchema>;

/**
 * Effective status, derived so it can never disagree with the timestamps.
 *
 * Request handling calls this rather than trusting `status` alone: an expired
 * session is refused even if the cleanup job has not run yet, and a terminated
 * session can never be reported as active.
 */
export function sessionStatus(
  session: Session,
  now: Date = new Date(),
  idleTimeoutMs?: number,
): SessionStatus {
  if (session.status !== 'active') return session.status;
  if (session.expiresAt !== undefined && Date.parse(session.expiresAt) <= now.getTime()) return 'expired';
  // Optional because the idle timeout is deployment configuration, not session
  // state: a caller that does not know it can still get the stored-vs-cap answer.
  if (idleTimeoutMs !== undefined && idleDeadline(session, idleTimeoutMs).getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'active';
}

/** True when the session may authorize a request at `now`. */
export function isSessionUsable(session: Session, now: Date = new Date(), idleTimeoutMs?: number): boolean {
  return sessionStatus(session, now, idleTimeoutMs) === 'active';
}

/** Idle deadline, derived from the last activity. Not stored: it moves. */
export function idleDeadline(session: Session, idleTimeoutMs: number): Date {
  return new Date(Date.parse(session.lastActivityAt) + idleTimeoutMs);
}

/** Deterministic expiry: whichever comes first, idle deadline or hard cap. */
export function sessionDeadline(
  session: Session,
  idleTimeoutMs: number,
  now: Date = new Date(),
): { at: Date; reason: 'idle_timeout' | 'max_lifetime' } | undefined {
  const idle = idleDeadline(session, idleTimeoutMs);
  if (idle.getTime() <= now.getTime()) return { at: idle, reason: 'idle_timeout' };

  if (session.expiresAt !== undefined) {
    const cap = new Date(session.expiresAt);
    if (cap.getTime() <= now.getTime()) return { at: cap, reason: 'max_lifetime' };
  }

  return undefined;
}
