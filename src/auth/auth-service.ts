import { randomUUID } from 'node:crypto';

import type { Agent } from '../domain/agent.js';
import type { AgentCredential } from '../domain/agent-credential.js';
import { credentialStatus } from '../domain/agent-credential.js';
import type { Database } from '../infrastructure/database/index.js';
import type { Logger } from '../monitoring/logger.js';
import { describeErrorForLog } from '../shared/errors.js';
import type { CredentialKeys } from './credential-key.js';
import { digest, digestMatches, isWellFormedToken } from './credential-key.js';

/**
 * MCP authentication.
 *
 * Every HTTP request is authenticated independently. There is no session-based
 * identity: a previously initialized MCP session proves nothing about *this*
 * request, and no client-supplied value (agent id, agent name, session id,
 * header, query parameter) is ever trusted as identity.
 *
 * Failure is uniform. Missing header, malformed header, unknown token, revoked
 * credential, expired credential, disabled agent and missing server secret all
 * produce the same answer, so a caller cannot use the difference to enumerate
 * agents or credentials.
 */

export interface AuthenticatedIdentity {
  agent: Agent;
  credential: AgentCredential;
}

export interface AuthFailure {
  /** Reason for the audit trail and logs only. Never serialized to the client. */
  reason: AuthFailureReason;
  /**
   * True when the failure is the gateway's own misconfiguration (no hashing key)
   * rather than the caller's credential. Both answer 401 to the client; only this
   * flag changes what is written to the log.
   */
  misconfigured?: boolean;
}

export type AuthFailureReason =
  | 'missing_header'
  | 'malformed_header'
  | 'malformed_token'
  | 'unknown_credential'
  | 'revoked_credential'
  | 'expired_credential'
  | 'agent_disabled'
  | 'agent_missing'
  | 'unknown_key'
  | 'secret_missing';

export interface AuthServiceOptions {
  store: Database;
  keys: CredentialKeys;
  logger: Logger;
  now?: () => Date;
  /**
   * Minimum spacing between two audit rows with the same shape. A failed-auth
   * flood is attacker-controllable even on loopback, and audit rows are durable;
   * collapsing repeats keeps the trail honest without letting it be filled.
   */
  auditWindowMs?: number;
}

/** Bounded audit writes: one row per (reason, window), with a suppressed count. */
interface AuditBucket {
  windowStart: number;
  suppressed: number;
}

export class AuthService {
  private readonly store: Database;
  private readonly keys: CredentialKeys;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly auditWindowMs: number;
  private readonly failureBuckets = new Map<string, AuditBucket>();
  private readonly successBuckets = new Map<string, AuditBucket>();
  private readonly bucketLimit = 512;

  constructor(options: AuthServiceOptions) {
    this.store = options.store;
    this.keys = options.keys;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.auditWindowMs = options.auditWindowMs ?? 60_000;
  }

  /**
   * Verifies one `Authorization` header value.
   *
   * Order is deliberate: cheap structural checks, then the keyed digest, then a
   * single indexed lookup, then a timing-safe confirm, then state checks. No
   * branch reveals which step failed.
   */
  authenticate(authorization: string | undefined, context: { requestId?: string } = {}): AuthenticatedIdentity | AuthFailure {
    const key = this.keys.issuing;

    if (key === undefined) {
      this.recordFailure('secret_missing', context, { misconfigured: true });
      return { reason: 'secret_missing', misconfigured: true };
    }

    if (authorization === undefined || authorization.trim() === '') {
      return this.fail('missing_header', context);
    }

    const match = /^Bearer[ ]+([^\s]+)$/i.exec(authorization.trim());
    if (match === null) {
      return this.fail('malformed_header', context);
    }

    const token = match[1]!;
    if (!isWellFormedToken(token)) {
      return this.fail('malformed_token', context);
    }

    const presentedHash = digest(token, key);
    const credential = this.store.credentials.findByHash(presentedHash);

    // The lookup is by digest, so a hit implies equality; this re-checks it in
    // constant time anyway, so a future change to the query cannot silently
    // turn a prefix match into an authentication.
    if (credential === undefined || !digestMatches(presentedHash, credential.credentialHash)) {
      return this.fail('unknown_credential', context);
    }

    // A credential hashed with a key this process does not hold cannot be
    // verified beyond the digest, so it is refused rather than trusted.
    if (this.keys.verifier(credential.hashKeyId) === undefined) {
      return this.fail('unknown_key', context);
    }

    const status = credentialStatus(credential, this.now());
    if (status === 'revoked') return this.fail('revoked_credential', context, credential);
    if (status === 'expired') return this.fail('expired_credential', context, credential);

    const agent = this.store.agents.findById(credential.agentId);
    if (agent === undefined) return this.fail('agent_missing', context, credential);
    if (!agent.enabled) return this.fail('agent_disabled', context, credential);

    this.touch(agent, credential);
    return { agent, credential };
  }

