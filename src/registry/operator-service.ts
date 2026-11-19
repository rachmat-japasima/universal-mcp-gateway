import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { CredentialKeys } from '../auth/credential-key.js';
import { digest } from '../auth/credential-key.js';
import { burnPasswordTime, verifyPassword } from '../auth/operator-password.js';
import type { AuditAction } from '../domain/audit-event.js';
import type { Operator, OperatorSession, PublicOperator } from '../domain/operator.js';
import {
  isOperatorSessionUsable,
  OPERATOR_TOKEN_PREFIX,
  operatorCanAuthenticate,
  toPublicOperator,
} from '../domain/operator.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { AppError } from '../shared/errors.js';

/**
 * Dashboard operator authentication (Phase 10.0).
 *
 * Everything security-relevant happens here, in the gateway process: password
 * verification, lockout, session minting, rotation, and revocation. The
 * dashboard never verifies a password and never mints a session — it forwards
 * credentials over loopback and re-issues the resulting cookie on its own
 * origin. That split is what keeps a dashboard that is down from being an
 * authentication bypass, and a dashboard that is up from being the only guard.
 *
 * Threat model notes that shaped the code:
 *
 *  * **The cookie is a bearer credential.** Only its keyed digest is stored, so
 *    a database copy cannot be replayed and a lookup never compares raw values.
 *  * **Login must not be an oracle.** Unknown, disabled, locked and
 *    wrong-password all take the same path and produce the same client answer;
 *    a dummy scrypt run keeps the timing comparable.
 *  * **Logout must actually end access.** Sessions are rows, revoked in one
 *    conditional UPDATE, and every request re-validates the row — there is no
 *    in-memory "logged in" flag and no stateless token that outlives a logout.
 */

/** 5 failures → 15 minutes. Bounded: a local operator has no recovery UI. */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60_000;

/** 32 bytes → 256 bits, base64url. */
const TOKEN_ENTROPY_BYTES = 32;

/** Cookie value: fixed prefix plus base64url entropy. */
const TOKEN_LENGTH = OPERATOR_TOKEN_PREFIX.length + 43;

export interface OperatorLoginInput {
  username: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Why a login failed. Logged and audited internally; the client always receives
 * one generic message, so this type must never be serialized.
 */
export type LoginFailureReason =
  | 'unknown_operator'
  | 'invalid_password'
  | 'operator_disabled'
  | 'operator_locked'
  | 'operator_missing_after_lock'
  | 'no_operator_configured'
  | 'hashing_unavailable';

export type LoginResult =
  | { ok: true; operator: PublicOperator; session: OperatorSession; token: string; csrfToken: string }
  | { ok: false; reason: LoginFailureReason };

export type SessionRejectionReason =
  | 'session_missing'
  | 'session_malformed'
  | 'session_unknown'
  | 'session_revoked'
  | 'session_expired'
  | 'operator_disabled'
  | 'operator_missing'
  | 'unknown_key'
  | 'hashing_unavailable';

export type AuthenticatedOperator = {
  operator: Operator;
  session: OperatorSession;
  csrfToken: string;
};

export type SessionValidation = { ok: true; value: AuthenticatedOperator } | { ok: false; reason: SessionRejectionReason };

export interface OperatorServiceOptions {
  store: Database;
  /** Same key registry the agent credentials use, with its own key-id namespace. */
  keys: CredentialKeys;
  logger: Logger;
  idleTimeoutMs: number;
  maxLifetimeMs: number;
  now?: () => Date;
}

/** Issued once, at login. The raw value exists only in this object and the cookie. */
export interface CreatedOperatorSession {
  session: OperatorSession;
  token: string;
  csrfToken: string;
}

export class OperatorService {
  private readonly store: Database;
  private readonly keys: CredentialKeys;
  private readonly logger: Logger;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly now: () => Date;

  constructor(options: OperatorServiceOptions) {
    this.store = options.store;
    this.keys = options.keys;
    this.logger = options.logger;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.maxLifetimeMs = options.maxLifetimeMs;
    this.now = options.now ?? (() => new Date());
  }

  /** Whether the instance has an operator at all. Drives the setup hint, not a bypass. */
  isConfigured(): boolean {
    return this.store.operators.count() > 0;
  }

