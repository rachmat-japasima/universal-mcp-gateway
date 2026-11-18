import { randomUUID } from 'node:crypto';

import type { Agent } from '../domain/agent.js';
import type { AgentCredential } from '../domain/agent-credential.js';
import { credentialStatus } from '../domain/agent-credential.js';
import type { AuditAction } from '../domain/audit-event.js';
import type { SessionQuery, SessionPage } from '../domain/repositories.js';
import type { Session, SessionStatus, SessionTerminationReason } from '../domain/session.js';
import { idleDeadline, isSessionUsable, sessionStatus } from '../domain/session.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { AppError, describeErrorForLog } from '../shared/errors.js';
import type { Actor } from './backend-service.js';
import { LOCAL_OPERATOR } from './backend-service.js';

/**
 * Persistent MCP session lifecycle.
 *
 * The rules this module owns:
 *
 *   * a protocol session id binds to exactly one agent and one credential, and
 *     that binding is immutable (DB trigger, migration 0005);
 *   * every request re-validates the session, so a revocation, a disable or an
 *     expiry takes effect on the next request rather than at the next sweep;
 *   * ending a session is idempotent and one-way — a finished session can never
 *     be reactivated;
 *   * cleanup keeps the row (auditable history) and only ever touches sessions
 *     that are still active, so a concurrent terminate cannot be overwritten.
 *
 * Concurrency: this process holds one SQLite connection, so all writes are
 * serialized by better-sqlite3, and every state change is a single conditional
 * UPDATE. Across processes, SQLite's write lock plus the 0005 constraints
 * (UNIQUE `mcp_session_id`, the identity trigger, the no-reactivation trigger)
 * are what keep the invariants; nothing here relies on an in-memory mutex.
 */

export interface SessionServiceOptions {
  store: Database;
  logger: Logger;
  /** Idle timeout in milliseconds. Enforced per request, not only by cleanup. */
  idleTimeoutMs: number;
  /** Hard cap on a session's life, measured from creation. */
  maxLifetimeMs: number;
  actor?: Actor;
  now?: () => Date;
  /**
   * Called with the sessions this service just ended, so the caller can release
   * the live transport. Injected rather than imported to keep the dependency
   * one-way: the transport registry depends on this service, not the reverse.
   */
  onEnded?: (sessions: Session[]) => void;
  /** Minimum spacing between two `session.authenticated` audit rows per session. */
  auditWindowMs?: number;
}

export interface SessionIdentity {
  agent: Agent;
  credential: AgentCredential;
}

/**
 * The slice of the session service the registry services need.
 *
 * A narrow interface rather than the whole class: a credential revocation only
 * needs "end the sessions this credential authorized", and depending on less
 * keeps the audit/inspection surface of the dependency small.
 */
export interface SessionInvalidator {
  invalidateFor(
    filter: { agentId?: string; credentialId?: string },
    reason: SessionTerminationReason,
    status?: 'invalidated' | 'terminated',
  ): number;
}

export interface CreatedSession {
  session: Session;
}

/**
 * Why a request could not be authorized against its session.
 *
 * Reported to the client as one uniform refusal; the reason exists for the audit
 * trail and the log, never for the wire.
 */
export type SessionRejectionReason =
  | 'session_missing'
  | 'session_unknown'
  | 'session_not_active'
  | 'session_owner_mismatch'
  | 'session_credential_mismatch'
  | 'session_expired'
  | 'credential_revoked'
  | 'credential_expired'
  | 'agent_disabled'
  | 'agent_missing';

export interface SessionFailure {
  reason: SessionRejectionReason;
  /** True when the session was usable but something else about it failed. */
  external?: boolean;
}

export type SessionValidation = { session: Session } | { failure: SessionFailure };

interface AuditBucket {
  windowStart: number;
  suppressed: number;
}

export class SessionService {
  private readonly store: Database;
  private readonly logger: Logger;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly actor: Actor;
  private readonly now: () => Date;
  private readonly auditWindowMs: number;
  private readonly onEnded: ((sessions: Session[]) => void) | undefined;
  private readonly buckets = new Map<string, AuditBucket>();
  private readonly bucketLimit = 512;

  constructor(options: SessionServiceOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.maxLifetimeMs = options.maxLifetimeMs;
    this.actor = options.actor ?? LOCAL_OPERATOR;
    this.now = options.now ?? (() => new Date());
    this.auditWindowMs = options.auditWindowMs ?? 60_000;
    this.onEnded = options.onEnded;
  }