  /**
   * Records a successful authentication.
   *
   * `lastUsedAt`/`lastAuthenticatedAt` are written on every success so an
   * operator can see live activity; the audit row is written at most once per
   * window per agent, because a busy agent would otherwise write an audit row
   * per tool call.
   */
  private touch(agent: Agent, credential: AgentCredential): void {
    const now = this.now().toISOString();

    try {
      this.store.credentials.touch(credential.id, now);
      this.store.agents.touchAuthentication(agent.id, now);
    } catch (error) {
      // The credential is valid; failing to record usage must not fail the call.
      this.logger.warn({ error: describeErrorForLog(error) }, 'Credential usage could not be recorded');
    }

    if (!this.take(this.successBuckets, agent.id)) return;

    try {
      this.store.audit.append({
        id: randomUUID(),
        actorType: 'agent',
        actorId: agent.id,
        action: 'auth.succeeded',
        targetType: 'credential',
        targetId: credential.id,
        result: 'success',
        metadata: { credentialId: credential.id, hashKeyId: credential.hashKeyId ?? 'unknown' },
        createdAt: now,
      });
    } catch (error) {
      this.logger.warn({ error: describeErrorForLog(error) }, 'Authentication success could not be audited');
    }
  }

  private fail(
    reason: AuthFailureReason,
    context: { requestId?: string },
    credential?: AgentCredential,
  ): AuthFailure {
    this.recordFailure(reason, context, credential === undefined ? {} : { credential, agentId: credential.agentId });
    return { reason };
  }

  private recordFailure(
    reason: AuthFailureReason,
    context: { requestId?: string },
    extra: { misconfigured?: boolean; credential?: AgentCredential; agentId?: string } = {},
  ): void {
    if (extra.misconfigured === true) {
      this.logger.error(
        { requestId: context.requestId, reason },
        'MCP authentication is unavailable: CREDENTIAL_HASH_SECRET is missing or invalid',
      );
      return;
    }

    this.logger.warn({ requestId: context.requestId, reason }, 'MCP authentication failed');

    if (!this.take(this.failureBuckets, reason)) return;

    const suppressed = this.failureBuckets.get(reason)?.suppressed ?? 0;

    try {
      this.store.audit.append({
        id: randomUUID(),
        actorType: 'system',
        ...(extra.agentId === undefined ? {} : { actorId: extra.agentId }),
        action: 'auth.failed',
        ...(extra.credential === undefined ? {} : { targetType: 'credential' as const, targetId: extra.credential.id }),
        result: 'failure',
        ...(context.requestId === undefined ? {} : { requestId: context.requestId.slice(0, 64) }),
        // The reason is a closed enum, never a token, header, or agent-supplied text.
        metadata: { reason, ...(suppressed === 0 ? {} : { suppressed }) },
        createdAt: this.now().toISOString(),
      });
    } catch (error) {
      this.logger.warn({ error: describeErrorForLog(error) }, 'Authentication failure could not be audited');
    }
  }

  /**
   * Fixed-window gate. Returns true when the caller may write a row now.
   *
   * Suppressed counts are attached to the *next* written row, then reset, so a
   * burst is reported rather than hidden. The map is bounded: if it grows past
   * the limit it is cleared, which only costs one extra row per reason.
   */
  private take(buckets: Map<string, AuditBucket>, key: string): boolean {
    const nowMs = this.now().getTime();
    const bucket = buckets.get(key);

    if (bucket === undefined || nowMs - bucket.windowStart >= this.auditWindowMs) {
      if (buckets.size >= this.bucketLimit) buckets.clear();
      buckets.set(key, { windowStart: nowMs, suppressed: 0 });
      return true;
    }

    bucket.suppressed += 1;
    return false;
  }
}

export function isAuthenticated(value: AuthenticatedIdentity | AuthFailure): value is AuthenticatedIdentity {
  return 'agent' in value;
}