  /**
   * Verifies credentials and mints a fresh session.
   *
   * Rotation is structural rather than a special case: a login always creates a
   * new session id and revokes any session the caller already held, which is
   * precisely what makes a pre-seeded session id useless (no fixation).
   */
  login(input: OperatorLoginInput, previousToken?: string): LoginResult {
    const key = this.keys.issuing;
    if (key === undefined) {
      // Fail closed: without a hashing key no digest can be produced, so no
      // session could be validated later. Same answer as a wrong password.
      this.recordLoginFailure('hashing_unavailable', undefined, input);
      return { ok: false, reason: 'hashing_unavailable' };
    }

    const operator = this.store.operators.findByUsername(input.username);

    if (operator === undefined) {
      // Burn comparable time, then answer exactly as for a wrong password.
      burnPasswordTime(input.password);
      this.recordLoginFailure('unknown_operator', undefined, input);
      return { ok: false, reason: 'unknown_operator' };
    }

    const nowDate = this.now();
    const now = nowDate.toISOString();

    if (!operatorCanAuthenticate(operator, now)) {
      const reason: LoginFailureReason = operator.enabled ? 'operator_locked' : 'operator_disabled';
      // Still verify, so a disabled account costs the same as an enabled one.
      burnPasswordTime(input.password);
      this.recordLoginFailure(reason, operator, input);
      return { ok: false, reason };
    }

    if (!verifyPassword(input.password, operator.passwordHash)) {
      const failures = operator.failedLoginAttempts + 1;
      const lockUntil =
        failures >= LOCKOUT_THRESHOLD ? new Date(nowDate.getTime() + LOCKOUT_DURATION_MS).toISOString() : undefined;

      const updated = this.store.operators.recordLoginFailure(operator.id, now, lockUntil);
      this.recordLoginFailure('invalid_password', updated, input, {
        ...(lockUntil === undefined ? {} : { lockedUntil: lockUntil }),
      });

      return { ok: false, reason: 'invalid_password' };
    }

    const { operator: refreshed, created } = this.store.transaction(() => {
      // Rotation: a session held before authentication cannot survive it.
      if (previousToken !== undefined) {
        const previous = this.store.operators.findSessionByTokenHash(digest(previousToken, key));
        if (previous !== undefined && previous.revokedAt === undefined) {
          this.store.operators.revokeSession(previous.id, now, 'cleanup');
        }
      }

      const succeeded = this.store.operators.recordLoginSuccess(operator.id, now);
      return { operator: succeeded, created: this.mintSession(succeeded, key, now, input) };
    });

    const { session, token, csrfToken } = created;

    this.audit('operator.login.succeeded', 'success', session.operatorId, session.id, {
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
    });
    this.logger.info({ operatorId: session.operatorId, sessionId: session.id }, 'Operator signed in');

    return {
      ok: true,
      operator: toPublicOperator(refreshed),
      session,
      token,
      csrfToken,
    };
  }

  /**
   * Resolves a presented cookie to a usable identity.
   *
   * Order matters for information leaks: structural checks first (no database
   * hit for garbage), then the row, then liveness, then the operator. Every
   * failure is answered identically to the client.
   */
  authenticate(token: string | undefined): SessionValidation {
    if (token === undefined || token === '') return { ok: false, reason: 'session_missing' };
    if (!isWellFormedToken(token)) return { ok: false, reason: 'session_malformed' };

    const key = this.keys.issuing;
    if (key === undefined) return { ok: false, reason: 'hashing_unavailable' };

    const session = this.store.operators.findSessionByTokenHash(digest(token, key));
    if (session === undefined) return { ok: false, reason: 'session_unknown' };

    // A digest produced by a key this process no longer holds cannot be trusted,
    // even though the lookup matched: treat it as unknown rather than downgrade.
    if (this.keys.verifier(session.hashKeyId) === undefined) return { ok: false, reason: 'unknown_key' };
    if (session.hashKeyId !== key.id) return { ok: false, reason: 'unknown_key' };

    const now = this.now().toISOString();
    if (session.revokedAt !== undefined) return { ok: false, reason: 'session_revoked' };
    if (!isOperatorSessionUsable(session, now, this.idleTimeoutMs)) {
      // Write the ending so the row reflects reality; if a concurrent request
      // already ended it, that write is a no-op.
      this.store.operators.revokeSession(session.id, now, 'cleanup');
      this.audit('operator.session.expired', 'failure', session.operatorId, session.id, {});
      return { ok: false, reason: 'session_expired' };
    }

    const operator = this.store.operators.findById(session.operatorId);
    if (operator === undefined) return { ok: false, reason: 'operator_missing' };

    if (!operator.enabled) {
      // Disabling an operator ends *all* their sessions, not just this request.
      this.store.operators.revokeSessionsForOperator(operator.id, now, 'operator_disabled');
      return { ok: false, reason: 'operator_disabled' };
    }

    this.store.operators.touchSession(session.id, now);

    return {
      ok: true,
      value: { operator, session: { ...session, lastSeenAt: now }, csrfToken: csrfFor(token) },
    };
  }

  /** Ends the presented session. Idempotent, and never resurrects a finished one. */
  logout(token: string | undefined): boolean {
    if (token === undefined || token === '') return false;

    const key = this.keys.issuing;
    if (key === undefined) return false;

    const session = this.store.operators.findSessionByTokenHash(digest(token, key));
    if (session === undefined || session.revokedAt !== undefined) return false;

    const now = this.now().toISOString();
    this.store.operators.revokeSession(session.id, now, 'logout');
    this.audit('operator.logout', 'success', session.operatorId, session.id, {});
    this.logger.info({ operatorId: session.operatorId, sessionId: session.id }, 'Operator signed out');

    return true;
  }