  /**
   * Binds a freshly initialized protocol session to its authenticated identity.
   *
   * Called once, from the SDK's `onsessioninitialized` callback, *before* the
   * transport answers the initialize response — so a client that receives a
   * session id can immediately use it. If the write fails the initialization
   * fails: a protocol session without a persistent record would be unusable (and
   * every later request would be refused), so failing closed is the honest
   * outcome.
   */
  create(identity: SessionIdentity, mcpSessionId: string, metadata?: Session['metadata']): CreatedSession {
    const now = this.now();
    const createdAt = now.toISOString();

    const session = this.store.transaction(() =>
      this.store.sessions.create({
        id: randomUUID(),
        mcpSessionId,
        agentId: identity.agent.id,
        credentialId: identity.credential.id,
        status: 'active',
        createdAt,
        lastActivityAt: createdAt,
        expiresAt: new Date(now.getTime() + this.maxLifetimeMs).toISOString(),
        ...(metadata === undefined ? {} : { metadata }),
      }),
    );

    this.audit('session.created', 'success', session, {
      mcpSessionId,
      agentId: session.agentId,
      ...(session.credentialId === undefined ? {} : { credentialId: session.credentialId }),
      ...(metadata?.protocolVersion === undefined ? {} : { protocolVersion: metadata.protocolVersion }),
      ...(metadata?.clientType === undefined ? {} : { clientType: metadata.clientType }),
    });

    return { session };
  }

  /**
   * Resolves a protocol session id to a usable session for this identity.
   *
   * Order mirrors the requirement: authenticate (already done by the caller),
   * resolve, load, exists → active → owner → credential → agent. A mismatch
   * anywhere produces the same client answer; only the audit row differs, and it
   * is written on the gateway side only.
   */
  validate(mcpSessionId: string | undefined, identity: SessionIdentity): SessionValidation {
    if (mcpSessionId === undefined || mcpSessionId === '') {
      return this.reject('session_missing', identity, undefined);
    }

    const session = this.store.sessions.findByMcpSessionId(mcpSessionId);
    if (session === undefined) return this.reject('session_unknown', identity, undefined);

    // Ownership is checked before liveness so a probe cannot use the error to
    // learn whether someone else's session is still alive.
    if (session.agentId !== identity.agent.id) return this.reject('session_owner_mismatch', identity, session);

    if (session.credentialId !== undefined && session.credentialId !== identity.credential.id) {
      return this.reject('session_credential_mismatch', identity, session);
    }

    // Two lifetimes, both enforced here rather than only by the sweep: the hard
    // cap (`expiresAt`) and the idle deadline, which moves with `lastActivityAt`
    // and so cannot be stored as a column.
    const now = this.now();
    const status = sessionStatus(session, now, this.idleTimeoutMs);
    if (status !== 'active') {
      return this.reject(status === 'expired' ? 'session_expired' : 'session_not_active', identity, session);
    }

    const credentialNow = credentialStatus(identity.credential, now);
    if (credentialNow === 'revoked') return this.reject('credential_revoked', identity, session);
    if (credentialNow === 'expired') return this.reject('credential_expired', identity, session);

    const agent = this.store.agents.findById(session.agentId);
    if (agent === undefined) return this.reject('agent_missing', identity, session);
    if (!agent.enabled) return this.reject('agent_disabled', identity, session);

    this.touch(session, identity);
    return { session };
  }

  /** Operator termination. Idempotent: an already-finished session comes back unchanged. */
  terminate(sessionId: string, reason: SessionTerminationReason = 'operator_terminated'): Session {
    return this.store.transaction(() => {
      const existing = this.require(sessionId);
      const ended = this.store.sessions.end(sessionId, this.now().toISOString(), 'terminated', reason);

      // Only audit an actual transition: a repeated terminate must not spam the
      // trail or claim a second termination happened.
      if (existing.status === 'active') {
        this.audit('session.terminated', 'success', ended, {
          reason,
          ...(ended.credentialId === undefined ? {} : { credentialId: ended.credentialId }),
          agentId: ended.agentId,
        });
        this.release([ended]);
      }

      return ended;
    });
  }

