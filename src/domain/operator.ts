import { z } from 'zod';

import { idSchema, timestampSchema } from './primitives.js';

/**
 * Dashboard operator identity (Phase 10.0).
 *
 * Deliberately *not* the `agents` table and not an `Agent` with a flag: an
 * operator is a human at the dashboard, an agent is a program at `/mcp`, and
 * ADR-044 requires those to stay separate boundaries. Sharing a table would make
 * "this credential can call tools" and "this session can mint credentials"
 * the same row, which is precisely the conflation the split exists to prevent.
 *
 * `passwordHash` never leaves the server: it is carried here because
 * verification happens in this process, and every public shape strips it.
 */

/** Prefix on the stored hash, so a future algorithm can coexist with this one. */
export const PASSWORD_HASH_SCHEME = 'scrypt';

/** Cookie value prefix. Not a secret — it makes a well-formed check possible. */
export const OPERATOR_TOKEN_PREFIX = 'umgo_';

/** Operator roles. Only `owner` is issued today; the column exists for later. */
export const OPERATOR_ROLES = ['owner', 'admin', 'viewer'] as const;
export const operatorRoleSchema = z.enum(OPERATOR_ROLES);
export type OperatorRole = z.infer<typeof operatorRoleSchema>;

export const operatorSchema = z
  .object({
    id: idSchema,
    username: z.string().trim().min(1).max(64),
    displayName: z.string().trim().min(1).max(120).optional(),
    role: operatorRoleSchema,
    enabled: z.boolean(),
    passwordHash: z.string().min(1),
    passwordChangedAt: timestampSchema.optional(),
    lastLoginAt: timestampSchema.optional(),
    failedLoginAttempts: z.number().int().min(0),
    /** Present while a temporary lockout is in force. */
    lockedUntil: timestampSchema.optional(),
    disabledAt: timestampSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export type Operator = z.infer<typeof operatorSchema>;

/** Everything an API or the UI may see. The hash is structurally absent. */
export interface PublicOperator {
  id: string;
  username: string;
  displayName?: string;
  role: OperatorRole;
  enabled: boolean;
  lastLoginAt?: string;
  passwordChangedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function toPublicOperator(operator: Operator): PublicOperator {
  return {
    id: operator.id,
    username: operator.username,
    ...(operator.displayName === undefined ? {} : { displayName: operator.displayName }),
    role: operator.role,
    enabled: operator.enabled,
    ...(operator.lastLoginAt === undefined ? {} : { lastLoginAt: operator.lastLoginAt }),
    ...(operator.passwordChangedAt === undefined ? {} : { passwordChangedAt: operator.passwordChangedAt }),
    createdAt: operator.createdAt,
    updatedAt: operator.updatedAt,
  };
}

/**
 * Why a session ended. Closed set, so the audit trail can be aggregated and a
 * typo cannot invent a new lifecycle state.
 */
export const OPERATOR_SESSION_REVOCATION_REASONS = [
  'logout',
  'operator_disabled',
  'operator_password_changed',
  'operator_deleted',
  'cleanup',
  'gateway_shutdown',
] as const;

export const operatorSessionRevocationReasonSchema = z.enum(OPERATOR_SESSION_REVOCATION_REASONS);
export type OperatorSessionRevocationReason = z.infer<typeof operatorSessionRevocationReasonSchema>;

export const operatorSessionSchema = z
  .object({
    id: idSchema,
    operatorId: idSchema,
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    hashKeyId: z.string().min(1).max(32),
    createdAt: timestampSchema,
    lastSeenAt: timestampSchema,
    /** Absolute ceiling. Idle timeout is derived, never stored. */
    expiresAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
    revocationReason: operatorSessionRevocationReasonSchema.optional(),
    userAgent: z.string().max(300).optional(),
    ipAddress: z.string().max(64).optional(),
  })
  .strict();

export type OperatorSession = z.infer<typeof operatorSessionSchema>;

/**
 * Whether a stored session is usable right now.
 *
 * Derived from the two stored instants rather than trusted from a cleanup sweep,
 * so a missed sweep cannot extend access — the same rule the MCP session service
 * applies, for the same reason.
 *
 * `idleTimeoutMs` is passed in rather than stored: it is configuration, and a
 * session row should not pin the timeout it was created under.
 */
export function isOperatorSessionUsable(
  session: OperatorSession,
  now: string,
  idleTimeoutMs: number,
): boolean {
  if (session.revokedAt !== undefined) return false;
  if (session.expiresAt <= now) return false;

  const idleDeadline = new Date(new Date(session.lastSeenAt).getTime() + idleTimeoutMs).toISOString();
  return idleDeadline > now;
}

/** Same predicate, expressed for SQL so counts and lists agree with the check. */
export function operatorSessionStatus(session: OperatorSession, now: string, idleTimeoutMs: number): 'active' | 'expired' | 'revoked' {
  if (session.revokedAt !== undefined) return 'revoked';
  return isOperatorSessionUsable(session, now, idleTimeoutMs) ? 'active' : 'expired';
}

/** Login is refused for these, but the *reason* never reaches the client. */
export function operatorCanAuthenticate(operator: Operator, now: string): boolean {
  if (!operator.enabled) return false;
  if (operator.lockedUntil !== undefined && operator.lockedUntil > now) return false;
  return true;
}