  /** Ends one session by id, for the future dashboard session list. */
  revokeSession(sessionId: string, operatorId: string | undefined): boolean {
    const session = this.store.operators.findSessionById(sessionId);
    if (session === undefined || session.revokedAt !== undefined) return false;

    const now = this.now().toISOString();
    this.store.operators.revokeSession(session.id, now, 'logout');
    this.audit('operator.session.revoked', 'success', session.operatorId, session.id, {
      ...(operatorId === undefined ? {} : { revokedBy: operatorId }),
    });
    return true;
  }

  /**
   * Marks sessions past either deadline. Derived status already refuses them, so
   * this exists to keep `revoked_at` honest and the audit trail complete.
   */
  sweep(): number {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const idleCutoff = new Date(nowDate.getTime() - this.idleTimeoutMs).toISOString();

    const expired = this.store.operators.expireSessions(now, idleCutoff);
    for (const session of expired) {
      this.audit('operator.session.expired', 'failure', session.operatorId, session.id, {});
    }

    return expired.length;
  }

  /** Revokes every live session of an operator. Used by disable and password change. */
  revokeAllFor(operatorId: string, reason: 'operator_disabled' | 'operator_password_changed' | 'operator_deleted'): number {
    const now = this.now().toISOString();
    return this.store.operators.revokeSessionsForOperator(operatorId, now, reason).length;
  }

  /** Verifies a token's CSRF binding without touching the database. */
  csrfMatches(token: string, presented: string): boolean {
    const expected = Buffer.from(csrfFor(token), 'utf8');
    const actual = Buffer.from(presented, 'utf8');

    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private mintSession(
    operator: Operator,
    key: { id: string; secret: string },
    now: string,
    input: OperatorLoginInput,
  ): CreatedOperatorSession {
    const token = `${OPERATOR_TOKEN_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')}`;

    const session = this.store.operators.createSession({
      id: randomId(),
      operatorId: operator.id,
      tokenHash: digest(token, key),
      hashKeyId: key.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(new Date(now).getTime() + this.maxLifetimeMs).toISOString(),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
    });

    return { session, token, csrfToken: csrfFor(token) };
  }

  /**
   * One audit row per failed login.
   *
   * `actorId` is deliberately omitted: naming the username would record an
   * attempted identity, and the requirement is that audit rows avoid personal
   * data that is not needed. The operator id is attached only once the account
   * is known to exist *and* the failure is about its state, never for a
   * username that could not be resolved.
   */
  private recordLoginFailure(
    reason: LoginFailureReason,
    operator: Operator | undefined,
    input: OperatorLoginInput,
    extra: Record<string, string> = {},
  ): void {
    this.audit('operator.login.failed', 'failure', operator?.id, undefined, {
      reason,
      ...(reason === 'invalid_password' || reason === 'operator_locked' || reason === 'operator_disabled'
        ? { failedLoginAttempts: operator?.failedLoginAttempts ?? 0 }
        : {}),
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      ...extra,
    });

    this.logger.warn(
      { reason, operatorId: operator?.id, requestUserAgent: input.userAgent },
      'Operator sign-in rejected',
    );
  }

  private audit(
    action: AuditAction,
    result: 'success' | 'failure',
    operatorId: string | undefined,
    sessionId: string | undefined,
    metadata: Record<string, string | number | boolean>,
  ): void {
    try {
      this.store.audit.append({
        id: randomId(),
        actorType: 'admin',
        ...(operatorId === undefined ? {} : { actorId: operatorId }),
        action,
        targetType: 'operator',
        ...(sessionId === undefined ? {} : { targetId: sessionId }),
        result,
        metadata,
        createdAt: this.now().toISOString(),
      });
    } catch (error) {
      // Auditing must never turn a rejected login into a 500: the answer to the
      // client stays uniform either way, and the failure is observable in logs.
      this.logger.error({ error, action }, 'Failed to write operator audit event');
    }
  }
}

/**
 * Cookie value shape check before any hashing or lookup.
 *
 * Rejecting garbage structurally keeps junk off the session index and makes the
 * failure path identical for every kind of bad cookie.
 */
export function isWellFormedToken(value: string): boolean {
  if (value.length !== TOKEN_LENGTH) return false;
  if (!value.startsWith(OPERATOR_TOKEN_PREFIX)) return false;
  return /^[A-Za-z0-9_-]+$/.test(value.slice(OPERATOR_TOKEN_PREFIX.length));
}

/**
 * CSRF token bound to a session.
 *
 * Derived from the cookie value itself rather than stored: it cannot drift from
 * the session, needs no column, and cannot be computed without the cookie. That
 * is exactly the property a cross-site request lacks. It is *not* a defence
 * against XSS — nothing cookie-derived is — and `SameSite=Strict` plus the
 * Origin guard are the primary controls; this is the second lock.
 */
export function csrfFor(token: string): string {
  return createHmac('sha256', token).update('operator-csrf-v1', 'utf8').digest('base64url');
}

function randomId(): string {
  return randomUUID();
}