  /** Ends one session for a security reason. Same idempotency as `terminate`. */
  invalidate(
    sessionId: string,
    reason: SessionTerminationReason,
    status: 'invalidated' | 'terminated' = 'invalidated',
  ): Session {
    return this.store.transaction(() => {
      const existing = this.require(sessionId);
      const ended = this.store.sessions.end(sessionId, this.now().toISOString(), status, reason);

      if (existing.status === 'active') {
        this.audit('session.invalidated', 'success', ended, {
          reason,
          ...(ended.credentialId === undefined ? {} : { credentialId: ended.credentialId }),
          agentId: ended.agentId,
        });
        this.release([ended]);
      }

      return ended;
    });
  }

  /**
   * Invalidates every active session belonging to an agent or a credential.
   *
   * Runs inside the caller's transaction when there is one (the credential and
   * agent services call it from theirs), so the credential revocation and the
   * session invalidation either both commit or neither does.
   */
  invalidateFor(
    filter: { agentId?: string; credentialId?: string },
    reason: SessionTerminationReason,
    status: 'invalidated' | 'terminated' = 'invalidated',
  ): number {
    const ended = this.store.sessions.endWhere(filter, this.now().toISOString(), status, reason);
    if (ended.length === 0) return 0;

    this.audit('session.invalidated', 'success', undefined, {
      reason,
      affected: ended.length,
      ...(filter.agentId === undefined ? {} : { agentId: filter.agentId }),
      ...(filter.credentialId === undefined ? {} : { credentialId: filter.credentialId }),
    });
    this.release(ended);

    return ended.length;
  }

  /**
   * Expires idle and over-lifetime sessions.
   *
   * Returns what changed so the caller (or a test) can assert on it. Safe to run
   * concurrently with itself and with termination: both statements are
   * conditional on `status = 'active'`, so the loser of a race changes zero rows.
   * Rows are kept, never deleted — the audit trail must survive the sweep.
   */
  cleanup(): { expired: number; sessions: Session[] } {
    const now = this.now();
    const idleCutoff = new Date(now.getTime() - this.idleTimeoutMs).toISOString();

    const sessions = this.store.transaction(() => this.store.sessions.expire(now.toISOString(), idleCutoff));

    for (const session of sessions) {
      this.audit('session.expired', 'success', session, {
        reason: session.terminationReason ?? 'cleanup',
        agentId: session.agentId,
      });
    }

    this.audit('session.cleanup.completed', 'success', undefined, {
      expired: sessions.length,
    });
    this.release(sessions);

    return { expired: sessions.length, sessions };
  }

  list(criteria: SessionQuery): SessionPage {
    // The idle deadline is configuration, not a column, so the repository needs
    // it to filter on effective status before the sweep has run.
    return this.store.sessions.query({
      ...criteria,
      now: this.now().toISOString(),
      idleCutoff: new Date(this.now().getTime() - this.idleTimeoutMs).toISOString(),
    });
  }

  /** Public representation with this deployment's idle timeout applied. */
  toPublic(session: Session): Record<string, unknown> {
    return toPublicSession(session, this.now(), this.idleTimeoutMs);
  }

  get(sessionId: string): Session {
    return this.require(sessionId);
  }

  /**
   * Ends every active session. Used by graceful shutdown, where the policy is to
   * terminate rather than leave rows that claim to be live in a process that no
   * longer exists.
   */
  terminateAll(reason: SessionTerminationReason): number {
    const ended = this.store.sessions.endWhere(
      { ids: this.activeIds() },
      this.now().toISOString(),
      'terminated',
      reason,
    );
    if (ended.length > 0) this.audit('session.terminated', 'success', undefined, { reason, affected: ended.length });
    this.release(ended);
    return ended.length;
  }

  private activeIds(): string[] {
    const page = this.store.sessions.query({
      status: 'active',
      limit: 10_000,
      offset: 0,
      sort: 'createdAt',
      order: 'asc',
    });
    return page.items.map((session) => session.id);
  }

  /**
   * Records activity and, at most once per window, an audit row.
   *
   * A busy session would otherwise write one audit row per request. The window is
   * the same bounded-map pattern the auth service uses, so it cannot grow without
   * limit and a burst is reported via `suppressed` on the next written row.
   */
  private touch(session: Session, identity: SessionIdentity): void {
    const now = this.now().toISOString();
    const deadline = idleDeadline(session, this.idleTimeoutMs);

    try {
      // A session whose idle deadline already passed is refused above, so this
      // cannot extend the life of one that should be dead.
      if (deadline.getTime() <= this.now().getTime()) return;
      this.store.sessions.touch(session.id, now);
    } catch (error) {
      // The session is still valid; failing to record activity must not fail the
      // request. The next request will try again.
      this.logger.warn({ error: describeErrorForLog(error) }, 'Session activity could not be recorded');
    }

    if (!this.take(`authenticated:${session.id}`)) return;

    const suppressed = this.buckets.get(`authenticated:${session.id}`)?.suppressed ?? 0;
    this.audit('session.authenticated', 'success', session, {
      agentId: identity.agent.id,
      ...(session.credentialId === undefined ? {} : { credentialId: session.credentialId }),
      ...(suppressed === 0 ? {} : { suppressed }),
    });
  }

  private reject(reason: SessionRejectionReason, identity: SessionIdentity, session: Session | undefined): SessionValidation {
    this.logger.warn({ reason, agentId: identity.agent.id }, 'MCP session refused');

    if (!this.take(`denied:${reason}`)) return { failure: { reason, external: true } };

    const suppressed = this.buckets.get(`denied:${reason}`)?.suppressed ?? 0;
    this.audit('session.access.denied', 'denied', session, {
      reason,
      agentId: identity.agent.id,
      ...(session === undefined ? {} : { sessionId: session.id }),
      ...(suppressed === 0 ? {} : { suppressed }),
    });

    return { failure: { reason, external: true } };
  }

  /** Best-effort transport release. A failure cannot un-end the session. */
  /** Effective status, so a caller reports `expired` before the sweep writes it. */
  statusOf(session: Session): SessionStatus {
    return sessionStatus(session, this.now(), this.idleTimeoutMs);
  }

  private release(sessions: Session[]): void {
    if (sessions.length === 0) return;
    try {
      this.onEnded?.(sessions);
    } catch (error) {
      this.logger.warn({ error: describeErrorForLog(error) }, 'Ended sessions could not be released');
    }
  }

  private require(sessionId: string): Session {
    const session = this.store.sessions.findById(sessionId);
    if (session === undefined) {
      throw new AppError('RESOURCE_NOT_FOUND', 'The requested session does not exist.', {
        details: { sessionId },
      });
    }
    return session;
  }

  private audit(
    action: AuditAction,
    result: 'success' | 'failure' | 'denied',
    session: Session | undefined,
    metadata: Record<string, string | number | boolean>,
  ): void {
    try {
      this.store.audit.append({
        id: randomUUID(),
        actorType: this.actor.type,
        ...(this.actor.id === undefined ? {} : { actorId: this.actor.id }),
        action,
        targetType: 'session',
        ...(session === undefined ? {} : { targetId: session.id }),
        result,
        metadata,
        createdAt: this.now().toISOString(),
      });
    } catch (error) {
      // Audit is best-effort for a session event: the security decision has
      // already been made, and a failed write must not change it.
      this.logger.warn({ error: describeErrorForLog(error), action }, 'Session audit could not be written');
    }
  }

  private take(key: string): boolean {
    const nowMs = this.now().getTime();
    const bucket = this.buckets.get(key);

    if (bucket === undefined || nowMs - bucket.windowStart >= this.auditWindowMs) {
      if (this.buckets.size >= this.bucketLimit) this.buckets.clear();
      this.buckets.set(key, { windowStart: nowMs, suppressed: 0 });
      return true;
    }

    bucket.suppressed += 1;
    return false;
  }
}

/** Public representation. No credential, no transport state, no internal close handle. */
export function toPublicSession(
  session: Session,
  now: Date = new Date(),
  idleTimeoutMs?: number,
): Record<string, unknown> {
  return {
    id: session.id,
    ...(session.mcpSessionId === undefined ? {} : { mcpSessionId: session.mcpSessionId }),
    agentId: session.agentId,
    ...(session.credentialId === undefined ? {} : { credentialId: session.credentialId }),
    status: sessionStatus(session, now, idleTimeoutMs),
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
    ...(session.terminatedAt === undefined ? {} : { terminatedAt: session.terminatedAt }),
    ...(session.terminationReason === undefined ? {} : { terminationReason: session.terminationReason }),
    ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
  };
}

export function isSessionStatus(value: string): value is SessionStatus {
  return value === 'active' || value === 'expired' || value === 'terminated' || value === 'invalidated';
}

export { isSessionUsable };
